/* ============================================================
 * core/selectors：chat-demo 选择器候选链与安全解析
 *
 * demo 页的 class 含构建哈希。这里同时保留稳定设计 token、结构属性和
 * 中英文原生 label 作为候选；业务模块统一通过 DCP.qs/qsa/closest 解析，
 * 单个候选失效时不会拖垮整条链。
 * ============================================================ */
var SELECTOR_CANDIDATES = {
  // 输入区
  textarea: [
    'textarea._27c9245:not([aria-label="编辑消息"]):not([aria-label="Edit message"])',
    'textarea:not([aria-label="编辑消息"]):not([aria-label="Edit message"])'
  ],
  inputToolbar: [
    '.ec4f5d61',
    '[data-dcp-toolbar]',
    '[class*="inputToolbar-"]',
    '[class*="input-toolbar-"]'
  ],
  msgEditor: [
    'textarea[aria-label="编辑消息"]',
    'textarea[aria-label="Edit message"]'
  ],

  // 消息区
  virtualList: [
    '.scroll-_7ccaf',
    '[data-dcp-virtual-list]'
  ],
  msg: [
    '.message-e1faee',
    '.bubble-_4cfe7',
    '[data-dcp-message-row]'
  ],
  msgRowAi: [
    '.message-e1faee',
    '[data-dcp-ai-row]'
  ],
  msgRowUser: [
    '.bubble-_4cfe7',
    '[data-dcp-user-row]'
  ],
  userBubble: [
    '.bubble-_4cfe7',
    '[data-dcp-user-bubble]'
  ],
  aiMarkdownAny: [
    '.ds-markdown',
    '[data-dcp-ai-markdown]'
  ],
  aiActionBar: [
    '[class*="actions-"]',
    '[data-dcp-ai-actions]'
  ],
  thinkBlock: [
    '.area-_3d93a',
    '[data-dcp-think-block]'
  ],
  thinkHeader: [
    '.title-_3d93a',
    '[data-dcp-think-header]'
  ],

  // 侧边栏与当前会话
  appTop: [
    '.top-ac14ac',
    '[data-dcp-app-top]'
  ],
  sidebarItem: [
    '.item-ff6fc9',
    '[data-dcp-session-id][role="button"]',
    '[data-dcp-session-id][tabindex]'
  ],
  sidebarItemActive: [
    '.item-ff6fc9.active-ff6fc9',
    '.item-ff6fc9[aria-current="page"]',
    '[data-dcp-session-id][aria-current="page"]',
    '[data-dcp-session-id].active'
  ],
  sidebarItemTitle: [
    '.title-ff6fc9',
    '[data-dcp-session-title]'
  ],
  sidebarList: [
    '.section-ac14ac',
    '[data-dcp-sidebar-list]'
  ],
  sidebarRoot: [
    '[class*="sider-"]',
    '[data-dcp-sidebar]'
  ],
  sidebarListWrap: [
    '[class*="listWrap-"]',
    '[data-dcp-sidebar-list-wrap]'
  ],
  sidebarCollapseBtn: [
    'button[aria-label="收起边栏"]',
    'button[aria-label="Collapse sidebar" i]',
    'button[title="Collapse sidebar" i]',
    'button[data-dcp-sidebar-collapse]'
  ],
  sidebarExpandBtn: [
    'button[aria-label="打开边栏"]',
    'button[aria-label="展开侧栏"]',
    'button[aria-label="Open sidebar" i]',
    'button[aria-label="Expand sidebar" i]',
    'button[title="Open sidebar" i]',
    'button[title="Expand sidebar" i]',
    'button[data-dcp-sidebar-expand]'
  ],
  newChatButton: [
    'button[aria-label="开启新对话"]',
    'button[aria-label="New chat" i]',
    'button[aria-label="New conversation" i]',
    'button[data-dcp-new-chat]'
  ],
  chatView: [
    '.view-_5fa77',
    '[data-dcp-chat-view]'
  ],
  chatHeader: [
    '.header-_5fa77',
    '[data-dcp-chat-header]'
  ],
  chatTitle: [
    '.title-_5fa77',
    '[data-dcp-chat-title]'
  ],

  // 搜索（供搜索模块复用；当前 demo 搜索节点仍以 #id 为主）
  searchEntry: [
    '#dcp-search-entry',
    'button[aria-label="搜索对话内容..."]',
    'button[aria-label="搜索对话内容"]',
    'button[aria-label="Search conversations" i]',
    'button[aria-label="Search chats" i]',
    'button[title="Search conversations" i]',
    'button[data-dcp-search-entry]'
  ],
  searchOverlay: [
    '#dcp-search-mask',
    '[data-dcp-search-overlay]'
  ],
  searchDialog: [
    '#dcp-search-modal',
    '[data-dcp-search-dialog]'
  ],
  searchInput: [
    '#dcp-search-input',
    '[data-dcp-search-input]',
    '#dcp-search-modal input[type="text"]'
  ],
  searchList: [
    '#dcp-search-list',
    '[data-dcp-search-list]'
  ],
  searchResult: [
    '[data-dcp-search-result]',
    '#dcp-search-list [role="option"]'
  ],

  // 设置与代码块
  settingsButton: [
    'button[aria-label="设置"]',
    'button[aria-label="Settings" i]',
    'button[title="Settings" i]',
    '[data-dcp-settings-button]'
  ],
  codeBlock: [
    '.md-code-block',
    '[data-dcp-code-block]'
  ],
  codeBanner: [
    '.md-code-block-banner',
    '[class*="code-block-banner-"]',
    '[data-dcp-code-banner]'
  ],
  copyButton: [
    'button[aria-label="复制"]',
    'button[aria-label="Copy" i]',
    'button[aria-label="Copy code" i]',
    'button[title="Copy" i]'
  ],
  continueButton: [
    '[class*="continueButton-"]',
    '[data-dcp-continue-template]'
  ],
  menu: [
    '[role="menu"]'
  ],
  menuItem: [
    '[role="menuitem"]'
  ],
  pinMenuItem: [
    '.dcp-pin-item'
  ],
  fileCard: [
    '[class*="card-"]',
    '[data-dcp-file-card]'
  ],
  previewOverlay: [
    '.dcp-preview-overlay',
    '[data-dcp-preview-overlay]'
  ],
  sendButton: [
    'button[aria-label="发送"]',
    'button[aria-label="Send" i]',
    'button[data-dcp-send]'
  ],
  stopGenerateButton: [
    'button[aria-label="停止生成"]',
    'button[aria-label="Stop generating" i]',
    'button[aria-label="Stop" i]',
    'button[data-dcp-stop-generate]'
  ]
};

