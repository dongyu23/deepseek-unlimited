/* ============================================================
 * modules/tpsmeter：自定义模型实时输出速率（thinking + 正文）
 *
 * demobridge 按「整个请求」累计输出 token 与生成用时（多轮工具循环不每轮
 * 清零），并通过 tps:start / tps:update / tps:idle 广播。本模块只在输入
 * 工具条上下文环左侧显示纯文本速率；默认关闭，可在高级选项开启。
 *
 * 读数要稳——2026-11-24 实测出三处闪烁，都在这里修：
 *  - 工具条被官方整块重建（切会话/新对话首条消息）后读数跟着消失，只能等
 *    body 上的节流兜底才回来（晚 1~7 帧）；占用环有绑在祖先链上的精确
 *    观察器、同一帧就回来。现在读数跟着占用环的补注一起回来。
 *  - 补回来/切会话时先顶着上一个会话的数字，等会话 id 解析完才换。现在值
 *    只认「当前会话」：离开一刻就清空，不串会话。
 *  - 新对话首条消息：会话 id 在请求进行中才解析出来，session:change 把读数
 *    从「实时」打回空闲态，首 token 一到又跳回「实时」。现在同一个请求仍在
 *    途时保持「实时」。
 * ============================================================ */
var TpsMeter = {
  /* ---------- 状态 ----------
   * _live：在途请求的实时读数；_last：当前会话上一轮的最终读数（空闲时显示
   * 「平均」）。两者必须分开：以前只有一个 _last，新一轮请求刚开始、首个
   * tps:update 还没来时，上一轮的「平均」会顶着「实时」的标签留在屏上
   * （等首 token 的那一秒多，实测） */
  _last: null,
  _live: null,
  _final: null,    // 本次请求收尾时未经平滑的最终值（落库用）
  _active: false,
  _reqId: '',      // 正在显示的那个请求（idle 只认它，别的请求的收尾事件不碰读数）
  _sid: null,      // 读数当前归属的会话

  inject: function () {
    var bar = (DCP.modules.toolbar && DCP.modules.toolbar.find) ? DCP.modules.toolbar.find() : null;
    if (!bar || document.getElementById('dcp-tps-meter')) return;
    var el = document.createElement('div');
    el.id = 'dcp-tps-meter';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'display:none;align-items:center;justify-content:flex-end;height:24px;' +
      'box-sizing:border-box;padding:0 4px;background:transparent;color:inherit;font-size:11px;line-height:1;' +
      'font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto;margin:0 4px 0 0;opacity:.72';
    el.textContent = DCP.t('-- tok/s');

    var ring = document.getElementById('dcp-ctx-ring');
    if (ring && ring.parentElement === bar) {
      bar.insertBefore(el, ring);
    } else {
      var sendBtn = bar.querySelector('[class*="sendButton"]');
      var ref = sendBtn;
      while (ref && ref.parentElement && ref.parentElement !== bar) ref = ref.parentElement;
      if (ref && ref.parentElement === bar) bar.insertBefore(el, ref);
      else bar.appendChild(el);
    }
    return el;
  },

  canShow: function () {
    if (!DCP.config.get('demoCustom')) return false;
    if (!DCP.config.get('demoShowTps')) return false;
    var B = DCP.modules.demoBridge;
    return !!(B && typeof B.active === 'function' && B.active());
  },

  fmt: function (n) {
    n = Number(n) || 0;
    if (n >= 100) return n.toFixed(0);
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  },

  // 当前会话 id 以占用环为准——会话身份是 ctxRing 负责解析的
  currentSid: function () {
    var R = DCP.modules && DCP.modules.ctxRing;
    return (R && R._sessionId) || null;
  },

  savedFor: function (sid) {
    var s = sid && DCP.config.sessions()[sid];
    return (s && s.tps && typeof s.tps.tps === 'number' && s.tps.tps > 0) ? s.tps : null;
  },

  // 事件属于不在当前会话纪元里的请求（用户已切走）→ 整条丢弃
  isCurrent: function (payload) {
    var tracker = DCP.modules && DCP.modules.demoSearch;
    return !(payload && payload.requestId && tracker && typeof tracker.isRequestCurrent === 'function' &&
      !tracker.isRequestCurrent(payload));
  },

  render: function () {
    var el = document.getElementById('dcp-tps-meter') || this.inject();
    if (!el) return;
    var d = this._active ? this._live : this._last;
    el.textContent = d
      ? DCP.t(this._active ? '实时 {n} tok/s' : '平均 {n} tok/s', { n: this.fmt(d.tps) })
      : DCP.t(this._active ? '实时 -- tok/s' : '-- tok/s');
    if (d) {
      el.title = DCP.t('本轮已输出 {tokens} tokens，用时 {sec} 秒（{kind}）', {
        tokens: Math.round(d.tokens || 0),
        sec: (Number(d.elapsed) || 0).toFixed(2),
        kind: d.estimated ? DCP.t('实时估算') : DCP.t('接口 usage 精确值')
      });
    } else {
      el.title = '';
    }
    el.style.display = this.canShow() ? 'inline-flex' : 'none';
    this.stabilize(el);
  },

  // 读数宽度固定：数字在 99.9 ↔ 100 之间变化时位数会变，宽度跟着变会让它
  // 左右抖一下。按最宽的写法量一次最小宽度（等宽数字，其余状态右侧对齐）
  stabilize: function (el) {
    if (this._minW && this._minLang === DCP.i18n.lang()) {
      el.style.minWidth = this._minW + 'px';
      return;
    }
    if (el.style.display === 'none') return;
    var keep = el.textContent, w = 0;
    ['实时', '平均'].forEach(function (label) {
      ['88.88', '888'].forEach(function (n) {
        el.textContent = DCP.t(label + ' {n} tok/s', { n: n });
        w = Math.max(w, el.getBoundingClientRect().width);
      });
    });
    el.textContent = keep;
    this._minW = Math.ceil(w);
    this._minLang = DCP.i18n.lang();
    el.style.minWidth = this._minW + 'px';
  },

  start: function (payload) {
    if (!this.isCurrent(payload)) return;
    this._reqId = payload.requestId || '';
    this._live = null;      // 上一轮的「平均」不能顶着「实时」的标签留在屏上
    this._final = null;
    this._active = true;
    this.render();
  },

  paint: function (data, payload) {
    if (!this.isCurrent(payload)) return;
    if (payload && payload.requestId) this._reqId = payload.requestId;
    if (data && data.tps > 0) this._live = data;
    this._active = true;
    this.render();
  },

  idle: function (payload) {
    if (!this.isCurrent(payload)) return;
    if (this._reqId && payload && payload.requestId && this._reqId !== payload.requestId) return;
    this._active = false;
    this._reqId = '';
    // 最终读数归发起它的那个会话；用户已经切走时只落库、不上屏
    var sameSession = !(payload && payload.sessionId && this._sid && payload.sessionId !== this._sid);
    if (sameSession && this._live && this._live.tps > 0) this._last = this._live;
    this._live = null;
    this.render();
    // 只在请求收尾时持久化一次权威/最终均值，避免 250ms 实时更新把整个
    // 会话表反复序列化并同步写 GM_setValue。
    this.saveLast(payload && payload.sessionId);
  },

  saveLast: function (sid) {
    // 落库的是未经平滑的最终值（tps:update 带 final 的那一条）
    var data = this._final;
    if (!data) return;
    sid = sid || this._sid || (DCP.modules.ctxRing && DCP.modules.ctxRing._sessionId);
    if (!sid) return;
    var all = DCP.config.sessions();
    all[sid] = Object.assign({}, all[sid], { tps: data, savedAt: Date.now() });
    DCP.config.saveSessions();
  },

  // 切到某个会话（含新对话的会话 id 在请求进行中才解析出来）：读数换成该
  // 会话上一轮的最终值。后一种不是用户切会话——同一个请求仍在途时保持
  // 「实时」，否则首 token 到来前读数会先掉回空闲态再跳回来
  restore: function (sid) {
    this._sid = sid || null;
    this._last = this.savedFor(this._sid);
    var tracker = DCP.modules && DCP.modules.demoSearch;
    var inFlight = !!(this._reqId && tracker && typeof tracker.isRequestCurrent === 'function' &&
      tracker.isRequestCurrent({ requestId: this._reqId, sessionId: this._sid }));
    if (!inFlight) {
      this._active = false;
      this._live = null;
      this._reqId = '';
    }
    this.render();
  },

  // 工具条被官方整块重建后读数跟着没了。占用环有精确观察器、同一帧补回；
  // 这里由 ctxRing 补完占用环后发 toolbar:rebuild 带动，一起在同一帧回来，
  // 并直接按当前会话取值（不先闪出上一个会话的数字）
  reattach: function () {
    if (document.getElementById('dcp-tps-meter')) return;
    this.inject();
    this.restore(this._sid);
  },

  init: function () {
    var self = this;
    Utils.onReady(function () {
      self.inject();
      self.restore(self.currentSid());
      DCP.on('tps:start', function (p) { self.start(p); });
      DCP.on('tps:update', function (p) {
        // 收尾那条是未经平滑的精确值，单独留着落库
        if (p && p.final && self.isCurrent(p)) self._final = p;
        self.paint(p, p);
      });
      DCP.on('tps:idle', function (p) { self.idle(p); });
      DCP.on('session:change', function (e) { self.restore(e && e.sessionId); });
      // 点了别的会话：屏上马上要换人，读数先清空，别继续顶着旧会话的数字
      DCP.on('session:leave', function () { self.restore(null); });
      DCP.on('toolbar:rebuild', function () { self.reattach(); });
      DCP.on('cfg:change', function (e) {
        if (e.path === 'demoCustom' || e.path === 'demoEndpoint' || e.path === 'demoBridge' || e.path === 'demoShowTps') {
          self.render();
        }
      });
      // 工具条会随会话切换重建；与上下文环相同，掉了就补回来（兜底：
      // 占位环自己没注上时 ctxRing 的精确观察器没绑，只能走这条节流路径）
      new MutationObserver(Utils.throttle(function () {
        self.reattach();
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  }
};
DCP.modules.tpsMeter = TpsMeter;
