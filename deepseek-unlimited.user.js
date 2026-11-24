// ==UserScript==
// @name         DeepSeek Unlimited
// @name:zh-CN   DeepSeek 不限流
// @namespace    https://github.com/dongyu23/deepseek-unlimited
// @version      1.0.16
// @description  Use your own API key in DeepSeek's official chat-demo page: any Anthropic-compatible model, no daily quota, no 7-day conversation expiry, no 40k-character input cap.
// @description:zh-CN 在 DeepSeek 官方的 chat-demo 页面里用你自己的 API Key：任意 Anthropic 兼容模型，没有每日额度上限、没有 7 天不活跃断连、没有单次 4 万字输入限制。搜索/起名/思考/图片/上下文占用环全部保留官网体验。
// @match        https://cdn.deepseek.com/chat-demo*
// @icon         https://raw.githubusercontent.com/dongyu23/deepseek-unlimited/main/docs/logo.png
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @noframes
// @license      MIT
// @supportURL   https://github.com/dongyu23/deepseek-unlimited/issues
// @homepageURL  https://github.com/dongyu23/deepseek-unlimited
// ==/UserScript==

/* ===== bootstrap.js ===== */
/* ============================================================
 * bootstrap：IIFE 外壳 + 运行时桥（油猴 / Android WebView 注入通用）
 * ============================================================ */
