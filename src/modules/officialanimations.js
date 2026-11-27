/* ============================================================
 * modules/officialanimations：补齐官网交互动效
 *
 *  - 侧栏展开/收起：300ms 宽度过渡，cubic-bezier(0.4,0,0.2,1)
 *  - 弹窗/菜单：100ms 淡入 + 缩放，cubic-bezier(0.4,0,1,1)
 *
 * 侧栏原生节点会被 React 直接移除，所以收起时先播放动画，再触发官网
 * 点击；展开时先让官网生成节点，再把它从 0 宽动画到实际宽度。只改临时
 * 内联样式，不移动、不删除、不克隆官网节点。
 * ============================================================ */
var OfficialAnimations = {
  SIDEBAR_MS: 300,
  POP_MS: 100,
  EASE: 'cubic-bezier(0.4, 0, 0.2, 1)',
  POP_EASE: 'cubic-bezier(0.4, 0, 1, 1)',
  EXPAND_CLASS: 'dcp-sidebar-expanding',
  _busy: false,
  _skip: false,
  _animating: false,
  _raf: 0,
  _observer: null,
  _styleInjected: false,

  reduced: function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  },

  sidebar: function () {
    return DCP.qs('sidebarRoot');
  },

  nativeClick: function (btn) {
    this._skip = true;
    try { Utils.realClick(btn); } finally { this._skip = false; }
  },

  onClick: async function (e) {
    if (this._skip || !e.target || !e.target.closest) return;
    var btn = e.target.closest('button');
    if (!btn) return;
    var collapse = UI.matchesLabel(btn, ['收起边栏', 'Collapse sidebar'], true);
    var expand = UI.matchesLabel(btn, ['展开侧栏', '打开边栏', 'Expand sidebar', 'Open sidebar'], true);
    if (!collapse && !expand) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (this._busy) return;
    this._busy = true;
    try {
      if (collapse) await this.collapse(btn);
      else await this.expand(btn);
    } catch (err) {
    } finally {
      this._busy = false;
    }
  },

  injectStyle: function () {
    if (this._styleInjected) return;
    this._styleInjected = true;
    // 官网以并发渲染插入侧栏时，先在样式层把它锁在 0 宽且不可见，避免
    // 动画代码拿到节点前先绘制一帧完整侧栏（展开闪烁的根因）。
    DCP.bridge.addStyle(
      '.dcp-sidebar-expanding [class*="sider-"]{visibility:hidden!important;width:0!important;' +
      'min-width:0!important;max-width:0!important;padding:0!important;border:0!important;flex:0 0 0!important}'
    );
  },

  capture: function (sider) {
    var cs = getComputedStyle(sider);
    return {
      width: sider.style.width, minWidth: sider.style.minWidth, maxWidth: sider.style.maxWidth,
      flex: sider.style.flex, overflow: sider.style.overflow, boxSizing: sider.style.boxSizing,
      paddingLeft: sider.style.paddingLeft, paddingRight: sider.style.paddingRight,
      computedPaddingLeft: cs.paddingLeft, computedPaddingRight: cs.paddingRight,
      borderRightWidth: sider.style.borderRightWidth, computedBorderRightWidth: cs.borderRightWidth
    };
  },

  applyWidth: function (sider, width) {
    sider.style.flex = '0 0 auto';
    sider.style.overflow = 'hidden';
    sider.style.boxSizing = 'border-box';
    sider.style.width = width + 'px';
    sider.style.minWidth = width + 'px';
    sider.style.maxWidth = width + 'px';
    if (width === 0) {
      sider.style.paddingLeft = '0px';
      sider.style.paddingRight = '0px';
      sider.style.borderRightWidth = '0px';
    }
  },

  prepare: function (sider, width) {
    var old = this.capture(sider);
    this.applyWidth(sider, width);
    return old;
  },

  waitForSidebar: function () {
    var selector = 'sidebarRoot';
    var now = DCP.qs(selector);
    if (now) return Promise.resolve(now);
    return UI.waitFor(function () { return DCP.qs(selector); }, { timeout: 900, interval: 50 });
  },

  restore: function (sider, old) {
    if (!sider || !old) return;
    sider.style.width = old.width;
    sider.style.minWidth = old.minWidth;
    sider.style.maxWidth = old.maxWidth;
    sider.style.flex = old.flex;
    sider.style.overflow = old.overflow;
    sider.style.boxSizing = old.boxSizing;
    sider.style.paddingLeft = old.paddingLeft;
    sider.style.paddingRight = old.paddingRight;
    sider.style.borderRightWidth = old.borderRightWidth;
  },

  content: function (sider) {
    return Array.prototype.slice.call(sider.children).filter(function (el) {
      return el && el.nodeType === 1 && !el.classList.contains('dcp-pinned-section');
    });
  },

  fadeContent: function (sider, from, to, duration) {
    var nodes = this.content(sider);
    if (!nodes.length || typeof nodes[0].animate !== 'function') return [];
    return nodes.map(function (el) {
      return el.animate([
        { opacity: from, transform: from === 1 ? 'translateX(0)' : 'translateX(-8px)' },
        { opacity: to, transform: to === 1 ? 'translateX(0)' : 'translateX(-8px)' }
      ], { duration: duration, easing: OfficialAnimations.EASE, fill: 'forwards' });
    });
  },

  startGeometry: function () {
    if (this._animating) return;
    this._animating = true;
    var self = this;
    var step = Utils.rafThrottle(function () {
      var pin = DCP.modules && DCP.modules.sessionPin;
      if (pin && pin._section && typeof pin.updateGeometry === 'function') pin.updateGeometry();
      var sync = DCP.modules && DCP.modules.sessionSync;
      if (sync && typeof sync.repositionStatuses === 'function') sync.repositionStatuses();
    });
    var loop = function () {
      if (!self._animating) return;
      step();
      self._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  },

  stopGeometry: function () {
    this._animating = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    var pin = DCP.modules && DCP.modules.sessionPin;
    if (pin && pin._section && typeof pin.updateGeometry === 'function') pin.updateGeometry();
    var sync = DCP.modules && DCP.modules.sessionSync;
    if (sync && typeof sync.repositionStatuses === 'function') sync.repositionStatuses();
  },

  collapse: async function (btn) {
    var sider = this.sidebar();
    if (!sider || typeof sider.animate !== 'function') { this.nativeClick(btn); return; }
    var from = sider.getBoundingClientRect().width;
    if (from <= 1) { this.nativeClick(btn); return; }
    var duration = this.reduced() ? 1 : this.SIDEBAR_MS;
    var old = this.prepare(sider, from);
    var anim = sider.animate([
      { width: from + 'px', minWidth: from + 'px', maxWidth: from + 'px', paddingLeft: old.computedPaddingLeft, paddingRight: old.computedPaddingRight, borderRightWidth: old.computedBorderRightWidth },
      { width: '0px', minWidth: '0px', maxWidth: '0px', paddingLeft: '0px', paddingRight: '0px', borderRightWidth: '0px' }
    ], { duration: duration, easing: this.EASE, fill: 'forwards' });
    var fades = this.fadeContent(sider, 1, 0, duration);
    this.startGeometry();
    try { await anim.finished; } catch (e) {}
    // 动画完成后再让 React 正常移除侧栏，避免节点提前消失导致动画截断。
    this.nativeClick(btn);
    if (sider.isConnected) this.restore(sider, old);
    fades.forEach(function (a) { try { a.cancel(); } catch (e) {} });
    this.stopGeometry();
  },

  expand: async function (btn) {
    this.injectStyle();
    var root = document.documentElement;
    var sider = null, old = null, anim = null, fades = [], started = false;
    // 点击前就锁住新节点：React 插入时不允许它先以完整宽度参与布局。
    root.classList.add(this.EXPAND_CLASS);
    try {
      this.nativeClick(btn);
      sider = await this.waitForSidebar();
      if (!sider || typeof sider.animate !== 'function') return;

      // 同一 JS 任务内临时解锁一次，只为量到真实目标宽度和原始盒模型；
      // 随后立即重新锁住并置 0，浏览器没有机会绘制中间态。
      root.classList.remove(this.EXPAND_CLASS);
      var to = sider.getBoundingClientRect().width || 261;
      old = this.capture(sider);
      root.classList.add(this.EXPAND_CLASS);
      this.applyWidth(sider, 0);
      void sider.offsetWidth;
      root.classList.remove(this.EXPAND_CLASS);

      var duration = this.reduced() ? 1 : this.SIDEBAR_MS;
      anim = sider.animate([
        { width: '0px', minWidth: '0px', maxWidth: '0px', paddingLeft: '0px', paddingRight: '0px', borderRightWidth: '0px' },
        { width: to + 'px', minWidth: to + 'px', maxWidth: to + 'px', paddingLeft: old.computedPaddingLeft, paddingRight: old.computedPaddingRight, borderRightWidth: old.computedBorderRightWidth }
      ], { duration: duration, easing: this.EASE, fill: 'forwards' });
      started = true;
      fades = this.fadeContent(sider, 0, 1, duration);
      this.startGeometry();
      try { await anim.finished; } catch (e) {}
      this.restore(sider, old);
      try { anim.cancel(); } catch (e) {}
      fades.forEach(function (a) { try { a.cancel(); } catch (e) {} });
      this.stopGeometry();
    } finally {
      root.classList.remove(this.EXPAND_CLASS);
      if (!started && sider && old && sider.isConnected) this.restore(sider, old);
    }
  },

  pop: function (node) {
    if (!node || UI.isOwned(node) || node.__dcpOfficialMotion || node.classList.contains('dcp-preview-overlay')) return;
    node.__dcpOfficialMotion = true;
    if (this.reduced() || typeof node.animate !== 'function') return;
    var isMenu = node.getAttribute('role') === 'menu';
    var duration = this.POP_MS;
    if (isMenu) node.style.transformOrigin = 'top left';
    node.animate([
      { opacity: 0, transform: isMenu ? 'scale(.96) translateY(-4px)' : 'scale(.98)' },
      { opacity: 1, transform: 'none' }
    ], { duration: duration, easing: this.POP_EASE });
    if (node.getAttribute('role') === 'dialog') {
      var parent = node.parentElement;
      if (parent && (parent.id === 'dcp-search-mask' || /overlay-|ds-modal/.test(parent.className || '')) && typeof parent.animate === 'function') {
        parent.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration, easing: this.POP_EASE });
      }
    }
  },

  scanPop: function (root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches('[role="dialog"], [role="menu"]')) this.pop(root);
    DCP.qsa('[role="dialog"], [role="menu"]', root).forEach(this.pop.bind(this));
  },

  init: function () {
    var self = this;
    Utils.onReady(function () {
      document.addEventListener('click', function (e) { self.onClick(e); }, true);
      self.scanPop(document.body);
      self._observer = UI.observeRelevant(document.body, function (muts) {
        for (var i = 0; i < muts.length; i++) {
          for (var j = 0; j < muts[i].addedNodes.length; j++) self.scanPop(muts[i].addedNodes[j]);
          for (var r = 0; r < muts[i].removedNodes.length; r++) {
            var gone = muts[i].removedNodes[r];
            if (gone && gone.nodeType === 1) delete gone.__dcpOfficialMotion;
          }
        }
      }, { childList: true, subtree: true });
    });
  }
};
DCP.modules.officialAnimations = OfficialAnimations;
