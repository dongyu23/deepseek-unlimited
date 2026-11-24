/* ============================================================
 * main：初始化（chat-demo 第三方模型适配）
 *
 * 顺序：toolbar（工具条定位，ctxRing/tpsMeter 要用）→ demoapi（设置面板 + fetch 补丁）
 *       → demobridge（工具桥接，由 demoapi 的补丁触发）→ ctxRing（占用环）
 *       → tpsMeter（实时速率）→ demosearch / sessionsync / thinktimer /
 *       codedownload / sessionpin / preview / demopastetxt / tabtitle
 * ============================================================ */
(function () {
  var order = [
    'toolbar',
    'demoApi',
    'ctxRing',
    'tpsMeter',
    'demoSearch',
    'sessionSync',
    'thinkTimer',
    'codeDownload',
    'sessionPin',
    'preview',
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