(function () {
'use strict';

/* ---------- 运行时探测：GM 可用用油猴，否则回退 localStorage（WebView 注入） ---------- */
var HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
var LS_PREFIX = 'dcp_store_';
var lsStore = {};
try { lsStore = JSON.parse(localStorage.getItem('dcp_bridge_store') || '{}') || {}; } catch (e) { lsStore = {}; }
var lsTimer = null;
function lsWriteNow() { try { localStorage.setItem('dcp_bridge_store', JSON.stringify(lsStore)); } catch (e) {} }
/* 合并写入：粘贴长文本时 input 会连续触发，逐次全量 stringify+写盘会卡死主线程 */
function lsFlush() {
  if (lsTimer) return;
  lsTimer = setTimeout(function () { lsTimer = null; lsWriteNow(); }, 150);
}
function lsFlushNow() { if (lsTimer) { clearTimeout(lsTimer); lsTimer = null; } lsWriteNow(); }
try {
  window.addEventListener('pagehide', lsFlushNow);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') lsFlushNow(); });
} catch (e) {}

var Bridge = {
  get: function (k, d) {
    if (HAS_GM) { var v = GM_getValue(k, undefined); return (v === undefined || v === null) ? d : v; }
    return (k in lsStore) ? lsStore[k] : d;
  },
  set: function (k, v) {
    if (HAS_GM) return GM_setValue(k, v);
    lsStore[k] = v; lsFlush();
  },
  remove: function (k) {
    if (HAS_GM) { try { GM_deleteValue(k); } catch (e) {} return; }
    delete lsStore[k]; lsFlush();
  },
  list: function () {
    if (HAS_GM) { try { return GM_listValues() || []; } catch (e) { return []; } }
    return Object.keys(lsStore);
  },
  _pendingCss: [],
  _flushScheduled: false,
  _mount: function (css) {
    if (typeof GM_addStyle === 'function') { try { return GM_addStyle(css); } catch (e) {} }
    var host = document.head || document.documentElement;
    if (!host) { this._pendingCss.push(css); this._scheduleFlush(); return null; }
    var s = document.createElement('style');
    s.setAttribute('data-dcp', '1');
    s.textContent = css;
    host.appendChild(s);
    return s;
  },
  _scheduleFlush: function () {
    if (this._flushScheduled) return; this._flushScheduled = true;
    var self = this;
    var flush = function () {
      self._flushScheduled = false;
      var host = document.head || document.documentElement;
      if (!host) { self._scheduleFlush(); return; }
      var all = self._pendingCss.slice(); self._pendingCss = [];
      all.forEach(function (css) {
        var s = document.createElement('style');
        s.setAttribute('data-dcp', '1'); s.textContent = css; host.appendChild(s);
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flush);
    else setTimeout(flush, 0);
  },
  addStyle: function (css) { return this._mount(css); },
  hasGM: HAS_GM
};

/* ---------- 页面真正的 window ----------
 * 油猴带 @grant 时把脚本跑在沙箱里，沙箱的 window 不是页面的 window：读会沿
 * 原型链穿透过去，写只落在沙箱全局。于是 `window.fetch = 补丁` 这种写法页面
 * 一个字节都没换到——demo 页走 fetch，桥接整个不工作、圆圈永远 0（主站走
 * XHR、改的是共享原型所以照常，故只有 demo 页炸）。document.defaultView 在
 * 任何上下文里都指向页面真正的 window，unsafeWindow 是油猴的显式通道 */
function pageWindow() {
  try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow; } catch (e) {}
  try { if (document.defaultView) return document.defaultView; } catch (e) {}
  return window;
}

/* ---------- 全局命名空间 + 极简事件总线 ----------
 * DCP 只保留在 userscript 闭包内，绝不挂到页面真实 window：配置对象包含
 * demoKey，页面脚本一旦能读到 DCP，GM_* 的沙箱隔离就形同虚设。 */
var DCP = {
  version: '1.0.16',
  runtime: HAS_GM ? 'tampermonkey' : 'inject',
  pageWindow: pageWindow,
  bridge: Bridge,
  modules: {},
  _ev: {},
  on: function (name, fn) { (this._ev[name] || (this._ev[name] = [])).push(fn); },
  emit: function (name, payload) {
    var list = this._ev[name] || [];
    for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (e) { console.error('[DCP]', name, e); } }
  }
};

DCP.register = function (name, api) { this.modules[name] = api || {}; };

/* ---------- 基础变量 ----------
 * 占用环/进度条读 --dcp-accent 与 --dcp-border。这两个值以前是从另一个脚本
 * （deepseek-enhance）注入的 --dse-* 借来的——单独装本项目时没有人定义，
 * SVG 的 stroke 会变成无效值、环直接看不见。故自带一份，取值与官方主站同一
 * 组品牌色（浅色 #3b6cf6 / 深色 #6b93ff）。 */
Bridge.addStyle(
  ':root{--dcp-accent:#3b6cf6;--dcp-border:rgba(0,0,0,.08)}' +
  'body.dark{--dcp-accent:#6b93ff;--dcp-border:rgba(255,255,255,.10)}' +
  /* Toast：保存成功/输入框无法识别这类轻反馈。以前也是从另一个脚本的样式表
   * 借的，单独装时是个没有样式的裸 div，故一并自带 */
  '#dcp-toast{position:fixed;left:50%;top:max(20px,env(safe-area-inset-top));transform:translate(-50%,-160%);' +
  'z-index:2147483000;padding:10px 18px;border-radius:999px;font-size:13px;max-width:88vw;' +
  'background:rgba(28,30,38,.92);color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.25);' +
  'transition:transform .35s cubic-bezier(.34,1.4,.64,1);pointer-events:none;text-align:center;line-height:1.4}' +
  '#dcp-toast.dcp-toast-show{transform:translate(-50%,0)}'
);
DCP.log = function () {
  var a = ['[DCP]'].concat([].slice.call(arguments));
  try { console.log.apply(console, a); } catch (e) {}
};

/* ===== core/config.js ===== */
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
  demoKey: '',                           // 第三方端点独立 Key（仅精确官方 api.deepseek.com 端点可留空）
  demoModel: '',                         // 模型名覆盖（空=官方默认 deepseek-flash）
  demoMultimodal: true,                  // 模型是否支持图片：开=转 base64 内联；关=只发文字说明
  demoCtxLimit: 128000,                   // 上下文窗口（tokens，占用环百分比用；可填 128000 / 128k / 1m）
  demoShowCtxRing: true,                  // 是否在工具条显示上下文占用环
  demoShowTps: false,                     // 是否在工具条显示实时输出速率
  demoSessionSync: true,                  // 跨标签同步会话状态；后台同会话完成后自动同步正文
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

/* ===== core/selectors.js ===== */
/* ============================================================
 * core/selectors：实测选择器集中地（chat-demo 专用）
 *
 * 只保留 chat-demo（cdn.deepseek.com/chat-demo）用到的：消息行、输入区、
 * 侧边栏会话条目、聊天区标题。demo 页是独立构建、class 全是构建哈希
 * （message-e1faee / bubble-_4cfe7 / scroll-_7ccaf / item-ff6fc9 /
 * view-_5fa77 / header-_5fa77 / title-_5fa77 / top-ac14ac 等），官方
 * 重建后这些哈希会变——届时只需更新下面这一组。
 * ============================================================ */
var SEL = {
  // 输入区（与主站共用的稳定设计 token）
  textarea: 'textarea._27c9245, textarea',
  inputToolbar: '.ec4f5d61',

  /* ---- cdn.deepseek.com/chat-demo ----
   * 消息区复用 ds-markdown / ds-think-content / md-code-block 等稳定设计 token；
   * 页面骨架与消息行类名全是构建哈希。demo 无虚拟列表：消息在普通滚动容器
   * .scroll-_7ccaf 内顺序渲染；用户消息行与 AI 消息底部容器复用同一 CSS 模块
   * （container-_4cfe7），取消息行会重复命中，故用户行改用气泡类 bubble-_4cfe7。 */
  virtualList: '.scroll-_7ccaf',
  msg: '.message-e1faee, .bubble-_4cfe7',
  msgRowAi: '.message-e1faee',
  msgRowUser: '.bubble-_4cfe7',
  userBubble: '.bubble-_4cfe7',
  aiMarkdownAny: '.ds-markdown',
  aiActionBar: '.actions-_4cfe7',
  thinkBlock: '.area-_3d93a',
  thinkHeader: '.title-_3d93a',
  // 侧边栏（收起边栏时条目会整个从 DOM 消失，不能作为常驻数据源）
  appTop: '.top-ac14ac',
  sidebarItem: '.item-ff6fc9',
  sidebarItemActive: '.item-ff6fc9.active-ff6fc9',
  sidebarItemTitle: '.title-ff6fc9',
  sidebarList: '.section-ac14ac',
  // 聊天区标题：demo 页自己渲染的当前会话名（新对话时整个元素不存在）
  chatView: '.view-_5fa77',
  chatHeader: '.header-_5fa77',
  chatTitle: '.title-_5fa77',
  // demo 是客户端直连 api.deepseek.com：无服务端会话 id、无 history_messages 接口
  noServerSession: true
};
DCP.SEL = SEL;

/* ===== core/utils.js ===== */
/* ============================================================
 * core/utils：通用工具
 * ============================================================ */
var Utils = {
  isMobile: function () { return window.innerWidth < 640; },
  isDark: function () { return document.body && document.body.classList.contains('dark'); },
  currentSid: function () {
    var m = location.pathname.match(/\/a\/chat\/s\/([\w-]+)/);
    return m ? m[1] : '';
  },
  debounce: function (fn, d) {
    var t; return function () {
      var a = arguments, c = this; clearTimeout(t);
      t = setTimeout(function () { fn.apply(c, a); }, d);
    };
  },
  throttle: function (fn, d) {
    var last = 0, timer;
    return function () {
      var now = Date.now(), a = arguments, c = this, rest = d - (now - last);
      if (rest <= 0) { last = now; fn.apply(c, a); }
      else { clearTimeout(timer); timer = setTimeout(function () { last = Date.now(); fn.apply(c, a); }, rest); }
    };
  },
  rafThrottle: function (fn) {
    var q = false;
    return function () {
      var a = arguments, c = this;
      if (q) return; q = true;
      requestAnimationFrame(function () { q = false; fn.apply(c, a); });
    };
  },
  onReady: function (cb) {
    if (document.body) cb();
    else document.addEventListener('DOMContentLoaded', cb);
  },
  // 轮询等待
  waitFor: function (fn, timeout, interval) {
    return new Promise(function (resolve) {
      timeout = timeout || 15000; interval = interval || 150;
      var t0 = Date.now();
      (function tick() {
        var r;
        try { r = fn(); } catch (e) { r = null; }
        if (r) return resolve(r);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, interval);
      })();
    });
  },
  estimateTokens: function (text) {
    if (!text) return 0;
    var cn = (text.match(/[一-鿿]/g) || []).length;
    var en = text.length - cn;
    return Math.ceil(cn * 1.4 + en / 3.6);
  },
  escHtml: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  // 简易 hash（用于消息幂等键）
  hash: function (str) {
    var h = 0; str = String(str || '');
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return (h >>> 0).toString(36);
  },
  rand: function (a, b) { return a + Math.random() * (b - a); },
  toast: function (msg, ms) {
    var t = document.getElementById('dcp-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'dcp-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'dcp-toast-show' + (Utils.isDark() ? ' dcp-toast-dark' : '');
    clearTimeout(t._tid);
    t._tid = setTimeout(function () { t.className = t.className.replace('dcp-toast-show', '').trim(); }, ms || 2000);
  },
  // 派发可信点击（React 受控元素需要完整事件序列）
  realClick: function (el) {
    if (!el) return;
    var opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) { el.click(); }
  },
  // 主题变化监听
  onThemeChange: function (cb) {
    new MutationObserver(function () { cb(Utils.isDark()); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
};
DCP.utils = Utils;
DCP.register('utils', Utils);

/* ===== core/i18n.js ===== */
/* ============================================================
 * core/i18n：界面中英文（以中文字符串为 key，缺省回退中文）
 *  - lang = auto：按 navigator.language 自动判定（zh* → 中文，其余 → English）
 *  - lang = zh / en：手动覆盖
 *  - 只做中英文；未收录的 key 原样返回中文，保证不出现空串
 * ============================================================ */
var I18N = {
  dict: {
    // ---------- 通用 ----------
    '外观': 'Appearance',
    '对话': 'Chat',
    '提示词': 'Prompt',
    '其他': 'More',
    '界面': 'Interface',
    '关于': 'About',
    '上传': 'Upload',
    '默认图': 'Default',
    '关闭背景': 'Disable',
    '模糊': 'Blur',
    '亮度': 'Brightness',
    '页面缩放': 'Page zoom',
    '恢复默认': 'Reset',
    '展开': 'Expand',
    '收起': 'Collapse',

    // ---------- 外观 ----------
    '背景图片': 'Background image',
    '图片 URL，留空用默认图': 'Image URL, leave empty for default',
    '气泡材质': 'Bubble style',
    '默认': 'Default',
    '清爽浅色气泡': 'Clean light bubbles',
    'iOS 磨砂': 'iOS Frosted',
    '高饱和毛玻璃': 'High-saturation blur',
    '水玻璃': 'Aqua glass',
    '通透高光（推荐）': 'Translucent highlight (recommended)',
    '输入框悬浮磨砂': 'Floating frosted input',
    '统一顶栏': 'Unified top bar',
    '消除分享按钮单独底色/标题黑条': 'Remove the share-button patch and title bar',
    '磨砂': 'Frosted',
    '背景透出': 'Transparent',
    '隐藏“下载应用”': 'Hide "Download app"',
    '仅欢迎页，不影响新建对话/侧栏按钮': 'Welcome page only; keeps other buttons',

    // ---------- 对话 ----------
    '消息呈现': 'Messages',
    '思考区自动折叠': 'Auto-collapse thinking',
    '默认收起 DeepSeek 思考过程': 'Collapse DeepSeek reasoning by default',
    '代码块自动折叠': 'Auto-collapse code blocks',
    '超过设定行数自动收起，点击展开': 'Collapse when longer than the limit; click to expand',
    '代码块显示行数': 'Code lines shown',
    '隐藏 AI 生成标识': 'Hide AI notice',
    '底部“内容由 AI 生成”等': 'The "AI-generated" notice at the bottom',
    'Markdown 排版美化': 'Markdown styling',
    '只改本地样式，不向 AI 发送任何指令': 'Local styling only; sends nothing to the AI',
    'LaTeX 公式渲染': 'LaTeX rendering',
    '离线 KaTeX，渲染 \\( \\)、\\[ \\]、$ 公式': 'Offline KaTeX for \\( \\), \\[ \\], $ formulas',
    '隐式时间注入': 'Implicit time injection',
    // ---------- chat-demo 模型切换 ----------
    'API 端点': 'API endpoint',
    '自定义模型': 'Custom model',
    '工具调用方式': 'Tool invocation',
    '每轮搜索次数上限': 'Search limit per turn',
    'unlimited：不限制': 'unlimited: no limit',
    '2：最多两次': '2: at most two',
    '1：最多一次': '1: at most one',
    '每轮回答中 web_search 的次数上限。unlimited=不限制，适合预算充裕、需要多轮检索的任务；2=最多两次；1=最多一次，适合节省预算。': 'Maximum web_search calls per assistant turn. unlimited = no limit for research-heavy tasks with ample budget; 2 = at most two; 1 = at most one for tighter budgets.',
    'unlimited：不限制（默认）；2：每轮最多两次；1：每轮最多一次': 'unlimited: no limit (default); 2: at most two per turn; 1: at most one per turn',
    '只填消息接口地址：到 /messages 为止，不要包含 /messages 本身（例：https://api.stepfun.com/step_plan/v1）。留空 = 官方 https://api.deepseek.com/anthropic/v1': 'Messages endpoint only: up to but excluding /messages itself (e.g. https://api.stepfun.com/step_plan/v1). Leave empty for the official https://api.deepseek.com/anthropic/v1',
    '模型要搜索时，谁来执行：native=交给 DeepSeek 的模型在对话里完成，能多轮搜、能读网页，但每轮搜索另付约 2 分钱模型费；searchapi=直接调 DeepSeek 的搜索接口，一次约 0.00075 美元、不经模型，搜什么由当前模型决定。两种在界面上看起来一样': 'Who runs the search when the model asks for one: native = the DeepSeek model does it inside the conversation (multi-round search and page reads; each round costs about 2 cents in model tokens). searchapi = call the DeepSeek search API directly, about $0.00075 per call, no model involved; the current model decides what to search. Both look identical in the UI',
    '模型要搜索时谁来执行：native=DeepSeek 的模型自己搜，另付约 2 分钱/轮模型费；searchapi=直调搜索接口，每次约 0.00075 美元、不经模型': 'Who runs a search when the model asks: native = the DeepSeek model searches itself (about 2 cents per round in model fees); searchapi = call the search API directly (about $0.00075 per call, no model involved)',
    '起名来源': 'Title source',
    'deepseek：官方起名腿': 'deepseek: official title leg',
    'model：自定义模型起名': 'model: custom model titles it',
    'off：用首条消息截断': 'off: truncated first message',
    '新对话首轮回答后生成会话标题的来源：deepseek=打 DeepSeek 官方端点用 title 参数起名（约 $0.001/次、标题质量官方级、用页面里那把 DeepSeek Key）；model=让当前自定义模型按提示词起名（一次极小非流式请求、费用走当前端点、不经 DeepSeek）；off=不起名，用首条消息截断。任一来源失败都退回首条消息截断': 'Who generates the session title after the first reply of a new chat: deepseek = a title leg against the official DeepSeek endpoint using the title parameter (about $0.001 per call, official-quality titles, uses the DeepSeek key entered on the page); model = the current custom model titles it from a prompt (one tiny non-streaming request, billed to the current endpoint, no DeepSeek involved); off = no title, truncated first message. Any source falls back to the truncated first message on failure',
    'deepseek：官方起名腿，约 $0.001/次；model：自定义模型起名，费用走当前端点；off：用首条消息截断': 'deepseek: official title leg, about $0.001 per call; model: titled by the custom model, billed to the current endpoint; off: truncated first message',
    // 会话搜索（官方主站同款文案）
    '搜索对话内容...': 'Search conversation content...',
    '暂无相关结果': 'No matching results',
    '新对话': 'New chat',
    // 粘贴大段文本转 txt（官方同款文案）
    '内容已恢复到输入框': 'Content restored to the input box.',
    'native：模型自己搜': 'native: model-driven',
    'searchapi：只付搜索费': 'searchapi: search fee only',
    'native（原生）': 'native (native tools)',
    '上下文容量': 'Context capacity',
    '消息': 'Messages',
    '系统提示词': 'System prompt',
    '系统工具': 'Tools',
    '平均缓存命中率': 'Avg cache hit rate',
    '总量与缓存命中率为接口 usage 精确值；构成占比按请求结构估算': 'Total and cache hit rate are exact values from the API usage; the composition split is estimated from the request structure',
    '上下文占用': 'Context usage',
    '上下文窗口': 'Context window',
    '显示上下文占用环': 'Show context usage ring',
    '在输入工具条发送按钮一侧显示上下文占用环；关闭后仍会继续统计，只是不显示': 'Show the context usage ring beside the send button. When off, usage is still counted but hidden.',
    '显示实时 TPS': 'Show live TPS',
    '在上下文占用环左侧显示实时输出速率（thinking + 正文 token/秒）；仅自定义模型桥接工作时生效': 'Show live output rate (thinking + text tokens per second) to the left of the context ring. Only active while the custom-model bridge is running.',
    '跨标签同步会话': 'Sync conversations across tabs',
    '侧栏实时显示生成中的转圈和生成完毕的蓝点；后台标签开着同一条会话时，对方完成后自动同步正文。刷新页面只恢复一次当前会话。': 'Show a spinner while a conversation is generating and a blue dot when it finishes. A background tab viewing the same conversation reloads once after the other tab finishes. Refreshing restores the current conversation once.',
    '正在生成': 'Generating',
    '生成完毕': 'Finished',
    '-- tok/s': '-- tok/s',
    '实时 -- tok/s': 'Live -- tok/s',
    '实时 {n} tok/s': 'Live {n} tok/s',
    '平均 {n} tok/s': 'Avg {n} tok/s',
    '{n} tok/s': '{n} tok/s',
    '本轮已输出 {tokens} tokens，用时 {sec} 秒（{kind}）': '{tokens} output tokens in {sec}s ({kind})',
    '实时估算': 'live estimate',
    '接口 usage 精确值': 'exact API usage',
    '所用模型的上下文窗口（tokens）。输入框旁的圆圈按 占用/窗口 显示百分比': 'The context window of the model in use (tokens). The ring beside the input box shows usage / window as a percentage',
    '来自模型接口返回的 usage 精确值（系统提示 + 工具 + 完整历史）': 'Exact value from the usage field returned by the model API (system prompt + tools + full history)',
    '测试连接与模型身份': 'Test connection & model identity',
    '测试': 'Test',
    '测试中…': 'Testing…',
    '连接成功': 'Connected',
    '连接失败': 'Connection failed',
    '请求失败': 'Request failed',
    '模型自述': 'Model says',
    '（未获得文本回复）': '(no text reply)',
    '（浏览器安全策略拦截了跨域请求，可在高级选项切换鉴权头试试）': '(blocked by browser CORS policy — try switching the auth header in Advanced options)',
    '你是什么AI模型？请用一句话直接说明你的模型名称和开发方，不要复述这个问题。': 'What AI model are you? State your model name and developer in one sentence. Do not repeat this question.',
    '鉴权头': 'Auth header',
    '工具桥接': 'Tool bridge',
    'x-api-key（默认）或 authorization（Bearer）。StepFun 等端点的 CORS 只放行 Authorization': 'x-api-key (default) or authorization (Bearer). StepFun and similar endpoints only allow Authorization via CORS',
    'auto=端点非 deepseek 时启用（默认）；on=强制启用；off=关闭（工具随端点丢失）': 'auto = enabled when the endpoint is not deepseek (default); on = force; off = disabled (tools lost with the endpoint)',
    'API Key': 'API key',
    '（第三方端点必填）': '(required for third-party endpoints)',
    '第三方端点必须填写独立 Key；只有精确官方 api.deepseek.com 端点可留空并使用页面官方 Key': 'Third-party endpoints require their own key. Only the exact official api.deepseek.com endpoint may be left blank to use the page’s official key.',
    '第三方端点必须填写独立的 API Key；脚本不会把官方 DeepSeek Key 发送到非官方地址。': 'Third-party endpoints require an independent API key. The official DeepSeek key is never sent to non-official addresses.',
    '（用页面里填的官方 Key）': '(use the official key entered on the page)',
    '留空 = 用官方设置里填的 Key；填写则替换请求头 x-api-key': 'Leave empty to use the key entered in the official settings; a value here replaces the x-api-key request header',
    '模型': 'Model',
    'deepseek-flash（官方默认）': 'deepseek-flash (official default)',
    '留空 = 官方默认 deepseek-flash；只更换请求中的 model 字段，端点 / Key / 工具一律不变': 'Leave empty for the official default (deepseek-flash). Only the model field in the request is swapped; endpoint, key and tools stay untouched',
    '本会话上下文用量': 'Session context usage',
    '提醒阈值': 'Warning threshold',
    '当前模型上下文约 1M；用量达到该百分比时弹一次提醒。': 'The current model context is about 1M. A reminder pops up when usage reaches this percentage.',
    '（已达提醒阈值）': ' (warning threshold reached)',
    '立即重新统计（拉取本会话历史）': 'Recount now (fetch this session history)',
    '约': 'About',
    '（估算）': ' (estimated)',
    '本会话上下文已使用 {p}%，达到提醒阈值 {t}%，可考虑开启新对话': 'Context usage of this session reached {p}% (warning threshold {t}%). Consider starting a new chat.',

    // ---------- 提示词 ----------
    '本会话系统提示词': 'Session system prompt',
    '只对当前这一个会话生效；切换到其它会话互不影响、互不可见。': 'Applies to this session only; each session is independent and private.',
    '启用本会话系统提示词': 'Enable session system prompt',
    '写给当前会话 AI 的系统设定…': 'System setup for this session\'s AI…',
    '高级：实际注入内容预览 / 模板': 'Advanced: injected preview / templates',
    '撤回后简短回应（模板，可编辑）': 'Brief reply after recall (editable template)',
    '预览实际注入': 'Preview injection',

    // ---------- 其他 ----------
    '防撤回 / 隐私': 'Anti-recall / Privacy',
    '关闭': 'Off',
    '智能': 'Smart',
    '全量': 'Full',
    '智能：连续撤回连续补回；服务端重载上下文后只补最新缺失轮次。全量：每次发送都拼接本地历史。': 'Smart: refill recalled rounds continuously; after the server reloads context only the latest missing round is refilled. Full: attach local history to every message.',
    '撤回后提示 AI 简短回应': 'Ask AI for a brief reply after recall',
    '降低再次撤回概率与 prompt 压力': 'Lower re-recall risk and prompt load',
    '全量历史条数': 'History messages (full mode)',
    '清除本会话本地历史': 'Clear local history for this session',
    '便捷功能': 'Shortcuts',
    '消息上下导航按钮': 'Message navigation buttons',
    '一键全屏按钮': 'Fullscreen button',
    '语言': 'Language',
    '自动': 'Auto',
    '中文': '中文',
    '界面语言（跟随系统 / 中文 / English）': 'Interface language (system / Chinese / English)',
    '本地记录 {n} 条': 'Local records: {n}',
    '，待回填撤回 {n} 条': ', to refill {n}',

    // ---------- 按钮 title / toast ----------
    '上一条消息': 'Previous message',
    '下一条消息': 'Next message',
    '一键全屏': 'Fullscreen',
    'DeepSeek Enhance 设置': 'DeepSeek Enhance settings',
    '图片不要超过 8MB': 'Image must be under 8MB',
    '请先进入一个对话': 'Open a conversation first',
    '正在重新统计…': 'Recounting…',
    '统计完成：约': 'Done: about ',
    'tokens': 'tokens',
    '统计失败（可能需要联网）': 'Failed (network required?)',
    '已拦截一次撤回，真实内容已本地保留': 'Recall intercepted; content kept locally',

    // ---------- 关于 ----------
    'GitHub 仓库': 'GitHub repo',
    '个人主页': 'Homepage'
  },
  _lang: null,
  resolve: function () {
    var pref = (DCP.config && DCP.config.get('lang')) || 'auto';
    if (pref === 'zh' || pref === 'en') return pref;
    var nav = String((navigator.language || navigator.userLanguage || 'en')).toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  },
  lang: function () { if (!this._lang) this._lang = this.resolve(); return this._lang; },
  refresh: function () { this._lang = this.resolve(); return this._lang; },
  t: function (key, params) {
    var l = this.lang();
    var d = this.dict;
    var s;
    if (l === 'en' && typeof d[key] === 'string') s = d[key];
    else s = key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) { return (params[k] != null ? params[k] : m); });
    }
    return s;
  }
};
DCP.i18n = I18N;
DCP.t = function (k, p) { return I18N.t(k, p); };
DCP.register('i18n', I18N);

/* ===== modules/toolbar.js ===== */
/* ============================================================
 * modules/toolbar：输入工具条定位（从 buttons 模块抽出的唯一共用件）
 *
 * 圆圈要注入在「深度思考/智能搜索」那一行里，而 demo 页是独立构建、class
 * 全是哈希——所以定位规则不依赖哈希：含“深度思考”开关、含按钮、不含输入框
 * 的最小容器，直接子按钮优先、后代元素数兜底。与主站脚本同一套逻辑，
 * 抽成独立模块供 ctxRing 使用。
 * ============================================================ */
var Toolbar = {
  find: function () {
    var t = document.querySelector(SEL.inputToolbar);
    if (t && t.offsetParent !== null) return t;
    // 兜底一：含“深度思考”开关的那一行
    var ta = document.querySelector(SEL.textarea);
    if (!ta) return null;
    var box = ta.closest('._871cbca') || ta.parentElement;
    var hit = null;
    if (box) box.querySelectorAll('div').forEach(function (d) {
      if (hit) return;
      if (/深度思考/.test(d.textContent || '') && d.children.length <= 8) hit = d.parentElement;
    });
    if (hit) return hit;
    // 兜底二：向上一层找不到时（demo 页开关行与输入框是兄弟节点），
    // 在全页面找「含思考开关、含按钮、不含输入框」的最小容器
    var cands = [];
    Array.prototype.forEach.call(document.querySelectorAll('div'), function (d) {
      if (d.contains(ta)) return;                          // 含输入框的不是工具行
      var txt = d.textContent || '';
      if (txt.indexOf('深度思考') === -1) return;           // 没有思考开关
      if (txt.replace(/\s/g, '').length > 300) return;      // 太大会选中整个页面
      if (!d.querySelector('button')) return;               // 没有按钮算不上工具行
      cands.push(d);
    });
    var row = null, rowScore = -1;
    cands.forEach(function (d) {
      var direct = Array.prototype.some.call(d.children, function (c) { return c.tagName === 'BUTTON'; });
      var score = (direct ? 1000 : 0) + d.querySelectorAll('*').length;
      if (score > rowScore) { rowScore = score; row = d; }
    });
    return row;
  }
};
DCP.modules.toolbar = Toolbar;

/* ===== modules/demoapi.js ===== */
/* ============================================================
 * modules/demoapi：chat-demo 页 API 覆盖（端点 / Key / 模型，三项各自独立）
 *
 * 背景：官方 API demo（cdn.deepseek.com/chat-demo）把端点与模型写死
 * （api.deepseek.com/anthropic/v1 + deepseek-flash），Key 存在页面
 * localStorage。用户需要换模型、以及换模型提供方的端点。
 *
 * 做法：拦截发往 /anthropic/v1/messages 的请求，按配置改写三项，
 * **彼此独立、留空即不干预**：
 *   - demoEndpoint：替换请求 URL 的 base（官方默认
 *     https://api.deepseek.com/anthropic/v1；填到不含 /messages 为止）
 *   - demoKey：替换 x-api-key 请求头（空 = 用页面里填的官方 Key）
 *   - demoModel：替换 body.model（空 = 官方默认 deepseek-flash）
 * **请求体其余部分一律原样**——deepseek_* 服务端工具（联网搜索/读链接）、
 * 系统提示、thinking / safety_check / title 等私有字段全都不碰。
 *
 * 协议实测（2026-11-17，bundle 分析）：demo 用 Anthropic Messages API，
 * POST {base}/messages，头 x-api-key，SSE 流式。该 URL 模式只存在于
 * demo 页，主站（/api/v0/chat/completion）不受影响。
 *
 * 端点兼容性（如实说明）：
 *   - 换成 DeepSeek 的中转/镜像（同协议）→ 全部照旧，工具也照样工作；
 *   - 换成别家提供方 → 请求原样直达，deepseek_* 工具类型对方不认
 *     （报错或被忽略），且对方必须说 Anthropic 协议；OpenAI 协议的
 *     端点需要额外的协议翻译层（未做）。
 *   - 模型与工具在当前实现里是同一个请求发出的（服务端工具），详见
 *     代码注释与交付说明——解耦需要客户端 agent 桥接，未做。
 * ============================================================ */
var DemoApi = {
  KEYS: { endpoint: 'demoEndpoint', key: 'demoKey', model: 'demoModel', multimodal: 'demoMultimodal', bridge: 'demoBridge', ctxLimit: 'demoCtxLimit', showCtxRing: 'demoShowCtxRing', showTps: 'demoShowTps', sessionSync: 'demoSessionSync', searchLimit: 'demoSearchLimit', toolMode: 'demoToolMode', titleSource: 'demoTitleSource' },
  DEFAULT_BASE: 'https://api.deepseek.com/anthropic/v1',
  // 只有精确官方域名才允许回退使用页面里的官方 Key；避免
  // https://deepseek.com.example/... 这类地址被正则误判为官方端点。
  isOfficialEndpoint: function (ep) {
    var raw = String(ep || this.DEFAULT_BASE).trim();
    try {
      var u = new URL(raw);
      return u.protocol === 'https:' && u.hostname.toLowerCase() === 'api.deepseek.com';
    } catch (e) {
      return false;
    }
  },
  // 模型输入建议（datalist），不限制手输
  HINTS: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'],

  /* ---------- 附件正文捕获（file_id → 文本） ----------
   * 页面把文件 POST 到 /anthropic/v1/files，响应只回 {id,size_bytes,filename,
   * mime_type}——没有正文。而 DeepSeek 明确不支持下载：GET .../files/{id} 只回
   * 元数据、GET .../files/{id}/content 404（官方文档原话「上传的原始文件和解析
   * 结果都不支持下载」）。所以对话请求里的 document/file_id 块**只有 DeepSeek
   * 自己的模型认**，第三方模型收到就是死引用（StepFun 直接 400 input_invalid，
   * 且该 400 不带 CORS 头，浏览器只报 Failed to fetch）。
   * 但上传请求本身就经过这里，FormData 里躺着真正的 File——趁上传时把正文按
   * file_id 记下来，桥接再内联成文本块，附件就能在自定义模型下用了。
   *
   * 只收文本类文件，**不设长度上限**：PDF/图片/Office 的字节按 UTF-8 解出来
   * 是乱码，硬塞给模型比给一行说明更糟，这是能力边界；而长度不该由我们截—
   * —模型上下文装不下时接口会直接报错，那是诚实失败，静默截断反而会让模型
   * 拿半份内容作答、还看不出少了什么（上下文圆圈会如实显示占用爆掉）。 */
  _fileTexts: {},
  _textExtRe: /\.(txt|md|csv|tsv|json|log|ya?ml|yml|ini|conf|cfg|html?|css|js|mjs|cjs|ts|tsx|jsx|py|go|java|c|cc|cpp|cxx|h|hpp|rs|rb|sh|bash|zsh|sql|xml|toml|dot|gv|proto|tex|bib|sty|cls|lisp|el|vim|r|lua|pl|pm|php|ps1|bat|cmd|awk|sed|make|mk|cmake|gradle|sbt|scala|kt|kts|swift|m|mm|dart|erl|hrl|ex|exs|clj|hs|lhs|ml|mli|fs|fsi|fsx|nim|cr|d|zig|v|sv|vhd|asm|s)$/i,

  captureFile: function (orig, selfArg, url, init) {
    var file = null, name = '', type = '';
    try {
      var b = init && init.body;
      if (b && typeof FormData !== 'undefined' && b instanceof FormData) {
        file = b.get('file');
        if (file) { name = file.name || ''; type = file.type || ''; }
      }
    } catch (e) {}
    if (!file) return orig.call(selfArg, url, init);
    return orig.call(selfArg, url, init).then(function (resp) {
      var bind = function (id) {
        if (!id) return;
        var rec = { name: name, type: type };
        DemoApi._fileTexts[id] = rec;
        // 只在开着自定义模型时值得存（官方端点下 document/image 块原生可用）
        if (!DCP.config.get('demoCustom')) return;
        var looksText = /^text\//.test(type) || DemoApi._textExtRe.test(name);
        if (looksText) {
          file.text().then(function (tx) { rec.text = tx; }).catch(function () {});
          return;
        }
        // 多模态：图片按 base64 存下来。第三方端点不认 DeepSeek 的 file 引用
        // （实测 StepFun 报 messages[0].content[0].source.type must be url or
        // base64），而 DeepSeek 自己的 Files API 又不支持下载原文件——唯一能
        // 把图片送到第三方模型的办法就是本地读成 base64 内联
        if (/^image\//.test(type)) {
          try {
            var reader = new FileReader();
            reader.onload = function () { rec.dataUrl = String(reader.result || ''); };
            reader.onerror = function () { rec.dataUrl = ''; };
            reader.readAsDataURL(file);
          } catch (e) {}
        }
      };
      try {
        resp.clone().json().then(function (j) { bind(j && j.id); }, function () {});
      } catch (e) {}
      return resp;
    });
  },

  // 注意：配置值不一定是字符串（如 demoCtxLimit 默认是数字 128000），
  // 直接 .trim() 会抛 TypeError 导致整个设置块注入失败
  cfg: function (k) {
    var v = DCP.config.get(this.KEYS[k]);
    return (v == null) ? '' : String(v);
  },
  base: function () { return this.cfg('endpoint').replace(/\/+$/, ''); },
  // 完整接口地址（含 /messages）。与 demobridge.normUrl 同一套归一逻辑——
  // 只填 base（StepFun 文档就是这格式）时补 /v1/messages，别再 404
  fullUrl: function () {
    var ep = this.base();
    if (!ep) return '';
    var B = DCP.modules.demoBridge;
    return (B && B.normUrl) ? B.normUrl(ep) : ep + '/messages';
  },

  /* ---------- 请求改写：端点 / Key / 模型 ---------- */
  // 必须写到 pageWindow()：油猴沙箱里 window 不是页面的 window，`window.fetch =`
  // 只改到沙箱全局、页面的 fetch 原封不动——demo 页整页走 fetch，桥接因此整个
  // 不工作（圆圈永远 0%，而主站走 XHR 不受影响，故只有 demo 页炸）
  patchFetch: function () {
    var self = this;
    var win = (typeof pageWindow === 'function') ? pageWindow() : window;
    if (!win.fetch) return;
    var orig = win.fetch;
    DemoApi._origFetch = orig;   // 桥接的出站请求走原生 fetch，避开本补丁的 URL 改写（否则搜索腿会被改写到第三方端点）
    win.fetch = function (input, init) {
      var isMessages = false, bridgeHandled = false;
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        isMessages = url.indexOf('/anthropic/v1/messages') !== -1;
        // 附件上传：顺手记下 file_id → 正文（详见 captureFile 注释）。必须在
        // 下面的 /messages 分支之前——两者 URL 不重叠，顺序只为少一次判断
        if (url.indexOf('/anthropic/v1/files') !== -1 && init && init.method === 'POST') {
          return self.captureFile(orig, this, url, init);
        }
        // 总开关关闭 = 完全官方逻辑（端点/Key/模型/桥接全部不干预）
        if (isMessages && DCP.config.get('demoCustom')) {
          var base = self.base(), key = self.cfg('key'), model = self.cfg('model');
          var officialEndpoint = self.isOfficialEndpoint(base);
          // 安全边界：官方 Key 只能发给精确 api.deepseek.com。第三方端点
          // 必须显式配置独立 Key，绝不静默回退，避免端点写错时泄露官方 Key。
          if (!officialEndpoint && !key) {
            return Promise.reject(new Error(DCP.t('第三方端点必须填写独立的 API Key；脚本不会把官方 DeepSeek Key 发送到非官方地址。')));
          }
          // 页面原始 DeepSeek Key（仅供 api.deepseek.com 的搜索/起名腿使用）
          var origDsKey = (init && init.headers && (init.headers['x-api-key'] || init.headers['X-API-Key'] || init.headers['X-Api-Key'])) || '';
          // 1) 端点：换成完整接口地址（fullUrl 已按 base/v1/messages 三种填法归一）
          var full = self.fullUrl();
          if (full) url = full;
          // 2) 请求头：第三方端点只保留用户显式配置的 Key，并移除原始官方鉴权头。
          if (key && init && init.headers) {
            var h = {};
            for (var k in init.headers) {
              if (!Object.prototype.hasOwnProperty.call(init.headers, k)) continue;
              if (!officialEndpoint && /^(x-api-key|authorization)$/i.test(k)) continue;
              h[k] = init.headers[k];
            }
            h['x-api-key'] = key;
            init = Object.assign({}, init, { headers: h });
          }
          // 3) body.model（其余字段原样，含 tools 数组）
          if (model && init && typeof init.body === 'string') {
            var body = JSON.parse(init.body);
            if (body && body.model !== model) {
              body.model = model;
              init = Object.assign({}, init, { body: JSON.stringify(body) });
            }
          }
          // 4) 桥接：端点非 DeepSeek 时，工具执行拆成「客户端工具循环 +
          //    DeepSeek 极小搜索腿」，demo 侧呈现仍为原生块（见 demobridge.js）
          if (DCP.modules.demoBridge && DCP.modules.demoBridge.active()) {
            bridgeHandled = true;
            var bridged = DCP.modules.demoBridge.intercept(url, init, origDsKey);
            if (bridged) return bridged;
          }
        }
      } catch (e) {}
      // 官方端点 / 未走桥接的请求也同步生成状态。旁路读取 response.clone()，
      // 不改页面拿到的响应；桥接请求由 demobridge 自己发 session:activity。
      var sync = DCP.modules.sessionSync;
      var syncRec = (isMessages && !bridgeHandled && sync && sync.enabled()) ? sync.beginNativeRequest() : null;
      try {
        var p = orig.call(this, url, init);
        return syncRec ? sync.observeNativeResponse(p, syncRec) : p;
      } catch (e) {
        if (syncRec) sync.finishNativeRequest(syncRec, 'error');
        throw e;
      }
    };
  },

  /* ---------- UI：注入官方设置弹窗（独立「自定义模型」tab） ---------- */
  // 官方弹窗是左侧导航（通用设置/数据管理）+ 右侧内容容器的结构。我们把配置块
  // 收进自建的第三个 tab：导航按钮插进左侧 rail，配置块作为内容容器的直接子
  // 级（与原生行同为 flex 列子级，天然对齐）；tab 显隐自己管，不猜官方机制。
  // 导航按钮直接复制原生按钮的 className（含构建哈希——运行时复制，官方重建
  // 后自动跟随），激活态令牌从"激活/未激活"两个原生按钮的类名差里取。
  injectUI: function () {
    var dlg = document.querySelector('[class*="dialogMain-"]');
    if (!dlg) return;
    var self = this;
    // 导航 = 含「通用设置/数据管理」文字的按钮的父容器；内容容器 = rail 兄弟
    // 里那个 flex 列的容器（都不依赖哈希类名）
    var navBtns = Array.prototype.filter.call(dlg.querySelectorAll('button'), function (b) {
      var t = (b.textContent || '').replace(/\s/g, '');
      return t === '通用设置' || t === '数据管理';
    });
    if (!navBtns.length) return;
    var rail = navBtns[0].parentElement;
    var content = null;
    Array.prototype.forEach.call(rail.parentElement.children, function (c) {
      if (!content && c !== rail && getComputedStyle(c).flexDirection === 'column') content = c;
    });
    if (!content) return;
    // 锚点仍用于取官方行的计算样式（标签/控件配色）——弹窗默认开在通用设置，
    // 该行可见；取不到就不注入（样式对齐优先）
    var anchor = null;
    Array.prototype.forEach.call(dlg.querySelectorAll('[class*="cell-"]'), function (c) {
      var t = (c.textContent || '').replace(/\s/g, '');
      if (/^(主题|语言|朗读音色|位置信息)/.test(t) && c.offsetParent !== null) anchor = c;
    });
    if (!anchor) return;
    // 接管：另一个脚本（deepseek-enhance）也往这个弹窗里注入「自定义模型」面
    // 板，而且它不管自己开没开自定义模型都会注入——两边用的是同一批 DOM id/
    // 属性（它那边是 dse- 前缀），谁先注入谁占位，后到的那个 injectUI 会当成
    // 「已在位」直接早退，面板永远显示不出来。本项目活动时先把对方那一份摘掉，
    // 用自己的 dcp- 前缀重建，两边各管各的、互不遮挡。
    var foreign = dlg.querySelector('[data-dse-api-wrap]');
    if (foreign) foreign.remove();
    var foreignNav = document.getElementById('dse-demo-tab');
    if (foreignNav) foreignNav.remove();
    var existing = dlg.querySelector('[data-dcp-api-wrap]');
    var navExisting = document.getElementById('dcp-demo-tab');
    if (existing && navExisting && existing.parentElement === content) {
      if (this._tabCtl) this._tabCtl.sync();   // 已在位：只同步显隐状态
      return;
    }
    if (existing) existing.remove();
    if (navExisting) navExisting.remove();
    // 上次注入绑定的监听/观察器先摘掉，避免重复累积
    if (this._tabCtl) {
      try { this._tabCtl.mo.disconnect(); } catch (e) {}
      try { this._tabCtl.rail.removeEventListener('click', this._tabCtl.onNativeClick, true); } catch (e) {}
      this._tabCtl = null;
    }
    var pick = function (el, props) {
      var cs = getComputedStyle(el), o = {};
      props.forEach(function (p) { o[p] = cs[p]; });
      return o;
    };
    var refLabel = anchor.querySelector('[class*="label-"]') || anchor;
    var refCtrl = anchor.querySelector('button') || anchor;
    var labelCss = pick(refLabel, ['color', 'fontSize']);
    var ctrlCss = pick(refCtrl, ['backgroundColor', 'color']);
    // 注意 box-sizing：demo 的全局 reset 不覆盖注入节点，默认 content-box 会
    // 让 60px 的行变成 84px（padding 外加）——与官方行观感不一致
    // 紧凑规格：行高从 60px 收到 44px、控件 36→32px、说明行 12→11px。
    // 这一屏有 6 行 + 2 条说明，按原规格设置面板要滚好长才能看到「高级选项」
    var rowBase = 'display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:44px;padding:6px 0;font-size:14px';
    var ctrlStyle = 'box-sizing:border-box;width:240px;height:32px;border:none;outline:none;border-radius:16px;padding:0 14px;' +
      'font-size:14px;background:' + (ctrlCss.backgroundColor || 'rgba(127,127,127,.18)') + ';' +
      'color:' + (ctrlCss.color || 'inherit');
    var descStyle = 'box-sizing:border-box;font-size:11px;line-height:1.4;opacity:.55;padding:0 0 3px';

    var self = this;
    var mkRow = function (labelText, cfgKey, placeholder, title, isPassword, hints, listId) {
      var row = document.createElement('div');
      row.setAttribute('data-dcp-api-row', cfgKey);
      row.style.cssText = rowBase;
      var label = document.createElement('div');
      label.textContent = DCP.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var input = document.createElement('input');
      input.type = isPassword ? 'password' : 'text';
      if (hints && listId) input.setAttribute('list', listId);
      else if (cfgKey === 'model') input.setAttribute('list', 'dcp-model-hints');
      input.placeholder = placeholder;
      input.value = self.cfg(cfgKey);
      input.title = title;
      input.style.cssText = ctrlStyle;
      // 即改即存（输入 300ms 防抖、失焦立即）。commit 挂到 input._dseCommit 上，
      // 底部「保存」按钮靠它冲掉还没落盘的防抖值
      var commit = function () { DCP.config.set(self.KEYS[cfgKey], input.value.trim()); };
      input._dseCommit = commit;
      input.addEventListener('input', function () {
        clearTimeout(input._dseT);
        input._dseT = setTimeout(function () { input._dseT = null; commit(); }, 300);
      });
      input.addEventListener('blur', function () {
        clearTimeout(input._dseT); input._dseT = null;
        commit();
      });
      row.appendChild(label);
      row.appendChild(input);
      return row;
    };

    // 固定选项（鉴权头/桥接）用原生下拉，不用带 datalist 的文本框
    var CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23888' fill='none' stroke-width='1.5' stroke-linecap='round'/></svg>\")";
    var mkSelect = function (labelText, cfgKey, options, defVal, title) {
      var row = document.createElement('div');
      row.setAttribute('data-dcp-api-row', cfgKey);
      row.style.cssText = rowBase;
      var label = document.createElement('div');
      label.textContent = DCP.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var sel = document.createElement('select');
      sel.title = title;
      sel.style.cssText = ctrlStyle + 'appearance:none;-webkit-appearance:none;cursor:pointer;' +
        'padding-right:32px;background-image:' + CHEVRON + ';background-repeat:no-repeat;background-position:right 12px center;';
      options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o[0]; opt.textContent = DCP.t(o[1]);
        sel.appendChild(opt);
      });
      sel.value = self.cfg(cfgKey) || defVal;
      sel.addEventListener('change', function () { DCP.config.set(self.KEYS[cfgKey], sel.value); });
      row.appendChild(label);
      row.appendChild(sel);
      return row;
    };

    var wrap = document.createElement('div');
    wrap.setAttribute('data-dcp-api-wrap', '1');

    // 主开关：关=完全官方逻辑（DeepSeek 全套）；开=才允许自定义
    var swRow = document.createElement('div');
    swRow.setAttribute('data-dcp-api-row', 'custom');
    swRow.style.cssText = rowBase + 'cursor:pointer;user-select:none';
    var swLabel = document.createElement('div');
    swLabel.textContent = DCP.t('自定义模型');
    swLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var swTrack = document.createElement('div');
    var swKnob = document.createElement('div');
    swTrack.style.cssText = 'width:44px;height:26px;border-radius:13px;position:relative;transition:background .15s;flex:0 0 auto';
    swKnob.style.cssText = 'position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.3)';
    swTrack.appendChild(swKnob);
    var cfgBox = document.createElement('div');
    cfgBox.setAttribute('data-dcp-cfg-box', '1');
    var paintSw = function (on) {
      var accent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
      swTrack.style.background = on ? accent : 'rgba(127,127,127,.35)';
      swKnob.style.left = on ? '20px' : '2px';
      cfgBox.style.display = on ? 'block' : 'none';
    };
    swRow.addEventListener('click', function () {
      var v = !DCP.config.get('demoCustom');
      DCP.config.set('demoCustom', v);
      paintSw(v);
    });
    paintSw(!!DCP.config.get('demoCustom'));
    swRow.appendChild(swLabel); swRow.appendChild(swTrack);
    wrap.appendChild(swRow);
    wrap.appendChild(cfgBox);

    // 行+可见描述行的包装。注意：这是 var 函数表达式，定义必须在所有调用
    // 之前——早前端点/Key 行在定义之前调用，执行时 withDesc 还是 undefined，
    // TypeError 让整个 injectUI 中断、设置块整体不注入（实机抓到）
    var withDesc = function (row, desc) {
      var d = document.createElement('div');
      d.style.cssText = descStyle;
      d.textContent = DCP.t(desc);
      var box = document.createElement('div');
      box.appendChild(row); box.appendChild(d);
      return box;
    };

    // 布尔开关行（与主开关同款样式）——供高级选项里的布尔配置用
    var mkSwitch = function (labelText, cfgKey, desc) {
      var row = document.createElement('div');
      row.setAttribute('data-dcp-api-row', cfgKey);
      row.style.cssText = rowBase + 'cursor:pointer;user-select:none';
      var label = document.createElement('div');
      label.textContent = DCP.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var track = document.createElement('div');
      var knob = document.createElement('div');
      track.style.cssText = swTrack.style.cssText;
      knob.style.cssText = swKnob.style.cssText;
      track.appendChild(knob);
      var paint = function (on) {
        var accent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
        track.style.background = on ? accent : 'rgba(127,127,127,.35)';
        knob.style.left = on ? '20px' : '2px';
      };
      row.addEventListener('click', function () {
        var v = !DCP.config.get(self.KEYS[cfgKey]);
        DCP.config.set(self.KEYS[cfgKey], v);
        paint(!!v);
      });
      paint(!!DCP.config.get(self.KEYS[cfgKey]));
      row.appendChild(label); row.appendChild(track);
      return desc ? withDesc(row, desc) : row;
    };

    // 端点/Key 两行的说明较长，既放可见描述行（withDesc），也放输入框
    // hover 提示（title），两处共用同一字符串
    var ENDPOINT_DESC = DCP.t('填 Base URL 或完整地址都认：https://api.stepfun.com/step_plan（文档里的 Base URL）、https://api.stepfun.com/step_plan/v1、或 .../v1/messages，脚本自动补全。留空 = 官方 ' + DemoApi.DEFAULT_BASE);
    var KEY_DESC = DCP.t('第三方端点必须填写独立 Key；只有精确官方 api.deepseek.com 端点可留空并使用页面官方 Key');
    cfgBox.appendChild(withDesc(mkRow('API 端点', 'endpoint', DemoApi.DEFAULT_BASE, ENDPOINT_DESC), ENDPOINT_DESC));
    cfgBox.appendChild(withDesc(mkRow('API Key', 'key', DCP.t('（第三方端点必填）'), KEY_DESC, true), KEY_DESC));
    cfgBox.appendChild(mkRow('模型', 'model', DCP.t('deepseek-flash（官方默认）'),
      DCP.t('留空 = 官方默认 deepseek-flash；只更换请求中的 model 字段'), false, DemoApi.HINTS, 'dcp-model-hints'));
    // 多模态开关：决定图片怎么发。开=转 base64 内联（多模态模型）；
    // 关=换成文字说明——纯文本模型即便收到图也是白烧 token，多半还被拒。
    // 注意 mkSwitch 内部已包 withDesc，这里别再套一层（否则描述渲染两遍）
    cfgBox.appendChild(mkSwitch('模型支持图片（多模态）', 'multimodal',
      DCP.t('开=图片转 base64 内联发送；关=只发「当前模型不支持图片」的文字说明。纯文本模型请关掉，省 token 也避免被端点拒')));

    /* ---------- 保存按钮（放在主字段下方、测试行之前：一眼可见，不用滚动） ----------
     * 这些项本来就是即改即存（输入 300ms 防抖、下拉 change 即时、失焦立即），
     * 但用户看不出来，也不确定直接关掉设置会不会丢——于是给一个显式「保存」：
     * 点一下冲掉所有未落盘的防抖写入、立即写盘并反馈；左边一句「改动会自动保存」
     * 把真实行为说明白，关不关面板都不会丢 */
    var saveRow = document.createElement('div');
    saveRow.setAttribute('data-dcp-api-row', 'save');
    saveRow.style.cssText = rowBase + 'margin-top:2px';
    var saveHint = document.createElement('div');
    saveHint.textContent = DCP.t('改动会自动保存，关掉面板也不会丢；点此可立即保存并确认');
    saveHint.style.cssText = 'flex:1;font-size:11px;line-height:1.4;opacity:.6;padding-right:8px';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = DCP.t('保存');
    var saveAccent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
    saveBtn.style.cssText = 'box-sizing:border-box;height:32px;border:none;outline:none;cursor:pointer;' +
      'border-radius:16px;padding:0 20px;font-size:13px;background:' + saveAccent + ';color:#fff;flex:0 0 auto';
    var saveBtnTimer = null;
    saveBtn.addEventListener('click', function () {
      // 冲掉未落盘的防抖写入（刚打完字还没到 300ms 的情况）
      cfgBox.querySelectorAll('input').forEach(function (inp) {
        if (inp._dseT) { clearTimeout(inp._dseT); inp._dseT = null; }
        if (typeof inp._dseCommit === 'function') inp._dseCommit();
      });
      DCP.config.save();
      Utils.toast(DCP.t('已保存'), 1500);
      saveBtn.textContent = DCP.t('已保存 ✓');
      clearTimeout(saveBtnTimer);
      saveBtnTimer = setTimeout(function () { saveBtn.textContent = DCP.t('保存'); }, 1600);
    });
    saveRow.appendChild(saveHint);
    saveRow.appendChild(saveBtn);
    cfgBox.appendChild(saveRow);
    // 模型测试：一发极小请求验证端点/Key/模型是否可用，并让模型自述身份——
    // DeepSeek 会答"我是DeepSeek"，第三方模型会答出自己的真实身份，用户据此
    // 确认切换真的生效了
    var testRow = document.createElement('div');
    testRow.setAttribute('data-dcp-api-row', 'test');
    testRow.style.cssText = rowBase;
    var testLabel = document.createElement('div');
    testLabel.textContent = DCP.t('测试连接与模型身份');
    testLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.textContent = DCP.t('测试');
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
    testBtn.style.cssText = 'box-sizing:border-box;height:32px;border:none;outline:none;cursor:pointer;' +
      'border-radius:16px;padding:0 18px;font-size:13px;background:' + accent + ';color:#fff;flex:0 0 auto';
    var testResult = document.createElement('div');
    testResult.setAttribute('data-dcp-test-result', '1');
    testResult.style.cssText = 'display:none;box-sizing:border-box;font-size:11px;line-height:1.5;padding:1px 0 6px;white-space:pre-wrap;word-break:break-all';
    testBtn.addEventListener('click', function () {
      testResult.style.display = 'block';
      testResult.style.color = 'inherit';
      testResult.textContent = DCP.t('测试中…');
      var t0 = Date.now();
      var u = self.fullUrl() || (DemoApi.DEFAULT_BASE.replace(/\/+$/, '') + '/messages');
      var model = (DCP.config.get('demoModel') || '').trim() || 'deepseek-flash';
      var officialEndpoint = self.isOfficialEndpoint(self.base());
      // Key：第三方端点必须使用独立 Key；只有精确官方端点才能回退页面官方 Key。
      var key = (DCP.config.get('demoKey') || '').trim();
      if (!key && officialEndpoint) { try { key = localStorage.getItem('chat-demo:api-key') || ''; } catch (e) {} }
      if (!officialEndpoint && !key) {
        testResult.style.color = '#f87171';
        testResult.textContent = '❌ ' + DCP.t('第三方端点必须填写独立的 API Key；脚本不会把官方 DeepSeek Key 发送到非官方地址。');
        return;
      }
      // 与桥接同一套：只用 Authorization: Bearer（详见 demobridge.keyHeader 注释）
      var headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = 'Bearer ' + key;
      (DemoApi._origFetch || window.fetch)(u, {
        method: 'POST', headers: headers,
        body: JSON.stringify({
          model: model, max_tokens: 1024, thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: DCP.t('你是什么AI模型？请用一句话直接说明你的模型名称和开发方，不要复述这个问题。') }]
        })
      }).then(function (resp) {
        var ms = Date.now() - t0;
        if (!resp.ok) {
          return resp.text().then(function (t) {
            var m = t; try { var j = JSON.parse(t); m = (j.error && j.error.message) || t; } catch (e) {}
            testResult.style.color = '#f87171';
            testResult.textContent = '❌ ' + DCP.t('连接失败') + '（HTTP ' + resp.status + '，' + ms + 'ms）\n' + String(m).slice(0, 200);
          });
        }
        return resp.json().then(function (j) {
          var txt = (j.content || []).filter(function (b) { return b.type === 'text'; })
            .map(function (b) { return b.text || ''; }).join('').trim();
          testResult.style.color = '#4ade80';
          testResult.textContent = '✅ ' + DCP.t('连接成功') + '（' + ms + 'ms）· ' + DCP.t('模型') + '：' + (j.model || model) +
            '\n' + DCP.t('模型自述') + '：' + (txt ||
            (DCP.t('（未获得文本回复') + '，stop_reason=' + (j.stop_reason || '?') + '，内容块=' + (j.content || []).map(function (b) { return b.type; }).join(',') + '）'));
        });
      }).catch(function (e) {
        testResult.style.color = '#f87171';
        var hint = (e && e.name === 'TypeError') ? DCP.t('（浏览器安全策略拦截了跨域请求，可在高级选项切换鉴权头试试）') : '';
        testResult.textContent = '❌ ' + DCP.t('请求失败') + '：' + String(e && e.message || e).slice(0, 150) + hint;
      });
    });
    testRow.appendChild(testLabel); testRow.appendChild(testBtn);
    cfgBox.appendChild(testRow);
    cfgBox.appendChild(testResult);

    // 高级选项：默认折叠，配人话说明（这两个是排障开关，不是常规配置）
    var advToggle = document.createElement('div');
    advToggle.setAttribute('data-dcp-api-row', 'advanced');
    advToggle.style.cssText = rowBase + 'cursor:pointer;user-select:none';
    var advLabel = document.createElement('div');
    advLabel.textContent = DCP.t('高级选项');
    advLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var advArrow = document.createElement('span');
    advArrow.textContent = '⌄';
    advArrow.style.cssText = 'transition:transform .15s;opacity:.6;font-size:16px;width:24px;text-align:center';
    advToggle.appendChild(advLabel); advToggle.appendChild(advArrow);
    var advBox = document.createElement('div');
    advBox.setAttribute('data-dcp-advanced', '1');
    advBox.style.display = 'none';
    advToggle.addEventListener('click', function () {
      var open = advBox.style.display !== 'none';
      advBox.style.display = open ? 'none' : 'block';
      advArrow.style.transform = open ? '' : 'rotate(180deg)';
    });
    // 每轮搜索次数上限：默认不限制，预算紧的用户可显式限制。
    var SEARCH_LIMIT_TITLE = DCP.t('每轮回答中 web_search 的次数上限。unlimited=不限制，适合预算充裕、需要多轮检索的任务；2=最多两次；1=最多一次，适合节省预算。');
    var SEARCH_LIMIT_DESC = DCP.t('unlimited：不限制（默认）；2：每轮最多两次；1：每轮最多一次');
    advBox.appendChild(withDesc(mkSelect('每轮搜索次数上限', 'searchLimit',
      [['unlimited', 'unlimited：不限制'], ['2', '2：最多两次'], ['1', '1：最多一次']], 'unlimited', SEARCH_LIMIT_TITLE), SEARCH_LIMIT_DESC));
    // 工具调用方式：选项文本已自明（native：模型自己搜 / searchapi：只付搜索费），
    // 可见描述行给一句人话结论，完整差异（计费/能力）放 hover 提示
    var TOOLMODE_TITLE = DCP.t('模型要搜索时，谁来执行：native=交给 DeepSeek 的模型在对话里完成，能多轮搜、能读网页，但每轮搜索另付约 2 分钱模型费；searchapi=直接调 DeepSeek 的搜索接口，一次约 0.00075 美元、不经模型，搜什么由当前模型决定。两种在界面上看起来一样');
    var TOOLMODE_DESC = DCP.t('模型要搜索时谁来执行：native=DeepSeek 的模型自己搜，另付约 2 分钱/轮模型费；searchapi=直调搜索接口，每次约 0.00075 美元、不经模型');
    advBox.appendChild(withDesc(mkSelect('工具调用方式', 'toolMode',
      [['native', 'native：模型自己搜'], ['searchapi', 'searchapi：只付搜索费']], 'native', TOOLMODE_TITLE), TOOLMODE_DESC));
    // 起名来源：官方页的 title 通道第三方端点没有，用一条极小腿补。来源三选一
    // ——deepseek=官方端点起名腿（title 参数、约 $0.001/次、标题质量官方级）；
    // model=当前自定义模型按提示词起名（费用走当前端点、不经 DeepSeek）；
    // off=不起名（首条消息截断）。任一来源失败都退回首条消息截断
    var TITLE_SOURCE_TITLE = DCP.t('新对话首轮回答后生成会话标题的来源：deepseek=打 DeepSeek 官方端点用 title 参数起名（约 $0.001/次、标题质量官方级、用页面里那把 DeepSeek Key）；model=让当前自定义模型按提示词起名（一次极小非流式请求、费用走当前端点、不经 DeepSeek）；off=不起名，用首条消息截断。任一来源失败都退回首条消息截断');
    var TITLE_SOURCE_DESC = DCP.t('deepseek：官方起名腿，约 $0.001/次；model：自定义模型起名，费用走当前端点；off：用首条消息截断');
    advBox.appendChild(withDesc(mkSelect('起名来源', 'titleSource',
      [['deepseek', 'deepseek：官方起名腿'], ['model', 'model：自定义模型起名'], ['off', 'off：用首条消息截断']], 'deepseek', TITLE_SOURCE_TITLE), TITLE_SOURCE_DESC));
    advBox.appendChild(withDesc(mkRow('上下文窗口', 'ctxLimit', '128000',
      DCP.t('所用模型的上下文窗口（tokens）。可填 128000，也可写 128k / 1m。输入框旁的圆圈按 占用/窗口 显示百分比'), false, null, null),
      DCP.t('所用模型的上下文窗口（tokens）。可填 128000，也可写 128k / 1m。输入框旁的圆圈按 占用/窗口 显示百分比')));
    advBox.appendChild(mkSwitch('显示上下文占用环', 'showCtxRing',
      DCP.t('在输入工具条发送按钮一侧显示上下文占用环；关闭后仍会继续统计，只是不显示')));
    advBox.appendChild(mkSwitch('显示实时 TPS', 'showTps',
      DCP.t('在上下文占用环左侧显示实时输出速率（thinking + 正文 token/秒）；仅自定义模型桥接工作时生效')));
    advBox.appendChild(mkSwitch('跨标签同步会话', 'sessionSync',
      DCP.t('侧栏实时显示生成中的转圈和生成完毕的蓝点；后台标签开着同一条会话时，对方完成后自动同步正文。刷新页面只恢复一次当前会话。')));
    advBox.appendChild(withDesc(mkSelect('搜索来源', 'bridge',
      [['auto', 'auto：DeepSeek 原生搜索'], ['off', 'off：用模型自带的']], 'auto'),
      'auto=换第三方模型时，搜索仍由 DeepSeek 原生执行、界面原样呈现（推荐）；off=完全使用第三方自己的能力（多数没有搜索）'));
    cfgBox.appendChild(advToggle);
    cfgBox.appendChild(advBox);

    var mkList = function (id, items) {
      if (document.getElementById(id)) return;
      var dl = document.createElement('datalist');
      dl.id = id;
      items.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      });
      document.body.appendChild(dl);
    };
    mkList('dcp-model-hints', this.HINTS);

    // 配置块作为内容容器的直接子级（与原生行同列，天然对齐）
    content.appendChild(wrap);

    /* ---------- 自建「自定义模型」tab ---------- */
    // 导航按钮复制原生按钮的 className（构建哈希运行时复制，官方重建自动跟随）；
    // 激活态令牌 = 激活按钮与未激活按钮类名差集里的那一项
    var refNav = navBtns.filter(function (b) { return !/Active/.test(b.className); })[0] || navBtns[0];
    var activeItem = navBtns.filter(function (b) { return /Active/.test(b.className); })[0] || null;
    var activeToken = null;
    if (activeItem && activeItem !== refNav) {
      var at = activeItem.className.split(/\s+/), it = refNav.className.split(/\s+/);
      activeToken = at.filter(function (t) { return t && it.indexOf(t) === -1; })[0] || null;
    }
    var nav = document.createElement('button');
    nav.id = 'dcp-demo-tab';
    nav.type = 'button';
    nav.className = refNav.className;
    var navIco = document.createElement('span');
    navIco.style.cssText = 'display:inline-flex;flex:0 0 auto';
    navIco.innerHTML = this.ICON_TAB;
    nav.appendChild(navIco);
    nav.appendChild(document.createTextNode(DCP.t('自定义模型')));
    rail.appendChild(nav);

    var applyState = function (on) {
      if (activeToken) {
        nav.classList.toggle(activeToken, !!on);
        // 只夺不还：原生 tab 的激活态由 React 自己管，我们开机时从原生激活项
        // 手上摘掉令牌即可；点回原生 tab 时 React 会重新打上
        if (on && activeItem) activeItem.classList.remove(activeToken);
      }
      Array.prototype.forEach.call(content.children, function (c) {
        if (c === wrap) c.style.display = on ? '' : 'none';
        else c.style.display = on ? 'none' : '';
      });
    };
    // 我们的 tab 被点 → 藏原生行、显示配置块
    nav.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); applyState(true); });
    // 原生 tab 被点（capture 先行于 React 处理器）→ 回到原生显隐
    var onNativeClick = function (e) {
      if (e.target === nav || (nav.contains && nav.contains(e.target))) return;
      applyState(false);
    };
    rail.addEventListener('click', onNativeClick, true);
    // React 重换内容子级时（重渲染/切 tab），我们的 tab 开着就立刻重新藏原生行
    var mo = new MutationObserver(function () { if (ctl.on) applyState(true); });
    mo.observe(content, { childList: true });
    var ctl = { rail: rail, content: content, nav: nav, wrap: wrap, mo: mo, onNativeClick: onNativeClick, on: false,
      sync: function () { if (ctl.on) applyState(true); } };
    this._tabCtl = ctl;
    applyState(false);
  },

  // demo 页左上角的应用名是纯文字“API 使用 demo”，与 DeepSeek 官方标识不一致。
  // 官方主站的标识是内联 SVG（鲸鱼 + DeepSeek 字标，143×23）——fe-static 上没有
  // 对应静态文件、只存在于主站 bundle，故以资源文件随脚本分发、构建时内联。
  // SVG 的 fill 用 var(--dsw-alias-brand-primary)，该变量由标识元素自身携带
  // （#5686fe，官方主站同款），整套 markup 原样可用、无需替换颜色

  // 自建 tab 的图标：官方「深度思考」原子图标（viewBox 0 0 14 14，原样提取），
  // 渲染 16x16 与导航栏其他图标对齐
  ICON_TAB: '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z" fill="currentColor"></path>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z" fill="currentColor"></path></svg>',
  OFFICIAL_LOGO: '<svg width="143" height="23" viewBox="0 0 143 23" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M78.6785 18.6823H77.1078V16.2472H78.6785C79.6513 16.2472 80.6342 16.0047 81.2672 15.3308C81.9009 14.6569 82.14 13.6232 82.14 12.59C82.14 11.5569 81.9109 10.5231 81.2672 9.84981C80.6247 9.17594 79.6513 8.93343 78.6785 8.93343C77.7056 8.93343 76.7228 9.17594 76.0886 9.84981C75.4549 10.5237 75.2158 11.5569 75.2158 12.59V22.5909H72.4605V6.50781H75.2158V7.53204H75.7209C75.7757 7.4689 75.8304 7.41525 75.8857 7.36161C76.5752 6.73244 77.6308 6.50781 78.6684 6.50781C80.2944 6.50781 81.9193 6.91236 82.9849 8.03549C84.0499 9.15861 84.4265 10.8835 84.4265 12.6001C84.4265 14.3166 84.0404 16.0326 82.9849 17.1647C81.9288 18.2967 80.2944 18.6834 78.6785 18.6834V18.6823Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M36.7486 6.94097H38.3188V9.37609H36.7486C35.7753 9.37609 34.7929 9.61859 34.1593 10.2925C33.5257 10.9663 33.2871 12.0001 33.2871 13.0332C33.2871 14.0664 33.5167 15.0996 34.1593 15.7734C34.8019 16.4473 35.7753 16.6898 36.7486 16.6898C37.722 16.6898 38.7049 16.4473 39.3385 15.7734C39.9722 15.0996 40.2108 14.0664 40.2108 13.0332V3.02344H42.9655V19.116H40.2108V18.0918H39.7057C39.6503 18.1544 39.5956 18.2086 39.5403 18.2622C38.8513 18.8908 37.7952 19.116 36.7576 19.116C35.1321 19.116 33.5067 18.712 32.4416 17.5889C31.3766 16.4658 31 14.7403 31 13.0243C31 11.3083 31.3856 9.59177 32.4416 8.45971C33.5067 7.33658 35.1321 6.94097 36.7486 6.94097Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M56.7855 12.8155V13.795H49.4483V11.8454H54.3152C54.2051 11.1358 53.9481 10.4709 53.4887 9.9853C52.8277 9.2846 51.808 9.03316 50.7983 9.03316C49.7886 9.03316 48.7688 9.2846 48.1078 9.9853C47.4468 10.686 47.2076 11.7555 47.2076 12.816C47.2076 13.8766 47.4462 14.9544 48.1078 15.6462C48.7688 16.338 49.788 16.5989 50.7983 16.5989C51.8085 16.5989 52.8277 16.3475 53.4887 15.6462C53.5804 15.5473 53.6631 15.4395 53.7458 15.3316H56.4642C56.2256 16.1765 55.849 16.9403 55.2796 17.5332C54.1777 18.692 52.479 19.1145 50.7983 19.1145C49.1175 19.1145 47.4188 18.701 46.3169 17.5332C45.215 16.3653 44.8111 14.5862 44.8111 12.816C44.8111 11.0458 45.2061 9.25778 46.3169 8.0989C47.4283 6.94001 49.1175 6.51758 50.7983 6.51758C52.479 6.51758 54.1777 6.93107 55.2796 8.0989C56.3904 9.26672 56.7855 11.0458 56.7855 12.816V12.8155Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M70.6151 12.8155V13.795H63.2779V11.8454H68.1448C68.0341 11.1358 67.7776 10.4709 67.3183 9.9853C66.6573 9.2846 65.6376 9.03316 64.6279 9.03316C63.6182 9.03316 62.5984 9.2846 61.9374 9.9853C61.2764 10.686 61.0372 11.7555 61.0372 12.816C61.0372 13.8766 61.2758 14.9544 61.9374 15.6462C62.5984 16.338 63.6182 16.5989 64.6279 16.5989C65.6376 16.5989 66.6573 16.3475 67.3183 15.6462C67.4105 15.5473 67.4927 15.4395 67.5748 15.3316H70.2938C70.0546 16.1765 69.678 16.9403 69.1086 17.5332C68.0067 18.692 66.3081 19.1145 64.6279 19.1145C62.9476 19.1145 61.2484 18.701 60.1465 17.5332C59.0446 16.3653 58.6406 14.5862 58.6406 12.816C58.6406 11.0458 59.0357 9.25778 60.1465 8.0989C61.2579 6.94001 62.9471 6.51758 64.6279 6.51758C66.3086 6.51758 68.0067 6.93107 69.1086 8.0989C70.22 9.26672 70.6151 11.0458 70.6151 12.816V12.8155Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M92.2781 19.1156C93.9589 19.1156 95.657 18.8731 96.7589 18.1813C97.8608 17.4896 98.2653 16.438 98.2653 15.3959C98.2653 14.3538 97.8697 13.2932 96.7589 12.6104C95.657 11.9276 93.9583 11.6756 92.2781 11.6756C91.5612 11.6756 90.9002 11.5767 90.4319 11.3163C89.9637 11.0464 89.7893 10.6424 89.7893 10.2379C89.7893 9.83332 89.9547 9.42039 90.4319 9.15944C90.9002 8.88955 91.626 8.80015 92.3418 8.80015C93.0576 8.80015 93.7834 8.89905 94.2528 9.15944C94.721 9.42933 94.8954 9.83332 94.8954 10.2379H97.6959C97.6959 9.1952 97.3383 8.13522 96.3376 7.4524C95.3368 6.76958 93.803 6.51758 92.2787 6.51758C90.7543 6.51758 89.2211 6.76008 88.2198 7.4524C87.219 8.14416 86.8603 9.1952 86.8603 10.2379C86.8603 11.2805 87.2185 12.3405 88.2198 13.0233C89.2205 13.7061 90.7538 13.9582 92.2787 13.9582C93.0682 13.9582 93.941 14.0571 94.464 14.3174C94.9881 14.5784 95.1714 14.9913 95.1714 15.3959C95.1714 15.8004 94.9881 16.2133 94.464 16.4743C93.941 16.7347 93.142 16.8336 92.3524 16.8336C91.5629 16.8336 90.7543 16.7347 90.2397 16.4743C89.7256 16.2139 89.5323 15.8004 89.5323 15.3959H86.2998C86.2998 16.4385 86.6943 17.4985 87.8063 18.1813C88.9171 18.8641 90.5979 19.1156 92.2787 19.1156H92.2781Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M112.094 12.8155V13.795H104.757V11.8454H109.624C109.514 11.1358 109.257 10.4709 108.798 9.9853C108.136 9.2846 107.117 9.03316 106.106 9.03316C105.095 9.03316 104.077 9.2846 103.416 9.9853C102.755 10.686 102.517 11.7555 102.517 12.816C102.517 13.8766 102.755 14.9544 103.416 15.6462C104.077 16.338 105.097 16.5989 106.106 16.5989C107.116 16.5989 108.136 16.3475 108.798 15.6462C108.889 15.5473 108.972 15.4395 109.054 15.3316H111.772C111.533 16.1765 111.157 16.9403 110.588 17.5332C109.486 18.692 107.787 19.1145 106.106 19.1145C104.425 19.1145 102.727 18.701 101.625 17.5332C100.524 16.3653 100.12 14.5862 100.12 12.816C100.12 11.0458 100.515 9.25778 101.625 8.0989C102.737 6.94001 104.427 6.51758 106.106 6.51758C107.786 6.51758 109.486 6.93107 110.588 8.0989C111.699 9.26672 112.093 11.0458 112.093 12.816L112.094 12.8155Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M125.924 12.8155V13.795H118.586V11.8454H123.453C123.344 11.1358 123.086 10.4709 122.627 9.9853C121.966 9.2846 120.947 9.03316 119.936 9.03316C118.926 9.03316 117.907 9.2846 117.246 9.9853C116.585 10.686 116.346 11.7555 116.346 12.816C116.346 13.8766 116.585 14.9544 117.246 15.6462C117.907 16.338 118.927 16.5989 119.936 16.5989C120.946 16.5989 121.966 16.3475 122.627 15.6462C122.719 15.5473 122.801 15.4395 122.885 15.3316H125.602C125.363 16.1765 124.987 16.9403 124.418 17.5332C123.316 18.692 121.617 19.1145 119.936 19.1145C118.256 19.1145 116.558 18.701 115.456 17.5332C114.354 16.3653 113.949 14.5862 113.949 12.816C113.949 11.0458 114.344 9.25778 115.456 8.0989C116.567 6.94001 118.256 6.51758 119.936 6.51758C121.617 6.51758 123.315 6.93107 124.418 8.0989C125.529 9.26672 125.924 11.0458 125.924 12.816V12.8155Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M130.524 3.02344H127.77V19.116H130.524V3.02344Z" fill="var(--dsw-alias-brand-primary)"></path><path d="M135.227 12.4384L139.744 19.1146H136.337L131.819 12.4384L136.337 7.07422H139.744L135.227 12.4384Z" fill="var(--dsw-alias-brand-primary)"></path><g clip-path="url(#clip0_4329_19769)"><path d="M26.5174 3.39471C26.235 3.2567 26.1137 3.52006 25.9487 3.65346C25.8923 3.69659 25.8446 3.75294 25.7969 3.80469C25.3846 4.24516 24.9027 4.53439 24.2737 4.49989C23.3536 4.44814 22.5682 4.73737 21.8735 5.44119C21.7258 4.57349 21.2353 4.0554 20.4889 3.72304C20.0985 3.55054 19.7034 3.37746 19.4297 3.00197C19.2388 2.73459 19.1865 2.43673 19.091 2.14289C19.0301 1.96579 18.9697 1.78466 18.7656 1.75418C18.5442 1.71968 18.4574 1.90541 18.3705 2.06067C18.0232 2.69549 17.8887 3.39471 17.9019 4.10313C17.9324 5.6965 18.6051 6.96556 19.9421 7.86834C20.0939 7.97184 20.133 8.07535 20.0852 8.22658C19.9938 8.53766 19.8857 8.83955 19.7903 9.15063C19.7293 9.34901 19.6385 9.39271 19.4257 9.30588C18.692 8.9994 18.0583 8.54571 17.4982 7.99772C16.5477 7.07827 15.6881 6.06336 14.6162 5.26869C14.3644 5.08296 14.1125 4.91045 13.8521 4.746C12.7584 3.68394 13.9952 2.81164 14.2816 2.70814C14.5812 2.60003 14.3857 2.22857 13.4179 2.23317C12.4502 2.2372 11.5646 2.56151 10.4359 2.99335C10.2708 3.05832 10.0972 3.10547 9.91951 3.14457C8.8954 2.95022 7.83162 2.90709 6.72069 3.03245C4.62877 3.26533 2.95777 4.25436 1.72954 5.94261C0.254043 7.97184 -0.0932679 10.2777 0.33167 12.6824C0.778458 15.2171 2.07225 17.3153 4.06008 18.9558C6.12152 20.6567 8.49577 21.4905 11.2047 21.3306C12.8498 21.2358 14.6812 21.0155 16.7473 19.2669C17.2682 19.5262 17.8151 19.6297 18.7219 19.7074C19.4205 19.7724 20.0933 19.6729 20.6143 19.5648C21.4302 19.3923 21.3739 18.6367 21.0789 18.4981C18.6874 17.3843 19.2124 17.8374 18.7351 17.4706C19.9501 16.033 21.8063 13.4776 22.379 9.99821C22.4353 9.61409 22.5072 9.073 22.4986 8.76192C22.494 8.57216 22.5377 8.49856 22.7545 8.47671C23.3536 8.40771 23.935 8.24383 24.4692 7.94999C26.0188 7.10357 26.6439 5.71318 26.7911 4.04678C26.8129 3.79204 26.7865 3.52869 26.5174 3.39471ZM13.0143 18.3946C10.6964 16.5724 9.5722 15.9726 9.10816 15.9985C8.67402 16.0244 8.75222 16.5212 8.84768 16.8449C8.94773 17.1646 9.07768 17.3849 9.25996 17.6655C9.38589 17.8512 9.47272 18.1272 9.13404 18.3348C8.38766 18.7965 7.08985 18.1796 7.0289 18.1491C5.51833 17.2595 4.25559 16.0853 3.36546 14.4793C2.50581 12.9337 2.0067 11.2753 1.92447 9.50542C1.90262 9.07818 2.02855 8.92695 2.45406 8.84932C3.01413 8.74582 3.59144 8.72397 4.15093 8.80619C6.51656 9.15178 8.53027 10.2092 10.2185 11.8848C11.1822 12.8388 11.9114 13.979 12.6623 15.0929C13.461 16.2757 14.3201 17.4027 15.4144 18.3268C15.8008 18.6505 16.109 18.8966 16.404 19.0783C15.5144 19.1778 14.0297 19.1991 13.0143 18.3958V18.3946ZM14.1252 11.2489C14.1252 11.0591 14.277 10.9079 14.4679 10.9079C14.511 10.9079 14.5501 10.9165 14.5852 10.9292C14.6329 10.9464 14.6766 10.9723 14.7111 11.0114C14.7721 11.0718 14.8066 11.158 14.8066 11.2489C14.8066 11.4386 14.6548 11.5899 14.4639 11.5899C14.273 11.5899 14.1252 11.4386 14.1252 11.2489ZM17.5759 13.0188C17.3545 13.1096 17.1331 13.1873 16.9203 13.1959C16.5903 13.2131 16.2303 13.0791 16.0348 12.9153C15.7312 12.6605 15.5139 12.5179 15.423 12.0734C15.3839 11.8837 15.4057 11.5899 15.4402 11.4214C15.5185 11.0585 15.4316 10.8257 15.1757 10.614C14.9676 10.4415 14.7025 10.3938 14.4115 10.3938C14.3029 10.3938 14.2034 10.3461 14.1292 10.3076C14.0079 10.2472 13.9078 10.096 14.0033 9.91023C14.0338 9.84985 14.1815 9.70322 14.216 9.67734C14.6111 9.45251 15.0665 9.52612 15.488 9.6946C15.8784 9.85445 16.174 10.1477 16.5989 10.5623C17.033 11.0631 17.1112 11.2011 17.3585 11.5772C17.554 11.871 17.7317 12.1729 17.8536 12.5185C17.9272 12.7341 17.8317 12.9107 17.5759 13.0188Z" fill="var(--dsw-alias-brand-primary)"></path></g><defs><clipPath id="clip0_4329_19769"><rect width="26.634" height="19.6" fill="white" transform="translate(0.163086 1.75)"></rect></clipPath></defs></svg>',

  fixLogo: function () {
    if (location.hostname !== 'cdn.deepseek.com') return;
    if (document.querySelector('[data-dcp-logo]')) return;    // 已替换
    // 按文本找应用名元素——类名是 bundle 哈希会变，页面自己的文本稳定
    var el = null;
    Array.prototype.forEach.call(document.querySelectorAll('div,span,a'), function (n) {
      if (el || n.children.length) return;
      if ((n.textContent || '').trim() !== 'API 使用 demo') return;
      if (n.offsetParent === null) return;                    // 只要可见的那个
      el = n;
    });
    if (!el) return;
    el.textContent = '';
    var host = document.createElement('span');
    host.setAttribute('data-dcp-logo', '1');
    // 与官方一致：品牌色变量随标识自身携带；inline-flex + line-height:0 消除
    // 行内 SVG 的基线间隙
    host.style.cssText = '--dsw-alias-brand-primary:#5686fe;display:inline-flex;line-height:0;vertical-align:middle';
    host.innerHTML = this.OFFICIAL_LOGO;
    el.appendChild(host);
  },

  init: function () {
    var self = this;
    // 共存保护：若同页还装着 deepseek-enhance 且它开着自定义模型（demoCustom），
    // 那份补丁已经在管 fetch 了——两个脚本各打一层会互相绕开，表现为请求发两遍
    // 或干脆不生效。此时本脚本待机，把舞台让给它。
    // 判据用 antiRecall 模块：那是 deepseek-enhance 独有、本项目没有的模块，
    // 不会把自己误判成对方。deepseek-enhance 没开 demoCustom 时它在 demo 页完全
    // inert，本项目可放心接管。
    // 注意：这里查的是对方脚本的全局 window.DSE（deepseek-enhance），不是本项目的 DCP
    if (window.DSE && window.DSE.modules && window.DSE.modules.antiRecall &&
        window.DSE.config && window.DSE.config.get('demoCustom')) {
      console.log('[DCP] 检测到 deepseek-enhance 已接管自定义模型，本脚本待机（在它里面关掉 demoCustom 即可由本脚本接管）');
      return;
    }
    this.patchFetch();
    this.fixFavicon();
    Utils.onReady(function () {
      self.injectUI();
      self.fixLogo();      // 应用名可能还没被 React 渲染出来——下面的 observer 会补
      // 弹窗是 React 组件，开合/切 tab 会重建 DOM——有弹窗时才补注入；
      // 应用名被重绘恢复成文字时也靠这里补。
      // 用节流（带前缘）而非防抖：防抖在弹窗打开时会因 React 连续变 DOM 而
      // 不断重置计时，注入要等变动停 300ms 才发生（实测开弹窗到 tab 出现
      // ~310ms，反复开尤其明显）；节流前缘让弹窗 DOM 一就绪就注入，尾部再补
      // 一次兜底。已注入时 injectUI 是几个 querySelector 的早退，代价可忽略
      new MutationObserver(Utils.throttle(function () {
        if (document.querySelector('[class*="dialogMain-"]')) self.injectUI();
        self.fixLogo();
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  },

  // demo 页（cdn.deepseek.com/chat-demo）的 head 里没有任何 favicon 声明，
  // 所在主机也没有 /favicon.ico（实测 404），浏览器只能显示默认空白图标。
  // 官方主站声明的是 fe-static.deepseek.com/chat/favicon.svg（鲸鱼）——
  // 照搬同一份官方资源，不自己画图标
  fixFavicon: function () {
    if (location.hostname !== 'cdn.deepseek.com') return;
    if (document.querySelector('link[rel*="icon"]')) return;   // 页面自己有时不干预
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/x-icon';
    link.href = 'https://fe-static.deepseek.com/chat/favicon.svg';
    (document.head || document.documentElement).appendChild(link);
  }
};
DCP.modules.demoApi = DemoApi;

/* ===== modules/demobridge.js ===== */
/* ============================================================
 * modules/demobridge：chat-demo 换模型时的「原生工具桥接」
 *
 * 背景：demo 把端点/模型写死（api.deepseek.com + deepseek-flash），工具
 * （deepseek_web_search / deepseek_read_url）是 DeepSeek 服务端工具，
 * 与模型调用同在一个请求里。换成第三方端点后，第三方不认这些私有工具
 * 类型——于是把工具执行拆成「客户端工具循环」：
 *
 *   1. 出站改写（打第三方端点）：剥 DeepSeek 私有字段（tools/safety_check/
 *      title/thinking）、latest_reminder 私有角色折叠进 system、声明标准
 *      客户端工具（web_search/read_url）、system 追加工具使用规程；
 *   2. 第三方模型吐 tool_use → 用一次【极小请求】打 DeepSeek 官方端点
 *      （thinking enabled + 原生双工具声明，无历史无 system）→ DeepSeek
 *      后端原生执行深度搜索/读网页 → 原样剥出 server_tool_use /
 *      web_search_tool_result / web_fetch_tool_result / thinking 块；
 *   3. 这些块【原样转发】给 demo（id 天然满足 demo 的 id===tool_use_id
 *      硬约束，呈现 100% 原生）；腿产出的调研报告浓缩成 tool_result
 *      喂回第三方模型；
 *   4. 循环至模型不再调工具，合成 message_delta/message_stop
 *      收尾；最终轮文本实时流式转发（保原生打字机效果）；
 *   5. 会话起名：demo 官方行为是请求带 title:{enabled:true}、服务端在
 *      message_delta 里回 delta.title——第三方端点没这个能力，由起名腿补上
 *      （与主回答并行，见 runTitleLeg / runTitleLegModel）。来源可配
 *      （demoTitleSource）：deepseek=官方端点起名腿 / model=自定义模型
 *      提示词起名 / off=首条消息截断
 *
 * 实测依据（2026-11-17 三份全链路追踪）：
 *  - 极小请求完整复现原生深度搜索（11 次工具调用/50 结果/9 全文页）；
 *  - 原生历史自清洗（工具块不进后续请求）→ 本模块不做历史清洗；
 *  - demo 解析器规范见 modules/think.js 注释与 docs/dom-research.md。
 *
 * 端点=DeepSeek（含未配端点）时本模块不激活，走 demoapi 原样透传。
 * ============================================================ */
var DemoBridge = {
  LEG_TIMEOUT: 60000,
  // 不再对腿报告设字符上限（2026-11-19 用户要求去掉）：搜索/读网页的完整内容
  // 原样作为 tool_result 喂回模型。代价是连续搜索时上下文涨得快——工具块不像
  // 官方端点那样被服务端清洗，会一直留在后续请求里（见模块头「本模块不做历史
  // 清洗」）。想要上限改回来只需把下面两处 slice 恢复
  DS_LEG_BASE: 'https://api.deepseek.com/anthropic/v1',

  // 自定义模型起名的系统提示词（source=model）。规则式写法参照 OpenWebUI
  // 默认标题模板与 Claude Code /rename：短、准确、跟随语言、只输出 JSON
  TITLE_SYSTEM_PROMPT: '你是会话标题生成器。根据用户给出的对话首条消息，生成一个简洁的会话标题。\n' +
    '规则：\n' +
    '- 不超过 12 个汉字或 6 个英文单词\n' +
    '- 准确概括主题，优先准确而非创意\n' +
    '- 使用该消息本身的语言\n' +
    '- 不要引号、书名号、emoji、句末标点\n' +
    '- 只输出一个 JSON 对象，不要任何解释：{"title":"标题"}',

  /* ---------- 激活判定 ---------- */
  active: function () {
    if (!DCP.config.get('demoCustom')) return false;   // 总开关关闭 = 完全官方逻辑
    var ep = (DCP.config.get('demoEndpoint') || '').trim();
    if (!ep) return false;
    var api = DCP.modules.demoApi;
    if (api && typeof api.isOfficialEndpoint === 'function' && api.isOfficialEndpoint(ep)) return false;
    var mode = DCP.config.get('demoBridge') || 'auto';
    return mode !== 'off';
  },

  // 原生 fetch（未经 demoapi 补丁）——桥接的出站请求（第三方端点 + DeepSeek 腿）
  // 必须走它，否则腿的 URL 会被 demoapi 的补丁改写成第三方端点
  nativeFetch: function () {
    return (DCP.modules.demoApi && DCP.modules.demoApi._origFetch) || window.fetch;
  },

  // 出站头：只发最小必要集，绝不照抄页面原始头。
  // 2026-11-18 实测（StepFun）：页面请求自带 anthropic-version、x-ds-trace-id
  // 和一个小写 content-type，桥接原先连它们一起转发——而这些头不在 StepFun 的
  // CORS allow-headers 里，浏览器预检直接失败、只报 TypeError: Failed to fetch，
  // 用户完全看不出是哪个头被拒。只发 Content-Type / Accept / Authorization
  // 三个头，同一条请求立刻 200。
  // Key 一律放 Authorization: Bearer：DeepSeek 文档原话「x-api-key 或
  // Authorization 任一种」、Anthropic 官方两个都收，而 Authorization 几乎在每个
  // 站点的 CORS allow-headers 里，x-api-key 经常不在（StepFun 就是）
  keyHeader: function () {
    // 第三方端点只接受用户显式配置的 Key；官方 Key 仅用于 DeepSeek 官方腿。
    var key = (DCP.config.get('demoKey') || '').trim();
    var h = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (key) h['Authorization'] = 'Bearer ' + key;
    return h;
  },

  /* ---------- 出站请求构造（第三方端点） ---------- */
  buildOutbound: function (body, origHeaders) {
    var messages = [];
    var reminder = '';
    (body.messages || []).forEach(function (m) {
      if (m.role === 'latest_reminder') { reminder = typeof m.content === 'string' ? m.content : ''; return; }
      messages.push(m);
    });
    // 附件内联：页面上传文件后只拿到 file_id，而 DeepSeek 明确不支持下载原文件/
    // 解析结果（GET .../files/{id} 只回元数据、.../content 404，官方文档原话
    // 「上传的原始文件和解析结果都不支持下载」）——file_id 引用只有 DeepSeek 自己
    // 的模型认，第三方模型收到直接 400（StepFun 实测 document 报 input_invalid、
    // image 报 source.type must be url or base64，且 400 不带 CORS 头，浏览器只报
    // Failed to fetch）。
    //    document 块 → 能当文本读的换成文本块（上传时已按 file_id 记下正文）；
    //                  读不了的（PDF/Office）换成一行说明
    //    image    块 → 上传时读成 base64，这里换成 Anthropic 形状的 base64 块
    //                   （本地文件没有公网 URL，base64 是唯一能送进第三方模型的路）
    // 留着死引用只会让整条请求失败，转换/说明至少能让对话继续
    var fileTexts = (DCP.modules.demoApi && DCP.modules.demoApi._fileTexts) || {};
    messages = messages.map(function (m) {
      if (!Array.isArray(m.content)) return m;
      var changed = false;
      var blocks = m.content.map(function (c) {
        // 图片：DeepSeek 的 file 引用 → base64 内联。第三方端点只认 url/base64
        // （StepFun 实测报 source.type must be url or base64），本地文件又拿不到
        // 公网 URL，只能走 base64——上传时 demoapi 已把图像数据按 file_id 记下
        if (c && c.type === 'image' && c.source && c.source.type === 'file') {
          changed = true;
          var ir = fileTexts[c.source.file_id];
          // 纯文本模型：不白发 base64（一张图几 MB，token 白烧且多半被拒），
          // 换成一行说明让对话能继续
          if (!DCP.config.get('demoMultimodal')) {
            return { type: 'text', text: '【图片：' + ((ir && ir.name) || c.source.file_id || 'image') + '，当前模型不支持图片输入，已忽略】' };
          }
          var du = ir && ir.dataUrl;
          if (du && du.indexOf('base64,') !== -1) {
            var mt = ir.mediaType || du.slice(5, du.indexOf(';'));
            return { type: 'image', source: { type: 'base64', media_type: mt, data: du.slice(du.indexOf('base64,') + 7) } };
          }
          return { type: 'text', text: '【图片：' + ((ir && ir.name) || c.source.file_id || 'image') + '，图像数据尚未读取完成，请重试发送】' };
        }
        if (!c || c.type !== 'document' || !c.source || c.source.type !== 'file') return c;
        changed = true;
        var rec = fileTexts[c.source.file_id];
        var nm = (rec && rec.name) || c.source.file_id || 'file';
        if (rec && typeof rec.text === 'string') {
          return { type: 'text', text: '【附件：' + nm + '】\n' + rec.text + (rec.truncated ? '\n（正文过长，已截断）' : '') };
        }
        return { type: 'text', text: '【附件：' + nm + '，当前模型无法读取该类型文件的内容，已忽略】' };
      });
      return changed ? Object.assign({}, m, { content: blocks }) : m;
    });
    var system = typeof body.system === 'string' ? body.system : '';
    // 系统提示词：只删掉官方内置的 DeepSeek 自述（"该助手为DeepSeek，由深度
    // 求索公司创造。"）——换第三方模型时保留它，模型会在思维链里引用该句并
    // 自称 DeepSeek（2026-11-17 实测）。仅删除，不替换成任何自造人设；
    // 官方端点不走桥接，不受影响
    system = system.replace(/该助手为DeepSeek[^。]*。?/g, '').trim();
    if (reminder) {
      var p = reminder.split(',');
      system += '\n\n当前时间：' + (p[0] || '') + ' ' + (p[1] || '') + '；语言：' + (p[4] || '中文') + '；平台：' + (p[3] || 'Web') + '。';
    }
    // 工具规程：两个工具是**配合**使用的，必须把分工写明白。此前只点名两个
    // 工具名、不说怎么配合，模型会在思维链里把 read_url 当成"文本提到但函数
    // 列表里没有"的东西、从而整轮不调用它（2026-11-18 用户实测反馈）——工具
    // 本身两种模式都声明了，缺的是这段指引
    system += '\n\n你可以使用 web_search / read_url 工具获取实时信息，结果会以 tool_result 返回。' +
      '需要最新或外部信息时必须调用工具，不要凭空回答。两个工具配合使用：先用 web_search 找到相关网页，' +
      '需要核实细节（日期、数字、原文表述）时再用 read_url 读取其中网页全文。' +
      'web_search 的参数没有固定搭配，请按当前任务自主选择、灵活组合。';
    var searchLimit = String(DCP.config.get('demoSearchLimit') || 'unlimited');
    if (searchLimit === '1' || searchLimit === '2') {
      system += '同一轮回答中 web_search 不超过 ' + searchLimit + ' 次，尽量一次搜准。';
    } else {
      system += '同一轮回答中的 web_search 次数不限制，可按任务需要持续检索。';
    }
    system += '调用工具前不要输出面向用户的文本。';
    var tools = [
      // web_search 的参数口径与 DeepSeek Search API 对齐（2026-11-19 按其文档补全）：
      // query 1~128 字符且支持整套搜索语法；count 1~50 且**不影响费用**（按次计费，
      // 填 50 和填 5 一个价）——此前只声明一个 query，模型既不知道能限定站点/语言/
      // 时间，也没法多要结果，等于白放一半能力
      { name: 'web_search',
        description: '搜索网页获取实时信息，返回标题/链接/摘要列表。需要最新或外部信息时先用本工具。' +
          'query 支持站点限定、排除、精确匹配、语言与时间范围等搜索语法，可按任务需要自主组合。',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索词，1~128 个字符，可按任务需要组合使用支持的搜索语法' },
            count: { type: 'integer', description: '返回条数，1~50。条数不影响费用，可按需选择' },
            need_content: { type: 'boolean', description: '是否在结果中返回网页正文，默认 false。需要引用原文细节时设 true' },
            ori_question: { type: 'string', description: '触发本次搜索的用户原始问题，1~128 字符，能帮助搜索服务理解意图' }
          },
          required: ['query']
        } }
    ];
    // read_url 两种模式都声明：native 走模型对话内的读网页工具；searchapi
    // 直调独立 Fetch API（/v1/tools/fetch）
    tools.push({ name: 'read_url', description: '读取指定网页的全文内容。搜索结果里需要核实细节（日期、数字、原文表述）时，用本工具打开对应链接。',
      input_schema: { type: 'object', properties: { url: { type: 'string', description: '网页 URL' } }, required: ['url'] } });
    var out = {
      model: (DCP.config.get('demoModel') || '').trim() || body.model,
      max_tokens: 8192,
      stream: true,
      system: system,
      messages: messages,
      tools: tools
    };
    // 官方 demo 的思考开关是请求字段，不是 UI 状态。桥接此前把它当私有字段
    // 剥掉，第三方模型因此可能不先思考，直接输出文本再调工具，块顺序与官方
    // 不一致。思考开启时原样透传，保证与官方同一协议语义。
    if (body.thinking === true || (body.thinking && body.thinking.type === 'enabled')) {
      out.thinking = { type: 'enabled' };
    }
    return { url: this.normUrl((DCP.config.get('demoEndpoint') || '').trim()), headers: this.keyHeader(origHeaders), body: out };
  },

  // 端点 URL 归一。三种填法都要认（2026-11-18 实测：StepFun 官方文档给的 Base
  // URL 就是第一种「只到 /step_plan」，旧代码只会补 /messages，于是被补成
  // .../step_plan/messages——真实地址是 .../step_plan/v1/messages，直接 404；
  // 而 StepFun 的 404 不带 CORS 头，浏览器只报 Failed to fetch，用户完全看不出
  // 是地址填错了）：
  //   ① 完整地址  .../v1/messages                        → 原样用
  //   ② 到版本号  .../v1                                 → 补 /messages
  //   ③ 只给 base https://api.stepfun.com/step_plan      → 补 /v1/messages（Anthropic 约定）
  normUrl: function (ep) {
    ep = String(ep || '').replace(/\/+$/, '');
    if (!ep) return '';
    if (/\/messages$/.test(ep)) return ep;
    if (/\/v\d+$/.test(ep)) return ep + '/messages';
    return ep + '/v1/messages';
  },

  /* ---------- SSE 工具 ---------- */
  sseEvent: function (type, obj) {
    return 'event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n';
  },

  // 通用 SSE 读取器：逐事件回调；返回累积的块/usage/stop_reason。
  // 兼容 LF / CRLF / CR、多行 data:、无空行结尾的 EOF 残事件；阻塞和中止
  // 都会向调用方抛出，由主流程统一转成 error 事件并关闭流。
  pump: function (stream, onEvent, signal) {
    if (!stream || typeof stream.getReader !== 'function') {
      return Promise.reject(new Error('response stream unavailable'));
    }
    var reader = stream.getReader();
    var dec = new TextDecoder();
    var buf = '', pendingCR = false;
    function normalizeChunk(text, final) {
      var out = '';
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (pendingCR) {
          pendingCR = false;
          out += '\n';
          if (ch === '\n') continue;
        }
        if (ch === '\r') pendingCR = true;
        else out += ch;
      }
      if (final && pendingCR) { pendingCR = false; out += '\n'; }
      return out;
    }
    function dispatch(raw) {
      var dataLines = [];
      var lines = raw.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line || line[0] === ':') continue;
        var colon = line.indexOf(':');
        var field = colon < 0 ? line : line.slice(0, colon);
        var value = colon < 0 ? '' : line.slice(colon + 1);
        if (value[0] === ' ') value = value.slice(1);
        if (field === 'data') dataLines.push(value);
      }
      if (!dataLines.length) return;
      var data = dataLines.join('\n');
      if (data === '[DONE]') return;
      var j = null;
      try { j = JSON.parse(data); } catch (e) { return; }
      if (j.type === 'error' || (j.error && j.error.message)) {
        throw new Error((j.error && j.error.message) || 'stream error');
      }
      onEvent(j);
    }
    function drain(final) {
      var idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        var ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
        dispatch(ev);
      }
      if (final && buf) { dispatch(buf); buf = ''; }
    }
    return (async function () {
      try {
        while (true) {
          if (signal && signal.aborted) {
            try { await reader.cancel(); } catch (e) {}
            throw new DOMException('Aborted', 'AbortError');
          }
          var r = await reader.read();
          if (r.done) break;
          buf += normalizeChunk(dec.decode(r.value, { stream: true }), false);
          drain(false);
        }
        buf += normalizeChunk(dec.decode(), true);
        drain(true);
      } finally {
        try { reader.releaseLock(); } catch (e) {}
      }
    })();
  },

  /* ---------- DeepSeek 极小搜索腿 ---------- */
  // 返回 {blocks:[...原生工具/思考块...], text:腿的报告, usage}
  /* ---------- DeepSeek 独立搜索腿（searchapi 模式：只付搜索费） ---------- */
  // 直调 POST https://api.deepseek.com/v1/tools/search（Bearer 鉴权，用页面里
  // 同一把 DeepSeek Key），不发起模型对话——没有模型 token 费，只按次计搜索
  // 费（$0.75/1000 次，空结果不计费）。结果按 demo 解析器规范合成原生形状的
  // server_tool_use / web_search_tool_result 块转发，界面呈现与 native 一致
  runLegSearchApi: function (toolName, toolInput, dsKey, push, nextIdx, signal, toolId, roundIndex) {
    var self = this;
    var isRead = toolName === 'read_url';
    var ti = toolInput || {};
    var q = isRead ? String(ti.url || '') : String(ti.query || '').slice(0, 128);
    if (!q) return Promise.reject(new Error('empty input'));
    // count：按模型给的走，夹在 API 允许的 1~50；按次计费，多不加钱。
    var cnt = parseInt(ti.count, 10);
    if (!(cnt >= 1)) cnt = 10;
    if (cnt > 50) cnt = 50;
    // need_content：模型要正文才给（默认 false，此时 API 的 content 恒为空串）
    var wantContent = ti.need_content === true;
    // ori_question：模型没传就用会话首条用户消息兜底——官方文档说带上原始问题
    // 能改善查询理解（智能体内部的检索词往往是压缩过的关键词串）
    var oriQ = String(ti.ori_question || self._firstUser || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 20000);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    var url = isRead ? 'https://api.deepseek.com/v1/tools/fetch' : 'https://api.deepseek.com/v1/tools/search';
    var reqBody = isRead ? { url: q }
      : { query: q, count: cnt, need_content: wantContent, ori_question: oriQ || null };
    return this.nativeFetch()(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + dsKey },
      body: JSON.stringify(reqBody)
    }).then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) throw new Error((isRead ? 'fetch' : 'search') + ' api http ' + resp.status);
      return resp.json();
    }).then(function (j) {
      var id = 'srvtoolu_sa_' + Math.random().toString(36).slice(2, 10);
      var i1 = nextIdx(), i2 = nextIdx();
      // 官方 demo 对普通 search 按整个 assistant 消息全局合并；桥接的多轮
      // 客户端工具循环因此会显示成一张卡。首轮保持 search，后续轮次用官方
      // 允许的 deep_search，让每轮形成独立步骤。
      var resultKind = roundIndex > 0 ? 'deep_search' : 'search';
      var toolResultText;
      var bridgeMeta = {
        bridge_tool_name: toolName,
        bridge_tool_input: toolInput,
        bridge_tool_id: toolId
      };
      if (isRead) {
        // 读网页：open_page 动作块 + web_fetch_tool_result（content 为单对象）
        var title = (j && j.title) || q;
        var content = (j && j.content) || '';
        toolResultText = (title ? title + '\n' : '') + String(content);
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i1,
          content_block: Object.assign({ type: 'server_tool_use', id: id, name: 'deepseek_read_url', kind: 'read_link',
            input: { action: 'open_page', url: q } }, bridgeMeta) }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i1 }));
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i2,
          content_block: Object.assign({ type: 'web_fetch_tool_result', tool_use_id: id, kind: 'read_link',
            content: { type: 'web_fetch_result', url: q, content: { title: title }, published_at: '' } },
            { bridge_tool_result: toolResultText }) }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i2 }));
      } else {
        var results = (j && j.results) || [];
        // 喂回模型的文本：默认只给标题/URL/摘要（snippet 给人看、summary 给模型读），
        // 模型显式要正文（need_content）时把 content 也带上。先算文本，再原样
        // 附到官方结果块里，下次中断恢复无需再猜或截断。
        toolResultText = results.slice(0, cnt).map(function (r, i) {
          var s = (i + 1) + '. ' + (r.title || '') + '\n' + (r.url || '') + '\n' + (r.snippet || r.summary || '');
          if (wantContent && r.content) s += '\n' + String(r.content);
          return s;
        }).join('\n\n') || '（未搜索到结果）';
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i1,
          content_block: Object.assign({ type: 'server_tool_use', id: id, name: 'deepseek_web_search', kind: resultKind,
            input: { action: 'search', queries: [q] } }, bridgeMeta) }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i1 }));
        push(self.sseEvent('content_block_start', { type: 'content_block_start', index: i2,
          content_block: Object.assign({ type: 'web_search_tool_result', tool_use_id: id, kind: resultKind,
            content: results.slice(0, cnt).map(function (r) {
              return { type: 'web_search_result', title: r.title || '', url: r.url || '',
                snippet: r.snippet || r.summary || '', site_name: r.site_name || '',
                site_icon: r.site_icon || '', page_age: r.date || '' };
            }) }, { bridge_tool_result: toolResultText }) }));
        push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: i2 }));
      }
      return { text: toolResultText };
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  /* ---------- 极小起名腿（补官方页的 title:{enabled:true} 通道） ---------- */
  // demo 页官方行为：请求带 title:{enabled:true}（仅会话还没标题时），服务端
  // 在同一次流式响应的 message_delta 里回 delta.title，侧边栏直接采用。第三方
  // 端点不认这个字段、不会回标题——故桥接补一条极小 DeepSeek 腿：同样的
  // title:{enabled:true} + 首条用户消息打官方端点，把服务端生成的标题按官方
  // 同一条通道（message_delta.delta.title）转发给 demo。成本约 55 in/16 out
  // token（≈$0.001）；腿与主回答并行发起，延迟被主回答掩盖。失败时退回首条
  // 消息截断（桥接此前行为）
  runTitleLeg: function (firstUser, dsKey, signal) {
    var self = this;
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 15000);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    var title = '';
    var body = {
      model: 'deepseek-flash', stream: true, max_tokens: 32,
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: [{ role: 'user', content: String(firstUser).replace(/\s+/g, ' ').trim().slice(0, 500) }],
      title: { enabled: true }
    };
    return this.nativeFetch()(this.DS_LEG_BASE + '/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': dsKey, 'Accept': 'text/event-stream' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) throw new Error('title leg http ' + resp.status);
      return self.pump(resp.body, function (j) {
        if (j.type === 'message_delta' && j.delta && j.delta.title) title = String(j.delta.title).trim();
      }, ac.signal);
    }).then(function () {
      clearTimeout(timer);
      return title.slice(0, 30);
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  /* ---------- 首条用户消息的可读文本 ----------
   * 一条 user 消息的 content 可能是字符串，也可能是块数组——粘贴大段文本触发
   * 「自动转 txt 附件」之后就是数组（document 块 + text 块）。起名腿、标题兜底、
   * 搜索腿的 ori_question 三处都要取这段文本，而早前只有搜索腿那份处理了数组、
   * 另两处只认字符串：粘贴 txt 之后 firstUser0 恒为空 → 起名腿根本不发起，
   * 兜底截断也取不到东西 → 侧边栏标题一直是空的或奇形怪状（2026-11-19 实测）。
   * 统一收敛到这一个函数。 */
  firstUserText: function (messages) {
    var ms = messages || [];
    var i, j, m, b;
    // 第一遍：跨消息找第一个有文字的 text 块（附件可能单独占一条消息，问题在下一条）
    for (i = 0; i < ms.length; i++) {
      m = ms[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') { if (m.content.trim()) return m.content; continue; }
      if (!Array.isArray(m.content)) continue;
      for (j = 0; j < m.content.length; j++) {
        b = m.content[j];
        if (b && b.type === 'text' && b.text && String(b.text).trim()) return String(b.text);
      }
    }
    // 第二遍：整段对话只有附件、一个文字块都没有（粘贴 txt 后直接发送）——
    // 用文件名顶一下，总比没有标题好
    for (i = 0; i < ms.length; i++) {
      m = ms[i];
      if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (j = 0; j < m.content.length; j++) {
        b = m.content[j];
        var nm = b && (b.title || b.name || (b.source && b.source.name));
        if (nm && String(nm).trim()) return String(nm);
      }
    }
    return '';
  },

  /* ---------- 起名来源（demoTitleSource） ---------- */
  // deepseek=起名腿打 DeepSeek 官方端点（title 参数，官方通道，约 $0.001/次）
  // model=当前自定义模型按提示词起名（费用走第三方端点，不经 DeepSeek）
  // off=不起名，退回首条消息截断
  titleSource: function () {
    var s = DCP.config.get('demoTitleSource');
    return (s === 'model' || s === 'off') ? s : 'deepseek';
  },

  // 自定义模型起名的输出清洗（LibreChat sanitizeTitle 同思路）：
  // 第三方模型不保证干净输出——推理模型可能把 <think> 吐进正文、可能包引号/
  // 代码围栏/寒暄。链路：剥思考 → 优先取 JSON 里的 title（围栏不挡匹配，
  // 顺序不能反）→ 没有 JSON 时按行挑（扔围栏、丢寒暄前缀与过长行）→ 去
  // 首尾包裹符号与句末标点 → 码点安全截断 → 空则返回 ''（交由上层兜底）
  cleanTitle: function (raw) {
    var t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    var m = t.match(/"title"\s*:\s*"([^"]{1,60})"/);
    if (m) {
      t = m[1];
    } else {
      var j = t.match(/\{[\s\S]*\}/);
      if (j) { try { var o = JSON.parse(j[0]); if (o && o.title) t = String(o.title); } catch (e) {} }
      if (!m) {
        t = t.replace(/```[\s\S]*?```/g, ' ');
        var lines = t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        var pick = '';
        for (var i = 0; i < lines.length; i++) {
          var l = lines[i];
          if (/^(当然|好的|以下是|这是|根据|希望|标题|如下|为你)/.test(l)) continue;  // 寒暄前缀
          if (Array.from(l).length > 24) continue;                                   // 标题不会这么长
          pick = l; break;
        }
        t = pick || lines[0] || '';
      }
    }
    t = t.replace(/^["'`“”‘’「『\[\(【〔{]+/, '').replace(/["'`“”‘’」』\]\)】〕}.。.，,！!？?；;：:\s]+$/, '').trim();
    var cps = Array.from(t);
    if (cps.length > 30) t = cps.slice(0, 30).join('') + '…';
    return t.trim();
  },

  /* ---------- 极小起名腿：自定义模型（提示词起名） ---------- */
  // source=model 时用当前第三方端点起名：非流式单发。两个实测约束：
  // ① max_tokens 不能小——StepFun 实测 <256 返 HTTP 200 但 content 空串
  //    （见 stepfun-api-gotchas）；② step-5-preview 实测忽略
  //    thinking:{disabled}（响应仍只回 thinking 块），256 预算会被思考全吃光、
  //    文本块轮不到（stop_reason=max_tokens）→ 故取 1024（与设置里测试按钮
  //    同款，实测思考+文本都放得下）。URL/headers 复用主出站（已按
  // keyHeader 已统一处理 Key），不另起配置。与主回答并行发起，延迟被掩盖；
  //    失败/空结果退回首条消息截断。费用走第三方端点，不产生 DeepSeek 模型费
  runTitleLegModel: function (firstUser, outbound, signal) {
    var self = this;
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 15000);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    var body = {
      model: outbound.body.model,
      max_tokens: 1024,
      stream: false,
      thinking: { type: 'disabled' },
      system: this.TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: String(firstUser).replace(/\s+/g, ' ').trim().slice(0, 500) }]
    };
    return this.nativeFetch()(outbound.url, {
      method: 'POST', signal: ac.signal,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, outbound.headers),
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) throw new Error('title(model) http ' + resp.status);
      return resp.json();
    }).then(function (j) {
      clearTimeout(timer);
      var txt = (j.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text || ''; }).join('');
      return self.cleanTitle(txt);
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  runLeg: function (toolName, toolInput, dsKey, push, nextIdx, signal, toolId, roundIndex) {
    if ((DCP.config.get('demoToolMode') || 'native') === 'searchapi') {
      return this.runLegSearchApi(toolName, toolInput, dsKey, push, nextIdx, signal, toolId, roundIndex);
    }
    var self = this;
    var q = toolName === 'read_url' ? ('请读取并详细总结这个网页的内容：' + (toolInput.url || ''))
                                    : ('请深入调研以下问题，搜索并阅读相关网页，然后给出有据可查的结论：\n' + (toolInput.query || ''));
    var tools = toolName === 'read_url'
      ? [{ name: 'deepseek_read_url', type: 'deepseek_read_url' }]
      : [{ name: 'deepseek_read_url', type: 'deepseek_read_url' }, { name: 'deepseek_web_search', type: 'deepseek_web_search' }];
    var body = { model: 'deepseek-flash', stream: true, thinking: { type: 'enabled' }, max_tokens: 4096, tools: tools, messages: [{ role: 'user', content: q }] };
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, this.LEG_TIMEOUT);
    if (signal) signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
    return this.nativeFetch()(this.DS_LEG_BASE + '/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': dsKey, 'Accept': 'text/event-stream' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      if (!resp.ok) return resp.text().then(function (t) { throw new Error('leg http ' + resp.status + ': ' + t.slice(0, 200)); });
      var out = { blocks: [], text: '', usage: null };
      // 同主流程：input 类 usage 可能只在 message_start 给
      var mergeLegUsage = function (u) {
        if (!u) return;
        out.usage = out.usage || {};
        ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
          if (typeof u[k] === 'number' && (out.usage[k] == null || u[k] > 0)) out.usage[k] = u[k];
        });
      };
      return self.pump(resp.body, function (j) {
        if (j.type === 'message_start' && j.message) mergeLegUsage(j.message.usage);
        if (j.type === 'content_block_start') {
          var cb = j.content_block || {};
          var b = { index: nextIdx(), raw: cb, fwd: false };
          out.blocks.push(b);
          // 工具块与思考块原样转发 demo（id/kind/tool_use_id 保持腿内原值）；
          // 腿的报告文本不转发——它走 tool_result 喂回模型
          if (cb.type === 'server_tool_use' || cb.type === 'web_search_tool_result' ||
              cb.type === 'web_fetch_tool_result' || cb.type === 'thinking') {
            var fwdCb = cb;
            if (roundIndex > 0 && (cb.type === 'server_tool_use' || cb.type === 'web_search_tool_result')) {
              fwdCb = Object.assign({}, cb, { kind: 'deep_search' });
            }
            b.fwd = true;
            push(self.sseEvent('content_block_start', { type: 'content_block_start', index: b.index, content_block: fwdCb }));
          }
        } else if (j.type === 'content_block_delta') {
          var d = j.delta || {};
          var blk = out.blocks[out.blocks.length - 1];
          if (blk && blk.fwd && (d.type === 'thinking_delta' || d.type === 'signature_delta')) {
            push(self.sseEvent('content_block_delta', { type: 'content_block_delta', index: blk.index, delta: d }));
          }
          if (blk && blk.raw.type === 'text' && d.type === 'text_delta') out.text += d.text || '';
        } else if (j.type === 'content_block_stop') {
          var b2 = out.blocks[out.blocks.length - 1];
          if (b2 && b2.fwd) push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: b2.index }));
        } else if (j.type === 'message_delta') {
          mergeLegUsage(j.usage);
        }
      }, ac.signal).then(function () { clearTimeout(timer); return out; });
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  },

  /* ---------- 主流程 ---------- */
  intercept: async function (url, init, dsKey) {
    var self = this;
    var body = null;
    try { body = JSON.parse(init.body); } catch (e) { return null; }
    if (!body || !body.messages) return null;

    // 请求发起时固定 requestId / epoch / sessionId。后续 ctx/TPS 事件只携带
    // 这组身份；用户切会话后 DemoSearch.invalidateRequests() 会递增 epoch，
    // 上一请求的迟到事件直接丢弃，不再异步解析后覆盖新会话。
    var search = DCP.modules && DCP.modules.demoSearch;
    var requestCtx = search && typeof search.beginRequest === 'function'
      ? search.beginRequest()
      : { requestId: 'dcpr_local_' + Math.random().toString(36).slice(2), epoch: 0, sessionId: null, session: Promise.resolve(null) };
    var requestSession = requestCtx && requestCtx.session ? await requestCtx.session : null;
    var requestSessionId = requestCtx && requestCtx.sessionId || (requestSession && requestSession.id) || null;
    var eventMeta = function (extra) {
      return Object.assign({ requestId: requestCtx && requestCtx.requestId || '', sessionId: requestSessionId }, extra || {});
    };
    var endRequest = function () {
      if (search && typeof search.finishRequest === 'function' && requestCtx) search.finishRequest(requestCtx.requestId);
    };

    /* ---------- 实时速率（按整个请求累计） ----------
     * 以前每轮从头重算，多轮工具循环里数字先跳高再往下走、每换一轮重来一遍；
     * 实时值又是按字数估的，轮末拿到接口 usage 才换成精确值，两个口径对不上，
     * 收尾时猛跳一下（实测 196 → 108）。现在：
     *  - 按整个请求累计：已结束的轮用接口 usage 的精确 output_tokens，在途的
     *    这一轮优先也用精确值——StepFun 这类端点每个 delta 上都带累计
     *    usage.output_tokens（2026-11-24 抓原始流确认）；端点不带才退回按字数
     *    估算。两者加总除以累计生成用时（不含工具腿等待）；
     *  - 显示值向目标值指数逼近（时间常数 0.45s）：目标缓变时基本跟手，遇到
     *    估算值被精确值替换这类阶跃则平滑过渡；
     *  - 计时器按请求走，工具腿等待期间也继续发，显示值才能走完这段过渡。 */
    var tps = {
      authTokens: 0,      // 已结束各轮的输出 token 之和
      authExact: true,    // 上述是否全部来自接口 usage
      genTime: 0,         // 已结束各轮的生成用时之和（秒）
      liveTokens: 0,      // 在途这一轮按字数估的 token
      liveAuth: 0,        // 在途这一轮接口回的累计 output_tokens
      liveTrusted: false, // liveAuth 可否当精确值用（见 pump 回调里的采信规则）
      roundStart: 0,      // 在途这一轮的起点；0 = 当前不在生成中
      shown: 0, hasShown: false, lastTick: 0, lastEmit: 0, timer: null
    };
    // 在途这一轮的精确输出量：接口给了就用，没给返回 0（调用方退回估算值）
    var tpsLiveExact = function () { return tps.liveTrusted ? tps.liveAuth : 0; };
    var tpsTarget = function () {
      var exact = tpsLiveExact();
      var live = exact > 0 ? exact : tps.liveTokens;
      var elapsed = tps.genTime + (tps.roundStart ? (performance.now() - tps.roundStart) / 1000 : 0);
      var tokens = tps.authTokens + live;
      if (!(elapsed > 0) || !(tokens > 0)) return null;
      return {
        tps: tokens / elapsed, tokens: tokens, elapsed: elapsed,
        // 工具腿等待期间没有在途轮：已结束各轮全是精确值，这个数就是精确的
        estimated: !(tps.authExact && (!tps.roundStart || exact > 0))
      };
    };
    var tpsEmit = function (force) {
      var t = tpsTarget();
      if (!t) return;
      var now = performance.now();
      if (!tps.hasShown) { tps.shown = t.tps; tps.hasShown = true; }
      else if (now > tps.lastTick) {
        tps.shown += (t.tps - tps.shown) * (1 - Math.exp(-(now - tps.lastTick) / 450));
      }
      tps.lastTick = now;
      if (!force && now - tps.lastEmit < 200) return;
      tps.lastEmit = now;
      // tps 是平滑后的显示值；tokens / elapsed 是真实累计量（浮层提示用）
      DCP.emit('tps:update', eventMeta({ tps: tps.shown, tokens: t.tokens, elapsed: t.elapsed, estimated: t.estimated }));
    };
    // 一轮结束：记进请求累计。接口没给 usage 的轮退回估算值，并把精确标记摘掉
    var tpsCloseRound = function () {
      var exact = tpsLiveExact();
      if (exact > 0) tps.authTokens += exact;
      else if (tps.liveTokens > 0) { tps.authTokens += tps.liveTokens; tps.authExact = false; }
      tps.genTime += tps.roundStart ? (performance.now() - tps.roundStart) / 1000 : 0;
      tps.roundStart = 0; tps.liveTokens = 0; tps.liveAuth = 0; tps.liveTrusted = false;
    };
    // 请求收尾：停计时器，把未经平滑的最终值发出去（「平均」要的是精确值），
    // 再通知空闲
    var tpsIdle = function (state) {
      if (tps.timer) { clearInterval(tps.timer); tps.timer = null; }
      var t = tpsTarget();
      if (t) DCP.emit('tps:update', eventMeta({ tps: t.tps, tokens: t.tokens, elapsed: t.elapsed, estimated: t.estimated, final: true }));
      DCP.emit('tps:idle', eventMeta());
      DCP.emit('session:activity', eventMeta({ state: state || 'stopped' }));
    };

    // 官方 demo 会把工具块从下一次 API 请求里过滤掉，但它自己的 IndexedDB
    // 仍完整保存着这些块。只从请求发起时唯一确定的当前会话恢复中断轮，
    // 不另建存储、不截断内容，也不扫描其它会话。
    try {
      var canRecover = !search || typeof search.isRequestCurrent !== 'function' ||
        search.isRequestCurrent({ requestId: requestCtx.requestId, sessionId: requestSessionId });
      var recovered = canRecover && requestSession
        ? await search.recoverBridgeRequest(body.messages, requestSession)
        : null;
      if (recovered && recovered.messages) {
        body = Object.assign({}, body, { messages: recovered.messages });
        console.log('[DCP] recovered interrupted bridge history', {
          sessionId: recovered.sessionId,
          targetId: recovered.targetId,
          status: recovered.status,
          mode: recovered.mode,
          recoveredMessages: recovered.recoveredMessages,
          recoveredBlocks: recovered.recoveredBlocks
        });
      }
    } catch (e) {
      console.warn('[DCP] recover bridge history failed', e);
    }

    var outbound = this.buildOutbound(body, init.headers || {});
    // 会话首条用户消息：搜索腿的 ori_question 兜底（官方文档说带上原始问题能改善
    // 查询理解——智能体内部的检索词往往是压缩过的关键词串）
    self._firstUser = this.firstUserText(body.messages);
    var enc = new TextEncoder();
    var q = [], done = false, wake = null;
    var push = function (s) { q.push(s); if (wake) { var w = wake; wake = null; w(); } };
    var finish = function () { done = true; if (wake) { var w = wake; wake = null; w(); } };
    var ac = new AbortController();
    if (init.signal) init.signal.addEventListener('abort', function () { ac.abort(); }, { once: true });

    var stream = new ReadableStream({
      pull: function (c) {
        if (q.length) { c.enqueue(enc.encode(q.shift())); return; }
        if (done) { c.close(); return; }
        return new Promise(function (r) { wake = r; });
      },
      cancel: function () { ac.abort(); }
    });

    (async function () {
      var idx = 0;
      var nextIdx = function () { return idx++; };
      var usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      var addUsage = function (u) {
        if (!u) return;
        ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
          if (typeof u[k] === 'number') usage[k] += u[k];
        });
      };
      var wantTitle = !!(body.title && body.title.enabled);
      // 起名腿与主回答并行发起（标题只需首条用户消息，不必等回答完）——
      // 官方端点上标题由服务端在同一次请求里顺手生成，第三方端点没这个
      // 能力，用一条极小腿补上，延迟被主回答掩盖掉。来源由 demoTitleSource
      // 决定：deepseek=官方端点 title 参数腿；model=自定义模型提示词腿；
      // off=不起腿（收尾处退回首条消息截断）。
      // 注意：本闭包是无接收者调用的 async IIFE（bootstrap 还有 'use strict'），
      // 里面的 this 不是 DemoBridge（严格模式下为 undefined）——必须用函数顶部
      // 捕获的 self，否则 this.titleSource 直接 TypeError；且该段在下方 try 之前，
      // 异常会变成 unhandled rejection，表现为流既不推数据也不发请求、页面永远
      // 挂在"停止生成"（本次开发实测踩到）
      var titleSrc = self.titleSource();
      var titleLeg = null;
      if (wantTitle && titleSrc !== 'off') {
        // 走统一的 firstUserText：粘贴长文本转成 txt 附件后 content 是块数组，
        // 早前这里只认字符串，导致 firstUser0 恒为空、起名腿根本不发起
        var firstUser0 = self.firstUserText(body.messages);
        if (firstUser0) {
          titleLeg = (titleSrc === 'model'
            ? self.runTitleLegModel(firstUser0, outbound, ac.signal)
            : self.runTitleLeg(firstUser0, dsKey, ac.signal)
          ).catch(function () { return ''; });
        }
      }
      try {
        push(self.sseEvent('message_start', {
          type: 'message_start',
          message: { id: 'msg_bridge_' + Math.random().toString(36).slice(2, 10), type: 'message', role: 'assistant',
            model: outbound.body.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
        }));
        DCP.emit('tps:start', eventMeta());
        DCP.emit('session:activity', eventMeta({ state: 'generating' }));
        // 工具循环：与原生行为一致——模型持续调用工具就持续供给结果，
        // 直到它自己停止调用（给出最终文本回答）。不设轮数上限、不加
        // 无进展检测之类的认为中断；需要停止时用页面自身的停止按钮
        // （abort 经 signal 传到在途请求，流关闭，demo 显示“已停止”）
        var messages = outbound.body.messages.slice();
        var stopReason = 'end_turn';
        var toolRoundIndex = 0;
        var refreshRequestSession = async function () {
          if (!search || typeof search.refreshRequestSession !== 'function' || !requestCtx) return;
          var before = requestSessionId;
          var s = await search.refreshRequestSession(requestCtx);
          if (s && s.id) requestSessionId = s.id;
          // 新对话首条消息的 ID 往往到工具轮后才落盘；补发一次带 ID 的生成中
          // 事件，侧栏与其它标签才能把转圈挂到正确的会话行。
          if (requestSessionId && requestSessionId !== before) {
            DCP.emit('session:activity', eventMeta({ state: 'generating' }));
          }
        };
        // 占用公式与原来完全一致；只是在每轮工具消息追加后也发射一次，
        // 让长任务过程中持续刷新，而不是等到整个工具循环结束才更新。
        // 工具轮后当前 messages 已经变化、但新请求的 usage 还没回来，因此这
        // 一次明确按请求结构估算；最终轮仍优先使用接口 usage 精确值。
        var emitCtxUsage = function (forceEstimate) {
          var uIn = (roundUsage && roundUsage.input_tokens) || 0;
          var uCacheRead = (roundUsage && roundUsage.cache_read_input_tokens) || 0;
          var uCacheCreate = (roundUsage && roundUsage.cache_creation_input_tokens) || 0;
          var exactUsed = uIn + uCacheRead + uCacheCreate;
          var estSys = Utils.estimateTokens(outbound.body.system || '');
          var estTool = Utils.estimateTokens(JSON.stringify(outbound.body.tools || []));
          var estMsg = Utils.estimateTokens(JSON.stringify(messages));
          var estTotal = estSys + estTool + estMsg;
          var exact = !forceEstimate && exactUsed > 0;
          var used = exact ? exactUsed : estTotal;
          var estimated = !exact;
          if (used > 0) {
            DCP.emit('ctx:api', eventMeta({
              used: used,
              input: exact ? uIn : 0,
              cacheRead: exact ? uCacheRead : 0,
              cacheCreate: exact ? uCacheCreate : 0,
              estSys: estSys, estTool: estTool, estMsg: estMsg, estimated: estimated,
              usageScope: exact ? 'current-request-usage' : 'current-messages-estimate',
              model: respModel || outbound.body.model || ''
            }));
          }
        };
        while (true) {
          var requestBody = Object.assign({}, outbound.body, { messages: messages });
          var payload = JSON.stringify(requestBody);
          var resp = await self.nativeFetch()(outbound.url, {
            method: 'POST', signal: ac.signal,
            headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, outbound.headers),
            body: payload
          });
          if (!resp.ok) {
            var et = await resp.text().catch(function () { return ''; });
            var em = et; try { var ej = JSON.parse(et); em = (ej.error && ej.error.message) || et; } catch (e) {}
            console.warn('[DCP] endpoint rejected request', {
              status: resp.status,
              messageCount: messages.length,
              payloadBytes: payload.length,
              roles: messages.map(function (m) { return m && m.role; }),
              blockTypes: messages.reduce(function (acc, m) {
                (Array.isArray(m && m.content) ? m.content : []).forEach(function (b) { if (b && b.type) acc[b.type] = (acc[b.type] || 0) + 1; });
                return acc;
              }, {})
            });
            push(self.sseEvent('error', { type: 'error', error: { type: 'api_error', message: '模型端点错误 ' + resp.status + '：' + String(em).slice(0, 200) } }));
            tpsIdle('error');
            endRequest();
            finish(); return;
          }
          var blocks = [];       // 本轮完整块（供下一轮历史）
          var partial = {};      // index → 累积 input_json
          var roundUsage = null, roundStop = 'end_turn', respModel = '';
          // 速率计时器按请求走（见 intercept 开头 tps 注释）：首轮起一次，收尾 tpsIdle() 清
          if (!tps.timer) tps.timer = setInterval(function () { tpsEmit(); }, 250);
          // usage 合并：Anthropic 系把 input 类放在 message_start.message.usage、
          // output 放在 message_delta.usage，很多第三方端点只给其中一个——
          // 以前只读 message_delta，遇到「只在 message_start 给 input_tokens」
          // 的端点就算出 used=0，圆圈永远显示 0%。这里按字段合并，0 不覆盖已有值
          var mergeUsage = function (u) {
            if (!u) return;
            roundUsage = roundUsage || {};
            ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
              if (typeof u[k] === 'number' && (roundUsage[k] == null || u[k] > 0)) roundUsage[k] = u[k];
            });
          };
          await self.pump(resp.body, function (j) {
            if (j.type === 'message_start' && j.message && j.message.model) respModel = j.message.model;
            if (j.type === 'message_start') {
              tps.roundStart = performance.now();
              tps.liveTokens = 0; tps.liveAuth = 0; tps.liveTrusted = false;
            }
            if (j.type === 'message_start' && j.message) mergeUsage(j.message.usage);
            // 实时 token 数：端点在 delta 上带了累计 usage.output_tokens 就直接用。
            // message_start 里那个 0/1 是 Anthropic 协议的占位值，不算；逐 delta
            // 的值要亲眼见过它递增一次才采信（防某个端点每个 delta 都回同一个
            // 占位数）；message_delta 回的按协议就是这一轮的完整输出量
            if (j.type !== 'message_start' && j.usage && Number(j.usage.output_tokens) > 0) {
              var uOut = Number(j.usage.output_tokens);
              if (j.type === 'message_delta' || (uOut > tps.liveAuth && tps.liveAuth > 0)) tps.liveTrusted = true;
              if (uOut > tps.liveAuth) tps.liveAuth = uOut;
            }
            if (j.type === 'content_block_start') {
              var cb = j.content_block || {};
              var b = { type: cb.type, raw: cb, index: nextIdx() };
              blocks.push(b); partial[b.index] = '';
              if (cb.type === 'text' || cb.type === 'thinking' || cb.type === 'tool_use') {
                push(self.sseEvent('content_block_start', { type: 'content_block_start', index: b.index, content_block: cb }));
              }
            } else if (j.type === 'content_block_delta') {
              var d = j.delta || {};
              var blk = blocks[blocks.length - 1];
              if (!blk) return;
              // 工具入参的 JSON 也是模型逐字吐出来的输出，要计入 token。以前不计，
              // 纯工具轮的实时值只有真实值的一个零头（实测估 10、接口回 113）
              if (d.type === 'input_json_delta') {
                var pj = d.partial_json || '';
                partial[blk.index] += pj;
                tps.liveTokens += Utils.estimateTokens(pj);
                return;
              }
              if (d.type === 'text_delta' || d.type === 'thinking_delta' || d.type === 'signature_delta') {
                if (blk.type === 'tool_use') return;
                if (d.type === 'text_delta') tps.liveTokens += Utils.estimateTokens(d.text || '');
                else if (d.type === 'thinking_delta') tps.liveTokens += Utils.estimateTokens(d.thinking || '');
                push(self.sseEvent('content_block_delta', { type: 'content_block_delta', index: blk.index, delta: d }));
              }
            } else if (j.type === 'content_block_stop') {
              var b2 = blocks[blocks.length - 1];
              if (b2) {
                if (b2.type === 'tool_use') {
                  try { b2.raw.input = JSON.parse(partial[b2.index] || '{}'); } catch (e) { b2.raw.input = {}; }
                }
                push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: b2.index }));
              }
            } else if (j.type === 'message_delta') {
              mergeUsage(j.usage);
              if (j.delta && j.delta.stop_reason) roundStop = j.delta.stop_reason;
              tpsEmit();
            }
          }, ac.signal);
          // 本轮结束：记进请求累计并立刻发一次。此时多半已拿到接口 usage 的精确
          // output_tokens；没有则退回估算值并保留 estimated:true，界面不会误标成
          // 接口精确值
          tpsCloseRound();
          tpsEmit(true);
          addUsage(roundUsage);
          var toolUses = blocks.filter(function (b) { return b.type === 'tool_use'; });
          if (roundStop !== 'tool_use' || !toolUses.length) { stopReason = roundStop; break; }
          // 有工具调用 → 逐个跑 DeepSeek 原生腿
          var results = [];
          for (var ti = 0; ti < toolUses.length; ti++) {
            var tu = toolUses[ti];
            var leg;
            try {
              leg = await self.runLeg(tu.raw.name, tu.raw.input || {}, dsKey, push, nextIdx, ac.signal, tu.raw.id, toolRoundIndex);
              addUsage(leg.usage);
            } catch (le) {
              // 腿失败 → 原生失败形状的搜索块 + 空结果喂回。id 必须配对：
              // 旧版结果固定用 srvtoolu_b_x，而调用块是随机 id，官方会话会
              // 出现连续 user(tool_result)，下一次请求直接变成非法消息序列。
              var fidx = nextIdx();
              var failId = 'srvtoolu_b_' + Math.random().toString(36).slice(2, 8);
              var failKind = toolRoundIndex > 0 ? 'deep_search' : 'search';
              push(self.sseEvent('content_block_start', { type: 'content_block_start', index: fidx,
                content_block: { type: 'server_tool_use', id: failId, name: 'deepseek_web_search', input: { action: 'search', queries: [String((tu.raw.input || {}).query || '').slice(0, 80)] }, kind: failKind } }));
              push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: fidx }));
              var ridx = nextIdx();
              push(self.sseEvent('content_block_start', { type: 'content_block_start', index: ridx,
                content_block: { type: 'web_search_tool_result', tool_use_id: failId, kind: failKind, content: [{ type: 'web_search_tool_result_error', error_code: 'search_unavailable' }] } }));
              push(self.sseEvent('content_block_stop', { type: 'content_block_stop', index: ridx }));
              leg = { text: '（搜索失败：' + String(le && le.message || le).slice(0, 120) + '）' };
            }
            results.push({ type: 'tool_result', tool_use_id: tu.raw.id, content: String(leg.text || '') || '（无结果）' });
          }
          // 历史追加：assistant 原样 + user tool_result（tool_result 在前，无文本）
          messages = messages.concat([
            { role: 'assistant', content: blocks.map(function (b) { return b.raw; }) },
            { role: 'user', content: results }
          ]);
          toolRoundIndex++;
          await refreshRequestSession();
          emitCtxUsage(true);
        }
        // 最终轮再更新一次；公式与上面每轮工具消息追加后相同，但这一轮
        // 已有本请求 usage，优先标记为精确值。
        await refreshRequestSession();
        emitCtxUsage(false);
        // 收尾
        var sr = (stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'refusal') ? stopReason : 'end_turn';
        var delta = { stop_reason: sr, stop_sequence: null };
        if (wantTitle) {
          // 优先起名腿拿到的标题（deepseek 源是服务端生成的官方同款；model
          // 源是自定义模型输出、已过 cleanTitle 清洗）；腿关闭/失败时退回首条
          // 消息截断——桥接此前行为
          var title = '';
          if (titleLeg) { try { title = (await titleLeg) || ''; } catch (e) { title = ''; } }
          if (!title) {
            // 同样走 firstUserText：早前这里只认字符串，粘贴 txt 之后连兜底
            // 截断都取不到东西，标题直接是空的
            var fb = self.firstUserText(messages);
            if (fb) title = fb.replace(/\s+/g, ' ').trim().slice(0, 20);
          }
          if (title) delta.title = title;
        }
        push(self.sseEvent('message_delta', { type: 'message_delta', delta: delta, usage: usage }));
        push(self.sseEvent('message_stop', { type: 'message_stop' }));
        tpsIdle('done');
      } catch (e) {
        tpsIdle(e && e.name === 'AbortError' ? 'stopped' : 'error');
        if (e && e.name === 'AbortError') { finish(); endRequest(); return; }
        push(self.sseEvent('error', { type: 'error', error: { type: 'api_error', message: String(e && e.message || e).slice(0, 200) } }));
      }
      finish();
      endRequest();
    })().catch(function (e) {
      // title leg 初始化、ReadableStream 构造等主 try 之前的异常也必须收口，
      // 否则页面会一直停在“停止生成”，既看不到 error 也不关流。
      tpsIdle(e && e.name === 'AbortError' ? 'stopped' : 'error');
      if (!(e && e.name === 'AbortError')) {
        push(self.sseEvent('error', { type: 'error', error: { type: 'api_error', message: String(e && e.message || e).slice(0, 200) } }));
      }
      finish();
      endRequest();
    });

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
  }
};
DCP.modules.demoBridge = DemoBridge;

