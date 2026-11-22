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
  version: '8.5.0',
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
