/* ============================================================
 * core/ui：可取消异步、DOM 幂等写入、观察器与可访问性基础设施
 * ============================================================ */
var UI = {
  _sessionEpoch: 0,
  _sessionSid: '',
  _querySequence: 0,
  _navigationSequence: 0,
  _warned: new Set(),

  /* ---------- 安全集合与字典 ---------- */
  dict: function () {
    return typeof Utils !== 'undefined' && Utils.dict ? Utils.dict() : Object.create(null);
  },
  own: function (object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  },
  array: function (value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    if (typeof value.length === 'number') {
      try { return Array.prototype.slice.call(value); } catch (e) {}
    }
    return [];
  },
  elements: function (value) {
    return this.array(value).filter(function (el) {
      return el && el.nodeType === 1;
    });
  },
  setTextIfChanged: function (el, text) {
    if (!el) return false;
    if (typeof Utils !== 'undefined' && Utils.setTextIfChanged) {
      return Utils.setTextIfChanged(el, text);
    }
    var next = String(text == null ? '' : text);
    if (el.textContent === next) return false;
    el.textContent = next;
    return true;
  },
  setAttributeIfChanged: function (el, name, value) {
    if (!el || !name) return false;
    if (value == null) {
      if (el.hasAttribute && el.hasAttribute(name)) {
        el.removeAttribute(name);
        return true;
      }
      return false;
    }
    var next = String(value);
    if (el.getAttribute && el.getAttribute(name) === next) return false;
    el.setAttribute(name, next);
    return true;
  },
  setStyleIfChanged: function (el, property, value) {
    if (!el || !el.style || !property) return false;
    var next = value == null ? '' : String(value);
    if (el.style[property] === next) return false;
    el.style[property] = next;
    return true;
  },
  appendOnce: function (parent, child, before) {
    if (!parent || !child) return false;
    if (child.parentNode === parent) {
      if (!before || child.nextSibling === before) return false;
    }
    parent.insertBefore(child, before || null);
    return true;
  },
  removeNode: function (el) {
    if (!el) return false;
    if (el.parentNode) {
      el.parentNode.removeChild(el);
      return true;
    }
    if (el.remove) {
      el.remove();
      return true;
    }
    return false;
  },

  /* ---------- 节点所有权 ---------- */
  markOwned: function (el) {
    if (!el || !el.setAttribute) return el;
    this.setAttributeIfChanged(el, 'data-dcp-owned', '');
    return el;
  },
  isOwned: function (node) {
    var current = node;
    while (current) {
      if (current.nodeType === 1 && current.hasAttribute && current.hasAttribute('data-dcp-owned')) return true;
      current = current.parentElement || current.parentNode;
    }
    return false;
  },

  /* ---------- 会话代次与查询令牌 ---------- */
  currentSid: function () {
    if (typeof Utils !== 'undefined' && Utils.currentSid) return Utils.currentSid() || this._sessionSid || '';
    if (typeof location !== 'undefined' && location.pathname) {
      var match = location.pathname.match(/\/a\/chat\/s\/([\w-]+)/);
      if (match) return match[1];
    }
    return this._sessionSid || '';
  },
  sessionEpoch: function () {
    return this._sessionEpoch;
  },
  sessionToken: function () {
    return { epoch: this._sessionEpoch, sid: this.currentSid() };
  },
  isSessionCurrent: function (token) {
    if (token == null) return true;
    var epoch = typeof token === 'object' ? token.epoch : token;
    var sid = typeof token === 'object' ? token.sid : '';
    if (epoch !== this._sessionEpoch) return false;
    return !sid || sid === this.currentSid();
  },
  invalidateSession: function (payload) {
    this._sessionEpoch += 1;
    if (payload && payload.sid != null) this._sessionSid = String(payload.sid);
    else this._sessionSid = this.currentSid();
    try { DCP.emit('ui:session', { epoch: this._sessionEpoch, sid: this.currentSid() }); } catch (e) {}
  },
  createQueryToken: function () {
    this._querySequence += 1;
    return {
      id: this._querySequence,
      epoch: this._sessionEpoch,
      sid: this.currentSid(),
      cancelled: false
    };
  },
  isQueryCurrent: function (token) {
    return !!(token && !token.cancelled && token.epoch === this._sessionEpoch &&
      (!token.sid || token.sid === this.currentSid()));
  },
  invalidateQuery: function (token) {
    if (token) token.cancelled = true;
  },
  stableNavigateToSession: function (sid) {
    if (!sid) return Promise.resolve(false);
    var sync = DCP.modules && DCP.modules.sessionSync;
    if (!sync || typeof sync.openSessionById !== 'function') return Promise.resolve(false);
    var navigation = ++this._navigationSequence;
    return Promise.resolve().then(function () {
      return sync.openSessionById(sid);
    }).then(function (ok) {
      return !!(ok && navigation === UI._navigationSequence);
    }, function () {
      return false;
    });
  },

  /* ---------- 可取消等待与防抖 ---------- */
  abortError: function () {
    try {
      if (typeof DOMException === 'function') return new DOMException('operation aborted', 'AbortError');
    } catch (e) {}
    var error = new Error('operation aborted');
    error.name = 'AbortError';
    return error;
  },
  wait: function (ms, signal) {
    var self = this;
    ms = Math.max(0, Number(ms) || 0);
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(self.abortError());
      var timer = setTimeout(done, ms);
      function cleanup() {
        clearTimeout(timer);
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
      }
      function done() {
        cleanup();
        resolve();
      }
      function onAbort() {
        cleanup();
        reject(self.abortError());
      }
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
    });
  },
  waitFor: function (fn, timeout, interval, signal) {
    if (timeout && typeof timeout === 'object') {
      var options = timeout;
      timeout = options.timeout;
      interval = options.interval;
      signal = options.signal;
    }
    timeout = timeout == null ? 15000 : Math.max(0, Number(timeout) || 0);
    interval = interval == null ? 100 : Math.max(1, Number(interval) || 100);
    var self = this;
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      var timer = null;
      var settled = false;
      function cleanup() {
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
      }
      function finish(value) {
        if (settled) return;
        cleanup();
        resolve(value);
      }
      function fail(error) {
        if (settled) return;
        cleanup();
        reject(error);
      }
      function onAbort() { fail(self.abortError()); }
      function tick() {
        if (settled) return;
        var value = null;
        try { value = fn(); } catch (e) {}
        if (value) return finish(value);
        if (Date.now() - started >= timeout) return finish(null);
        timer = setTimeout(tick, interval);
      }
      if (signal && signal.aborted) return onAbort();
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
      tick();
    });
  },
  debounce: function (fn, delay, options) {
    var timer = null;
    var lastArgs = null;
    var lastThis = null;
    options = options || {};
    function clear() {
      if (timer) clearTimeout(timer);
      timer = null;
      lastArgs = null;
      lastThis = null;
    }
    function invoke() {
      var args = lastArgs || [];
      var context = lastThis;
      clear();
      fn.apply(context, args);
    }
    function wrapped() {
      lastArgs = arguments;
      lastThis = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(invoke, Math.max(0, Number(delay) || 0));
    }
    wrapped.cancel = clear;
    wrapped.flush = function () {
      if (timer) invoke();
    };
    if (options.signal && options.signal.addEventListener) {
      options.signal.addEventListener('abort', clear, { once: true });
    }
    return wrapped;
  },

  /* ---------- MutationObserver ---------- */
  observeRelevant: function (target, callback, options) {
    if (!target || typeof MutationObserver === 'undefined') return null;
    var self = this;
    function relevantRecord(record) {
      if (options && typeof options.filter === 'function' && !options.filter(record)) return false;
      if (record.target && self.isOwned(record.target)) return false;
      if (record.type === 'attributes' || record.type === 'characterData') return true;
      var added = self.array(record.addedNodes);
      var removed = self.array(record.removedNodes);
      for (var i = 0; i < added.length; i++) {
        if (!self.isOwned(added[i])) return true;
      }
      for (var j = 0; j < removed.length; j++) {
        if (!self.isOwned(removed[j])) return true;
      }
      return false;
    }
    var observer = new MutationObserver(function (records) {
      var relevant = self.array(records).filter(relevantRecord);
      if (relevant.length) callback(relevant, observer);
    });
    var observeOptions = {};
    if (options) {
      Object.keys(options).forEach(function (key) {
        if (key !== 'filter') observeOptions[key] = options[key];
      });
    }
    observer.observe(target, observeOptions);
    return observer;
  },

  /* ---------- 焦点管理 ---------- */
  focusableSelector: [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
  ].join(','),
  _focusableVisible: function (el) {
    if (!el || el.disabled) return false;
    if (el.getClientRects && el.getClientRects().length) return true;
    if (typeof el.offsetParent !== 'undefined') return el.offsetParent !== null;
    return true;
  },
  _focusables: function (container) {
    var list = [];
    if (typeof DCP.qsa === 'function') list = DCP.qsa(this.focusableSelector, container);
    else if (container.querySelectorAll) list = this.array(container.querySelectorAll(this.focusableSelector));
    return list.filter(this._focusableVisible);
  },
  trapFocus: function (container, options) {
    if (!container) return function () {};
    options = options || {};
    var self = this;
    var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    var previous = doc && doc.activeElement;
    var released = false;
    function focusElement(el) {
      if (!el) return;
      try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (err) {} }
    }
    function focusFirst() {
      var list = self._focusables(container);
      focusElement(list[0] || container);
    }
    function onKey(event) {
      if (event.key === 'Escape' && typeof options.onEscape === 'function') {
        event.preventDefault();
        options.onEscape(event);
        return;
      }
      if (event.key !== 'Tab') return;
      var list = self._focusables(container);
      if (!list.length) {
        event.preventDefault();
        focusElement(container);
        return;
      }
      var first = list[0];
      var last = list[list.length - 1];
      var active = doc && doc.activeElement;
      var outside = !active || !container.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        focusElement(last);
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        focusElement(first);
      }
    }
    function onFocusIn(event) {
      if (options.contain === false) return;
      if (!container.contains(event.target)) focusFirst();
    }
    if (doc && doc.addEventListener) {
      doc.addEventListener('keydown', onKey, true);
      if (options.contain !== false) doc.addEventListener('focusin', onFocusIn, true);
    }
    if (options.focus !== false) {
      var initial = options.initialFocus || container;
      focusElement(initial);
    }
    return function release() {
      if (released) return;
      released = true;
      if (doc && doc.removeEventListener) {
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('focusin', onFocusIn, true);
      }
      if (options.restoreFocus !== false && previous && previous.isConnected !== false && previous.focus) {
        focusElement(previous);
      }
    };
  },

  /* ---------- 选择器与健康检查 ---------- */
  qs: function (selector, root) {
    return typeof DCP.qs === 'function' ? DCP.qs(selector, root) : null;
  },
  qsa: function (selector, root) {
    if (typeof DCP.qsa === 'function') return DCP.qsa(selector, root);
    return [];
  },
  closest: function (el, selector) {
    return typeof DCP.closest === 'function' ? DCP.closest(el, selector) : null;
  },
  requireSelector: function (key, root) {
    var el = this.qs(key, root);
    if (!el && typeof DCP.warnSelector === 'function') DCP.warnSelector(key, key);
    return el;
  },
  selectorHealth: function (required) {
    return typeof DCP.selectorHealth === 'function' ? DCP.selectorHealth(required) : {};
  },
  checkSelectorHealth: function (required) {
    return typeof DCP.checkSelectorHealth === 'function' ? DCP.checkSelectorHealth(required) : {};
  },

  /* ---------- 原生 label 匹配 ---------- */
  labelValues: function (el) {
    if (!el) return [];
    var values = [el.textContent, el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'), el.getAttribute && el.getAttribute('placeholder')];
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var value = String(values[i] || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (value) out.push(value);
    }
    return out;
  },
  matchesLabel: function (el, labels, exact) {
    var values = this.labelValues(el);
    for (var i = 0; i < values.length; i++) {
      for (var j = 0; j < labels.length; j++) {
        var label = String(labels[j] || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!label) continue;
        if (exact ? values[i] === label : values[i].indexOf(label) !== -1) return true;
      }
    }
    return false;
  },
  findByLabels: function (root, labels, selector, exact) {
    var nodes = selector ? this.qsa(selector, root) : this.elements(root && root.children);
    return nodes.find(function (el) { return UI.matchesLabel(el, labels, exact); }) || null;
  }
};

try {
  DCP.on('session:change', function (payload) { UI.invalidateSession(payload); });
  DCP.on('session:leave', function (payload) {
    UI._navigationSequence += 1;
    UI.invalidateSession(payload);
  });
} catch (e) {}

DCP.ui = UI;
try { DCP.register('ui', UI); } catch (e) {}