/* ===== modules/ctxring.js ===== */
/* ============================================================
 * modules/ctxring：自定义模型时的上下文占用圆圈（ZCode 式精简环）
 *
 * 数据来源：demobridge 在每轮工具结果追加后按当前 messages 估算，并在最终
 * 轮优先采用响应 usage 的精确值，经 'ctx:api' 事件广播。事件自带请求发起时
 * 固定的 sessionId/requestId；切会话后过期事件直接丢弃。本模块只负责把
 * 占用/窗口画成一个环，注入在输入工具条里、发送按钮一侧。配了第三方端点
 * （桥接活动）时常驻显示（首次对话前显示 0%）；总开关关、或端点是官方/
 * 未配（桥接不跑、永远没有数据）时隐藏。
 * ============================================================ */
var CtxRing = {
  SIZE: 22, R: 8.5,

  // 解析「上下文窗口」输入：支持 128000 / 128k / 1m / 1M 等写法（大小写不敏感，
  // 容忍逗号空格和 tokens 后缀）。以前直接 parseInt——用户按习惯打 "1m" 会被解析
  // 成 1，窗口变成 1 token，圆圈瞬间 100% 变红、浮层显示 "35K/1（100.0%）"，
  // 而用户只是想扩展到 1M（2026-11-18 实测复现）。解析不出来返回 0，由 limit() 回退
  parseLimit: function (raw) {
    if (typeof raw === 'number') return (isFinite(raw) && raw > 0) ? Math.floor(raw) : 0;
    var s = String(raw == null ? '' : raw).trim().toLowerCase()
      .replace(/[,\s_]/g, '').replace(/tokens?$/, '');
    if (!s) return 0;
    var m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    if (m[2] === 'k') n *= 1e3;
    else if (m[2] === 'm') n *= 1e6;
    return (isFinite(n) && n > 0) ? Math.floor(n) : 0;
  },

  limit: function () {
    var v = this.parseLimit(DCP.config.get('demoCtxLimit'));
    return v > 0 ? v : 128000;
  },

  fmt: function (n) {
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
    return String(n);
  },

  inject: function () {
    var bar = (DCP.modules.toolbar && DCP.modules.toolbar.find) ? DCP.modules.toolbar.find() : null;
    if (!bar || document.getElementById('dcp-ctx-ring')) return;
    var C = 2 * Math.PI * this.R;
    var btn = document.createElement('button');
    btn.id = 'dcp-ctx-ring';
    btn.type = 'button';
    // 不用 .dcp-icon-btn（display!important 会压住内联隐藏）；也不给按钮加
    // 圆形边框/底色——那会和里面的 SVG 进度环叠成“两个圈”（UI 瑕疵），
    // 保持只有一个环
    btn.style.cssText = 'display:none;align-items:center;justify-content:center;width:24px;height:24px;' +
      'border:none;background:transparent;cursor:pointer;flex:0 0 auto;padding:0;margin:0 6px;' +
      'transition:opacity .15s;opacity:.8';
    btn.title = '';
    btn.innerHTML =
      '<svg width="' + this.SIZE + '" height="' + this.SIZE + '" viewBox="0 0 ' + this.SIZE + ' ' + this.SIZE + '">' +
      '<circle cx="11" cy="11" r="' + this.R + '" fill="none" stroke="var(--dcp-border)" stroke-width="2.5"></circle>' +
      '<circle class="dcp-ctx-arc" cx="11" cy="11" r="' + this.R + '" fill="none" stroke="var(--dcp-accent)" ' +
      'stroke-width="2.5" stroke-linecap="round" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + C.toFixed(2) + '" ' +
      'transform="rotate(-90 11 11)"></circle></svg>';
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    // 位置：发送按钮左侧（ZCode 式：环挨着发送区）。发送按钮可能嵌在中间层
    // （如 right-xxx 容器），先向上找到属于 bar 的直接子级再插
    var sendBtn = bar.querySelector('[class*="sendButton"]');
    var ref = sendBtn;
    while (ref && ref.parentElement && ref.parentElement !== bar) ref = ref.parentElement;
    if (ref && ref.parentElement === bar) bar.insertBefore(btn, ref);
    else bar.appendChild(btn);
    return btn;
  },

  // 圆圈能不能显示：总开关开着【且桥接真的在跑】。桥接只在配了第三方
  // （非 deepseek.com）端点时才活动——开着自定义模型但用的是官方端点时，
  // 请求原生透传、ctx:api 永远不来，圆圈就是个永远 0% 的装饰。
  // 实测（2026-11-18 官网 demo 页）：官方端点下 message_start/message_delta
  // 的 usage 都是全的，但桥接不跑所以一个字都拿不到——这种「看得见却永远
  // 是 0」比不显示更糟，故与设置面板同一思路：不适用就隐藏
  canShow: function () {
    if (!DCP.config.get('demoCustom')) return false;
    if (!DCP.config.get('demoShowCtxRing')) return false;
    var B = DCP.modules.demoBridge;
    return !!(B && typeof B.active === 'function' && B.active());
  },

  update: function (data) {
    var self = this;   // 必须在方法内捕获——裸 self 会解析到浏览器全局 window.self
    // 注意 used===0 的判定：早先用 `data.used ? data : data`，0 是 falsy
    // 会把整个对象当数字用、pct 算成 NaN（环报废）。现在按类型分流，0 正常走
    var isObj = !!data && typeof data === 'object';
    var used = isObj ? (Number(data.used) || 0) : (Number(data) || 0);
    this._last = used;
    this._data = isObj ? data : { used: used, input: used, cacheRead: 0, cacheCreate: 0, estSys: 0, estTool: 0, estMsg: used };
    if (this._data.sessionId) {
      this._sessionId = this._data.sessionId;
      var all = DCP.config.sessions();
      all[this._data.sessionId] = Object.assign({}, all[this._data.sessionId], this._data, { savedAt: Date.now() });
      // 只保留最近 100 个会话，避免 localStorage 无限增长。
      var ids = Object.keys(all);
      if (ids.length > 100) {
        ids.sort(function (a, b) { return (all[a].savedAt || 0) - (all[b].savedAt || 0); });
        ids.slice(0, ids.length - 100).forEach(function (id) { delete all[id]; });
      }
      DCP.config.saveSessions();
    }
    var btn = document.getElementById('dcp-ctx-ring') || this.inject();
    if (!btn) return;
    var limit = this.limit();
    var pct = Math.max(0, Math.min(100, used / limit * 100));
    var arc = btn.querySelector('.dcp-ctx-arc');
    var C = 2 * Math.PI * this.R;
    if (arc) arc.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(2));
    // 颜色分级：>90% 危险 / >70% 警告（与设置面板的 ctx 分级一致）
    arc.setAttribute('stroke', pct >= 90 ? '#f87171' : (pct >= 70 ? '#fbbf24' : 'var(--dcp-accent)'));
    btn.style.display = this.canShow() ? 'inline-flex' : 'none';
    // 富信息悬浮面板替代原生 title
    btn.onmouseenter = function () { self.showPanel(); };
    btn.onmouseleave = function () { self.hidePanel(); };
    btn.onfocus = function () { self.showPanel(); };
    btn.onblur = function () { self.hidePanel(); };
  },

  /* ---------- 悬浮详情面板（ZCode 式：总量+进度条+构成+缓存命中率） ---------- */
  ensurePanel: function () {
    if (document.getElementById('dcp-ctx-panel')) return document.getElementById('dcp-ctx-panel');
    var p = document.createElement('div');
    p.id = 'dcp-ctx-panel';
    p.style.cssText = 'position:fixed;z-index:99999;display:none;width:264px;box-sizing:border-box;' +
      'border-radius:14px;padding:14px 16px;font-size:12px;line-height:1.6;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);backdrop-filter:blur(20px) saturate(160%);' +
      '-webkit-backdrop-filter:blur(20px) saturate(160%);pointer-events:none;';
    document.body.appendChild(p);
    return p;
  },

  paintPanel: function () {
    var d = this._data;
    var p = this.ensurePanel();
    if (!d) { p.style.display = 'none'; return; }
    var dark = document.body.classList.contains('dark');
    var bg = dark ? 'rgba(38,40,48,.92)' : 'rgba(255,255,255,.94)';
    var fg = dark ? '#e8eaef' : '#1d2129';
    var dim = dark ? 'rgba(232,234,239,.55)' : 'rgba(29,33,41,.55)';
    var line = dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)';
    p.style.background = bg; p.style.color = fg;
    p.style.border = '1px solid ' + line;
    var limit = this.limit();
    var pct = Math.max(0, Math.min(100, d.used / limit * 100));
    // 构成占比（估算，归一到 100%）
    var estSum = Math.max(1, d.estSys + d.estTool + d.estMsg);
    var rows = [
      [DCP.t('消息'), d.estMsg],
      [DCP.t('系统提示词'), d.estSys],
      [DCP.t('系统工具'), d.estTool]
    ];
    var hit = (d.input + d.cacheRead + d.cacheCreate) > 0
      ? Math.round(d.cacheRead / (d.input + d.cacheRead + d.cacheCreate) * 1000) / 10 : 0;
    var html = '';
    // 标题行：左“上下文容量”，右当前模型名（响应里回的 model，权威）
    var modelName = d.model || (DCP.config.get('demoModel') || '').trim();
    html += '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">' +
      '<span style="font-size:13px;font-weight:600">' + DCP.t('上下文容量') + '</span>' +
      (modelName ? '<span style="font-size:11px;opacity:.55;font-weight:400;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + Utils.escHtml(modelName) + '">' + Utils.escHtml(modelName) + '</span>' : '') +
      '</div>';
    html += '<div style="font-size:15px;font-weight:600;margin-bottom:8px">' + this.fmt(d.used) + '/' + this.fmt(limit) +
      '<span style="font-weight:400;font-size:12px;opacity:.75">（' + pct.toFixed(pct >= 10 ? 1 : 1) + '%' +
      (d.estimated ? '，' + DCP.t('估算') : '') + '）</span></div>';
    html += '<div style="height:6px;border-radius:3px;background:' + line + ';overflow:hidden;margin-bottom:10px">' +
      '<div style="height:100%;width:' + pct + '%;border-radius:3px;background:' +
      (pct >= 90 ? '#f87171' : (pct >= 70 ? '#fbbf24' : 'var(--dcp-accent)')) + '"></div></div>';
    rows.forEach(function (r) {
      var pctRow = Math.round(r[1] / estSum * 1000) / 10;
      html += '<div style="display:flex;justify-content:space-between;padding:1px 0">' +
        '<span style="color:' + dim + '">' + r[0] + '</span><span>' + pctRow.toFixed(1) + '%</span></div>';
    });
    html += '<div style="border-top:1px solid ' + line + ';margin:8px 0 6px"></div>';
    html += '<div style="display:flex;justify-content:space-between"><span style="color:' + dim + '">' +
      DCP.t('平均缓存命中率') + '</span><span>' + hit.toFixed(1) + '%</span></div>';
    html += '<div style="color:' + dim + ';font-size:11px;margin-top:6px">' +
      (d.estimated
        ? DCP.t('该端点未回传 usage，此处按请求体结构估算')
        : DCP.t('总量与缓存命中率为接口 usage 精确值；构成占比按请求结构估算')) + '</div>';
    p.innerHTML = html;
  },

  showPanel: function () {
    var p = this.ensurePanel();
    var btn = document.getElementById('dcp-ctx-ring');
    if (!btn || !this._data) return;
    this.paintPanel();
    p.style.display = 'block';
    var r = btn.getBoundingClientRect();
    var ph = p.offsetHeight, pw = p.offsetWidth;
    var left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2));
    var top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    p.style.left = left + 'px';
    p.style.top = top + 'px';
  },

  hidePanel: function () {
    var p = document.getElementById('dcp-ctx-panel');
    if (p) p.style.display = 'none';
  },

  // 无数据时的占位载荷：圆圈常驻显示（用户要求），首次对话前显示 0%
  emptyData: function () {
    return { used: 0, input: 0, cacheRead: 0, cacheCreate: 0, estSys: 0, estTool: 0, estMsg: 0, model: '', estimated: false };
  },

  /* ---------- 会话切换感知：按官方 session ID 恢复本地占用 ----------
   * demo 的会话 ID 只存在于 IndexedDB，URL/请求体都不带；DemoSearch.currentSession
   * 会用 active 侧边栏项（收起时用标题 + 可见 user 文本）解析出稳定 ID。
   * ctx:api 到来时按该 ID 写入 dcp_sessions_v1，切回时直接恢复。 */
  hasSessionDom: function () {
    var SEL = DCP.SEL || {};
    if (SEL.chatTitle && document.querySelector(SEL.chatTitle)) return true;
    if (SEL.sidebarItemActive && document.querySelector(SEL.sidebarItemActive)) return true;
    return false;
  },

  resetForNewChat: function () {
    // pointerdown 与 click 都会走到这里；已经清空时不要再次把 baseSid 覆盖。
    if (this._newChatPending && this._sessionId === null) return;
    // 新会话在 IndexedDB 落盘前没有稳定 ID。点击按钮后必须同步清空旧读数，
    // 否则工具条重建时 MutationObserver 会先用 _data 重绘，短暂或持续显示
    // 上一会话 token；随后异步 currentSession 也可能先读到尚未清除的旧 DOM。
    this._syncToken = (this._syncToken || 0) + 1;
    this._newChatPending = true;
    this._newChatBaseSid = this._sessionId || null;
    this._newChatDeadline = Date.now() + 5000;
    this._sessionId = null;
    this._last = 0;
    this._data = this.emptyData();
    var tracker = DCP.modules && DCP.modules.demoSearch;
    if (tracker && typeof tracker.invalidateRequests === 'function') tracker.invalidateRequests();
    DCP.emit('session:change', { sessionId: null });
    this.update(this._data);
    this.hidePanel();
  },

  syncSession: async function (force) {
    var SEL = DCP.SEL || {};
    var n = SEL.msg ? document.querySelectorAll(SEL.msg).length : 0;
    if (n === this._msgCount && !force) return;
    var prev = this._msgCount;
    this._msgCount = n;
    // 流式生成只会让消息数增加，此时不能拿旧快照覆盖刚收到的 usage。
    if (prev != null && n > prev && !force) return;
    var token = (this._syncToken || 0) + 1;
    this._syncToken = token;
    var search = DCP.modules && DCP.modules.demoSearch;
    var session = search && typeof search.currentSession === 'function' ? await search.currentSession() : null;
    if (token !== this._syncToken) return;
    var sid = session && session.id;

    // 新建会话后的前几次解析可能仍看到旧聊天 DOM/IndexedDB。只要结果还是
    // 点击前的会话就保持空态，直到真正的新会话落盘；用户主动点其它会话时
    // 监听器会清除该保护。
    if (this._newChatPending && sid && sid === this._newChatBaseSid) {
      if (Date.now() > this._newChatDeadline) this._newChatPending = false;
      return;
    }
    if (this._newChatPending && !sid && this._sessionId === null) {
      if (Date.now() > this._newChatDeadline) this._newChatPending = false;
      return;
    }
    if (this._newChatPending && sid && sid !== this._newChatBaseSid) this._newChatPending = false;

    if (sid && sid === this._sessionId) return;
    if (sid !== this._sessionId) {
      var tracker = DCP.modules && DCP.modules.demoSearch;
      // 新会话首个请求发起时 IndexedDB 往往还没落盘，request 的 sessionId
      // 可能暂时为 null，也可能已经解析出来但 ctxRing 自己还是 null。随后
      // syncSession 识别出同一个会话属于身份补全，不是用户切会话，不能递增
      // 纪元把该请求自己的 TPS/ctx 事件全部丢掉。
      var completingRequest = !this._sessionId && !!sid && tracker && (
        (typeof tracker.hasPendingRequestForSession === 'function' && tracker.hasPendingRequestForSession(sid)) ||
        (typeof tracker.hasPendingAnonymousRequest === 'function' && tracker.hasPendingAnonymousRequest())
      );
      if (!completingRequest && tracker && typeof tracker.invalidateRequests === 'function') {
        tracker.invalidateRequests();
      }
    }
    this._sessionId = sid || null;
    DCP.emit('session:change', { sessionId: this._sessionId });
    var saved = sid && DCP.config.sessions()[sid];
    this.update(saved || this.emptyData());
    if (!saved) this.hidePanel();
  },

  init: function () {
    var self = this;
    var SEL = DCP.SEL || {};
    // 精确触发：换会话时从工具条到 view 的整条输入子树都会被换掉（实测 5 层
    // 全灭、只剩聊天内容根节点存活）——所以把 childList 观察器绑在圆圈的**整条
    // 祖先链**上（最多 8 层）：任一层的子级变动都立刻检查，活着的那个层就会
    // 在替换发生的同一个 microtask（浏览器绘制前）补注，圆圈不会闪。被换掉
    // 的层其观察器随之失效（无害），补注后重新绑到新链上
    var bindPrecise = function () {
      // 关键：没有圆圈时直接返回、绝不能摘掉现有观察器。早先无条件摘+重绑，
      // 而 inject() 失败（工具条还没渲染完）时圆圈不存在、新链也走不起来——
      // 结果观察器被全部摘掉且没绑新的，之后只能等 body 节流兜底（实测掉到
      // ~117ms）。保留旧观察器，它们会在下一次变异时继续尝试
      var ring0 = document.getElementById('dcp-ctx-ring');
      if (!ring0) return;
      (self._barMos || []).forEach(function (mo) { try { mo.disconnect(); } catch (e) {} });
      self._barMos = [];
      var ring = ring0;
      var n = ring && ring.parentElement;
      var depth = 0, top = null;
      while (n && n !== document.body && depth < 8) {
        (function (host) {
          var mo = new MutationObserver(function () {
            if (document.getElementById('dcp-ctx-ring')) return;
            self.inject();
            self.update(self._data || self.emptyData());
            bindPrecise();          // 新链可能变了——重新绑
            DCP.emit('toolbar:rebuild');   // 同一条工具条上的速率读数跟着在同一帧补回
          });
          mo.observe(host, { childList: true });
          self._barMos.push(mo);
        })(n);
        top = n;
        n = n.parentElement;
        depth++;
      }
      // 最上层存活节点再加一个 subtree 监听：实测换会话时新工具条外壳先出现
      // （t≈38ms）、按钮行要到 t≈87ms 才渲染完——只听直接子级变动会在外壳出现
      // 那刻尝试补注却因按钮行没就绪而失败，之后干等节流兜底。subtree 让按钮行
      // 渲染完成的那一刻就补上。回调本身只是 getElementById 早退，代价可忽略
      if (top) {
        var moTop = new MutationObserver(function () {
          if (document.getElementById('dcp-ctx-ring')) return;
          self.inject();
          self.update(self._data || self.emptyData());
          bindPrecise();
          DCP.emit('toolbar:rebuild');
        });
        moTop.observe(top, { childList: true, subtree: true });
        self._barMos.push(moTop);
      }
    };
    Utils.onReady(function () {
      self.inject();
      // 首帧即显示（开着自定义模型时）
      self.update(self._data || self.emptyData());
      bindPrecise();
      DCP.on('ctx:api', function (p) {
        if (!p || !(p.used > 0)) return;
        var tracker = DCP.modules && DCP.modules.demoSearch;
        if (p.requestId && tracker && typeof tracker.isRequestCurrent === 'function' &&
            !tracker.isRequestCurrent(p)) return;
        self.update(p);
      });
      // 常驻显隐由「总开关 + 桥接是否活动」共同决定：关→隐藏；开且桥接在跑
      // （配了第三方端点）→立刻显示（没数据时 0%），不必等首次对话；
      // demoCustom 开着但端点是官方/未配时桥接不跑，圆圈永远拿不到数据，
      // 那种情况下隐藏（见 canShow 注释）
      DCP.on('cfg:change', function (e) {
        if (e.path === 'demoCustom' || e.path === 'demoEndpoint' || e.path === 'demoBridge' || e.path === 'demoShowCtxRing') {
          self.update(self._data || self.emptyData());
          if (!self.canShow()) self.hidePanel();
        }
        if (e.path === 'demoCtxLimit') {
          // 输入改不动的（比如把 128k 打成 128x）要给个反馈，否则用户只会看到
          // 百分比毫无变化、以为脚本坏了
          if (String(DCP.config.get('demoCtxLimit') || '').trim() && !self.parseLimit(DCP.config.get('demoCtxLimit'))) {
            Utils.toast(DCP.t('上下文窗口无法识别「{v}」，已按 128K 计算。可填 128000 / 128k / 1m', { v: String(DCP.config.get('demoCtxLimit')).slice(0, 20) }), 3600);
          }
          if (self._data) { self.update(self._data); self.hidePanel(); }
        }
      });
      // 工具条会随会话切换重建——保持圆圈在场。节流（带前缘）而非防抖：
      // 防抖会被 DOM 变动不断重置，重建后圆圈迟迟不出现
      new MutationObserver(Utils.throttle(function () {
        if (!document.getElementById('dcp-ctx-ring')) {
          // 官方切到新会话时会先拆掉旧工具条；此时若聊天标题/active 项也已
          // 消失，就不能再拿旧 _data 补画，否则用户会看到上一会话 token。
          if (!self.hasSessionDom() && self._sessionId) self.resetForNewChat();
          else self.update(!self.hasSessionDom() ? self.emptyData() : (self._data || self.emptyData()));
          bindPrecise();
          DCP.emit('toolbar:rebuild');
        }
        // 消息数下降通常是切会话；点击监听覆盖“两条会话消息数相同”的情况。
        self.syncSession(!self._sessionId && !!(SEL.msg && document.querySelector(SEL.msg)));
      }, 100)).observe(document.body, { childList: true, subtree: true });
      // pointerdown 先于官方 click 处理：新建会话时在这一刻就清空，避免旧
      // token 在 React 切换工具条的几十毫秒窗口里继续可见。
      document.addEventListener('pointerdown', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('button[aria-label="开启新对话"]') : null;
        if (t) self.resetForNewChat();
      }, true);
      document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest((DCP.SEL || {}).sidebarItem + ', button[aria-label="开启新对话"]') : null;
        if (t) {
          var isNewChat = !!(t.matches && t.matches('button[aria-label="开启新对话"]'));
          if (isNewChat) {
            // 先同步清空，再让异步解析去辨认真正的新会话；不能等 IndexedDB。
            self.resetForNewChat();
          } else {
            self._newChatPending = false;
          }
          // 点击当前会话不应打断正在生成的数据；切到别的会话/新建会话必须在
          // 异步 currentSession 解析前立刻递增纪元，拒绝上一请求的迟到事件。
          var activeSel = (DCP.SEL || {}).sidebarItemActive;
          var sameActive = !!(activeSel && t.matches && t.matches(activeSel));
          if (!sameActive && !isNewChat) {
            var tracker = DCP.modules && DCP.modules.demoSearch;
            if (tracker && typeof tracker.invalidateRequests === 'function') tracker.invalidateRequests();
            // 新会话 id 要等异步解析才有，这期间屏上已经是别的会话了——先通知
            // 速率读数清空，别继续顶着旧会话的数字
            DCP.emit('session:leave');
          }
          setTimeout(function () { self.syncSession(true); }, 0);
        }
      }, true);
      self.syncSession(true);
    });
  }
};
DCP.modules.ctxRing = CtxRing;

