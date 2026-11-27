/* ============================================================
 * bootstrap：IIFE 外壳 + 运行时桥（油猴 / Android WebView 注入通用）
 * ============================================================ */
(function () {
'use strict';

/* ---------- 基础安全工具 ---------- */
function dict() { return Object.create(null); }
function own(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
function blockedKey(key) { return key === '__proto__' || key === 'constructor' || key === 'prototype'; }

// 生产日志只留诊断信息，不输出会话身份、Key 或完整对象。
function redactText(value) {
  return String(value == null ? '' : value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|x-api-key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:session[_-]?id|target[_-]?id|request[_-]?id)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '[REDACTED_ID]')
    .slice(0, 500);
}
function redactLog(value) {
  if (value instanceof Error) return redactText(value.name + ': ' + value.message);
  if (typeof value === 'string') return redactText(value);
  try { return redactText(JSON.stringify(value)); }
  catch (e) { return redactText(String(value)); }
}

/* ---------- 管理器能力探测 ----------
 * GM storage 是隔离存储；localStorage 是页面可读存储，只能存非敏感配置。
 * 如果只检测到半个 GM storage 接口，说明管理器集成不完整，此时不静默
 * 降级到 localStorage，而是退到仅内存存储并明确报告能力缺失。 */
var GM_GET = typeof GM_getValue === 'function';
var GM_SET = typeof GM_setValue === 'function';
var GM_DELETE = typeof GM_deleteValue === 'function';
var GM_LIST = typeof GM_listValues === 'function';
var GM_STYLE = typeof GM_addStyle === 'function';
var HAS_GM = GM_GET && GM_SET;
var GM_PARTIAL = (GM_GET || GM_SET) && !HAS_GM;

var LS_PREFIX = 'dcp_store_';
var LEGACY_LS_KEY = 'dcp_bridge_store';
var legacyStore = dict();
var memoryStore = dict();
var lsAvailable = false;

function readLegacyStore() {
  var raw = null;
  try { raw = localStorage.getItem(LEGACY_LS_KEY); } catch (e) { return; }
  if (!raw) return;
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    Object.keys(parsed).forEach(function (k) {
      if (!blockedKey(k)) legacyStore[k] = parsed[k];
    });
  } catch (e) {}
}
function writeLegacyStore() {
  var keys = Object.keys(legacyStore);
  if (!keys.length) {
    try { localStorage.removeItem(LEGACY_LS_KEY); } catch (e) {}
    return;
  }
  localStorage.setItem(LEGACY_LS_KEY, JSON.stringify(legacyStore));
}
function detectLocalStorage() {
  if (GM_PARTIAL) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    var probe = LS_PREFIX + '__probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    readLegacyStore();
    return true;
  } catch (e) {
    return false;
  }
}
lsAvailable = detectLocalStorage();

