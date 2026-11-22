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
 * 侧边栏顺序 = sessionSummaries 按 updatedAt 降序，与 store 逐位一一对应
 * （唯一"差异"是空标题显示为「新对话」）——故点击结果按索引取侧边栏第 N
 * 个条目即可打开正确会话，重复标题也不会开错。
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
      var rq;
      try { rq = indexedDB.open('chat-demo'); } catch (e) { return resolve([]); }
      rq.onerror = function () { resolve([]); };
      rq.onsuccess = function () {
        var db = rq.result;
        var getAll;
        try { getAll = db.transaction('sessions', 'readonly').objectStore('sessions').getAll(); }
        catch (e) { db.close(); return resolve([]); }
        getAll.onsuccess = function () { resolve(getAll.result || []); db.close(); };
        getAll.onerror = function () { resolve([]); db.close(); };
      };
    });
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

  // 当前正在查看的官方会话。侧边栏可见时用 active 项索引（与 runSearch 相同
  // 的 updatedAt 排序）；侧边栏收起时用聊天区标题 + 可见 user 消息文本消歧。
  currentSession: async function () {
    var sessions = await this.readSessions();
    sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var SEL = DCP.SEL || {};
    var items = SEL.sidebarItem ? Array.prototype.slice.call(document.querySelectorAll(SEL.sidebarItem)) : [];
    var active = -1;
    for (var i = 0; i < items.length; i++) {
      if (/(^|\s)active-/.test(items[i].className || '')) { active = i; break; }
    }
    if (active >= 0 && sessions[active]) return sessions[active];

    var title = SEL.chatTitle ? (document.querySelector(SEL.chatTitle)?.textContent || '').trim() : '';
    if (!title) return null;
    var candidates = sessions.filter(function (s) { return (s.title || '').trim() === title; });
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    var domUsers = SEL.userBubble ? Array.prototype.slice.call(document.querySelectorAll(SEL.userBubble)) : [];
    var domTexts = domUsers.map(function (el) { return (el.textContent || '').trim(); });
    var best = null, bestScore = -1;
    candidates.forEach(function (s) {
      var texts = this.chain(s).filter(function (m) { return m.role === 'user'; })
        .map(function (m) { return this.msgText(m).trim(); }.bind(this));
      var score = 0;
      for (var j = 0; j < domTexts.length; j++) if (texts.indexOf(domTexts[j]) >= 0) score++;
      if (score > bestScore) { bestScore = score; best = s; }
    }.bind(this));
    return best || candidates[0];
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
    var parts = [];
    m.content.forEach(function (b) {
      if (!b) return;
      if (b.type === 'text' && b.text) parts.push(String(b.text));
      else if (b.type === 'document') {
        var nm = b.title || b.name || (b.source && b.source.name) || '附件';
        parts.push('【附件：' + nm + '】');
      }
    });
    return parts.join('\n');
  },

  sessionRequestText: function (m) {
    if (!m) return '';
    if (m.role === 'user') return this.msgText(m);
    return this.msgText(m);
  },

  shapeCompatible: function (a, b) {
    if (!a || a.role !== b.role) return false;
    var x = String(this.sessionRequestText(a) || '').trim();
    var y = String(this.requestText(b) || '').trim();
    if (x === y) return true;
    // 粘贴长文本转成 txt 后，官方会话记录的 user.content 可能为空，而请求体里
    // 是内联附件文本；这类结构差异不应阻止会话匹配。
    if (!x && y.indexOf('【附件：') === 0) return true;
    return false;
  },

  matchBodyPrefix: function (chain, bodyMessages) {
    var n = 0;
    while (n < chain.length && n < bodyMessages.length && this.shapeCompatible(chain[n], bodyMessages[n])) n++;
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

  /* 返回注入了完整中断历史的新 body.messages；没有可恢复中断时返回 null。 */
  recoverBridgeRequest: async function (bodyMessages) {
    var source = (bodyMessages || []).slice();
    var body = [], sourceIndexes = [];
    source.forEach(function (m, i) {
      if (m && (m.role === 'user' || m.role === 'assistant')) { body.push(m); sourceIndexes.push(i); }
    });
    if (!body.length) return null;
    var sessions = await this.readSessions();
    var best = null;
    for (var si = 0; si < sessions.length; si++) {
      var session = sessions[si];
      var chain = this.chain(session);
      var n = this.matchBodyPrefix(chain, body);
      if (n !== body.length) continue;
      var score = chain.length * 1000 + (session.updatedAt || 0);
      if (!best || score > best.score) best = { session: session, chain: chain, score: score };
    }

    var target = null, mode = null, chainIndex = -1, prefixLength = -1;
    if (best) {
      // 重新生成：官方请求停在该轮父 user，活跃链多出一条 assistant。
      if (best.chain.length === body.length + 1) {
        var extra = best.chain[body.length];
        if (extra && extra.role === 'assistant' && this.hasToolBlocks(extra) && this.isRecoverableStatus(extra)) {
          target = extra; mode = 'insert'; chainIndex = body.length; prefixLength = body.length;
        } else if (extra && extra.role === 'assistant') {
          // 点击重新生成时，demo 可能先插入一条空 assistant 占位；真正要恢复的是
          // 同一父 user 下最近一条非 done 且含工具块的历史分支。
          var siblings = (best.session.messages || []).filter(function (m) {
            return m && m.role === 'assistant' && m.parentId === extra.parentId && m.id !== extra.id &&
              this.hasToolBlocks(m) && this.isRecoverableStatus(m);
          }.bind(this)).sort(function (a, b) {
            // error 是真正异常中断、且最需要续接的分支；stopped 可能只是用户
            // 手动停止的旧版本。同类再按创建时间取最新。
            var rank = function (m) { return m.status === 'error' ? 2 : (m.status === 'stopped' ? 1 : 0); };
            return rank(b) - rank(a) || (b.createdAt || 0) - (a.createdAt || 0);
          });
          if (siblings.length) { target = siblings[0]; mode = 'insert'; chainIndex = body.length; prefixLength = body.length; }
        }
      }
      // 中断后直接发新消息，且官方仍保留该轮：活跃 user 的父 assistant 就是目标。
      if (!target && best.chain.length === body.length) {
        var last = best.chain[best.chain.length - 1];
        if (last && last.role === 'user') {
          var parent = (best.session.messages || []).find(function (m) { return m.id === last.parentId; });
          if (parent && parent.role === 'assistant' && this.hasToolBlocks(parent) && this.isRecoverableStatus(parent)) {
            target = parent; mode = 'replace'; prefixLength = body.length;
            chainIndex = best.chain.findIndex(function (m) { return m.id === parent.id; });
          }
        }
      }
    }

    // 官方在“停止后直接发消息”时可能把中断轮及其父 user 整段从请求中跳过，
    // 前缀匹配因此失败。用最后一条 user 做锚点，沿会话树向上找最近的含工具
    // 中断轮；遇到已完成轮次立即停止，避免把旧历史注入到无关新对话。
    if (!target && body.length && body[body.length - 1].role === 'user') {
      var lastBodyUser = body[body.length - 1];
      var anchorBest = null;
      for (var ai = 0; ai < sessions.length; ai++) {
        var as = sessions[ai], achain = this.chain(as), byId = {};
        (as.messages || []).forEach(function (m) { byId[m.id] = m; });
        for (var li = achain.length - 1; li >= 0; li--) {
          if (achain[li].role !== 'user' || !this.shapeCompatible(achain[li], lastBodyUser)) continue;
          var cur = byId[achain[li].parentId], guard = 0;
          while (cur && guard++ < 4) {
            if (cur.role === 'assistant') {
              if (this.hasToolBlocks(cur) && this.isRecoverableStatus(cur)) {
                var idx = achain.findIndex(function (m) { return m.id === cur.id; });
                var pre = this.matchBodyPrefix(achain, body);
                if (idx > pre) {
                  var ascore = (cur.blocks || []).length * 1000000 + (as.updatedAt || 0);
                  if (!anchorBest || ascore > anchorBest.score) {
                    anchorBest = { session: as, chain: achain, score: ascore, target: cur, chainIndex: idx, prefixLength: pre };
                  }
                }
                break;
              }
              if (cur.status === 'done') break;
            }
            cur = byId[cur.parentId];
          }
          break;
        }
      }
      if (anchorBest) {
        best = { session: anchorBest.session, chain: anchorBest.chain, score: anchorBest.score };
        target = anchorBest.target; mode = 'anchor'; chainIndex = anchorBest.chainIndex; prefixLength = anchorBest.prefixLength;
      }
    }
    if (!target) return null;

    var rebuilt = this.rebuildBridgeMessages(target.blocks);
    if (!rebuilt.length) return null;
    // 只在原始 user/assistant 位置上注入；latest_reminder 等其它消息原样保留。
    var messages = source.slice();
    if (mode === 'insert') {
      var parentFiltered = chainIndex - 1;
      var insertAt = parentFiltered >= 0 ? sourceIndexes[parentFiltered] + 1 : 0;
      messages.splice.apply(messages, [insertAt, 0].concat(rebuilt));
    } else if (mode === 'anchor') {
      var anchorAt = prefixLength < body.length ? sourceIndexes[prefixLength] : source.length;
      var missing = best.chain.slice(prefixLength, chainIndex).map(function (m) { return this.sessionToRequest(m); }.bind(this)).filter(Boolean);
      messages.splice.apply(messages, [anchorAt, 0].concat(missing, rebuilt));
    } else {
      messages.splice.apply(messages, [sourceIndexes[chainIndex], 1].concat(rebuilt));
    }
    return {
      messages: messages,
      sessionId: best.session.id,
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
