/* ============================================================
 * modules/sessionpin：会话置顶
 *
 * demo 的会话摘要没有 pinned 字段，因此置顶状态保存在脚本配置里。原生
 * 会话行仍留在 React 管理的日期分组中，只把置顶行隐藏；侧栏顶部用独立
 * DOM 渲染一个“置顶”分组。绝不移动/克隆官网行，避免 React removeChild
 * 冲突。点击置顶行时转点原生行，官网事件与 ID 映射保持不变。
 * ============================================================ */
var SessionPin = {
  ICON: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M9.2 1.8h4.9M10.6 1.8v3.4l2.1 2.2H6.2l2.1-2.2V1.8ZM5.4 7.1h8.1M7.2 7.1v3.3c0 1.7-1 2.8-2.4 3.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  _menuRow: null,
  _menuSid: null,
  _applying: false,
  _again: false,
  _observer: null,
  _section: null,
  _rows: {},
  _wrap: null,
  _origPaddingTop: '',

  pins: function () {
    var p = DCP.config.get('demoPinnedSessions');
    return Array.isArray(p) ? p.filter(function (x) { return typeof x === 'string' && x; }) : [];
  },

  broadcast: function (pins) {
    var sync = DCP.modules && DCP.modules.sessionSync;
    if (sync && sync.enabled()) sync.send({ type: 'pins', pins: pins });
  },

  toggle: function (sid) {
    if (!sid) return;
    var pins = this.pins(), at = pins.indexOf(sid);
    if (at >= 0) pins.splice(at, 1);
    else pins.unshift(sid);
    DCP.config.set('demoPinnedSessions', pins);
    this.broadcast(pins);
    this.applyPins();
    Utils.toast(DCP.t(at >= 0 ? '已取消置顶' : '已置顶'), 1500);
  },

  captureRow: function (e) {
    var SEL = DCP.SEL || {};
    var row = e.target && e.target.closest ? e.target.closest(SEL.sidebarItem || '.item-ff6fc9') : null;
    if (!row) return;
    this._menuRow = row;
    this._menuSid = row.__dcpSessionId || row.getAttribute('data-dcp-session-id') || null;
  },

  injectMenu: function () {
    var menus = document.querySelectorAll('[role="menu"]');
    for (var mi = 0; mi < menus.length; mi++) {
      var menu = menus[mi];
      var existing = menu.querySelector('.dcp-pin-item');
      if (existing) {
        var oldSid = existing.getAttribute('data-dcp-sid');
        if (oldSid) this.updateMenuLabel(existing, oldSid);
        continue;
      }
      var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
      var rename = items.find(function (el) { return /重命名/.test(el.textContent || ''); });
      if (!rename) continue;
      var sid = this._menuSid;
      if (!sid && this._menuRow) sid = this._menuRow.__dcpSessionId || this._menuRow.getAttribute('data-dcp-session-id');
      if (!sid) continue;
      var item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.className = rename.className + ' dcp-pin-item';
      item.setAttribute('data-dcp-sid', sid);
      var icon = document.createElement('span');
      var nativeIcon = rename.querySelector('span');
      icon.className = nativeIcon ? nativeIcon.className : '';
      icon.innerHTML = this.ICON;
      item.appendChild(icon);
      item.appendChild(document.createTextNode(this.pins().indexOf(sid) >= 0 ? DCP.t('取消置顶') : DCP.t('置顶')));
      var self = this;
      item.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        self.toggle(sid);
        // 菜单是 React 节点，不能手动 remove；派发一次外部点击/ESC 让官网
        // 自己关闭，避免下次协调时 removeChild 找不到节点。
        setTimeout(function () {
          try { Utils.realClick(document.body); } catch (err) {}
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        }, 0);
      }, true);
      menu.appendChild(item);
    }
  },

  updateMenuLabel: function (item, sid) {
    var label = this.pins().indexOf(sid) >= 0 ? DCP.t('取消置顶') : DCP.t('置顶');
    var textNode = Array.prototype.slice.call(item.childNodes).find(function (n) { return n.nodeType === 3; });
    if (textNode) textNode.nodeValue = label;
    else item.appendChild(document.createTextNode(label));
    item.setAttribute('aria-label', label);
  },

  ensureSection: function () {
    if (this._section && this._section.isConnected) return this._section;
    if (!this._styleInjected) {
      this._styleInjected = true;
      DCP.bridge.addStyle(
        '.dcp-pinned-section{position:fixed;z-index:80;display:none;box-sizing:border-box;max-height:35vh;overflow:auto;' +
        'border-bottom:1px solid rgba(127,127,127,.18);box-shadow:0 8px 20px rgba(0,0,0,.12)}' +
        '.dcp-pinned-row{position:relative;display:flex;align-items:center;gap:6px;min-height:40px;padding:8px 6px 8px 10px;cursor:pointer;' +
        'font-size:14px;line-height:20px;color:inherit;border-radius:8px}' +
        '.dcp-pinned-row:hover{background:rgba(127,127,127,.12)}' +
        '.dcp-pinned-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.dcp-pinned-unpin{flex:0 0 26px;width:26px;height:26px;border:0;border-radius:7px;background:transparent;' +
        'color:inherit;opacity:.55;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}' +
        '.dcp-pinned-unpin:hover{background:rgba(127,127,127,.16);opacity:.9}' +
        '.dcp-pinned-row .dcp-session-status{margin-left:2px}'
      );
    }
    var section = document.createElement('div');
    section.className = 'section-ac14ac dcp-pinned-section';
    var header = document.createElement('div');
    header.className = 'sectionHeader-ac14ac';
    header.textContent = DCP.t('置顶');
    section.appendChild(header);
    document.body.appendChild(section);
    this._section = section;
    return section;
  },

  updateGeometry: function () {
    var SEL = DCP.SEL || {};
    var wrap = document.querySelector('[class*="listWrap-"]') || document.querySelector(SEL.sidebarList && SEL.sidebarList.parentElement);
    if (!wrap) { if (this._section) this._section.style.display = 'none'; return; }
    var r = wrap.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { this._section.style.display = 'none'; return; }
    if (this._wrap !== wrap) {
      this._wrap = wrap;
      this._origPaddingTop = wrap.style.paddingTop || '';
    }
    var sider = document.querySelector('[class*="sider-"]');
    var bg = getComputedStyle(sider || wrap).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(wrap).backgroundColor;
    this._section.style.display = 'block';
    this._section.style.left = r.left + 'px';
    this._section.style.top = r.top + 'px';
    this._section.style.width = r.width + 'px';
    this._section.style.background = bg || '#fff';
    this._section.style.color = getComputedStyle(sider || wrap).color;
    wrap.style.paddingTop = (this._section.offsetHeight + 8) + 'px';
    var sync = DCP.modules && DCP.modules.sessionSync;
    if (sync && sync.repositionStatuses) sync.repositionStatuses();
  },

  clearGeometry: function () {
    if (this._wrap && this._wrap.isConnected) this._wrap.style.paddingTop = this._origPaddingTop || '';
    this._wrap = null;
    if (this._section) {
      this._section.remove();
      this._section = null;
    }
    this._rows = {};
  },

  renderRow: function (sid, summary, nativeRow) {
    var self = this, section = this._section;
    var row = this._rows[sid];
    if (!row) {
      row = document.createElement('div');
      row.className = 'dcp-pinned-row';
      row.setAttribute('data-dcp-sid', sid);
      var title = document.createElement('span');
      title.className = 'dcp-pinned-title';
      row.appendChild(title);
      var status = document.createElement('span');
      status.className = 'dcp-session-status';
      status.setAttribute('role', 'status');
      row.appendChild(status);
      var unpin = document.createElement('button');
      unpin.type = 'button';
      unpin.className = 'dcp-pinned-unpin';
      unpin.title = DCP.t('取消置顶');
      unpin.setAttribute('aria-label', DCP.t('取消置顶'));
      unpin.innerHTML = this.ICON;
      unpin.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation(); self.toggle(sid);
      }, true);
      row.appendChild(unpin);
      row.addEventListener('click', function () {
        var native = row._dcpNativeRow;
        if (native && native.isConnected) Utils.realClick(native);
      });
      this._rows[sid] = row;
    }
    row._dcpNativeRow = nativeRow;
    row.querySelector('.dcp-pinned-title').textContent = this.normalizeTitle(summary && summary.title);
    var sync = DCP.modules && DCP.modules.sessionSync;
    var state = sync && sync.generatingForSid(sid).length ? 'generating' : (sync && sync._done[sid] ? 'done' : '');
    var status = row.querySelector('.dcp-session-status');
    if (state) {
      status.setAttribute('data-state', state);
      status.title = DCP.t(state === 'generating' ? '正在生成' : '生成完毕');
      status.setAttribute('aria-label', status.title);
    } else {
      status.removeAttribute('data-state'); status.removeAttribute('title'); status.removeAttribute('aria-label');
    }
    section.appendChild(row);
  },

  normalizeTitle: function (s) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s || DCP.t('新对话');
  },

  applyPins: async function () {
    if (this._applying) { this._again = true; return; }
    this._applying = true;
    var self = this;
    try {
      do {
        this._again = false;
        var search = DCP.modules && DCP.modules.demoSearch;
        if (!search || typeof search.sidebarRowsWithIds !== 'function') continue;
        var entries = await search.sidebarRowsWithIds();
        var pins = this.pins();

        entries.forEach(function (e) {
          if (!e.row) return;
          if (pins.indexOf(e.sid) !== -1) {
            e.row.__dcpPinHidden = true;
            e.row.style.display = 'none';
          } else if (e.row.__dcpPinHidden) {
            e.row.__dcpPinHidden = false;
            e.row.style.display = '';
          }
        });

        if (!pins.length) { self.clearGeometry(); continue; }
        var section = self.ensureSection();
        var keep = {};
        pins.forEach(function (sid) {
          var hit = entries.find(function (e) { return e.sid === sid; });
          if (!hit) return;
          keep[sid] = true;
          self.renderRow(sid, hit.summary, hit.row);
        });
        Object.keys(self._rows).forEach(function (sid) {
          if (!keep[sid]) { self._rows[sid].remove(); delete self._rows[sid]; }
        });
        self.updateGeometry();
      } while (this._again);
    } catch (e) {
    } finally {
      this._applying = false;
    }
  },

  init: function () {
    var self = this;
    Utils.onReady(function () {
      self.applyPins();
      document.addEventListener('pointerdown', function (e) { self.captureRow(e); }, true);
      document.addEventListener('click', function (e) { self.captureRow(e); }, true);
      document.addEventListener('contextmenu', function (e) { self.captureRow(e); }, true);
      self._observer = new MutationObserver(Utils.throttle(function () {
        self.injectMenu();
        self.applyPins();
      }, 100));
      self._observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', function () { if (self._section) self.updateGeometry(); });
    });
    DCP.on('session:change', function () { self.applyPins(); });
    DCP.on('session:activity', function () { self.applyPins(); });
    DCP.on('sync:pins', function (pins) {
      if (!Array.isArray(pins)) return;
      DCP.config.set('demoPinnedSessions', pins);
      self.applyPins();
    });
    DCP.on('cfg:change', function (e) {
      if (e && e.path === 'demoPinnedSessions') self.applyPins();
    });
  }
};
DCP.modules.sessionPin = SessionPin;
