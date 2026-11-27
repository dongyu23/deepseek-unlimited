/* ============================================================
 * modules/editcaret：编辑已发送消息时把光标放到句末
 *
 * 只修正“已连接且当前聚焦”的编辑框。用户把焦点移出编辑框、指针交互或
 * 输入时，文档级监听立即取消，后续定时器不会再抢焦点。
 * ============================================================ */
var EditCaret = {
  _target: null,
  _doc: null,
  _timers: [],
  _listeners: [],
  _observer: null,

  selector: function () {
    return (DCP.SEL || {}).msgEditor || 'textarea[aria-label="编辑消息"], textarea[aria-label="Edit message"]';
  },

  find: function (node) {
    if (!node) return null;
    var selector = this.selector();
    if (node.nodeType === 1 && node.matches && node.matches(selector)) return node;
    return DCP.qs ? DCP.qs(selector, node) : (node.querySelector ? node.querySelector(selector) : null);
  },

  moveToEnd: function (el, focus) {
    if (!el || !el.isConnected) return false;
    var doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (focus !== false) {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }
    if (doc && doc.activeElement !== el) return false;
    try {
      var end = String(el.value || '').length;
      el.setSelectionRange(end, end);
      return true;
    } catch (e) {
      return false;
    }
  },

  cleanup: function () {
    this._timers.forEach(function (timer) { clearTimeout(timer); });
    this._timers = [];
    this._listeners.forEach(function (item) {
      try { item.el.removeEventListener(item.type, item.fn, true); } catch (e) {}
    });
    this._listeners = [];
    this._target = null;
    this._doc = null;
  },

  arm: function (el) {
    if (!el || !el.isConnected) return;
    if (this._target === el) return;
    this.cleanup();
    var self = this;
    var doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    this._target = el;
    this._doc = doc;
    var cancel = function () { self.cleanup(); };
    var onFocusIn = function (e) {
      if (!e || e.target === el) return;
      self.cleanup();
    };
    var onEditorFocus = function (e) {
      if (!e || e.target !== el || self._target !== el) return;
      self.apply();
    };
    ['pointerdown', 'keydown', 'beforeinput'].forEach(function (type) {
      el.addEventListener(type, cancel, true);
      self._listeners.push({ el: el, type: type, fn: cancel });
      if (doc && doc.addEventListener) {
        doc.addEventListener(type, cancel, true);
        self._listeners.push({ el: doc, type: type, fn: cancel });
      }
    });
    if (doc && doc.addEventListener) {
      doc.addEventListener('focusin', onFocusIn, true);
      doc.addEventListener('focusin', onEditorFocus, true);
      self._listeners.push({ el: doc, type: 'focusin', fn: onFocusIn });
      self._listeners.push({ el: doc, type: 'focusin', fn: onEditorFocus });
    }
    var apply = function () { self.apply(); };
    requestAnimationFrame(function () { requestAnimationFrame(apply); });
    this._timers.push(setTimeout(apply, 80));
    this._timers.push(setTimeout(function () {
      apply();
      self.cleanup();
    }, 180));
  },

  apply: function () {
    var el = this._target;
    if (!el || this._target !== el || !el.isConnected) return;
    var doc = this._doc || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (doc && doc.activeElement !== el) return;
    this.moveToEnd(el, false);
  },

  scan: function (root) {
    var el = this.find(root || document);
    if (el) this.arm(el);
  },

  init: function () {
    if (this._inited) return;
    this._inited = true;
    var self = this;
    Utils.onReady(function () {
      self.scan(document);
      if (UI.observeRelevant) {
        self._observer = UI.observeRelevant(document.body, function (records) {
          for (var i = 0; i < records.length; i++) {
            var added = records[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var el = self.find(added[j]);
              if (el) { self.arm(el); return; }
            }
          }
        }, { childList: true, subtree: true });
      }
    });
  },

  destroy: function () {
    if (this._observer) this._observer.disconnect();
    this._observer = null;
    this.cleanup();
  }
};
DCP.modules.editCaret = EditCaret;
