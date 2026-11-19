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
