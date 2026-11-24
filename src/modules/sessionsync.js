/* ============================================================
 * modules/sessionsync：跨标签会话同步 + 侧栏生成状态
 *
 * demo 页把会话存在同源 IndexedDB，但页面本身没有跨标签通知。这个模块
 * 只同步元数据与状态，不接管官网 React 内部状态：
 *   - BroadcastChannel（不可用时 localStorage/storage）在标签间同步生成中 /
 *     完成 / 停止 / 已读；
 *   - 侧栏行右侧显示转圈或蓝点；
 *   - sessionStorage 记住当前会话，刷新后只恢复一次；
 *   - 后台标签正开着同一条会话时，远端完成后等 IDB 落盘，再自动重载一次
 *     并回到原会话。
 *
 * 广播里没有消息正文，也没有 API Key。
 * ============================================================ */
var SessionSync = {
  CHANNEL: 'dcp-session-sync-v1',
  LS_KEY: 'dcp_session_sync_bus_v1',
  TAB_KEY: 'dcp_sync_tab_id',
  ACTIVE_KEY: 'dcp_sync_active_sid',
  HEARTBEAT_MS: 5000,
  STALE_MS: 60000,
  RESTORE_GRACE_MS: 1200,

  _enabled: false,
  _booted: false,
  _bootPromise: null,
  _tabId: '',
  _channel: null,
  _useStorage: false,
  _onStorage: null,
  _observer: null,
  _rowTimer: null,
  _rowToken: 0,
  _heartbeat: null,
  _generating: {},       // tabId:requestId -> { tabId, requestId, sid, state, at, lastSeen, title }
  _done: {},             // sid -> { at, title, updatedAt }
  _summaries: [],
  _activeSid: null,
  _lastInteractionAt: Date.now(),
  _remoteInteraction: {},
  _seenBlur: false,
  _pendingRestore: null,
  _restoreStarted: false,
  _restoreTimer: null,
  _reloadScheduled: {},
  _reloadTimers: {},
  _nativeRequests: {},
  _styleInjected: false,

  enabled: function () {
    return DCP.config.get('demoSessionSync') !== false;
  },

  pageWin: function () {
    return (typeof pageWindow === 'function') ? pageWindow() : window;
  },

  ensureTabId: function () {
    if (this._tabId) return this._tabId;
    var id = '';
    try { id = this.pageWin().sessionStorage.getItem(this.TAB_KEY) || ''; } catch (e) {}
    if (!id) id = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    this._tabId = id;
    try { this.pageWin().sessionStorage.setItem(this.TAB_KEY, id); } catch (e) {}
    return id;
  },

  /* ---------- 标签间通信 ---------- */
  connect: function () {
    if (this._channel || this._useStorage) return;
    this.ensureTabId();
    var Win = this.pageWin(), self = this;
    try {
      if (typeof Win.BroadcastChannel === 'function') {
        this._channel = new Win.BroadcastChannel(this.CHANNEL);
        this._channel.onmessage = function (e) { self.onMessage(e && e.data); };
        return;
      }
    } catch (e) {}
    this._useStorage = true;
    this._onStorage = function (e) {
      if (e.key !== self.LS_KEY || !e.newValue) return;
      try { self.onMessage(JSON.parse(e.newValue)); } catch (err) {}
    };
    try { Win.addEventListener('storage', this._onStorage); } catch (e) {}
  },

  disconnect: function () {
    if (this._channel) {
      try { this._channel.close(); } catch (e) {}
      this._channel = null;
    }
    if (this._useStorage && this._onStorage) {
      try { this.pageWin().removeEventListener('storage', this._onStorage); } catch (e) {}
    }
    this._useStorage = false;
    this._onStorage = null;
  },

  send: function (msg) {
    if (!this._enabled) return;
    msg = Object.assign({ v: 1, tabId: this._tabId, at: Date.now(), interactionAt: this._lastInteractionAt }, msg || {});
    if (this._channel) {
      try { this._channel.postMessage(msg); } catch (e) {}
      return;
    }
    if (this._useStorage) {
      try { this.pageWin().localStorage.setItem(this.LS_KEY, JSON.stringify(msg)); } catch (e) {}
    }
  },

  onMessage: function (msg) {
    var self = this;
    if (!this._enabled || !msg || msg.v !== 1 || !msg.tabId || msg.tabId === this._tabId) return;
    if (msg.to && msg.to !== this._tabId) return;
    if (['activity', 'presence', 'heartbeat'].indexOf(msg.type) !== -1 && msg.interactionAt) {
      this._remoteInteraction[msg.tabId] = Math.max(this._remoteInteraction[msg.tabId] || 0, msg.interactionAt);
    }
    if (msg.type === 'hello') {
      this.send({
        type: 'presence', to: msg.tabId, activeSid: this._activeSid,
        generating: this.selfGenerating(), done: Object.keys(this._done)
      });
      return;
    }
    if (msg.type === 'presence' || msg.type === 'heartbeat') {
      this.mergeGenerating(msg.generating || [], msg.tabId, msg.at);
      (msg.done || []).forEach(function (sid) {
        if (sid) self._done[sid] = self._done[sid] || { at: msg.at };
      });
      this.renderRows();
      this.tryRestore();
      return;
    }
    if (msg.type === 'activity') {
      this.applyActivity(msg, false);
      return;
    }
    if (msg.type === 'seen') {
      if (msg.sessionId) delete this._done[msg.sessionId];
      this.renderRows();
      return;
    }
    if (msg.type === 'summary') {
      this.applySummary(msg);
      return;
    }
    if (msg.type === 'pins') {
      DCP.emit('sync:pins', Array.isArray(msg.pins) ? msg.pins : []);
      return;
    }
    if (msg.type === 'bye') {
      this.removeTab(msg.tabId);
      this.renderRows();
      this.tryRestore();
    }
  },

  selfGenerating: function () {
    var self = this, out = [];
    Object.keys(this._generating).forEach(function (key) {
      var g = self._generating[key];
      if (g && g.tabId === self._tabId) out.push(g);
    });
    return out;
  },

  mergeGenerating: function (list, tabId, at) {
    var self = this;
    (list || []).forEach(function (g) {
      if (!g || !g.requestId) return;
      g.tabId = tabId;
      g.lastSeen = at || Date.now();
      var key = tabId + ':' + g.requestId;
      var old = self._generating[key];
      if (old && old.sid && !g.sid) g.sid = old.sid;
      self._generating[key] = g;
    });
  },

  removeTab: function (tabId) {
    var self = this;
    Object.keys(this._generating).forEach(function (key) {
      if (self._generating[key] && self._generating[key].tabId === tabId) delete self._generating[key];
    });
  },

  /* ---------- 生成状态 ---------- */
  onActivity: function (p) {
    if (!this._enabled || !p) return;
    this.applyActivity(p, true);
  },

  applyActivity: function (p, local) {
    var self = this;
    var state = p.state || '';
    if (['generating', 'done', 'stopped', 'error'].indexOf(state) === -1) return;
    var tabId = local ? this._tabId : (p.tabId || '');
    var requestId = p.requestId || (local ? 'local_' + Date.now().toString(36) : '');
    if (!tabId || !requestId) return;
    var key = tabId + ':' + requestId;
    var sid = p.sessionId || null;
    if (state === 'generating') {
      var old = this._generating[key];
      if (old && old.sid && !sid) sid = old.sid;
      this._generating[key] = {
        tabId: tabId, requestId: requestId, sid: sid, state: state,
        title: p.title || (old && old.title) || '', at: p.at || Date.now(), lastSeen: p.at || Date.now()
      };
      if (sid) delete this._done[sid];
    } else {
      var prev = this._generating[key];
      if (prev && prev.sid && !sid) sid = prev.sid;
      delete this._generating[key];
      if (state === 'done' && sid) {
        this._done[sid] = { at: p.at || Date.now(), title: p.title || (prev && prev.title) || '', updatedAt: p.updatedAt || 0 };
      }
    }
    if (local) this.send({ type: 'activity', requestId: requestId, sessionId: sid, state: state, title: p.title || '', updatedAt: p.updatedAt || 0 });
    this.renderRows();
    // 完成后把最新标题/排序摘要发给其它标签；IDB 落盘可能比事件晚一拍。
    if (state === 'done' && sid) {
      setTimeout(function () { self.publishSummary(sid); }, 900);
      if (!local) this.scheduleReload(sid);
      this.tryRestore();
    } else if (!local && (state === 'stopped' || state === 'error')) {
      this.tryRestore();
    }
  },

  generatingForSid: function (sid) {
    if (!sid) return [];
    var self = this, out = [];
    Object.keys(this._generating).forEach(function (key) {
      var g = self._generating[key];
      if (g && g.sid === sid) out.push(g);
    });
    return out;
  },

  localGenerating: function () {
    return this.selfGenerating().length > 0;
  },

  expireStale: function () {
    var self = this, now = Date.now(), changed = false;
    Object.keys(this._generating).forEach(function (key) {
      var g = self._generating[key];
      if (!g) return;
      if (g.tabId === self._tabId) { g.lastSeen = now; return; }
      if (now - (g.lastSeen || 0) > self.STALE_MS) { delete self._generating[key]; changed = true; }
    });
    if (changed) { this.renderRows(); this.tryRestore(); }
  },

  /* ---------- 官方端点请求跟踪（桥接请求由 demobridge 直接发事件） ---------- */
  beginNativeRequest: function () {
    if (!this._enabled) return null;
    var search = DCP.modules && DCP.modules.demoSearch;
    var ctx = search && typeof search.beginRequest === 'function' ? search.beginRequest() : null;
    if (!ctx) return null;
    var rec = { ctx: ctx, requestId: ctx.requestId, sid: null };
    this._nativeRequests[ctx.requestId] = rec;
    this.onActivity({ requestId: ctx.requestId, sessionId: null, state: 'generating' });
    var self = this;
    ctx.session.then(function (s) {
      if (!self._nativeRequests[ctx.requestId] || !s || !s.id) return;
      rec.sid = s.id;
      self.onActivity({ requestId: ctx.requestId, sessionId: s.id, state: 'generating', title: s.title || '' });
    }, function () {});
    return rec;
  },

  observeNativeResponse: function (resp, rec) {
    if (!resp || !rec) return resp;
    var self = this, settled = false;
    var finish = function (state) {
      if (settled) return;
      settled = true;
      self.finishNativeRequest(rec, state);
    };
    if (!resp.ok) { finish('error'); return resp; }
    try {
      if (!resp.body || typeof resp.body.getReader !== 'function') { finish('done'); return resp; }
      var reader = resp.clone().body.getReader();
      var dec = new TextDecoder(), buf = '', sawStop = false;
      (async function () {
        try {
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            if (buf.length > 8192) buf = buf.slice(-8192);
            if (/event:\s*message_stop/i.test(buf) || /"type"\s*:\s*"message_stop"/.test(buf)) {
              sawStop = true; finish('done'); break;
            }
            if (/event:\s*error/i.test(buf) || /"type"\s*:\s*"error"/.test(buf)) { finish('error'); break; }
          }
          finish(sawStop ? 'done' : 'stopped');
        } catch (e) {
          finish('stopped');
        } finally {
          try { reader.releaseLock(); } catch (e) {}
        }
      })();
    } catch (e) { finish('stopped'); }
    return resp;
  },

  finishNativeRequest: async function (rec, state) {
    if (!rec || !this._nativeRequests[rec.requestId]) return;
    delete this._nativeRequests[rec.requestId];
    var search = DCP.modules && DCP.modules.demoSearch;
    if (!rec.sid && search && typeof search.refreshRequestSession === 'function') {
      try {
        var s = await search.refreshRequestSession(rec.ctx);
        if (s && s.id) rec.sid = s.id;
      } catch (e) {}
    }
    if (search && typeof search.finishRequest === 'function') search.finishRequest(rec.requestId);
    this.onActivity({ requestId: rec.requestId, sessionId: rec.sid, state: state });
  },

  /* ---------- 侧栏映射与状态节点 ---------- */
  injectStyle: function () {
    if (this._styleInjected) return;
    this._styleInjected = true;
    DCP.bridge.addStyle(
      '.dcp-session-status{position:absolute;top:50%;transform:translateY(-50%);flex:0 0 12px;width:12px;height:16px;margin:0;display:none;' +
      'align-items:center;justify-content:center;pointer-events:none;color:var(--dcp-accent,#3b6cf6)}' +
      '.dcp-session-status[data-state="generating"],.dcp-session-status[data-state="done"]{display:inline-flex}' +
      '.dcp-session-status::before{content:"";display:block;box-sizing:border-box}' +
      '.dcp-session-status[data-state="generating"]::before{width:11px;height:11px;border-radius:50%;' +
      'border:1.5px solid currentColor;border-right-color:transparent;animation:dcp-session-spin .75s linear infinite}' +
      '.dcp-session-status[data-state="done"]::before{width:6px;height:6px;border-radius:50%;background:currentColor}' +
      '@keyframes dcp-session-spin{to{transform:rotate(360deg)}}' +
      '@media (prefers-reduced-motion:reduce){.dcp-session-status[data-state="generating"]::before{animation-duration:1.8s}}'
    );
  },

  refreshRows: function () {
    if (!this._enabled) return;
    var self = this;
    if (this._rowTimer) return;
    this._rowTimer = setTimeout(function () {
      self._rowTimer = null;
      var token = ++self._rowToken;
      var search = DCP.modules && DCP.modules.demoSearch;
      if (!search || typeof search.sidebarRowsWithIds !== 'function') return;
      search.sidebarRowsWithIds().then(function (entries) {
        if (token !== self._rowToken || !self._enabled) return;
        self.renderRows(entries);
      }, function () {});
    }, 80);
  },

  // 状态点紧贴标题文字右侧，而不是被 flex:1 的标题容器推到最右边。
  // 标题过长时限制在操作按钮左侧，避免和“更多”按钮重叠。
  placeStatus: function (row, el) {
    if (!row || !el) return;
    var title = row.querySelector('.title-ff6fc9') || row.querySelector('.dcp-pinned-title');
    if (!title) { el.style.left = ''; return; }
    var rr = row.getBoundingClientRect();
    var tr = title.getBoundingClientRect();
    var textRight = tr.right;
    try {
      var range = document.createRange();
      range.selectNodeContents(title);
      var rects = range.getClientRects();
      if (rects.length) textRight = rects[rects.length - 1].right;
      else textRight = range.getBoundingClientRect().right || textRight;
    } catch (e) {}
    textRight = Math.min(textRight || tr.right, tr.right);
    var left = textRight - rr.left + 6;
    var action = row.querySelector('[class*="action-"]') || row.querySelector('.dcp-pinned-unpin');
    if (action) {
      var ar = action.getBoundingClientRect();
      if (ar.width > 0) left = Math.min(left, ar.left - rr.left - 18);
    }
    el.style.left = Math.max(0, left) + 'px';
  },

  repositionStatuses: function () {
    var nodes = document.querySelectorAll('.dcp-session-status');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      this.placeStatus(el.closest('.item-ff6fc9, .dcp-pinned-row'), el);
    }
  },

  renderRows: function (entries) {
    if (!this._enabled) return;
    var self = this, SEL = DCP.SEL || {};
    if (!entries) entries = SEL.sidebarItem ? Array.prototype.slice.call(document.querySelectorAll(SEL.sidebarItem)).map(function (row) {
      return { row: row, sid: row.__dcpSessionId || row.getAttribute('data-dcp-session-id') || null };
    }) : [];
    entries.forEach(function (e) {
      var row = e.row, sid = e.sid;
      var old = row.querySelector(':scope > .dcp-session-status');
      var state = sid && self.generatingForSid(sid).length ? 'generating' : (sid && self._done[sid] ? 'done' : '');
      if (!state) {
        if (old) old.remove();
        return;
      }
      var el = old;
      if (!el) {
        el = document.createElement('span');
        el.className = 'dcp-session-status';
        el.setAttribute('role', 'status');
        var action = row.querySelector('[class*="action-"]');
        row.insertBefore(el, action || null);
      }
      if (el.getAttribute('data-state') !== state) {
        el.setAttribute('data-state', state);
        el.title = DCP.t(state === 'generating' ? '正在生成' : '生成完毕');
        el.setAttribute('aria-label', el.title);
      }
      self.placeStatus(row, el);
    });
  },

  bindDom: function () {
    if (this._observer) return;
    var self = this;
    this._observer = new MutationObserver(function () { self.refreshRows(); });
    this._observer.observe(document.body, { childList: true, subtree: true });
    this._onRowClick = function (e) {
      var row = e.target && e.target.closest ? e.target.closest((DCP.SEL || {}).sidebarItem || '.item-ff6fc9') : null;
      if (!row) return;
      var sid = row.__dcpSessionId || row.getAttribute('data-dcp-session-id');
      if (sid) self.markSeen(sid);
      else self.refreshRows();
    };
    this._onPageHide = function () { self.bye(); };
    this._onInteraction = function () { self._lastInteractionAt = Date.now(); };
    this._onFocus = function () { self._lastInteractionAt = Date.now(); };
    this._onBlur = function () { self._seenBlur = true; };
    this._onResize = function () { self.repositionStatuses(); };
    document.addEventListener('click', this._onRowClick, true);
    document.addEventListener('pointerdown', this._onInteraction, true);
    document.addEventListener('keydown', this._onInteraction, true);
    document.addEventListener('input', this._onInteraction, true);
    this.pageWin().addEventListener('focus', this._onFocus);
    this.pageWin().addEventListener('blur', this._onBlur);
    this.pageWin().addEventListener('resize', this._onResize);
    this.pageWin().addEventListener('pagehide', this._onPageHide);
  },

  markSeen: function (sid) {
    if (!sid || !this._done[sid]) return;
    delete this._done[sid];
    this.send({ type: 'seen', sessionId: sid });
    this.renderRows();
  },

  /* ---------- 标题/摘要 ---------- */
  publishSummary: function (sid) {
    if (!this._enabled || !sid) return;
    var self = this, search = DCP.modules && DCP.modules.demoSearch;
    if (!search || typeof search.readSummaries !== 'function') return;
    search.readSummaries().then(function (list) {
      var s = (list || []).find(function (x) { return x.id === sid; });
      if (!s) return;
      self._summaries = list || [];
      self.send({ type: 'summary', sessionId: sid, title: s.title || '', updatedAt: s.updatedAt || 0 });
      self.applySummary({ sessionId: sid, title: s.title || '', updatedAt: s.updatedAt || 0 });
    }, function () {});
  },

  applySummary: function (msg) {
    var sid = msg.sessionId, title = msg.title || '', updatedAt = msg.updatedAt || 0;
    if (!sid) return;
    var s = this._summaries.find(function (x) { return x.id === sid; });
    if (s) { s.title = title; s.updatedAt = updatedAt; }
    var SEL = DCP.SEL || {};
    var rows = SEL.sidebarItem ? document.querySelectorAll(SEL.sidebarItem) : [];
    Array.prototype.forEach.call(rows, function (row) {
      if ((row.__dcpSessionId || row.getAttribute('data-dcp-session-id')) !== sid) return;
      var el = SEL.sidebarItemTitle ? row.querySelector(SEL.sidebarItemTitle) : null;
      if (el) {
        var next = this.normalizeTitle(title);
        if ((el.textContent || '').trim() !== next) el.textContent = next;
      }
    }, this);
  },

  normalizeTitle: function (s) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s || DCP.t('新对话');
  },

  /* ---------- 刷新恢复与后台正文同步 ---------- */
  hasUnfinished: function (session) {
    var search = DCP.modules && DCP.modules.demoSearch;
    if (!session || !search || typeof search.chain !== 'function') return false;
    return search.chain(session).some(function (m) {
      return m && m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming');
    });
  },

  tryRestore: function () {
    if (!this._enabled || this._restoreStarted || !this._pendingRestore) return;
    var sid = this._pendingRestore;
    if (this.generatingForSid(sid).length) return;
    if (this._restoreTimer) return;
    var self = this;
    this._restoreTimer = setTimeout(async function () {
      self._restoreTimer = null;
      if (!self._enabled || self._restoreStarted || self._pendingRestore !== sid) return;
      if (self.generatingForSid(sid).length) return;
      var search = DCP.modules && DCP.modules.demoSearch;
      var session = search && typeof search.readSession === 'function' ? await search.readSession(sid) : null;
      if (!session) { self._pendingRestore = null; return; }
      // 没有其它标签报告生成时，pending/streaming 是刷新留下的旧状态，可以打开；
      // 有远端生成中则继续等，避免官网加载器把它误改成 stopped。
      if (self.hasUnfinished(session) && Date.now() - (self._bootAt || 0) < self.RESTORE_GRACE_MS) {
        self._restoreTimer = setTimeout(function () { self.tryRestore(); }, self.RESTORE_GRACE_MS);
        return;
      }
      await self.openSessionById(sid);
      if (!self._restoreStarted && self._pendingRestore === sid) {
        self._restoreAttempts = (self._restoreAttempts || 0) + 1;
        if (self._restoreAttempts < 6) {
          self._restoreTimer = setTimeout(function () { self.tryRestore(); }, 300);
        } else {
          self._pendingRestore = null;
          self._restoreStarted = true;
        }
      }
    }, 120);
  },

  openSessionById: async function (sid) {
    var SEL = DCP.SEL || {}, self = this;
    var rows = await Utils.waitFor(function () {
      return SEL.sidebarItem && document.querySelector(SEL.sidebarItem);
    }, 15000, 100);
    if (!rows) {
      var expand = Array.prototype.slice.call(document.querySelectorAll('button')).find(function (b) {
        return /展开侧栏|打开边栏/.test(b.getAttribute('aria-label') || '');
      });
      if (expand) {
        Utils.realClick(expand);
        await Utils.waitFor(function () { return SEL.sidebarItem && document.querySelector(SEL.sidebarItem); }, 5000, 100);
      }
    }
    var search = DCP.modules && DCP.modules.demoSearch;
    var entries = search && typeof search.sidebarRowsWithIds === 'function' ? await search.sidebarRowsWithIds() : [];
    var hit = entries.find(function (e) { return e.sid === sid; });
    if (!hit) {
      var session = search && typeof search.readSession === 'function' ? await search.readSession(sid) : null;
      var title = this.normalizeTitle(session && session.title);
      var candidates = entries.filter(function (e) {
        var el = SEL.sidebarItemTitle ? e.row.querySelector(SEL.sidebarItemTitle) : null;
        return self.normalizeTitle((el || e.row).textContent) === title;
      });
      if (candidates.length === 1) hit = candidates[0];
    }
    if (!hit) return false;
    Utils.realClick(hit.row);
    var opened = await Utils.waitFor(function () {
      var active = document.querySelector(SEL.sidebarItemActive);
      return active && (active.__dcpSessionId || active.getAttribute('data-dcp-session-id')) === sid;
    }, 2000, 100);
    if (!opened) return false;
    this._restoreStarted = true;
    this._pendingRestore = null;
    return true;
  },

  isBackground: function () {
    if (document.hidden || !document.hasFocus()) return true;
    // 真实浏览器切标签会触发 blur；一旦见过 blur，focus/hidden 就可信。
    if (this._seenBlur) return !document.hasFocus();
    // 某些内嵌浏览器切标签时始终报 visible/focused，也不触发 blur，只能用
    // 最近一次页面交互做仲裁：刚在别的标签敲字/点击发送的标签更新。
    var self = this, newest = 0;
    Object.keys(this._remoteInteraction).forEach(function (id) {
      newest = Math.max(newest, self._remoteInteraction[id] || 0);
    });
    return newest > this._lastInteractionAt + 500;
  },

  scheduleReload: function (sid) {
    if (!sid || sid !== this._activeSid || this._reloadScheduled[sid]) return;
    if (!this.isBackground()) return;
    if (this.localGenerating() || this.generatingForSid(sid).length) return;
    var ta = document.querySelector((DCP.SEL || {}).textarea || 'textarea');
    if (ta && String(ta.value || '').trim()) return;
    var self = this;
    this._reloadScheduled[sid] = true;
    var timer = setTimeout(async function () {
      var reloading = false;
      try {
        var ok = await self.waitForSessionSettled(sid, 5000);
        if (!ok) return;
        if (self._activeSid !== sid || self.localGenerating() || self.generatingForSid(sid).length) return;
        if (!self.isBackground()) return;
        var ta2 = document.querySelector((DCP.SEL || {}).textarea || 'textarea');
        if (ta2 && String(ta2.value || '').trim()) return;
        try { self.pageWin().sessionStorage.setItem(self.ACTIVE_KEY, sid); } catch (e) {}
        reloading = true;
        location.reload();
      } finally {
        // 已发起重载时保留标记到页面卸载，防止重复完成事件再排一次。
        if (!reloading) {
          delete self._reloadScheduled[sid];
          delete self._reloadTimers[sid];
        }
      }
    }, 500);
    this._reloadTimers[sid] = timer;
  },

  waitForSessionSettled: function (sid, timeout) {
    var self = this, start = Date.now();
    return new Promise(function (resolve) {
      (async function tick() {
        var search = DCP.modules && DCP.modules.demoSearch;
        var session = search && typeof search.readSession === 'function' ? await search.readSession(sid) : null;
        if (session) {
          var chain = search.chain(session);
          var last = chain.slice().reverse().find(function (m) { return m && m.role === 'assistant'; });
          if (last && last.status === 'done') return resolve(true);
        }
        if (Date.now() - start >= timeout) return resolve(false);
        setTimeout(tick, 250);
      })();
    });
  },

  readActiveSid: function () {
    try { return this.pageWin().sessionStorage.getItem(this.ACTIVE_KEY) || ''; } catch (e) { return ''; }
  },

  restoreOnce: function () {
    if (this._restoreStarted || this._pendingRestore) return;
    var sid = this._bootActiveSid || this.readActiveSid();
    this._bootActiveSid = '';
    if (!sid) return;
    // 先消费标记：无论恢复成功与否，本次加载只尝试一次。
    try { this.pageWin().sessionStorage.removeItem(this.ACTIVE_KEY); } catch (e) {}
    this._pendingRestore = sid;
    this._restoreAttempts = 0;
    this.tryRestore();
  },

  bye: function () {
    if (!this._enabled) return;
    this.send({ type: 'bye' });
  },

  /* ---------- 启停 ---------- */
  bootOnce: function () {
    if (this._bootPromise) return this._bootPromise;
    this._bootPromise = (async () => {
      if (!this.enabled()) return;
      this._enabled = true;
      this._booted = true;
      this._bootAt = Date.now();
      this.injectStyle();
      this.connect();
      this.bindDom();
      var search = DCP.modules && DCP.modules.demoSearch;
      if (search && typeof search.readSummaries === 'function') {
        try { this._summaries = await search.readSummaries(); } catch (e) {}
      }
      this.refreshRows();
      this.send({ type: 'hello', activeSid: this._activeSid });
      this.restoreOnce();
      this._heartbeat = setInterval(function () {
        if (!this._enabled) return;
        this.expireStale();
        if (this.selfGenerating().length) this.send({ type: 'heartbeat', generating: this.selfGenerating() });
      }.bind(this), this.HEARTBEAT_MS);
    })();
    return this._bootPromise;
  },

  disable: function () {
    this._enabled = false;
    this.disconnect();
    if (this._observer) { try { this._observer.disconnect(); } catch (e) {} this._observer = null; }
    if (this._onRowClick) { document.removeEventListener('click', this._onRowClick, true); this._onRowClick = null; }
    if (this._onPageHide) { try { this.pageWin().removeEventListener('pagehide', this._onPageHide); } catch (e) {} this._onPageHide = null; }
    if (this._onFocus) { try { this.pageWin().removeEventListener('focus', this._onFocus); } catch (e) {} this._onFocus = null; }
    if (this._onBlur) { try { this.pageWin().removeEventListener('blur', this._onBlur); } catch (e) {} this._onBlur = null; }
    if (this._onResize) { try { this.pageWin().removeEventListener('resize', this._onResize); } catch (e) {} this._onResize = null; }
    if (this._onInteraction) {
      document.removeEventListener('pointerdown', this._onInteraction, true);
      document.removeEventListener('keydown', this._onInteraction, true);
      document.removeEventListener('input', this._onInteraction, true);
      this._onInteraction = null;
    }
    if (this._rowTimer) { clearTimeout(this._rowTimer); this._rowTimer = null; }
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
    var self = this;
    Object.keys(this._reloadTimers).forEach(function (sid) {
      clearTimeout(self._reloadTimers[sid]);
      delete self._reloadTimers[sid];
      delete self._reloadScheduled[sid];
    });
    Object.keys(this._nativeRequests).forEach(function (id) {
      var search = DCP.modules && DCP.modules.demoSearch;
      if (search && typeof search.finishRequest === 'function') search.finishRequest(id);
      delete self._nativeRequests[id];
    });
    this._generating = {};
    this._done = {};
    var SEL = DCP.SEL || {};
    var rows = SEL.sidebarItem ? document.querySelectorAll(SEL.sidebarItem) : [];
    Array.prototype.forEach.call(rows, function (row) {
      var el = row.querySelector(':scope > .dcp-session-status');
      if (el) el.remove();
    });
  },

  init: function () {
    var self = this;
    // ctxRing 的首次 syncSession 可能先发出 null 并清掉存储；在监听事件之前
    // 先把本次加载要恢复的会话 ID 捕获下来。
    this._bootActiveSid = this.readActiveSid();
    Utils.onReady(function () { self.bootOnce(); });
    DCP.on('session:activity', function (p) { self.onActivity(p); });
    DCP.on('session:change', function (e) {
      self._activeSid = (e && e.sessionId) || null;
      try {
        if (self._activeSid) self.pageWin().sessionStorage.setItem(self.ACTIVE_KEY, self._activeSid);
        else self.pageWin().sessionStorage.removeItem(self.ACTIVE_KEY);
      } catch (err) {}
      self.renderRows();
    });
    DCP.on('cfg:change', function (e) {
      if (!e || e.path !== 'demoSessionSync') return;
      if (e.value === false) self.disable();
      else if (!self._enabled) {
        // 配置里重新打开：复用已有事件订阅，只重建通信与 DOM 观察器。
        self._bootPromise = null;
        self.bootOnce();
      }
    });
  }
};
DCP.modules.sessionSync = SessionSync;
