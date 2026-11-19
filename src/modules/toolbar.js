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