/* ===== modules/tpsmeter.js ===== */
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

/* ===== modules/demosearch.js ===== */
/* ============================================================
 * modules/demosearch：chat-demo 会话搜索（一比一复刻官方主站）
 *
 * 背景：demo 页（cdn.deepseek.com/chat-demo）自身没有会话搜索——bundle 里
 * 零搜索代码，左上角只有 Logo / 收起边栏 / 开启新对话。官方主站有：头部
 * pill 第二个图标（放大镜）打开居中模态浮层，搜全部会话的消息内容。本模块
 * 按官方实测规格复刻这套交互，数据源换成 demo 页本地 IndexedDB（官方是
 * 服务端 SSE 搜云端；demo 的会话全在本地，无服务端可搜——这是唯一无法
 * 同源的点）。
 *
 * 官方规格（2026-11-18 主站实测，暗/亮两主题；只抄数值与结构，不抄官方
 * 的构建哈希类名）：
 *   遮罩  全屏 fixed，bg rgba(0,0,0,.6)（亮 .36）+ backdrop-filter blur(2px)
 *   表层  宽 660px、圆角 20px、暗 #2c2c2e / 亮 #fff、
 *         阴影 0 2px 4px rgba(0,0,0,.04), 0 4px 10px rgba(0,0,0,.02)、
 *         水平垂直居中、max-height calc(100vh - 202px)（内容超出则列表内滚）
 *   搜索框 高 61px、padding 12px 12px 12px 8px、左 16px 放大镜（dim 色）、
 *         输入框字号 16px（暗 #f9fafb / 亮 #0f1115）、右侧 × 关闭
 *   结果项 左 40×40 气泡图标（20px，#81858c 双主题同值）；
 *         标题 15px、日期 13px「M月D日」、多命中徽标 11px「n/m」均 dim 色；
 *         摘要 13px（暗 #cfd3d6 / 亮 #61666b）、宽约 570px、单行 nowrap
 *         截断、保留原始 markdown 不渲染、命中词同色加粗（font-weight 500）
 *   选中/悬停行背景 暗 #353638 / 亮 #f1f3f5；空状态「暂无相关结果」
 *   防抖 200ms（官方 conversation_search_debounce_ms 默认值）
 *
 * 数据源（demo 页 IndexedDB 实测）：库 chat-demo → store sessions，
 * {id,title,createdAt,updatedAt,messages[]}；消息是 parentId/selectedChildId
 * 树，user.content 为字符串，assistant 内容在 blocks[]——只取 type==='text'
 * 的块（与官方可见结果一致，思考/工具块不搜）。
 * 侧边栏顺序通常与 sessionSummaries 按 updatedAt 降序一致，但脚本不再把
 * active 项索引直接当作会话 ID：索引只用于取当前标题，最终身份还要求用户
 * 消息文本与附件特征唯一匹配，避免新会话尚未落盘时回指上一会话。
 *
 * 与官方其余差异（如实记录）：结果排序官方按服务端相关度，本地按会话
 * updatedAt 降序+会话内消息序；官方结果列表虚拟滚动，本地全量渲染（同量
 * 级无性能差异）；官方标题命中结果的形态未取到样本，本地摘要取该会话首条
 * 用户消息。
 * ============================================================ */
