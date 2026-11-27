/* ============================================================
 * core/config：统一配置（chat-demo 第三方模型适配专用）
 *
 * - 只合并自身属性，拒绝 __proto__ / constructor / prototype
 * - 每个顶层字段独立存储并带修订号，避免多标签整对象互相覆盖
 * - demoKey 只允许写入管理器隔离存储；页面存储只保存非敏感配置
 * ============================================================ */
var CFG_KEY = 'dcp_config_v1';
var SESS_KEY = 'dcp_sessions_v1';
var FIELD_PREFIX = CFG_KEY + ':field:';

function cfgDict() { return Object.create(null); }
function cfgOwn(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
function cfgBlocked(key) { return key === '__proto__' || key === 'constructor' || key === 'prototype'; }
function cfgClone(value) {
  if (Array.isArray(value)) return value.map(cfgClone);
  if (value && typeof value === 'object') {
    var out = cfgDict();
    Object.keys(value).forEach(function (k) {
      if (!cfgBlocked(k)) out[k] = cfgClone(value[k]);
    });
    return out;
  }
  return value;
}
function cfgIsObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 出厂默认：完全官方逻辑（DeepSeek 模型/端点/搜索，脚本零干预）
var DEFAULT_CONFIG = {
  demoCustom: false,                      // 自定义模型总开关：关=完全官方逻辑，脚本零干预
  demoEndpoint: '',                      // API 端点（空=官方 api.deepseek.com/anthropic/v1；Base URL 或完整地址都认）
  demoKey: '',                           // 第三方端点独立 Key（仅精确官方 api.deepseek.com 端点可留空）
  demoModel: '',                         // 模型名覆盖（空=官方默认 deepseek-flash）
  demoMultimodal: true,                  // 模型是否支持图片：开=转 base64 内联；关=只发文字说明
  demoCtxLimit: 128000,                   // 上下文窗口（tokens，占用环百分比用；可填 128000 / 128k / 1m）
  demoShowCtxRing: true,                  // 是否在工具条显示上下文占用环
  demoShowTps: false,                     // 是否在工具条显示实时输出速率
  demoSessionSync: true,                  // 跨标签同步会话状态；后台同会话完成后自动同步正文
  demoPinnedSessions: [],                 // 置顶会话 ID（按置顶顺序）
  demoSearchLimit: 'unlimited',           // 每轮 web_search 次数上限：unlimited / 2 / 1
  demoToolMode: 'native',                // 工具调用方式：native=DeepSeek 模型驱动搜索 / searchapi=直调搜索 API
  demoBridge: 'auto',                    // 工具桥接：auto / on / off
  demoTitleSource: 'deepseek',            // 会话标题来源：deepseek / model / off
  lang: 'auto'                           // 界面语言：auto / zh / en
};

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
function configFieldKey(field) { return FIELD_PREFIX + encodeURIComponent(field); }

var Config = {
  _cache: null,
  _sessCache: null,
  _dirty: cfgDict(),
  _revisions: cfgDict(),
  _writers: cfgDict(),
  _seq: 0,
  _tabId: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2),
  _crossTabBound: false,
  _keyWarningEmitted: false,
  defaults: DEFAULT_CONFIG,

  _validFieldRecord: function (rec) {
    return cfgIsObject(rec) && cfgOwn(rec, 'value') &&
      typeof rec.revision === 'number' && isFinite(rec.revision) &&
      typeof rec.writer === 'string';
  },
  _nextRevision: function (field) {
    var now = Date.now() * 1000 + (this._seq++ % 1000);
    var current = this._revisions[field] || 0;
    return now > current ? now : current + 1;
  },
  _merge: function (base, over) {
    if (!cfgIsObject(base) || !cfgIsObject(over)) return;
    Object.keys(over).forEach(function (k) {
      if (cfgBlocked(k) || !cfgOwn(base, k)) return;
      var bv = base[k];
      var ov = over[k];
      if (cfgIsObject(bv) && cfgIsObject(ov)) this._merge(bv, ov);
      else base[k] = cfgClone(ov);
    }, this);
  },
  _applyValue: function (field, value) {
    if (!cfgOwn(DEFAULT_CONFIG, field) || cfgBlocked(field)) return;
    if (cfgIsObject(this._cache[field]) && cfgIsObject(value)) this._merge(this._cache[field], value);
    else this._cache[field] = cfgClone(value);
  },
  _warnKeyStorage: function () {
    if (this._keyWarningEmitted) return;
    this._keyWarningEmitted = true;
    try { DCP.emit('cfg:warning', { code: 'KEY_NOT_PERSISTED' }); } catch (e) {}
  },
  load: function () {
    if (this._cache) return this._cache;

    var cfg = cloneDefaults();
    var legacy = Bridge.get(CFG_KEY, null);
    var legacyValues = cfgIsObject(legacy) ? legacy : null;
    var isolated = !!(Bridge.capabilities && Bridge.capabilities.isolatedStorage);
    var ignoredLegacyKey = false;

    if (legacyValues) {
      // 旧版本可能把 demoKey 写进页面可读存储。这里只迁移非敏感字段，
      // 并在迁移完成后删除旧整对象，避免继续留存 Key。
      if (!isolated && cfgOwn(legacyValues, 'demoKey') && legacyValues.demoKey) ignoredLegacyKey = true;
      var safeLegacy = cfgDict();
      Object.keys(legacyValues).forEach(function (k) {
        if (k !== 'demoKey' || isolated) safeLegacy[k] = legacyValues[k];
      });
      this._merge(cfg, safeLegacy);
    }

    this._cache = cfg;
    var migrated = cfgDict();
    Object.keys(DEFAULT_CONFIG).forEach(function (field) {
      var rec = Bridge.get(configFieldKey(field), null);
      if (this._validFieldRecord(rec)) {
        this._applyValue(field, rec.value);
        this._revisions[field] = rec.revision;
        this._writers[field] = rec.writer;
      } else if (legacyValues && cfgOwn(legacyValues, field) && (field !== 'demoKey' || isolated)) {
        migrated[field] = true;
      }
    }, this);

    this._ensureCrossTab();

    if (legacyValues) {
      Object.keys(migrated).forEach(function (field) { this._dirty[field] = true; }, this);
      var migration = this.save();
      if (migration.ok) Bridge.remove(CFG_KEY);
    }
    if (ignoredLegacyKey) this._warnKeyStorage();
    return cfg;
  },
  save: function () {
    var cfg = this.load();
    var fields = Object.keys(this._dirty).filter(function (field) {
      return cfgOwn(DEFAULT_CONFIG, field) && !cfgBlocked(field);
    });
    var isolated = !!(Bridge.capabilities && Bridge.capabilities.isolatedStorage);
    var persistent = !!(Bridge.capabilities && Bridge.capabilities.persistentStorage);
    var failures = [];
    var keyOmitted = false;

    fields.forEach(function (field) {
      if (field === 'demoKey' && !isolated) {
        keyOmitted = true;
        delete this._dirty[field];
        return;
      }
      var rec = {
        value: cfgClone(cfg[field]),
        revision: this._nextRevision(field),
        writer: this._tabId,
        updatedAt: Date.now()
      };
      var result = Bridge.set(configFieldKey(field), rec);
      if (!result || result.ok === false) {
        failures.push({ field: field, error: result && result.error || 'storage write failed' });
        return;
      }
      this._revisions[field] = rec.revision;
      this._writers[field] = rec.writer;
      delete this._dirty[field];
    }, this);

    if (keyOmitted) this._warnKeyStorage();
    var ok = failures.length === 0;
    return {
      ok: ok,
      persistent: persistent,
      keyStored: !cfg.demoKey || isolated,
      fields: fields.length,
      failures: failures,
      error: ok ? null : 'one or more configuration fields could not be saved'
    };
  },
  get: function (path) {
    var c = this.load();
    if (!path) return c;
    var ps = String(path).split('.');
    var cur = c;
    for (var i = 0; i < ps.length; i++) {
      if (cfgBlocked(ps[i]) || !cfgOwn(cur, ps[i])) return undefined;
      cur = cur[ps[i]];
    }
    return cur;
  },
  set: function (path, val) {
    if (!path || typeof path !== 'string') return { ok: false, error: 'invalid config path' };
    var ps = path.split('.');
    for (var i = 0; i < ps.length; i++) {
      if (cfgBlocked(ps[i])) return { ok: false, error: 'invalid config path' };
    }
    var c = this.load();
    var cur = c;
    for (var j = 0; j < ps.length - 1; j++) {
      if (!cfgOwn(cur, ps[j]) || !cfgIsObject(cur[ps[j]])) return { ok: false, error: 'invalid config path' };
      cur = cur[ps[j]];
    }
    var leaf = ps[ps.length - 1];
    if (!cfgOwn(cur, leaf)) return { ok: false, error: 'unknown config field' };
    cur[leaf] = cfgClone(val);
    this._dirty[ps[0]] = true;
    var result = this.save();
    try {
      DCP.emit('cfg:change', {
        path: path,
        value: cfgClone(val),
        saved: result.ok,
        persistent: result.persistent,
        keyStored: result.keyStored,
        error: result.error
      });
    } catch (e) {}
    return result;
  },
  reset: function () {
    this._cache = cloneDefaults();
    var self = this;
    Object.keys(DEFAULT_CONFIG).forEach(function (field) { self._dirty[field] = true; });
    var result = this.save();
    try { DCP.emit('cfg:change', { path: '*', saved: result.ok, persistent: result.persistent, keyStored: result.keyStored }); } catch (e) {}
    return result;
  },

  /* ---- 跨标签：只接收更新字段，绝不整对象覆盖 ---- */
  _isNewer: function (field, rec) {
    if (!this._validFieldRecord(rec)) return false;
    var local = this._revisions[field];
    if (typeof local !== 'number') return true;
    if (rec.revision > local) return true;
    return rec.revision === local && rec.writer !== this._writers[field] && rec.writer > (this._writers[field] || '');
  },
  _applyRemoteField: function (field, rec) {
    if (!cfgOwn(DEFAULT_CONFIG, field) || !this._isNewer(field, rec)) return false;
    this._applyValue(field, rec.value);
    this._revisions[field] = rec.revision;
    this._writers[field] = rec.writer;
    delete this._dirty[field];
    try { DCP.emit('cfg:change', { path: field, value: cfgClone(rec.value), remote: true, saved: true }); } catch (e) {}
    return true;
  },
  _reloadFields: function () {
    var changed = false;
    var self = this;
    Object.keys(DEFAULT_CONFIG).forEach(function (field) {
      var rec = Bridge.get(configFieldKey(field), null);
      if (self._applyRemoteField(field, rec)) changed = true;
    });
    return changed;
  },
  _applyStorageEvent: function (event) {
    if (!event || !event.key) return false;
    var self = this;
    if (Bridge.storageKey && event.key === Bridge.storageKey(CFG_KEY)) return this._reloadFields();
    var changed = false;
    Object.keys(DEFAULT_CONFIG).forEach(function (field) {
      if (event.key === Bridge.storageKey(configFieldKey(field))) {
        var rec = Bridge.get(configFieldKey(field), null);
        if (self._applyRemoteField(field, rec)) changed = true;
      }
    });
    return changed;
  },
  _ensureCrossTab: function () {
    if (this._crossTabBound || typeof window === 'undefined' || !window.addEventListener) return;
    this._crossTabBound = true;
    var self = this;
    this._onStorage = function (event) {
      try { self._applyStorageEvent(event); } catch (e) {}
    };
    this._onFocus = function () {
      try { self._reloadFields(); } catch (e) {}
    };
    this._onVisibility = function () {
      try { if (!document.hidden) self._reloadFields(); } catch (e) {}
    };
    window.addEventListener('storage', this._onStorage);
    window.addEventListener('focus', this._onFocus);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  },

  /* ---- 按会话存储（当前仅上下文占用读数） ---- */
  _normalizeSessions: function (raw) {
    var out = cfgDict();
    if (!cfgIsObject(raw)) return out;
    Object.keys(raw).forEach(function (sid) {
      if (!sid || cfgBlocked(sid) || !cfgIsObject(raw[sid])) return;
      var rec = cfgDict();
      Object.keys(raw[sid]).forEach(function (k) {
        if (!cfgBlocked(k)) rec[k] = cfgClone(raw[sid][k]);
      });
      out[sid] = rec;
    });
    return out;
  },
  sessions: function () {
    if (!this._sessCache) this._sessCache = this._normalizeSessions(Bridge.get(SESS_KEY, {}));
    return this._sessCache;
  },
  session: function (sid) {
    if (!sid && DCP.utils) sid = DCP.utils.currentSid();
    if (!sid || cfgBlocked(String(sid))) return cfgDict();
    sid = String(sid);
    var all = this.sessions();
    if (!cfgOwn(all, sid)) all[sid] = cfgDict();
    return all[sid];
  },
  saveSessions: function () { return Bridge.set(SESS_KEY, this._sessCache || cfgDict()); }
};

DCP.config = Config;
DCP.register('config', Config);
