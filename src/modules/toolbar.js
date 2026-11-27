/* ============================================================
 * modules/toolbar：输入工具条定位
 *
 * 优先使用选择器候选链；结构兜底只接受“含思考/搜索开关、含按钮、不含
 * 输入框”的最小可见容器。中英文原生 label 都参与匹配。
 * ============================================================ */
var Toolbar = {
  LABELS: ['深度思考', 'Deep thinking', 'DeepThink', '智能搜索', '联网搜索', 'Search the web'],

  visible: function (el) {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects && el.getClientRects().length) return true;
    if (typeof el.offsetParent !== 'undefined') return el.offsetParent !== null;
    return true;
  },

  hasButton: function (el) {
    return !!(el && DCP.qsa('button,[role="button"]', el).length);
  },

  containsTextarea: function (el, ta) {
    return !!(el && ta && el.contains && el.contains(ta));
  },

  isValid: function (el, ta) {
    if (!this.visible(el)) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (this.containsTextarea(el, ta)) return false;
    return this.hasButton(el);
  },

  hasToolLabel: function (el) {
    if (!el) return false;
    if (UI.matchesLabel(el, this.LABELS, false)) return true;
    var buttons = DCP.qsa('button,[role="button"]', el);
    for (var i = 0; i < buttons.length; i++) {
      if (UI.matchesLabel(buttons[i], this.LABELS, false)) return true;
    }
    return false;
  },

  size: function (el) {
    var count = el.querySelectorAll ? el.querySelectorAll('*').length : 0;
    var direct = Array.prototype.some.call(el.children || [], function (child) {
      return child.tagName === 'BUTTON' || child.getAttribute('role') === 'button';
    });
    return { count: count, direct: direct };
  },

  compare: function (a, b) {
    var sa = this.size(a);
    var sb = this.size(b);
    if (sa.count !== sb.count) return sa.count - sb.count;
    if (sa.direct !== sb.direct) return sa.direct ? -1 : 1;
    return 0;
  },

  find: function () {
    var ta = DCP.qs('textarea');
    if (!ta) return null;

    var preferred = DCP.qsa('inputToolbar').filter(function (el) {
      return Toolbar.isValid(el, ta);
    });
    if (preferred.length) {
      preferred.sort(Toolbar.compare.bind(Toolbar));
      return preferred[0];
    }

    var candidates = [];
    var seen = new Set();
    function add(element) {
      if (!element || seen.has(element) || !Toolbar.isValid(element, ta)) return;
      if (!Toolbar.hasToolLabel(element)) return;
      var text = String(element.textContent || '').replace(/\s/g, '');
      if (text.length > 300) return;
      seen.add(element);
      candidates.push(element);
    }

    // 从原生 label 节点向上找，通常能直接命中开关所在的最小工具行。
    var labelNodes = DCP.qsa('button,[role="button"],span,div');
    for (var i = 0; i < labelNodes.length; i++) {
      var node = labelNodes[i];
      if (!UI.matchesLabel(node, this.LABELS, false)) continue;
      var current = node;
      var guard = 0;
      while (current && current !== document.body && guard++ < 8) {
        add(current);
        current = current.parentElement;
      }
    }

    // 最后做一次全页面小范围兜底。
    if (!candidates.length) {
      var divs = DCP.qsa('div,section');
      for (var j = 0; j < divs.length; j++) add(divs[j]);
    }
    if (!candidates.length) return null;
    candidates.sort(Toolbar.compare.bind(Toolbar));
    return candidates[0];
  }
};
DCP.modules.toolbar = Toolbar;