var DemoSearch = {
  // 官方实测配色（暗/亮两组，取自官方设计令牌在两主题下的解析值）
  PALETTE: {
    dark: { surface: '#2c2c2e', text: '#f9fafb', snippet: '#cfd3d6', dim: '#adb2b8', hover: '#353638', mask: 'rgba(0,0,0,.6)' },
    light: { surface: '#ffffff', text: '#0f1115', snippet: '#61666b', dim: '#81858c', hover: '#f1f3f5', mask: 'rgba(0,0,0,.36)' }
  },
  // 官方同款图标（从主站元素提取的原始 path，未改一个数值）
  ICON_MAGNIFIER: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M11.748 6.7028C11.748 3.90104 9.47653 1.62976 6.6748 1.62956C3.87291 1.62956 1.60156 3.90091 1.60156 6.7028C1.60176 9.50453 3.87304 11.776 6.6748 11.776C9.47641 11.7759 11.7479 9.50441 11.748 6.7028ZM13.0479 6.7028C13.0477 10.2224 10.1944 13.0757 6.6748 13.0759C3.15507 13.0759 0.300977 10.2225 0.300781 6.7028C0.300781 3.18294 3.15494 0.328781 6.6748 0.328781C10.1945 0.328977 13.0479 3.18307 13.0479 6.7028Z" fill="currentColor"/>' +
    '<path d="M15.6991 14.7513L14.7792 15.6712L11.3974 12.2894L12.3173 11.3694L15.6991 14.7513Z" fill="currentColor"/></svg>',
  ICON_CLOSE: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M14.1871 13.1265L13.1265 14.1872L1.81275 2.87347L2.87341 1.81281L14.1871 13.1265" fill="currentColor"/>' +
    '<path d="M13.1265 1.81282L14.1871 2.87348L2.8734 14.1872L1.81274 13.1265L13.1265 1.81282Z" fill="currentColor"/></svg>',
  ICON_BUBBLE: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2C5.58162 2 2.00003 5.58162 2 10C2 11.2255 2.27557 12.3887 2.76953 13.4287L3.07422 14.0674L4.35059 13.4609L4.04785 12.8223L3.90332 12.4971C3.58796 11.7279 3.41406 10.8848 3.41406 10C3.41409 6.36278 6.36277 3.41407 10 3.41406C13.6372 3.41406 16.5859 6.36278 16.5859 10C16.5859 13.6372 13.6372 16.5859 10 16.5859C9.25515 16.5859 8.70984 16.5329 8.22656 16.3994C7.75059 16.2679 7.29925 16.0478 6.75879 15.6709C5.96644 15.1182 4.82978 14.9233 3.89355 15.5146L3.86426 15.5342L3.24121 15.9727L3.70996 17.3721L4.65918 16.7041C5.00017 16.4952 5.50572 16.5226 5.94824 16.8311C6.58879 17.2779 7.18624 17.5792 7.85059 17.7627C8.50781 17.9442 9.19541 18 10 18C14.4184 18 18 14.4184 18 10C18 5.58162 14.4184 2 10 2ZM6.25 10.5566V11.9707H10.1367V10.5566H6.25ZM6.25 9.23438H13.7852V7.82031H6.25V9.23438Z" fill="#81858C"/></svg>',
  Z_INDEX: 2147483400,                 // 项目内阶梯：高于 toast(2147483000)，低于设置面板(2147483500)

  active: function () { return location.hostname === 'cdn.deepseek.com'; },

  init: function () {
    if (!this.active()) return;
    var self = this;
    Utils.onReady(function () {
      self.injectEntry();
      // demo 头部会随侧边栏开合重绘——掉了就补。节流（带前缘）而非防抖：
      // 防抖会被连续 DOM 变动重置，入口迟迟不出现
      new MutationObserver(Utils.throttle(function () {
        if (!document.getElementById('dcp-search-entry')) self.injectEntry();
      }, 100)).observe(document.body, { childList: true, subtree: true });
      // 主题切换：只更新根节点上的配色变量，已渲染条目自动跟随
      Utils.onThemeChange(function () { self.paint(); });
    });
  },

  /* ---------- 入口按钮（注入 demo 页左上角 Logo 行） ---------- */
  // 位置：收起边栏按钮左侧。官方 pill 内顺序是[收起][搜索][新对话]，但 demo
  // 侧边栏宽 261px、收起按钮已贴右缘（214–248），右侧放不下 34px——故放其
  // 左侧，是唯一可行且不挤占官方元素的位置
  injectEntry: function () {
    var self = this;
    if (!this.active() || document.getElementById('dcp-search-entry')) return;
    var top = document.querySelector('.top-ac14ac');
    if (!top) return;
    var collapse = Array.from(top.querySelectorAll('button'))
      .find(b => (b.getAttribute('aria-label') || '') === '收起边栏');
    if (!collapse) return;
    // 尺寸/圆角/图标色对齐邻位按钮（实测照抄，不猜）
    var cs = getComputedStyle(collapse);
    var iconColor = cs.color;
    var btn = document.createElement('button');
    btn.id = 'dcp-search-entry';
    btn.type = 'button';
    btn.title = DCP.t('搜索对话内容...');
    btn.setAttribute('aria-label', DCP.t('搜索对话内容...'));
    btn.style.cssText = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;' +
      'flex:0 0 auto;width:34px;height:34px;margin:0 2px;padding:0;border:none;outline:none;cursor:pointer;' +
      'border-radius:' + (cs.borderRadius || '8px') + ';background:transparent;color:' + iconColor + ';' +
      'transition:background .15s;opacity:.9';
    btn.innerHTML = this.ICON_MAGNIFIER;
    // 注意：事件处理器是普通函数，里面的 this 是按钮元素而非模块——必须用
    // 顶部捕获的 self（本模块已在 demobridge 的 IIFE 上踩过同款坑）
    btn.addEventListener('mouseenter', function () { btn.style.background = self.pal().hover; });
    btn.addEventListener('mouseleave', function () { btn.style.background = 'transparent'; });
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); self.open(); });
    // 收起按钮裹在一个 trigger span 里，页面自带的 tooltip（"收起边栏"）就锚在
    // 这个 span 上——按钮若插进 span，悬停它会弹出"收起边栏"（实测踩到）。
    // 故插到 .top-ac14ac 下、排在 trigger span 之前：视觉上同样贴在收起按钮
    // 左侧（span 是 display:contents，不改变布局），但不共享它的提示锚点
    top.insertBefore(btn, collapse.parentElement);
  },

  pal: function () { return Utils.isDark() ? this.PALETTE.dark : this.PALETTE.light; },

  /* ---------- 浮层（首次打开时构建，之后只切显隐） ---------- */
  build: function () {
    if (this.overlay) return;
    var self = this;
    var p = this.pal();

    var overlay = document.createElement('div');
    overlay.id = 'dcp-search-mask';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:' + this.Z_INDEX + ';background:' + p.mask +
      ';backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)';
    overlay.addEventListener('click', function () { self.close(); });

    var surface = document.createElement('div');
    surface.id = 'dcp-search-modal';
    surface.setAttribute('role', 'dialog');
    // font-family:inherit——表单控件（input/button）默认不继承字体，会掉到
    // Arial（实测），整层显式继承页面字体才与官方一致
    surface.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:' + (this.Z_INDEX + 1) +
      ';width:660px;max-width:calc(100vw - 32px);max-height:calc(100vh - 202px);box-sizing:border-box;' +
      'display:flex;flex-direction:column;overflow:hidden;border-radius:20px;background:' + p.surface +
      ';box-shadow:rgba(0,0,0,.04) 0 2px 4px 0,rgba(0,0,0,.02) 0 4px 10px 0;font-family:inherit;line-height:inherit';

    var box = document.createElement('div');
    box.style.cssText = 'box-sizing:border-box;flex:0 0 auto;height:61px;display:flex;align-items:center;' +
      'gap:8px;padding:12px 12px 12px 8px';
    var ico = document.createElement('span');
    ico.style.cssText = 'flex:0 0 auto;display:inline-flex;color:' + p.dim;
    ico.innerHTML = this.ICON_MAGNIFIER;
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = DCP.t('搜索对话内容...');
    // font-family/line-height:inherit——input 默认不继承（实测掉到 Arial），
    // 必须显式继承页面字体才与官方浮层一致；官方输入框行高实测 24px
    input.style.cssText = 'flex:1 1 auto;min-width:0;height:24px;border:none;outline:none;background:transparent;' +
      'font-size:16px;font-family:inherit;line-height:24px;color:' + p.text;
    input.addEventListener('input', Utils.debounce(function () { self.runSearch(input.value); }, 200));
    var close = document.createElement('button');
    close.type = 'button';
    close.style.cssText = 'box-sizing:border-box;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;' +
      'width:34px;height:34px;border:none;outline:none;cursor:pointer;border-radius:8px;background:transparent;color:' + p.dim;
    close.innerHTML = this.ICON_CLOSE;
    close.addEventListener('click', function () { self.close(); });
    box.appendChild(ico); box.appendChild(input); box.appendChild(close);

    var list = document.createElement('div');
    list.id = 'dcp-search-list';
    // 官方实测：滚动容器无 padding，其内层 items 容器 padding 8px 8px 0
    list.style.cssText = 'box-sizing:border-box;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;' +
      'padding:8px 8px 0';

    surface.appendChild(box); surface.appendChild(list);
    overlay.appendChild(surface);
    document.body.appendChild(overlay);

    this.overlay = overlay; this.surface = surface; this.input = input; this.list = list;
    // Esc 关闭（打开期间常驻，关闭后不拦键）
    this._onKey = function (e) { if (e.key === 'Escape') self.close(); };
  },

  paint: function () {
    if (!this.overlay) return;
    var p = this.pal();
    this.overlay.style.background = p.mask;
    this.surface.style.background = p.surface;
    this.input.style.color = p.text;
    this.list.querySelectorAll('[data-dcp-s-text]').forEach(function (el) { el.style.color = p.text; });
    this.list.querySelectorAll('[data-dcp-s-dim]').forEach(function (el) { el.style.color = p.dim; });
    this.list.querySelectorAll('[data-dcp-s-snippet]').forEach(function (el) { el.style.color = p.snippet; });
  },

  open: function () {
    this.build();
    this.overlay.style.display = 'block';
    this.paint();
    this.input.value = '';
    this.list.innerHTML = '';
    this.input.focus();
    document.addEventListener('keydown', this._onKey, true);
  },

  close: function () {
    if (!this.overlay) return;
    this.overlay.style.display = 'none';
    document.removeEventListener('keydown', this._onKey, true);
  },

  /* ---------- 数据：读本地会话，沿活跃消息链收集可搜文本 ---------- */
  readSessions: function () {
    return new Promise(function (resolve) {
      var rq = null, settled = false, db = null;
      function done(value) {
        if (settled) return;
        settled = true;
        if (db) { try { db.close(); } catch (e) {} }
        resolve(value || []);
      }
      try { rq = indexedDB.open('chat-demo'); } catch (e) { return done([]); }
      if (!rq) return done([]);
      rq.onerror = function () { done([]); };
      rq.onabort = function () { done([]); };
      rq.onblocked = function () { done([]); };
      rq.onsuccess = function () {
        if (settled) {
          try { rq.result.close(); } catch (e) {}
          return;
        }
        try {
          db = rq.result;
          if (!db.objectStoreNames || !db.objectStoreNames.contains('sessions')) return done([]);
          var getAll = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
          getAll.onsuccess = function () { done(getAll.result || []); };
          getAll.onerror = function () { done([]); };
          getAll.onabort = function () { done([]); };
        } catch (e) { done([]); }
      };
    });
  },

  // 侧栏同步只需要摘要，不把 151 条会话的完整消息树全部读进内存。
  readSummaries: function () {
    return new Promise(function (resolve) {
      var rq = null, settled = false, db = null;
      function done(value) {
        if (settled) return;
        settled = true;
        if (db) { try { db.close(); } catch (e) {} }
        resolve(value || []);
      }
      try { rq = indexedDB.open('chat-demo'); } catch (e) { return done([]); }
      if (!rq) return done([]);
      rq.onerror = function () { done([]); };
      rq.onabort = function () { done([]); };
      rq.onblocked = function () { done([]); };
      rq.onsuccess = function () {
        if (settled) {
          try { rq.result.close(); } catch (e) {}
          return;
        }
        try {
          db = rq.result;
          if (!db.objectStoreNames || !db.objectStoreNames.contains('sessionSummaries')) return done([]);
          var getAll = db.transaction('sessionSummaries', 'readonly').objectStore('sessionSummaries').getAll();
          getAll.onsuccess = function () { done(getAll.result || []); };
          getAll.onerror = function () { done([]); };
          getAll.onabort = function () { done([]); };
        } catch (e) { done([]); }
      };
    });
  },

  readSession: function (id) {
    return new Promise(function (resolve) {
      var rq = null, settled = false, db = null;
      function done(value) {
        if (settled) return;
        settled = true;
        if (db) { try { db.close(); } catch (e) {} }
        resolve(value || null);
      }
      if (!id) return done(null);
      try { rq = indexedDB.open('chat-demo'); } catch (e) { return done(null); }
      if (!rq) return done(null);
      rq.onerror = function () { done(null); };
      rq.onabort = function () { done(null); };
      rq.onblocked = function () { done(null); };
      rq.onsuccess = function () {
        if (settled) {
          try { rq.result.close(); } catch (e) {}
          return;
        }
        try {
          db = rq.result;
          if (!db.objectStoreNames || !db.objectStoreNames.contains('sessions')) return done(null);
          var get = db.transaction('sessions', 'readonly').objectStore('sessions').get(id);
          get.onsuccess = function () { done(get.result || null); };
          get.onerror = function () { done(null); };
          get.onabort = function () { done(null); };
        } catch (e) { done(null); }
      };
    });
  },

  // 侧栏行 → 稳定会话 ID。页面没有把 ID 放在 DOM 上，只能按官方自己的排序
  // （updatedAt 倒序）+ 标题队列还原；当前行再单独用消息树校验。数量不相等
  // （例如文件夹插件隐藏了行）时只映射标题唯一项，宁可不显示状态也不挂错行。
  sidebarRowsWithIds: async function () {
    var SEL = DCP.SEL || {};
    var rows = SEL.sidebarItem ? Array.prototype.slice.call(document.querySelectorAll(SEL.sidebarItem)) : [];
    if (!rows.length) return [];
    var summaries = await this.readSummaries();
    if (!summaries.length) return rows.map(function (row) { return { row: row, sid: null, summary: null }; });
    summaries.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var queues = {}, titleCounts = {};
    summaries.forEach(function (s) {
      var title = DemoSearch.normalizeTitle(s.title);
      (queues[title] || (queues[title] = [])).push(s);
      titleCounts[title] = (titleCounts[title] || 0) + 1;
    });
    var rowTitleCounts = {};
    var titles = rows.map(function (row) {
      var el = SEL.sidebarItemTitle ? row.querySelector(SEL.sidebarItemTitle) : null;
      var title = DemoSearch.normalizeTitle((el || row).textContent);
      rowTitleCounts[title] = (rowTitleCounts[title] || 0) + 1;
      return title;
    });
    var complete = rows.length === summaries.length;
    var out = rows.map(function (row, i) {
      var title = titles[i], sid = null, summary = null;
      if (complete || (titleCounts[title] === 1 && rowTitleCounts[title] === 1)) {
        summary = queues[title] && queues[title].length ? queues[title].shift() : null;
        sid = summary && summary.id || null;
      }
      if (sid) {
        row.__dcpSessionId = sid;
        row.setAttribute('data-dcp-session-id', sid);
      } else {
        delete row.__dcpSessionId;
        row.removeAttribute('data-dcp-session-id');
      }
      return { row: row, sid: sid, summary: summary };
    });

    // 当前行是唯一能再用消息内容校验的锚点。校验失败说明排序/隐藏导致整份
    // 映射都不可信，全部撤掉，避免把别的会话的转圈/蓝点挂到当前行。
    var activeSel = SEL.sidebarItemActive;
    var active = out.find(function (e) { return activeSel && e.row.matches(activeSel); });
    if (!active) active = out.find(function (e) { return /(^|\s)active-/.test(e.row.className || ''); });
    if (active && active.sid) {
      var session = await this.readSession(active.sid);
      var titleEl = SEL.chatTitle ? document.querySelector(SEL.chatTitle) : null;
      var chatTitle = this.normalizeText(titleEl ? titleEl.textContent : '');
      var titleOk = !chatTitle || this.normalizeTitle(chatTitle) === this.normalizeTitle(session && session.title);
      // 正文不一致不一定说明映射错了：另一个标签刚写入的新消息还没同步到
      // 当前 DOM。标题和会话是否存在才是硬校验；正文校验只用于欢迎页/空标题
      // 这种没有标题可锚定的场景。
      var contentOk = session ? this.domSessionMatches(session, this.domUsers()) : false;
      if (!session || !titleOk || (!chatTitle && !contentOk)) {
        out.forEach(function (e) {
          e.sid = null; e.summary = null;
          delete e.row.__dcpSessionId;
          e.row.removeAttribute('data-dcp-session-id');
        });
      }
    }
    return out;
  },

  // 沿 selectedChildId 走当前分支（与页面自身读取逻辑一致）
  chain: function (session) {
    var byId = {}, msgs = session.messages || [], i;
    for (i = 0; i < msgs.length; i++) byId[msgs[i].id] = msgs[i];
    var root = null;
    for (i = 0; i < msgs.length; i++) if (msgs[i].parentId == null) { root = msgs[i]; break; }
    if (!root) root = msgs[0];
    var out = [], cur = root, guard = 0;
    while (cur && guard++ < 500) { out.push(cur); cur = cur.selectedChildId ? byId[cur.selectedChildId] : null; }
    return out;
  },

  normalizeText: function (s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  },

  normalizeTitle: function (s) {
    return this.normalizeText(s) || DCP.t('新对话');
  },

  // 会话记录把附件放在 message.files（id/serverId/name/isImage/mimeType），
  // 请求体则把附件表达成 document/image content block。两边归一成同一组
  // {type,name,id,mimeType}，避免“文本 + document”被误判，也避免两个只有
  // 空文本的附件会话因为 text==='' 而被当成同一个。
  messageAttachments: function (m) {
    if (!m) return [];
    var out = [], seen = {}, self = this;
    function add(type, name, id, mimeType) {
      type = type === 'image' ? 'image' : 'document';
      name = self.normalizeText(name);
      id = self.normalizeText(id);
      mimeType = self.normalizeText(mimeType).toLowerCase();
      var key = [type, name, id, mimeType].join('|');
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ type: type, name: name, id: id, mimeType: mimeType });
    }
    if (Array.isArray(m.files) && m.files.length) {
      m.files.forEach(function (f) {
        if (!f) return;
        var mime = f.mimeType || f.type || '';
        add(f.isImage || /^image\//i.test(mime) ? 'image' : 'document',
          f.name || f.filename || f.title, f.serverId || f.file_id || f.id, mime);
      });
      // message.files 是官方会话对附件的权威清单；少数记录还会在 content
      // 里重复放 document/image block，再把两边叠加会虚增附件数量。
      return out;
    }
    if (Array.isArray(m.content)) {
      m.content.forEach(function (b) {
        if (!b || (b.type !== 'document' && b.type !== 'image' && b.type !== 'file')) return;
        var src = b.source || {};
        var mime = src.media_type || b.media_type || b.mimeType || '';
        add(b.type === 'image' || /^image\//i.test(mime) ? 'image' : 'document',
          b.title || b.name || src.name || src.filename,
          src.file_id || src.fileId || b.file_id || b.id, mime);
      });
    }
    return out;
  },

  attachmentsEqual: function (a, b, strictId) {
    a = a || []; b = b || [];
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].type !== b[i].type) return false;
      if (a[i].name && b[i].name && a[i].name !== b[i].name) return false;
      if (strictId) {
        if (!!a[i].id !== !!b[i].id) return false;
        if (a[i].id && b[i].id && a[i].id !== b[i].id) return false;
      } else if (a[i].id && b[i].id && a[i].id !== b[i].id) {
        return false;
      }
    }
    return true;
  },

  // 页面文件卡只有 title/download，没有 serverId；因此 DOM 匹配只比较类型、
  // 数量、文件名。请求体匹配走 strictId，再额外比较 file_id/serverId。
  domUserAttachments: function (bubble) {
    if (!bubble) return [];
    var root = bubble;
    if (bubble.closest) root = bubble.closest('[class*="container-"]') || bubble;
    else {
      for (var d = 0; d < 4 && root.parentElement; d++) {
        root = root.parentElement;
        if ((root.className || '').indexOf('container-') !== -1) break;
      }
    }
    var cards = [];
    try {
      cards = Array.prototype.slice.call(root.querySelectorAll('[class*="card-"][title], a[download]'));
    } catch (e) { cards = []; }
    if (!cards.length) return [];
    var filesRoot = null;
    try { filesRoot = root.querySelector('[class*="files-"]'); } catch (e) {}
    var rootClass = String((filesRoot && filesRoot.className) || root.className || '');
    var out = [], seen = {};
    cards.forEach(function (card) {
      var name = card.getAttribute('title') || card.getAttribute('download') ||
        card.getAttribute('aria-label') || card.textContent || '';
      name = DemoSearch.normalizeText(name);
      if (!name || seen[name]) return;
      seen[name] = 1;
      var isImage = /filesWithImages/i.test(rootClass) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
      out.push({ type: isImage ? 'image' : 'document', name: name, id: '', mimeType: '' });
    });
    return out;
  },

  domUsers: function () {
    var SEL = DCP.SEL || {};
    var scope = SEL.chatView ? document.querySelector(SEL.chatView) : null;
    if (!scope) scope = document;
    var bubbles = SEL.userBubble ? Array.prototype.slice.call(scope.querySelectorAll(SEL.userBubble)) : [];
    return bubbles.map(function (el) {
      return {
        text: DemoSearch.normalizeText(el.textContent),
        attachments: DemoSearch.domUserAttachments(el)
      };
    });
  },

  sessionUsers: function (session) {
    return this.chain(session).filter(function (m) { return m.role === 'user'; }).map(function (m) {
      return { text: this.normalizeText(this.msgText(m)), attachments: this.messageAttachments(m) };
    }.bind(this));
  },

  // 当前会话必须同时通过标题、用户消息文本和附件特征校验。任何一项无法
  // 唯一匹配都返回 null——宁可放弃恢复/持久化，也不能把别的内容写进来。
  domSessionMatches: function (session, domUsers) {
    var users = this.sessionUsers(session);
    if (users.length !== domUsers.length) return false;
    for (var i = 0; i < users.length; i++) {
      var textOk = users[i].text === domUsers[i].text;
      var attrsOk = this.attachmentsEqual(users[i].attachments, domUsers[i].attachments, false);
      if (!attrsOk) return false;
      // 附件匹配不能掩盖矛盾正文：只有纯附件/粘贴文件场景允许一侧文本为空，
      // 两边都有正文时必须逐字一致，避免同标题同附件误选另一会话。
      if (!textOk && users[i].text && domUsers[i].text) return false;
    }
    return true;
  },

  currentSession: async function () {
    var sessions = await this.readSessions();
    if (!sessions.length) return null;
    sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var SEL = DCP.SEL || {};
    var items = SEL.sidebarItem ? Array.prototype.slice.call(document.querySelectorAll(SEL.sidebarItem)) : [];
    var active = SEL.sidebarItemActive ? document.querySelector(SEL.sidebarItemActive) : null;
    if (!active) {
      for (var i = 0; i < items.length; i++) {
        if (/(^|\s)active-/.test(items[i].className || '')) { active = items[i]; break; }
      }
    }
    var sidebarTitle = '';
    if (active) {
      var st = SEL.sidebarItemTitle ? active.querySelector(SEL.sidebarItemTitle) : null;
      sidebarTitle = this.normalizeText((st || active).textContent);
    }
    var chatTitle = SEL.chatTitle ? this.normalizeText((document.querySelector(SEL.chatTitle) || {}).textContent) : '';
    if (sidebarTitle && chatTitle && this.normalizeTitle(sidebarTitle) !== this.normalizeTitle(chatTitle)) return null;
    var title = this.normalizeTitle(chatTitle || sidebarTitle);
    var hasDomTitle = !!(chatTitle || sidebarTitle);
    var domUsers = this.domUsers();

    // 欢迎页/刚点“新对话”但 IndexedDB 尚未落盘时没有任何可信身份特征。
    // 此时绝不能按 updatedAt 或侧边栏索引回指到上一会话。
    if (!hasDomTitle && !domUsers.length) return null;
    if (!domUsers.length && title === this.normalizeTitle('')) return null;
    // 没有聊天区标题、只看到侧边栏“新对话”时，无法区分“尚未落盘的新会话”
    // 和一个历史空标题会话；即使提示词完全相同也不冒险匹配。
    if (!chatTitle && title === this.normalizeTitle('')) return null;

    var candidates = sessions.filter(function (s) {
      return this.normalizeTitle(s.title) === title;
    }.bind(this));
    if (!candidates.length && !hasDomTitle) candidates = sessions.slice();
    var matches = candidates.filter(function (s) {
      return this.domSessionMatches(s, domUsers);
    }.bind(this));
    // active 索引只用于读取当前项标题，不参与最终身份判定：官方排序与
    // IndexedDB 可能短暂不一致，真正可信的是标题 + 消息 + 附件特征。
    return matches.length === 1 ? matches[0] : null;
  },

  /* ---------- 请求纪元：切会话后丢弃上一请求的迟到事件 ---------- */
  _sessionEpoch: 0,
  _requestSeq: 0,
  _requests: {},
  invalidateRequests: function () {
    this._sessionEpoch++;
    this._requests = {};
  },
  beginRequest: function () {
    var self = this;
    var id = 'dcpr_' + Date.now().toString(36) + '_' + (++this._requestSeq).toString(36);
    var ctx = { requestId: id, epoch: this._sessionEpoch, sessionId: null, session: null };
    ctx.session = this.currentSession().then(function (s) {
      if (ctx.epoch !== self._sessionEpoch) return null;
      ctx.session = s || null;
      ctx.sessionId = s && s.id || null;
      return ctx.session;
    }, function () { return null; });
    this._requests[id] = ctx;
    return ctx;
  },
  refreshRequestSession: async function (ctx) {
    if (!ctx || !this._requests[ctx.requestId] || ctx.epoch !== this._sessionEpoch) return null;
    try {
      var s = await this.currentSession();
      if (ctx.epoch !== this._sessionEpoch || !this._requests[ctx.requestId]) return null;
      ctx.session = s || null;
      ctx.sessionId = s && s.id || null;
      return ctx.session;
    } catch (e) { return null; }
  },
  isRequestCurrent: function (payload) {
    if (!payload || !payload.requestId) return false;
    var ctx = this._requests[payload.requestId];
    if (!ctx || ctx.epoch !== this._sessionEpoch) return false;
    if (payload.sessionId && ctx.sessionId && payload.sessionId !== ctx.sessionId) return false;
    return true;
  },
  hasPendingAnonymousRequest: function () {
    var self = this;
    return Object.keys(this._requests).some(function (id) {
      var ctx = self._requests[id];
      return ctx && ctx.epoch === self._sessionEpoch && !ctx.sessionId;
    });
  },
  hasPendingRequestForSession: function (sid) {
    var self = this;
    return !!sid && Object.keys(this._requests).some(function (id) {
      var ctx = self._requests[id];
      return ctx && ctx.epoch === self._sessionEpoch && ctx.sessionId === sid;
    });
  },
  finishRequest: function (requestId) {
    if (requestId) delete this._requests[requestId];
  },

  // 一条消息的可搜文本：user=content 字符串或块数组里的 text 块（粘贴长文本
  // 转成 txt 附件后就是数组，早前只认字符串、那条消息会搜不到）；
  // assistant=text 块拼接（thinking/工具块不搜——官方可见结果同样只有正文）
  msgText: function (m) {
    if (!m) return '';
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.filter(function (b) { return b && b.type === 'text'; })
          .map(function (b) { return b.text || ''; }).join('\n');
      }
      return '';
    }
    return (m.blocks || []).filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text || ''; }).join('\n');
  },

  runSearch: async function (q) {
    q = String(q || '').trim();
    if (!q) { this.list.innerHTML = ''; return; }
    var sessions = await this.readSessions();
    // 与侧边栏同序：updatedAt 降序（索引即侧边栏条目位置）
    sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var ql = q.toLowerCase(), self = this, results = [];
    sessions.forEach(function (s, idx) {
      var title = (s.title || '').trim();
      var titleHit = title && title.toLowerCase().indexOf(ql) !== -1;
      var hits = [];
      self.chain(s).forEach(function (m) {
        var t = self.msgText(m);
        if (t && t.toLowerCase().indexOf(ql) !== -1) hits.push({ role: m.role, text: t });
      });
      // 标题命中：摘要取该会话首条用户消息（官方此形态未取到样本）
      if (titleHit && !hits.length) {
        var firstUser = '';
        self.chain(s).some(function (m) { if (m.role === 'user') { firstUser = self.msgText(m); return true; } return false; });
        hits.push({ role: 'user', text: firstUser });
      }
      hits.forEach(function (h, i) {
        results.push({ idx: idx, title: title, updatedAt: s.updatedAt || 0, text: h.text, n: i + 1, m: hits.length });
      });
    });
    this.render(q, results);
  },

  /* ---------- 渲染 ---------- */
  // 摘要：命中词前后各取约 60 字，前缀/后缀省略号；原文转义不渲染 markdown；
  // 命中词同色加粗（官方实测：无背景色，仅 font-weight 500）
  snippet: function (text, q) {
    var t = String(text || '');
    var i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) i = 0;
    var s = Math.max(0, i - 60), e = Math.min(t.length, i + q.length + 60);
    var pre = (s > 0 ? '…' : '') + t.slice(s, i);
    var hit = t.slice(i, i + q.length);
    var post = t.slice(i + q.length, e) + (e < t.length ? '…' : '');
    return Utils.escHtml(pre) + '<span data-dcp-s-hit style="font-weight:500">' + Utils.escHtml(hit) + '</span>' + Utils.escHtml(post);
  },

  fmtDate: function (ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  },

  render: function (q, results) {
    var self = this, p = this.pal();
    this.list.innerHTML = '';
    if (!results.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'box-sizing:border-box;padding:24px 16px;text-align:center;font-size:13px;color:' + p.dim;
      empty.textContent = DCP.t('暂无相关结果');
      this.list.appendChild(empty);
      return;
    }
    results.forEach(function (r) {
      var item = document.createElement('div');
      item.setAttribute('role', 'option');
      // 官方实测：flex/center/gap 12、padding 10 12 10 10、圆角 16
      item.style.cssText = 'box-sizing:border-box;display:flex;align-items:center;gap:12px;' +
        'padding:10px 12px 10px 10px;border-radius:16px;cursor:pointer;flex:0 0 auto';
      item.addEventListener('mouseenter', function () { item.style.background = self.pal().hover; });
      item.addEventListener('mouseleave', function () { item.style.background = 'transparent'; });
      item.addEventListener('click', function () { self.openSession(r.idx); });

      var ico = document.createElement('span');
      ico.style.cssText = 'flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px';
      ico.innerHTML = this.ICON_BUBBLE;

      var body = document.createElement('div');
      body.style.cssText = 'flex:1 1 0px;min-width:0';
      // 官方实测：标题行 flex/center/gap 12；标题行高 25、日期/徽标行高 20
      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:12px;min-width:0';
      var title = document.createElement('span');
      title.setAttribute('data-dcp-s-text', '1');
      title.style.cssText = 'flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-size:15px;line-height:25px;color:' + p.text;
      title.textContent = r.title || DCP.t('新对话');
      var date = document.createElement('span');
      date.setAttribute('data-dcp-s-dim', '1');
      date.style.cssText = 'flex:0 0 auto;font-size:13px;line-height:20px;color:' + p.dim;
      date.textContent = this.fmtDate(r.updatedAt);
      head.appendChild(title); head.appendChild(date);
      // 多命中会话显示「n/m」（官方实测：11px、dim 色、紧跟日期）
      if (r.m > 1) {
        var badge = document.createElement('span');
        badge.setAttribute('data-dcp-s-dim', '1');
        badge.style.cssText = 'flex:0 0 auto;font-size:11px;line-height:20px;color:' + p.dim;
        badge.textContent = r.n + '/' + r.m;
        head.appendChild(badge);
      }
      var snip = document.createElement('div');
      snip.setAttribute('data-dcp-s-snippet', '1');
      snip.style.cssText = 'margin-top:2px;font-size:13px;line-height:20px;color:' + p.snippet +
        ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      snip.innerHTML = this.snippet(r.text, q);
      body.appendChild(head); body.appendChild(snip);

      item.appendChild(ico); item.appendChild(body);
      this.list.appendChild(item);
    }.bind(this));
  },

  /* ---------- 打开会话（按索引点侧边栏对应条目） ---------- */
  // 侧边栏顺序 = sessionSummaries 按 updatedAt 降序，与搜索结果同序——
  // 第 idx 个条目就是要找的会话（重复标题也不会开错）
  openSession: function (idx) {
    this.close();
    var items = document.querySelectorAll('.item-ff6fc9');
    var el = items[idx];
    if (!el) return;
    Utils.realClick(el);
  },

  /* ---------- 桥接中断轮恢复 ----------
   * demo 的 IndexedDB 已完整保存 server_tool_use / tool_result / thinking，
   * 但官方下一次请求只带文本块。这里从同一份官方记录重建结构化 API 历史，
   * 不另建存储、不截断内容。 */
  requestText: function (m) {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (!Array.isArray(m.content)) return '';
    return m.content.filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text || ''; }).join('\n');
  },

  sessionRequestText: function (m) {
    return this.msgText(m);
  },

  shapeCompatible: function (a, b, allowEmptyAssistant) {
    if (!a || !b || a.role !== b.role) return false;
    var x = this.normalizeText(this.sessionRequestText(a));
    var y = this.normalizeText(this.requestText(b));
    if (!this.attachmentsEqual(this.messageAttachments(a), this.messageAttachments(b), true)) return false;
    if (x || y) return x === y;
    // 空 user 不能作为身份依据；空 assistant 只允许出现在已经匹配过的前缀之后，
    // 用于覆盖“继续生成”时请求体只带 assistant 前缀的形态。
    return !!(allowEmptyAssistant && a.role === 'assistant' && b.role === 'assistant');
  },

  matchBodyPrefix: function (chain, bodyMessages) {
    var n = 0;
    while (n < chain.length && n < bodyMessages.length &&
        this.shapeCompatible(chain[n], bodyMessages[n], n > 0)) n++;
    return n;
  },

  hasBridgeBlocks: function (m) {
    var types = { thinking: 1, text: 1, server_tool_use: 1, web_search_tool_result: 1, web_fetch_tool_result: 1 };
    return !!(m && Array.isArray(m.blocks) && m.blocks.some(function (b) { return b && types[b.type]; }));
  },

  hasToolBlocks: function (m) {
    return !!(m && Array.isArray(m.blocks) && m.blocks.some(function (b) {
      return b && (b.type === 'server_tool_use' || b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result');
    }));
  },

  sessionToRequest: function (m) {
    if (!m) return null;
    if (m.role === 'user') {
      var text = this.msgText(m);
      var files = Array.isArray(m.files) ? m.files : [];
      if (files.length) {
        var content = files.map(function (f) {
          var image = !!f.isImage || /^image\//i.test(f.mimeType || f.type || '');
          return image
            ? { type: 'image', source: { type: 'file', file_id: f.serverId || f.file_id || f.id } }
            : { type: 'document', source: { type: 'file', file_id: f.serverId || f.file_id || f.id } };
        });
        if (text) content.push({ type: 'text', text: text });
        return { role: 'user', content: content };
      }
      if (Array.isArray(m.content)) {
        try { return { role: 'user', content: JSON.parse(JSON.stringify(m.content)) }; }
        catch (e) { return { role: 'user', content: m.content.slice() }; }
      }
      return text ? { role: 'user', content: text } : null;
    }
    if (m.role === 'assistant') {
      var answer = (m.blocks || []).filter(function (b) { return b && b.type === 'text'; })
        .map(function (b) { return b.text || ''; }).join('');
      return answer ? { role: 'assistant', content: [{ type: 'text', text: answer }] } : null;
    }
    return null;
  },

  isRecoverableStatus: function (m) {
    return !!(m && m.status && m.status !== 'done');
  },

  resultBlockText: function (b) {
    if (!b) return '';
    if (typeof b.bridge_tool_result === 'string') return b.bridge_tool_result;
    var c = b.content;
    if (typeof c === 'string') return c;
    if (b.type === 'web_fetch_tool_result' && c && c.type === 'web_fetch_result') {
      var title = c.content && c.content.title;
      var body = c.content && c.content.content;
      if (body == null) body = c.content;
      if (typeof body !== 'string') body = JSON.stringify(body);
      return String(title ? title + '\n' : '') + String(body || '');
    }
    try { return JSON.stringify(c); } catch (e) { return String(c == null ? '' : c); }
  },

  toolUseFromServerBlock: function (b) {
    var input = (b && b.input) || {};
    var name = b && b.name === 'deepseek_read_url' ? 'read_url' : 'web_search';
    var clientInput = b && b.bridge_tool_input;
    if (!clientInput) {
      if (name === 'read_url') clientInput = { url: input.url || (input.queries && input.queries[0]) || '' };
      else clientInput = { query: (input.queries && input.queries[0]) || input.query || '' };
    }
    return {
      type: 'tool_use',
      id: (b && (b.bridge_tool_id || b.id)) || ('bridge_' + Math.random().toString(36).slice(2, 12)),
      name: name,
      input: clientInput
    };
  },

  /* 将官方展示块还原成第三方 Anthropic 接口可接受的消息序列。每个服务端
   * 工具调用单独形成一对 assistant(tool_use)/user(tool_result)；未完成调用
   * 补一条明确结果，避免悬空 tool_use。所有文本原样保留。 */
  rebuildBridgeMessages: function (blocks) {
    var out = [], pending = [], opened = {}, answered = {}, openOrder = [], legacy = 0;
    var self = this;
    (blocks || []).forEach(function (b) {
      if (!b) return;
      if (b.type === 'thinking' || b.type === 'text') {
        pending.push(JSON.parse(JSON.stringify(b)));
        return;
      }
      if (b.type === 'server_tool_use') {
        var tu = self.toolUseFromServerBlock(b);
        pending.push(tu);
        out.push({ role: 'assistant', content: pending });
        pending = [];
        opened[tu.id] = true;
        openOrder.push(tu.id);
        return;
      }
      if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') {
        var id = b.tool_use_id || ('bridge_result_' + (++legacy));
        // 旧版失败路径把结果 id 固定成 srvtoolu_b_x，调用块却是随机 id。
        // 若 id 对不上，按 FIFO 与最早一个未完成调用配对，保留全部内容。
        if (!opened[id] && openOrder.length) id = openOrder.shift();
        else if (opened[id]) {
          var at = openOrder.indexOf(id);
          if (at >= 0) openOrder.splice(at, 1);
        } else {
          id = id + '_legacy_' + (++legacy);
          var synthetic = {
            type: 'tool_use', id: id, name: b.type === 'web_fetch_tool_result' ? 'read_url' : 'web_search',
            input: b.type === 'web_fetch_tool_result' ? { url: (b.content && b.content.url) || '' } : { query: '' }
          };
          out.push({ role: 'assistant', content: [synthetic] });
          opened[id] = true;
        }
        answered[id] = true;
        out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: self.resultBlockText(b) }] });
      }
    });
    if (pending.length) out.push({ role: 'assistant', content: pending });
    openOrder.forEach(function (id) {
      if (!answered[id]) out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '（上一轮在此处中断，工具未完成）' }] });
    });
    return out;
  },

  /* 返回注入了完整中断历史的新 body.messages；没有可恢复中断时返回 null。
   * session 必须由 beginRequest 在请求发起时唯一确定；这里不再扫描全部会话，
   * 避免相同提示词把另一个会话的工具历史注入当前请求。 */
  recoverBridgeRequest: async function (bodyMessages, session) {
    if (!session) return null;
    var source = (bodyMessages || []).slice();
    var body = [], sourceIndexes = [];
    source.forEach(function (m, i) {
      if (m && (m.role === 'user' || m.role === 'assistant')) { body.push(m); sourceIndexes.push(i); }
    });
    if (!body.length) return null;

    var chain = this.chain(session);
    var prefixLength = this.matchBodyPrefix(chain, body);
    var target = null, mode = null, chainIndex = -1;

    if (prefixLength === body.length) {
      // 重新生成：官方请求停在该轮父 user，活跃链多出一条 assistant。
      if (chain.length === body.length + 1) {
        var extra = chain[body.length];
        if (extra && extra.role === 'assistant' && this.hasToolBlocks(extra) && this.isRecoverableStatus(extra)) {
          target = extra; mode = 'insert'; chainIndex = body.length;
        } else if (extra && extra.role === 'assistant') {
          // 点击重新生成时，demo 可能先插入一条空 assistant 占位；真正要恢复的是
          // 同一父 user 下最近一条非 done 且含工具块的历史分支。
          var siblings = (session.messages || []).filter(function (m) {
            return m && m.role === 'assistant' && m.parentId === extra.parentId && m.id !== extra.id &&
              this.hasToolBlocks(m) && this.isRecoverableStatus(m);
          }.bind(this)).sort(function (a, b) {
            // error 是真正异常中断、且最需要续接的分支；stopped 可能只是用户
            // 手动停止的旧版本。同类再按创建时间取最新。
            var rank = function (m) { return m.status === 'error' ? 2 : (m.status === 'stopped' ? 1 : 0); };
            return rank(b) - rank(a) || (b.createdAt || 0) - (a.createdAt || 0);
          });
          if (siblings.length) { target = siblings[0]; mode = 'insert'; chainIndex = body.length; }
        }
      }
      // 继续生成：官方请求携带的是中断 assistant 的前缀，链与请求等长，末条
      // 仍是可恢复 assistant。用 IndexedDB 中的完整块替换这段前缀。
      if (!target && chain.length === body.length) {
        var last = chain[chain.length - 1];
        if (last && last.role === 'assistant' && body[body.length - 1].role === 'assistant' &&
            this.hasToolBlocks(last) && this.isRecoverableStatus(last)) {
          target = last; mode = 'continue'; chainIndex = body.length - 1;
        }
      }
      // 中断后直接发新消息，且官方仍保留该轮：活跃 user 的父 assistant 就是目标。
      if (!target && chain.length === body.length) {
        var tail = chain[chain.length - 1];
        if (tail && tail.role === 'user') {
          var parent = (session.messages || []).find(function (m) { return m.id === tail.parentId; });
          if (parent && parent.role === 'assistant' && this.hasToolBlocks(parent) && this.isRecoverableStatus(parent)) {
            target = parent; mode = 'replace'; chainIndex = chain.length - 2;
          }
        }
      }
    }

    // 官方在“停止后直接发消息”时可能把中断轮及其父 user 整段从请求中跳过，
    // 前缀匹配因此失败。只在本会话内用最后一条 user 做锚点，沿会话树向上找
    // 最近的含工具中断轮；遇到已完成轮次立即停止。
    if (!target && body.length && body[body.length - 1].role === 'user') {
      var lastBodyUser = body[body.length - 1];
      var byId = {};
      (session.messages || []).forEach(function (m) { byId[m.id] = m; });
      for (var li = chain.length - 1; li >= 0 && !target; li--) {
        if (chain[li].role !== 'user' || !this.shapeCompatible(chain[li], lastBodyUser, false)) continue;
        var cur = byId[chain[li].parentId], guard = 0;
        while (cur && guard++ < 8) {
          if (cur.role === 'assistant') {
            if (this.hasToolBlocks(cur) && this.isRecoverableStatus(cur)) {
              var idx = chain.findIndex(function (m) { return m.id === cur.id; });
              if (idx > prefixLength) {
                target = cur; mode = 'anchor'; chainIndex = idx;
              }
              break;
            }
            if (cur.status === 'done') break;
          }
          cur = byId[cur.parentId];
        }
      }
    }
    if (!target) return null;

    var rebuilt = this.rebuildBridgeMessages(target.blocks);
    if (!rebuilt.length) return null;
    // 只在原始 user/assistant 位置上注入；latest_reminder 等其它消息原样保留。
    var messages = source.slice();
    if (mode === 'insert') {
      var insertAt = chainIndex > 0 ? sourceIndexes[chainIndex - 1] + 1 : 0;
      messages.splice.apply(messages, [insertAt, 0].concat(rebuilt));
    } else if (mode === 'anchor') {
      var anchorAt = prefixLength < body.length ? sourceIndexes[prefixLength] : source.length;
      var missing = chain.slice(prefixLength, chainIndex).map(function (m) { return this.sessionToRequest(m); }.bind(this)).filter(Boolean);
      messages.splice.apply(messages, [anchorAt, 0].concat(missing, rebuilt));
    } else {
      // continue / replace 都替换已定位的 assistant 位置。
      messages.splice.apply(messages, [sourceIndexes[chainIndex], 1].concat(rebuilt));
    }
    return {
      messages: messages,
      sessionId: session.id,
      targetId: target.id,
      status: target.status,
      mode: mode,
      prefixLength: prefixLength,
      recoveredMessages: rebuilt.length,
      recoveredBlocks: (target.blocks || []).length
    };
  }
};
DCP.modules.demoSearch = DemoSearch;

