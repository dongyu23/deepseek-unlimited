/* ============================================================
 * modules/sessionpin：会话置顶
 *
 * 原生会话行仍留在 React 管理的日期分组中，只隐藏置顶行；侧栏顶部用独立
 * DOM 渲染“置顶”分组。使用 Map/Set 与 apply token，只写真正变化的 DOM。
 * ============================================================ */
var SessionPin = {
  ICON: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M9.2 1.8h4.9M10.6 1.8v3.4l2.1 2.2H6.2l2.1-2.2V1.8ZM5.4 7.1h8.1M7.2 7.1v3.3c0 1.7-1 2.8-2.4 3.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  _menuRow: null,
  _menuSid: null,
  _applyToken: 0,
  _observer: null,
  _section: null,
  _header: null,
  _rows: new Map(),
  _nativeDisplays: new Map(),
  _wrap: null,
  _origPaddingTop: '',
  _paddingApplied: false,
  _styleInjected: false,

  pins: function () {
    var value = DCP.config.get('demoPinnedSessions');
    var out = [];
    var seen = new Set();
    UI.array(value).forEach(function (sid) {
      if (typeof sid !== 'string' || !sid || seen.has(sid)) return;
      seen.add(sid);
      out.push(sid);
    });
    return out;
  },

  broadcast: function (pins) {
    var sync = DCP.modules && DCP.modules.sessionSync;
    if (sync && sync.enabled && sync.enabled()) sync.send({ type: 'pins', pins: pins });
  },

  toggle: function (sid) {
    if (!sid) return;
    var pins = this.pins();
    var at = pins.indexOf(sid);
    if (at >= 0) pins.splice(at, 1);
    else pins.unshift(sid);
    DCP.config.set('demoPinnedSessions', pins);
    this.broadcast(pins);
    this.applyPins();
    Utils.toast(DCP.t(at >= 0 ? '已取消置顶' : '已置顶'), 1500);
  },

  captureRow: function (e) {
    var target = e && e.target;
    var row = UI.closest(target, 'sidebarItem');
    if (!row && document.activeElement) row = UI.closest(document.activeElement, 'sidebarItem');
    if (!row) {
      this._menuRow = null;
      this._menuSid = null;
      return;
    }
    this._menuRow = row;
    this._menuSid = row.__dcpSessionId || row.getAttribute('data-dcp-session-id') || null;
  },

  currentMenuSid: function () {
    if (this._menuRow && !this._menuRow.isConnected) {
      this._menuRow = null;
      this._menuSid = null;
    }
    if (this._menuRow) {
      var sid = this._menuRow.__dcpSessionId || this._menuRow.getAttribute('data-dcp-session-id');
      if (sid) return sid;
    }
    return this._menuSid || null;
  },

  injectMenu: function () {
    var self = this;
    var sid = this.currentMenuSid();
    UI.qsa('menu').forEach(function (menu) {
      var rename = UI.findByLabels(menu, ['重命名', 'Rename'], 'menuItem', true);
      if (!rename) return;
      var existing = menu.querySelector('.dcp-pin-item');
      if (existing) {
        if (!sid) return;
        existing.__dcpSid = sid;
        UI.setAttributeIfChanged(existing, 'data-dcp-sid', sid);
        self.updateMenuLabel(existing, sid);
        return;
      }
      if (!sid) return;
      var item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.tabIndex = 0;
      item.className = rename.className + ' dcp-pin-item';
      item.__dcpSid = sid;
      UI.markOwned(item);
      UI.setAttributeIfChanged(item, 'data-dcp-sid', sid);
      var icon = document.createElement('span');
      var nativeIcon = rename.querySelector('span');
      icon.className = nativeIcon ? nativeIcon.className : '';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = self.ICON;
      var label = document.createElement('span');
      item.appendChild(icon);
      item.appendChild(label);
      var activate = function (e) {
        e.preventDefault();
        e.stopPropagation();
        var clickedSid = item.__dcpSid;
        if (!clickedSid) return;
        self.toggle(clickedSid);
        setTimeout(function () {
          try { Utils.realClick(document.body); } catch (err) {}
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        }, 0);
      };
      item.addEventListener('click', activate, true);
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') activate(e);
      }, true);
      menu.appendChild(item);
      self.updateMenuLabel(item, sid);
    });
  },

  updateMenuLabel: function (item, sid) {
    if (!item) return;
    var label = this.pins().indexOf(sid) >= 0 ? DCP.t('取消置顶') : DCP.t('置顶');
    var text = item.querySelector('span:last-child');
    if (!text) {
      text = document.createElement('span');
      item.appendChild(text);
    }
    UI.setTextIfChanged(text, label);
    UI.setAttributeIfChanged(item, 'aria-label', label);
  },

  ensureSection: function () {
    if (this._section && this._section.isConnected) return this._section;
    if (!this._styleInjected) {
      this._styleInjected = true;
      DCP.bridge.addStyle(
        '.dcp-pinned-section{position:fixed;z-index:80;display:none;box-sizing:border-box;max-height:35vh;overflow:auto;' +
        'border-bottom:1px solid rgba(127,127,127,.18);box-shadow:0 8px 20px rgba(0,0,0,.12)}' +
        '.dcp-pinned-row{position:relative;display:flex;align-items:center;gap:6px;min-height:40px;padding:8px 6px 8px 10px;' +
        'font-size:14px;line-height:20px;color:inherit;border-radius:8px}' +
        '.dcp-pinned-open{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:0;border:0;background:transparent;' +
        'color:inherit;font:inherit;text-align:left;cursor:pointer}' +
        '.dcp-pinned-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '.dcp-pinned-unpin{flex:0 0 26px;width:26px;height:26px;border:0;border-radius:7px;background:transparent;' +
        'color:inherit;opacity:.55;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}' +
        '.dcp-pinned-unpin:hover{background:rgba(127,127,127,.16);opacity:.9}' +
        '.dcp-pinned-open:focus-visible,.dcp-pinned-unpin:focus-visible{outline:2px solid var(--dcp-accent,#3b6cf6);outline-offset:2px}' +
        '.dcp-pinned-row .dcp-session-status{margin-left:2px}'
      );
    }
    var section = document.createElement('div');
    section.className = 'section-ac14ac dcp-pinned-section';
    section.setAttribute('role', 'region');
    section.setAttribute('aria-label', DCP.t('置顶'));
    UI.markOwned(section);
    var header = document.createElement('div');
    header.className = 'sectionHeader-ac14ac';
    UI.setTextIfChanged(header, DCP.t('置顶'));
    UI.markOwned(header);
    section.appendChild(header);
    document.body.appendChild(section);
    this._section = section;
    this._header = header;
    return section;
  },

  restoreNativePadding: function () {
    if (this._wrap && this._wrap.isConnected && this._paddingApplied) {
      UI.setStyleIfChanged(this._wrap, 'paddingTop', this._origPaddingTop || '');
    }
    this._paddingApplied = false;
  },

  hideSection: function () {
    this.restoreNativePadding();
    if (!this._section) return;
    UI.setAttributeIfChanged(this._section, 'aria-hidden', 'true');
    UI.setStyleIfChanged(this._section, 'display', 'none');
  },

  updateGeometry: function () {
    var section = this._section;
    if (!section || !section.isConnected || !this._rows.size) {
      this.hideSection();
      return;
    }
    var wrap = DCP.qs('sidebarListWrap');
    if (!wrap) {
      this.hideSection();
      return;
    }
    var rect = wrap.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      this.hideSection();
      return;
    }
    if (this._wrap !== wrap) {
      this.restoreNativePadding();
      this._wrap = wrap;
      this._origPaddingTop = wrap.style.paddingTop || '';
    }
    var sider = DCP.qs('sidebarRoot');
    var bg = getComputedStyle(sider || wrap).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = getComputedStyle(wrap).backgroundColor;
    UI.setAttributeIfChanged(section, 'aria-hidden', null);
    UI.setStyleIfChanged(section, 'display', 'block');
    UI.setStyleIfChanged(section, 'left', rect.left + 'px');
    UI.setStyleIfChanged(section, 'top', rect.top + 'px');
    UI.setStyleIfChanged(section, 'width', rect.width + 'px');
    UI.setStyleIfChanged(section, 'background', bg || '#fff');
    UI.setStyleIfChanged(section, 'color', getComputedStyle(sider || wrap).color);
    var padding = (section.offsetHeight + 8) + 'px';
    if (!this._paddingApplied || this._wrap.style.paddingTop !== padding) {
      UI.setStyleIfChanged(this._wrap, 'paddingTop', padding);
      this._paddingApplied = true;
    }
    var sync = DCP.modules && DCP.modules.sessionSync;
    if (sync && sync.repositionStatuses) sync.repositionStatuses();
  },

  clearGeometry: function () {
    this.restoreNativePadding();
    this._wrap = null;
    if (this._section) {
      this._section.remove();
      this._section = null;
      this._header = null;
    }
    this._rows.clear();
    this._nativeDisplays.clear();
  },

  renderRow: function (sid, summary, nativeRow) {
    var self = this;
    var section = this._section;
    if (!section) return null;
    var row = this._rows.get(sid);
    if (!row) {
      row = document.createElement('div');
      row.className = 'dcp-pinned-row';
      UI.markOwned(row);
      UI.setAttributeIfChanged(row, 'data-dcp-sid', sid);
      row.setAttribute('role', 'group');
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'dcp-pinned-open';
      UI.markOwned(open);
      var title = document.createElement('span');
      title.className = 'dcp-pinned-title';
      UI.markOwned(title);
      var status = document.createElement('span');
      status.className = 'dcp-session-status';
      status.setAttribute('role', 'status');
      UI.markOwned(status);
      open.appendChild(title);
      open.appendChild(status);
      var unpin = document.createElement('button');
      unpin.type = 'button';
      unpin.className = 'dcp-pinned-unpin';
      unpin.title = DCP.t('取消置顶');
      unpin.setAttribute('aria-label', DCP.t('取消置顶'));
      unpin.innerHTML = this.ICON;
      UI.markOwned(unpin);
      unpin.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        self.toggle(sid);
      }, true);
      open.addEventListener('click', function () {
        var native = row._dcpNativeRow;
        if (native && native.isConnected) Utils.realClick(native);
      });
      row.appendChild(open);
      row.appendChild(unpin);
      row._dcpOpen = open;
      row._dcpTitle = title;
      row._dcpStatus = status;
      row._dcpUnpin = unpin;
      this._rows.set(sid, row);
      section.appendChild(row);
    }
    if (row._dcpNativeRow !== nativeRow) row._dcpNativeRow = nativeRow;
    var titleText = this.normalizeTitle(summary && summary.title);
    UI.setTextIfChanged(row._dcpTitle, titleText);
    UI.setAttributeIfChanged(row._dcpOpen, 'aria-label', titleText);
    var sync = DCP.modules && DCP.modules.sessionSync;
    var done = sync && sync._done && UI.own(sync._done, sid);
    var state = sync && sync.generatingForSid && sync.generatingForSid(sid).length ? 'generating' : (done ? 'done' : '');
    var status = row._dcpStatus;
    UI.setAttributeIfChanged(status, 'data-state', state || null);
    if (state) {
      var statusLabel = DCP.t(state === 'generating' ? '正在生成' : '生成完毕');
      UI.setAttributeIfChanged(status, 'title', statusLabel);
      UI.setAttributeIfChanged(status, 'aria-label', statusLabel);
    } else {
      UI.setAttributeIfChanged(status, 'title', null);
      UI.setAttributeIfChanged(status, 'aria-label', null);
    }
    return row;
  },

  reorderRows: function (ordered) {
    var section = this._section;
    if (!section || !this._header) return;
    var desired = [this._header];
    for (var i = 0; i < ordered.length; i++) {
      var row = this._rows.get(ordered[i]);
      if (row) desired.push(row);
    }
    for (var j = 0; j < desired.length; j++) {
      if (section.children[j] !== desired[j]) section.insertBefore(desired[j], section.children[j] || null);
    }
  },

  normalizeTitle: function (s) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s || DCP.t('新对话');
  },

  applyPins: async function () {
    var token = ++this._applyToken;
    var epoch = UI.sessionEpoch();
    var self = this;
    try {
      var search = DCP.modules && DCP.modules.demoSearch;
      if (!search || typeof search.sidebarRowsWithIds !== 'function') return false;
      var entries = await search.sidebarRowsWithIds();
      if (token !== this._applyToken || epoch !== UI.sessionEpoch()) return false;
      var pins = this.pins();
      var pinSet = new Set(pins);
      var bySid = new Map();
      entries.forEach(function (entry) {
        if (!entry || !entry.row) return;
        if (entry.sid && !bySid.has(entry.sid)) bySid.set(entry.sid, entry);
        var shouldHide = !!(entry.sid && pinSet.has(entry.sid));
        if (shouldHide) {
          if (!self._nativeDisplays.has(entry.row)) self._nativeDisplays.set(entry.row, entry.row.style.display || '');
          UI.setStyleIfChanged(entry.row, 'display', 'none');
        } else if (self._nativeDisplays.has(entry.row)) {
          UI.setStyleIfChanged(entry.row, 'display', self._nativeDisplays.get(entry.row));
          self._nativeDisplays.delete(entry.row);
        }
      });
      this._nativeDisplays.forEach(function (display, row) {
        if (!row.isConnected) self._nativeDisplays.delete(row);
      });

      var rendered = [];
      if (pins.length) this.ensureSection();
      pins.forEach(function (sid) {
        var hit = bySid.get(sid);
        if (!hit) return;
        rendered.push(sid);
        self.renderRow(sid, hit.summary, hit.row);
      });
      var keep = new Set(rendered);
      this._rows.forEach(function (row, sid) {
        if (!keep.has(sid)) {
          row.remove();
          self._rows.delete(sid);
        }
      });
      if (!rendered.length) {
        this.hideSection();
        return true;
      }
      this.ensureSection();
      this.reorderRows(rendered);
      this.updateGeometry();
      return true;
    } catch (e) {
      return false;
    }
  },

  init: function () {
    if (this._inited) return;
    this._inited = true;
    var self = this;
    Utils.onReady(function () {
      self.applyPins();
      document.addEventListener('pointerdown', function (e) { self.captureRow(e); }, true);
      document.addEventListener('click', function (e) { self.captureRow(e); }, true);
      document.addEventListener('contextmenu', function (e) { self.captureRow(e); }, true);
      self._observer = UI.observeRelevant(document.body, function () {
        self.injectMenu();
        self.applyPins();
      }, { childList: true, subtree: true });
      window.addEventListener('resize', function () { if (self._section) self.updateGeometry(); });
    });
    DCP.on('session:change', function () { self.applyPins(); });
    DCP.on('session:leave', function () {
      self._menuRow = null;
      self._menuSid = null;
      self.applyPins();
    });
    DCP.on('session:activity', function () { self.applyPins(); });
    DCP.on('sync:pins', function (pins) {
      if (!Array.isArray(pins)) return;
      DCP.config.set('demoPinnedSessions', pins);
      self.applyPins();
    });
    DCP.on('cfg:change', function (e) {
      if (e && e.path === 'demoPinnedSessions') self.applyPins();
    });
  },

  destroy: function () {
    if (this._observer) this._observer.disconnect();
    this._observer = null;
    this._applyToken += 1;
    this.clearGeometry();
  }
};
DCP.modules.sessionPin = SessionPin;