var Bridge = {
  capabilities: {
    storage: HAS_GM ? 'manager' : (lsAvailable ? 'page' : 'memory'),
    isolatedStorage: HAS_GM,
    persistentStorage: HAS_GM || lsAvailable,
    delete: HAS_GM ? GM_DELETE : true,
    list: HAS_GM ? GM_LIST : true,
    style: GM_STYLE ? 'manager' : 'dom',
    degraded: GM_PARTIAL || (!HAS_GM && !lsAvailable)
  },
  lastError: null,
  storageKey: function (k) {
    return HAS_GM ? null : LS_PREFIX + encodeURIComponent(String(k));
  },
  _recordError: function (operation, error) {
    this.lastError = { operation: operation, message: redactText(error && error.message || error) };
    try {
      if (typeof DCP !== 'undefined' && DCP.emit) {
        DCP.emit('bridge:error', { operation: operation, message: this.lastError.message });
      }
    } catch (e) {}
    return this.lastError;
  },
  _failure: function (operation, message) {
    var err = new Error(message);
    this._recordError(operation, err);
    return { ok: false, persistent: false, error: message };
  },
  get: function (k, d) {
    try {
      if (HAS_GM) {
        var v = GM_getValue(k, undefined);
        return (v === undefined || v === null) ? d : v;
      }
      if (lsAvailable) {
        var raw = localStorage.getItem(this.storageKey(k));
        if (raw !== null) {
          try { return JSON.parse(raw); }
          catch (e) { this._recordError('get', e); return d; }
        }
      }
      if (own(legacyStore, k)) return legacyStore[k];
      if (own(memoryStore, k)) return memoryStore[k];
      return d;
    } catch (e) {
      this._recordError('get', e);
      return d;
    }
  },
  set: function (k, v) {
    try {
      if (HAS_GM) {
        GM_setValue(k, v);
        return { ok: true, persistent: true, storage: 'manager' };
      }
      if (lsAvailable) {
        localStorage.setItem(this.storageKey(k), JSON.stringify(v));
        return { ok: true, persistent: true, storage: 'page' };
      }
      memoryStore[k] = v;
      return { ok: true, persistent: false, storage: 'memory', degraded: this.capabilities.degraded };
    } catch (e) {
      this._recordError('set', e);
      return { ok: false, persistent: false, error: redactText(e && e.message || e) };
    }
  },
  remove: function (k) {
    try {
      if (HAS_GM) {
        if (!GM_DELETE) return this._failure('remove', 'GM_deleteValue is unavailable');
        GM_deleteValue(k);
        return { ok: true };
      }
      if (lsAvailable) {
        localStorage.removeItem(this.storageKey(k));
        if (own(legacyStore, k)) {
          delete legacyStore[k];
          writeLegacyStore();
        }
        return { ok: true };
      }
      delete memoryStore[k];
      return { ok: true, persistent: false };
    } catch (e) {
      this._recordError('remove', e);
      return { ok: false, error: redactText(e && e.message || e) };
    }
  },
  list: function () {
    try {
      if (HAS_GM) {
        if (!GM_LIST) return { ok: false, values: [], error: 'GM_listValues is unavailable' };
        return { ok: true, values: GM_listValues() || [] };
      }
      var values = [];
      var seen = dict();
      if (lsAvailable) {
        for (var i = 0; i < localStorage.length; i++) {
          var storageKey = localStorage.key(i);
          if (storageKey && storageKey.indexOf(LS_PREFIX) === 0) {
            var name = storageKey.slice(LS_PREFIX.length);
            try { name = decodeURIComponent(name); } catch (e) {}
            if (!blockedKey(name) && !seen[name]) { seen[name] = true; values.push(name); }
          }
        }
      }
      Object.keys(legacyStore).forEach(function (k) {
        if (!seen[k]) { seen[k] = true; values.push(k); }
      });
      Object.keys(memoryStore).forEach(function (k) {
        if (!seen[k]) { seen[k] = true; values.push(k); }
      });
      return { ok: true, values: values };
    } catch (e) {
      this._recordError('list', e);
      return { ok: false, values: [], error: redactText(e && e.message || e) };
    }
  },
  _pendingCss: [],
  _flushScheduled: false,
  _mount: function (css) {
    if (GM_STYLE) {
      try {
        this.capabilities.style = 'manager';
        return GM_addStyle(css);
      } catch (e) {
        this.capabilities.style = 'dom';
        this.capabilities.styleFallback = true;
        this._recordError('addStyle', e);
      }
    }
    var host = document.head || document.documentElement;
    if (!host) {
      this.capabilities.style = 'pending';
      this._pendingCss.push(css);
      this._scheduleFlush();
      return null;
    }
    try {
      var s = document.createElement('style');
      s.setAttribute('data-dcp', '1');
      s.textContent = css;
      host.appendChild(s);
      this.capabilities.style = 'dom';
      return s;
    } catch (e) {
      this.capabilities.style = 'unavailable';
      this._recordError('addStyle', e);
      return null;
    }
  },
  _scheduleFlush: function () {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    var self = this;
    var flush = function () {
      self._flushScheduled = false;
      var host = document.head || document.documentElement;
      if (!host) { self._scheduleFlush(); return; }
      var all = self._pendingCss.slice();
      self._pendingCss = [];
      all.forEach(function (css) {
        try {
          var s = document.createElement('style');
          s.setAttribute('data-dcp', '1');
          s.textContent = css;
          host.appendChild(s);
          self.capabilities.style = 'dom';
        } catch (e) {
          self.capabilities.style = 'unavailable';
          self._recordError('addStyle', e);
        }
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flush);
    else setTimeout(flush, 0);
  },
  addStyle: function (css) { return this._mount(css); },
  hasGM: HAS_GM
};

/* ---------- 页面真正的 window ---------- */
function pageWindow() {
  try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow; } catch (e) {}
  try { if (document.defaultView) return document.defaultView; } catch (e) {}
  return window;
}

/* ---------- 全局命名空间 + 极简事件总线 ---------- */
var DCP = {
  version: '8.5.0',
  runtime: HAS_GM ? 'tampermonkey' : 'inject',
  pageWindow: pageWindow,
  bridge: Bridge,
  modules: dict(),
  _ev: dict(),
  on: function (name, fn) {
    if (!name || typeof fn !== 'function') return;
    (this._ev[name] || (this._ev[name] = [])).push(fn);
  },
  emit: function (name, payload) {
    var list = this._ev[name] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); }
      catch (e) { console.error('[DCP]', redactText(name), redactLog(e)); }
    }
  },
  redact: redactLog
};

DCP.register = function (name, api) { this.modules[name] = api || {}; };

/* ---------- 基础变量 ---------- */
Bridge.addStyle(
  ':root{--dcp-accent:#3b6cf6;--dcp-border:rgba(0,0,0,.08)}' +
  'body.dark{--dcp-accent:#6b93ff;--dcp-border:rgba(255,255,255,.10)}' +
  '#dcp-toast{position:fixed;left:50%;top:max(20px,env(safe-area-inset-top));transform:translate(-50%,-160%);' +
  'z-index:2147483000;padding:10px 18px;border-radius:999px;font-size:13px;max-width:88vw;' +
  'background:rgba(28,30,38,.92);color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.25);' +
  'transition:transform .35s cubic-bezier(.34,1.4,.64,1);pointer-events:none;text-align:center;line-height:1.4}' +
  '#dcp-toast.dcp-toast-show{transform:translate(-50%,0)}'
);
DCP.log = function () {
  var a = ['[DCP]'];
  for (var i = 0; i < arguments.length; i++) a.push(redactLog(arguments[i]));
  try { console.log.apply(console, a); } catch (e) {}
};