/* ===== modules/sessionsync.js ===== */
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
      '.dcp-session-status{flex:0 0 12px;width:12px;height:16px;margin:0 2px 0 6px;display:none;' +
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
    document.addEventListener('click', this._onRowClick, true);
    document.addEventListener('pointerdown', this._onInteraction, true);
    document.addEventListener('keydown', this._onInteraction, true);
    document.addEventListener('input', this._onInteraction, true);
    this.pageWin().addEventListener('focus', this._onFocus);
    this.pageWin().addEventListener('blur', this._onBlur);
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

/* ===== modules/demopastetxt.js ===== */
/* ============================================================
 * modules/demoPasteTxt：复刻官方「粘贴大段文本自动转成 txt 附件」
 *
 * 官方行为（2026-11-18 从主站 chat-main.js 逐字提取）：
 *   - 触发条件是**粘贴**，不是打字；剪贴板里带文件项时整段逻辑不介入
 *   - 阈值 = 服务端 file_feature.paste_text_to_file_character_limit，
 *     取不到时默认 2000；判的是「粘贴文本自身长度 > 阈值」
 *   - 还要 canAddFile（上传可用且文件数没满），否则照常按文本粘贴
 *   - 转成 File 后走页面上传管线：附件卡、上传、document 内容块全原生
 *   - 文件名：首行 → 超 50 字符截断（ASCII 词边界回退）→ 去非法字符 →
 *     折叠空白 → 空则用「粘贴的文本」→ 拼 .txt
 *   - 上传没成功时把文本还回输入框并提示；Ctrl+Z 可撤销这次转换
 *
 * demo 页（cdn.deepseek.com/chat-demo）bundle 里没有这段逻辑，但上传管线
 * 是齐的——隐藏 <input type="file"> 的 onChange 就是上传入口。所以本模块
 * **不重画任何 UI**：把 File 塞进那个 input 再派发 change，让页面自己上传、
 * 自己渲染附件卡。主站（chat.deepseek.com）原生就有这功能，不介入。
 * ============================================================ */