function selectorChain(input) {
  if (Array.isArray(input)) return input;
  if (typeof input !== 'string' || !input) return [];
  if (Object.prototype.hasOwnProperty.call(SELECTOR_CANDIDATES, input)) {
    return SELECTOR_CANDIDATES[input];
  }
  return [input];
}

function selectorRoot(first, second) {
  if (first && typeof first === 'object' &&
      (first.nodeType === 1 || first.nodeType === 9 || first.nodeType === 11)) {
    return { root: first, selector: second };
  }
  return { root: second || (typeof document !== 'undefined' ? document : null), selector: first };
}

function safeQsa(first, second) {
  var args = selectorRoot(first, second);
  var root = args.root;
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  var selectors = selectorChain(args.selector);
  var out = [];
  var seen = new Set();
  for (var i = 0; i < selectors.length; i++) {
    var selector = selectors[i];
    if (typeof selector !== 'string' || !selector) continue;
    var list;
    try { list = root.querySelectorAll(selector); } catch (e) { continue; }
    for (var j = 0; j < list.length; j++) {
      var el = list[j];
      if (!el || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  if (out.length > 1 && root.nodeType === 1 && root.compareDocumentPosition) {
    out.sort(function (a, b) {
      var position = a.compareDocumentPosition(b);
      if (position & 4) return -1;
      if (position & 2) return 1;
      return 0;
    });
  }
  return out;
}

function safeQs(first, second) {
  var list = safeQsa(first, second);
  return list.length ? list[0] : null;
}

function safeClosest(element, selector) {
  if (!element || element.nodeType !== 1) return null;
  var selectors = selectorChain(selector);
  var node = element;
  while (node && node.nodeType === 1) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        if (node.matches && node.matches(selectors[i])) return node;
      } catch (e) {}
    }
    node = node.parentElement;
  }
  return null;
}

function safeMatches(element, selector) {
  return !!(element && element.nodeType === 1 && safeClosest(element, selector) === element);
}

var SEL = {};
Object.keys(SELECTOR_CANDIDATES).forEach(function (key) {
  // 兼容旧模块直接把 SEL.xxx 传给 querySelector/matches 的用法。
  SEL[key] = SELECTOR_CANDIDATES[key].join(', ');
});
SEL.noServerSession = true;

var _warnedSelectors = new Set();
function warnSelector(key, selector) {
  var id = key || String(selector || '');
  if (_warnedSelectors.has(id)) return;
  _warnedSelectors.add(id);
  var message = '[DCP] selector not found: ' + id;
  try { if (typeof console !== 'undefined' && console.warn) console.warn(message); } catch (e) {}
  try { DCP.emit('selectors:warning', { key: key, selector: selector }); } catch (e) {}
}

function selectorHealth(required) {
  var keys = Array.isArray(required) ? required : ['textarea', 'msgRowAi', 'sidebarItem', 'chatTitle'];
  var report = Object.create(null);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    report[key] = !!safeQs(key);
  }
  return report;
}

function checkSelectorHealth(required) {
  var keys = Array.isArray(required) ? required : ['textarea', 'msgRowAi', 'sidebarItem', 'chatTitle'];
  var report = selectorHealth(keys);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!report[key]) warnSelector(key, SELECTOR_CANDIDATES[key] || key);
  }
  try { DCP.emit('selectors:health', report); } catch (e) {}
  return report;
}

DCP.SEL = SEL;
DCP.SELECTORS = SEL;
DCP.selectorCandidates = SELECTOR_CANDIDATES;
DCP.qs = safeQs;
DCP.qsa = safeQsa;
DCP.closest = safeClosest;
DCP.matches = safeMatches;
DCP.selectorHealth = selectorHealth;
DCP.checkSelectorHealth = checkSelectorHealth;
DCP.warnSelector = warnSelector;
try { DCP.register('selectors', SEL); } catch (e) {}
