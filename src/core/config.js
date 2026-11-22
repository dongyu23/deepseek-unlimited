/* ============================================================
 * core/config：统一配置（chat-demo 第三方模型适配专用）
 *
 * 只保留本项目用到的键：自定义模型总开关、端点、Key、模型名、多模态、
 * 上下文窗口、工具调用方式、起名来源、桥接开关。带出厂默认与缺省补齐。
 * ============================================================ */
var CFG_KEY = 'dcp_config_v1';
var SESS_KEY = 'dcp_sessions_v1';

// 出厂默认：完全官方逻辑（DeepSeek 模型/端点/搜索，脚本零干预）
var DEFAULT_CONFIG = {
  demoCustom: false,                      // 自定义模型总开关：关=完全官方逻辑，脚本零干预
  demoEndpoint: '',                      // API 端点（空=官方 api.deepseek.com/anthropic/v1；Base URL 或完整地址都认）
  demoKey: '',                           // API Key 覆盖（空=用页面设置里填的那把）
  demoModel: '',                         // 模型名覆盖（空=官方默认 deepseek-flash）
  demoMultimodal: true,                  // 模型是否支持图片：开=转 base64 内联；关=只发文字说明
  demoCtxLimit: 128000,                   // 上下文窗口（tokens，占用环百分比用；可填 128000 / 128k / 1m）
  demoShowCtxRing: true,                  // 是否在工具条显示上下文占用环
  demoShowTps: false,                     // 是否在工具条显示实时输出速率
  demoSearchLimit: 'unlimited',           // 每轮 web_search 次数上限：unlimited / 2 / 1
  demoToolMode: 'native',                // 工具调用方式：native=DeepSeek 模型驱动搜索（含模型 token 费）/ searchapi=直调搜索 API（仅付搜索费）
  demoBridge: 'auto',                    // 工具桥接：auto(端点非 deepseek 即启用) / on / off
  demoTitleSource: 'deepseek'            // 会话标题来源：deepseek=官方端点起名腿 / model=自定义模型起名 / off=首条消息截断
};

function cloneDefaults() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }

var Config = {
  _cache: null,
  _sessCache: null,
  defaults: DEFAULT_CONFIG,
  load: function () {
    if (this._cache) return this._cache;
    var saved = Bridge.get(CFG_KEY, null);
    var cfg = cloneDefaults();
    if (saved && typeof saved === 'object') this._merge(cfg, saved);
    this._cache = cfg;
    return cfg;
  },
  _merge: function (base, over) {
    Object.keys(over).forEach(function (k) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
          base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        this._merge(base[k], over[k]);
      } else if (k in base) {
        base[k] = over[k];
      }
    }.bind(this));
  },
  save: function () { Bridge.set(CFG_KEY, this._cache); },
  get: function (path) {
    var c = this.load();
    if (!path) return c;
    var ps = path.split('.'); var cur = c;
    for (var i = 0; i < ps.length; i++) { if (cur == null) return undefined; cur = cur[ps[i]]; }
    return cur;
  },
  set: function (path, val) {
    var c = this.load();
    var ps = path.split('.'); var cur = c;
    for (var i = 0; i < ps.length - 1; i++) cur = cur[ps[i]];
    cur[ps[ps.length - 1]] = val;
    this.save();
    DCP.emit('cfg:change', { path: path, value: val });
  },
  reset: function () { this._cache = cloneDefaults(); this.save(); },

  /* ---- 按会话存储（当前仅上下文占用读数） ---- */
  sessions: function () {
    if (!this._sessCache) this._sessCache = Bridge.get(SESS_KEY, {}) || {};
    return this._sessCache;
  },
  session: function (sid) {
    if (!sid && DCP.utils) sid = DCP.utils.currentSid();
    var all = this.sessions();
    if (!all[sid]) all[sid] = { serverTokens: 0 };
    return all[sid];
  },
  saveSessions: function () { Bridge.set(SESS_KEY, this._sessCache); }
};

DCP.config = Config;
DCP.register('config', Config);