var DemoPasteTxt = {
  // 官方默认阈值（服务端没配 paste_text_to_file_character_limit 时）
  LIMIT: 2000,
  // 上传结果轮询：卡片出现算成功，超时算失败（走官方「还回输入框」分支）
  POLL_MS: 100, POLL_TIMEOUT: 4000,

  /* ---------- 定位（不依赖哈希 class，用结构关系） ---------- */
  // 上传 input：accept 里带 .txt 且可多选——demo 页有两个 file input，
  // 另一个是 image/* 单选，不会误取
  findInput: function () {
    var list = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < list.length; i++) if (/\.txt/.test(list[i].accept || '')) return list[i];
    return null;
  },

  // 上传按钮：从隐藏 input 往前找最近的一个按钮（它包在 tooltip 的 trigger
  // span 里也没关系，取 span 内的 button）——与 aria-label 的本地化文案无关，
  // 也不依赖 class 哈希
  findUploadBtn: function (input) {
    var n = input ? input.previousElementSibling : null;
    while (n) {
      if (n.tagName === 'BUTTON') return n;
      var b = n.querySelector ? n.querySelector('button') : null;
      if (b) return b;
      n = n.previousElementSibling;
    }
    return null;
  },

  // 输入区：从 input 往上走到第一个含 textarea 的容器（附件卡/输入框/功能行
  // 都在这个容器里）
  findComposer: function (input) {
    var n = input;
    while (n && n !== document.body) {
      if (n.querySelector && n.querySelector('textarea')) return n;
      n = n.parentElement;
    }
    return null;
  },

  // 附件卡列表。注意：**0 个卡片时页面连 attachments 容器都不渲染**，所以不能
  // 先找容器再数子元素（会永远是 0，导致误判"上传失败"而把文本还回输入框）。
  // 改成直接按 card- 前缀找，再用「卡内必有删除按钮」过滤掉误匹配
  cardList: function (composer) {
    if (!composer) return [];
    var all = composer.querySelectorAll('[class*="card-"]');
    var out = [];
    for (var i = 0; i < all.length; i++) if (all[i].querySelector('button')) out.push(all[i]);
    return out;
  },

  countCards: function (composer) {
    return this.cardList(composer).length;
  },

  /* ---------- 粘贴判定 ---------- */
  onPaste: function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    // 剪贴板带文件项 → 官方整体不介入，交给浏览器默认行为
    var items = cd.items;
    if (items) for (var i = 0; i < items.length; i++) if (items[i].kind === 'file') return;
    var text = cd.getData('text/plain');
    if (!text) return;
    var input = this.findInput();
    if (!input) return;
    var composer = this.findComposer(input);
    if (!composer) return;
    var ta = e.currentTarget;
    var s0 = ta.selectionStart, s1 = ta.selectionEnd;
    // canAddFile：读页面上传按钮自己的禁用态（文件数满/当前不可上传时页面
    // 会禁用它）——不自己猜上限，上限只有页面知道
    var btn = this.findUploadBtn(input);
    if (!btn || btn.disabled) return;
    // 官方还有一条 inputMaxLength 分支（超长直接按文本粘 + 弹计数提示），
    // 但那个上限来自服务端 input_character_limit；demo 页没有该配置，
    // 官方代码里是 `void 0 !== a` 判定，取不到时整条分支跳过——同样跳过
    if (text.length <= this.LIMIT) return;

    e.preventDefault();
    var delInUndo = this.deleteSelection(ta, s0, s1);
    var file = new File([text], this.txtName(text), { type: 'text/plain;charset=utf-8' });
    var self = this;
    this._rec = null;
    this.feed(input, file, composer, function (ok, card) {
      if (!ok) {
        // 官方失败分支：文本还回输入框 + 提示，绝不让用户丢字
        self.insertText(ta, text, s0);
        Utils.toast(DCP.t('内容已恢复到输入框'));
        return;
      }
      // 记下这次转换供 Ctrl+Z 撤销（官方同款：撤销=删卡片+文本回输入框）
      self._rec = { kind: 'converted', text: text, at: s0, card: card, delInUndo: delInUndo, composer: composer };
    });
  },

  /* ---------- 选区删除（官方同款：先 execCommand，失败再走 setValue） ---------- */
  deleteSelection: function (ta, s0, s1) {
    if (s0 === s1) return false;
    ta.focus();
    if (document.activeElement === ta && document.execCommand('delete', false)) return true;
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var v = ta.value;
    setter.call(ta, v.slice(0, s0) + v.slice(s1));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(s0, s0);
    return false;
  },

  /* ---------- 把 File 交给页面上传管线 ---------- */
  feed: function (input, file, composer, cb) {
    var before = this.countCards(composer);
    var dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    var self = this, t0 = Date.now();
    (function poll() {
      var list = self.cardList(composer);
      if (list.length > before) return cb(true, list[list.length - 1]);
      if (Date.now() - t0 > self.POLL_TIMEOUT) return cb(false, null);
      setTimeout(poll, self.POLL_MS);
    })();
  },

  /* ---------- 文本写回输入框 ---------- */
  insertText: function (ta, text, pos) {
    ta.focus();
    var p = (pos == null ? ta.value.length : Math.max(0, Math.min(pos, ta.value.length)));
    if (document.activeElement === ta) {
      ta.setSelectionRange(p, p);
      if (document.execCommand('insertText', false, text)) return;
    }
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var v = ta.value;
    setter.call(ta, v.slice(0, p) + text + v.slice(p));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    requestAnimationFrame(function () { ta.setSelectionRange(p + text.length, p + text.length); });
  },

  /* ---------- Ctrl+Z 撤销这次转换（官方同款） ---------- */
  onKey: function (e) {
    var rec = this._rec;
    // 只拦截「紧接着这次转换」的撤销：用户一打字或按别的键，记录即失效，
    // 之后 Ctrl+Z 交回 textarea 原生撤销，不劫持
    if (!rec) return;
    var isUndo = (e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'z' && !e.shiftKey;
    if (!isUndo) { this._rec = null; return; }
    e.preventDefault();
    this._rec = null;
    // 删卡片（卡片里唯一的 button 就是删除按钮，aria-label 是本地化的）
    var rm = rec.card && rec.card.querySelector('button');
    if (rm) Utils.realClick(rm);
    // 删除选区时若走了 execCommand（进了原生撤销栈），要连带 undo 一次，
    // 否则撤销栈里会留下那次删除
    if (rec.delInUndo) document.execCommand('undo', false);
    var ta = (rec.composer || document).querySelector('textarea');
    if (ta) this.insertText(ta, rec.text, rec.at);
  },

  /* ---------- 绑定 ---------- */
  bind: function () {
    var self = this;
    var input = this.findInput();
    if (!input) return;
    var composer = this.findComposer(input);
    if (!composer) return;
    var tas = composer.querySelectorAll('textarea');
    for (var i = 0; i < tas.length; i++) {
      var ta = tas[i];
      if (ta.__dsePasteTxt) continue;
      ta.__dsePasteTxt = true;
      ta.addEventListener('paste', function (e) { self.onPaste(e); }, true);
      ta.addEventListener('keydown', function (e) { self.onKey(e); }, true);
      // 用户一打字，这次转换就不再是「最近一次操作」，撤销记录作废
      ta.addEventListener('input', function () { self._rec = null; });
    }
  },

  /* ---------- 文件名（官方算法逐字对应） ---------- */
  txtName: function (text) {
    // v5 = 字母或数字、且不是 CJK/泰文等——官方用它判断「是否处在词中间」
    var RE_WORD = /[\p{L}\p{N}]/u;
    var RE_NON_LATIN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
    var isWord = function (ch) { return !!ch && RE_WORD.test(ch) && !RE_NON_LATIN.test(ch); };
    var RE_BAD = /[\\/:*?"<>|\x00-\x1f]/g;   // v8：文件名非法字符
    var n = text.search(/\r|\n/);
    var first = n === -1 ? text : text.slice(0, n);
    if (first.length > 50) {
      var cut = 50;
      // 第 50 个字符和被挤掉的第 51 个都是 ASCII 词字符 → 说明切在了词中间，
      // 往前退到词边界
      if (isWord(first[49]) && isWord(first[50])) {
        var t = 50;
        while (t > 0 && isWord(first[t - 1])) t -= 1;
        if (t > 0) cut = t;
      }
      first = first.slice(0, cut);
    }
    var s = first.replace(RE_BAD, '').replace(/\s+/g, ' ').trim();
    return (s || this.fallbackName()) + '.txt';
  },

  fallbackName: function () {
    // 官方回退名按页面语言取值：粘贴的文本 / Pasted text
    var lang = '';
    try { lang = localStorage.getItem('latestReminderLanguage') || navigator.language || ''; } catch (e) {}
    return /^zh/i.test(lang) ? '粘贴的文本' : 'Pasted text';
  },

  init: function () {
    // 主站原生就有这功能，只补 demo 页
    if (location.hostname !== 'cdn.deepseek.com') return;
    var self = this;
    Utils.onReady(function () { self.bind(); });
    // 输入框随会话切换重建——节流（带前缘）兜底自愈，不用防抖（连续 DOM
    // 变动会把防抖一直重置，重建后迟迟绑不上）
    new MutationObserver(Utils.throttle(function () { self.bind(); }, 300))
      .observe(document.body, { childList: true, subtree: true });
  }
};
DCP.modules.demoPasteTxt = DemoPasteTxt;

/* ===== modules/tabtitle.js ===== */
/* ============================================================
 * modules/tabtitle：浏览器标签页标题跟随当前会话名
 *
 * 官方公式（主站 bundle 逐字，React 19 metadata hoisting）：
 *   jsx("title",{children: 标题 ? `标题 - 品牌名` : `品牌名 - chatHtmlTitle`})
 *   → 实测 "ln(ax+b)高阶导数 - DeepSeek"；无标题时 "DeepSeek - 探索未至之境"
 * demo  bundle 里**没有**这段代码（jsx("title") 零处），标签页标题永远是
 * 静态的 "API 使用 demo"——所以这是按官方公式补的新增功能，不是复刻。
 *
 * 数据源：demo 页聊天区自己渲染出来的当前会话标题 .title-_5fa77。不用
 * 侧边栏——收起边栏时侧边栏条目会整个从 DOM 消失（实测 47→0），标题就断了；
 * 聊天区标题在收起时依然在，且换会话/改名都会重渲染。无标题会话该元素显示
 * 占位"新对话"，按官方语义等同无标题（只有真标题才进标签页）；新对话时该
 * 元素干脆不存在。两者都回落到页面原标题（demo 没有官方那句 slogan 可替）。
 * ============================================================ */
var TabTitle = {
  BRAND: 'DeepSeek',      // 官方 useBrandName() 的值（DSeek 品牌时为 "DSeek"）
  // demo 页对无标题会话的占位显示（侧边栏/聊天区一致）。两种写法都比一遍：
  // 页面按浏览器语言渲染，脚本 i18n 可能与页面不同步，漏一种就会把占位当真标题
  PLACEHOLDERS: ['新对话', 'New chat'],

  init: function () {
    // 只做 demo 页：主站自己会用 React hoisting 改标题，脚本不能插手
    if (location.hostname !== 'cdn.deepseek.com') return;
    var self = this;
    this.orig = document.title;
    Utils.onReady(function () {
      self.sync();
      self.bind();
      // 兜底自愈：聊天区容器整体被换掉（切会话）时重新绑。节流（带前缘）而非
      // 防抖——防抖会被连续 DOM 变动不断重置，重建后迟迟不生效
      new MutationObserver(Utils.throttle(function () {
        if (!self._host || !self._host.isConnected) self.bind();
        self.sync();
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  },

  // 当前会话名 → "会话名 - DeepSeek"；无标题/新对话 → 页面原标题
  sync: function () {
    var el = document.querySelector(DCP.SEL.chatTitle);
    var t = el ? String(el.textContent || '').trim() : '';
    if (this.PLACEHOLDERS.indexOf(t) !== -1) t = '';
    var want = t ? t + ' - ' + this.BRAND : this.orig;
    if (document.title !== want) document.title = want;
  },

  // 精确观察器绑在聊天区标题的父容器上：childList 管元素出现/消失（新对话）、
  // subtree+characterData 管标题文本变化（改名）
  bind: function () {
    var el = document.querySelector(DCP.SEL.chatTitle);
    var host = (el && el.parentElement) || document.querySelector(DCP.SEL.chatHeader) ||
               document.querySelector(DCP.SEL.chatView);
    if (!host) return;
    if (this._mo) { try { this._mo.disconnect(); } catch (e) {} }
    this._host = host;
    var self = this;
    this._mo = new MutationObserver(Utils.throttle(function () { self.sync(); }, 50));
    this._mo.observe(host, { childList: true, subtree: true, characterData: true });
  }
};
DCP.modules.tabTitle = TabTitle;

/* ===== main.js ===== */
/* ============================================================
 * main：初始化（chat-demo 第三方模型适配）
 *
 * 顺序：toolbar（工具条定位，ctxRing/tpsMeter 要用）→ demoapi（设置面板 + fetch 补丁）
 *       → demobridge（工具桥接，由 demoapi 的补丁触发）→ ctxRing（占用环）
 *       → tpsMeter（实时速率）→ demosearch / sessionsync / demopastetxt / tabtitle
 * ============================================================ */
(function () {
  var order = [
    'toolbar',
    'demoApi',
    'ctxRing',
    'tpsMeter',
    'demoSearch',
    'sessionSync',
    'demoPasteTxt',
    'tabTitle'
  ];
  function initModule(name) {
    var m = DCP.modules[name];
    if (!m || typeof m.init !== 'function') return;
    if (m._inited) return;
    m._inited = true;
    try { m.init(); } catch (e) { console.error('[DCP] init fail:', name, e); }
  }
  function boot() {
    try {
      order.forEach(initModule);
      DCP.emit('dcp:ready');
      console.log('%c[DeepSeek Chat-Demo Plus] v' + DCP.version + ' loaded', 'color:#3b6cf6');
    } catch (e) { console.error('[DCP] boot error', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/* ===== footer.js ===== */
/* footer：IIFE 闭合 */
})();
