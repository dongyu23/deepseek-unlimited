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
  // IndexedDB 异常（阻塞、事务不结束、浏览器隐私模式卡住）不能让桥接请求、
  // 侧栏映射或后台持久化无限等待。测试里会把这两个值调小。
  IDB_TIMEOUT_MS: 3000,
  SESSION_REFRESH_TIMEOUT_MS: 2500,
  _bridgeWriteQueues: null,
  _queryToken: null,
  _releaseFocus: null,
  _results: [],
  _activeIndex: -1,

  active: function () { return location.hostname === 'cdn.deepseek.com'; },

  dict: function () {
    if (DCP.ui && typeof DCP.ui.dict === 'function') return DCP.ui.dict();
    if (typeof Utils !== 'undefined' && Utils.dict) return Utils.dict();
    return Object.create(null);
  },

  own: function (object, key) {
    if (DCP.ui && typeof DCP.ui.own === 'function') return DCP.ui.own(object, key);
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  },

  setAttr: function (el, name, value) {
    if (!el || !name) return false;
    if (DCP.ui && typeof DCP.ui.setAttributeIfChanged === 'function') return DCP.ui.setAttributeIfChanged(el, name, value);
    if (value == null) {
      if (el.hasAttribute && el.hasAttribute(name)) { el.removeAttribute(name); return true; }
      return false;
    }
    var next = String(value);
    if (el.getAttribute && el.getAttribute(name) === next) return false;
    el.setAttribute(name, next);
    return true;
  },

  setText: function (el, value) {
    if (!el) return false;
    if (DCP.ui && typeof DCP.ui.setTextIfChanged === 'function') return DCP.ui.setTextIfChanged(el, value);
    if (typeof Utils !== 'undefined' && Utils.setTextIfChanged) return Utils.setTextIfChanged(el, value);
    var next = String(value == null ? '' : value);
    if (el.textContent === next) return false;
    el.textContent = next;
    return true;
  },

  cancelQuery: function () {
    if (this._queryToken && DCP.ui && typeof DCP.ui.invalidateQuery === 'function') {
      DCP.ui.invalidateQuery(this._queryToken);
    }
    this._queryToken = null;
  },

  isQueryCurrent: function (token) {
    if (DCP.ui && typeof DCP.ui.isQueryCurrent === 'function') return DCP.ui.isQueryCurrent(token);
    return this._queryToken === token;
  },

  // 所有 IDB 读写共用的硬 deadline。超时后由调用方提供的 cleanup 中止事务/
  // 关闭连接；迟到回调仍有 settled 保护，不会在超时后继续写盘。
  withIdbTimeout: function (promise, fallback, cleanup) {
    var self = this;
    return Utils.withTimeout(promise, self.IDB_TIMEOUT_MS, 'IndexedDB operation timed out')
      .catch(function () {
        if (cleanup) { try { cleanup(); } catch (e) {} }
        return fallback;
      });
  },

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
    // 会话代次变化后，旧查询即使晚返回也不能覆盖新会话的搜索结果。
    DCP.on('session:change', function () {
      self.cancelQuery();
      if (self.overlay && self.overlay.style.display === 'block') self.close();
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
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) self.close();
    });

    var surface = document.createElement('div');
    surface.id = 'dcp-search-modal';
    surface.setAttribute('role', 'dialog');
    surface.setAttribute('aria-modal', 'true');
    surface.setAttribute('aria-label', DCP.t('搜索对话内容...'));
    surface.tabIndex = -1;
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
    input.id = 'dcp-search-input';
    input.type = 'text';
    input.placeholder = DCP.t('搜索对话内容...');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'dcp-search-list');
    input.setAttribute('aria-expanded', 'true');
    // font-family/line-height:inherit——input 默认不继承（实测掉到 Arial），
    // 必须显式继承页面字体才与官方一致；官方输入框行高实测 24px
    input.style.cssText = 'flex:1 1 auto;min-width:0;height:24px;border:none;outline:none;background:transparent;' +
      'font-size:16px;font-family:inherit;line-height:24px;color:' + p.text;
    input.addEventListener('input', Utils.debounce(function () { self.runSearch(input.value); }, 200));
    input.addEventListener('keydown', function (e) { self.onInputKey(e); });
    var close = document.createElement('button');
    close.type = 'button';
    close.style.cssText = 'box-sizing:border-box;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;' +
      'width:34px;height:34px;border:none;outline:none;cursor:pointer;border-radius:8px;background:transparent;color:' + p.dim;
    close.innerHTML = this.ICON_CLOSE;
    close.setAttribute('aria-label', DCP.t('关闭'));
    close.addEventListener('click', function () { self.close(); });
    box.appendChild(ico); box.appendChild(input); box.appendChild(close);

    var list = document.createElement('div');
    list.id = 'dcp-search-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', DCP.t('搜索结果'));
    // 官方实测：滚动容器无 padding，其内层 items 容器 padding 8px 8px 0
    list.style.cssText = 'box-sizing:border-box;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;' +
      'padding:8px 8px 0';

    surface.appendChild(box); surface.appendChild(list);
    overlay.appendChild(surface);
    document.body.appendChild(overlay);

    this.overlay = overlay; this.surface = surface; this.input = input; this.list = list;
    // 没有 DCP.ui 时仍保留 Esc 兜底；正常情况下由 trapFocus 统一处理。
    this._onKey = function (e) { if (e.key === 'Escape') self.close(); };
  },

  paint: function () {
    if (!this.overlay) return;
    var p = this.pal();
    if (DCP.ui && typeof DCP.ui.setStyleIfChanged === 'function') {
      DCP.ui.setStyleIfChanged(this.overlay, 'background', p.mask);
      DCP.ui.setStyleIfChanged(this.surface, 'background', p.surface);
      DCP.ui.setStyleIfChanged(this.input, 'color', p.text);
    } else {
      this.overlay.style.background = p.mask;
      this.surface.style.background = p.surface;
      this.input.style.color = p.text;
    }
    this.list.querySelectorAll('[data-dcp-s-text]').forEach(function (el) { el.style.color = p.text; });
    this.list.querySelectorAll('[data-dcp-s-dim]').forEach(function (el) { el.style.color = p.dim; });
    this.list.querySelectorAll('[data-dcp-s-snippet]').forEach(function (el) { el.style.color = p.snippet; });
  },

  open: function () {
    this.build();
    this.cancelQuery();
    this.overlay.style.display = 'block';
    this.paint();
    this.input.value = '';
    this.list.innerHTML = '';
    this._results = [];
    this._activeIndex = -1;
    this.setAttr(this.input, 'aria-activedescendant', null);
    if (this._releaseFocus) { try { this._releaseFocus(); } catch (e) {} this._releaseFocus = null; }
    if (DCP.ui && typeof DCP.ui.trapFocus === 'function') {
      this._releaseFocus = DCP.ui.trapFocus(this.surface, {
        initialFocus: this.input,
        onEscape: function () { self.close(); }
      });
    } else {
      this.input.focus();
      document.addEventListener('keydown', this._onKey, true);
    }
  },

  close: function () {
    this.cancelQuery();
    if (!this.overlay) return;
    this.overlay.style.display = 'none';
    document.removeEventListener('keydown', this._onKey, true);
    if (this._releaseFocus) {
      try { this._releaseFocus(); } catch (e) {}
      this._releaseFocus = null;
    }
  },

  setActiveIndex: function (index) {
    var self = this;
    var count = this._results.length;
    if (!count) { this._activeIndex = -1; this.setAttr(this.input, 'aria-activedescendant', null); return; }
    index = Math.max(0, Math.min(count - 1, Number(index) || 0));
    this._activeIndex = index;
    var items = this.list.querySelectorAll('[role="option"]');
    Array.prototype.forEach.call(items, function (item, i) {
      self.setAttr(item, 'aria-selected', i === index ? 'true' : 'false');
      if (i === index) {
        item.style.background = self.pal().hover;
        try { item.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      } else {
        item.style.background = 'transparent';
      }
    });
    var active = items[index];
    this.setAttr(this.input, 'aria-activedescendant', active ? active.id : null);
  },

  onInputKey: function (e) {
    if (!e) return;
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this._results.length) return;
      var next = this._activeIndex;
      if (e.key === 'ArrowDown') next = next < 0 ? 0 : (next + 1) % this._results.length;
      else next = next < 0 ? this._results.length - 1 : (next - 1 + this._results.length) % this._results.length;
      this.setActiveIndex(next);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!this._results.length) return;
      e.preventDefault();
      this.setActiveIndex(e.key === 'Home' ? 0 : this._results.length - 1);
      return;
    }
    if (e.key === 'Enter') {
      var index = this._activeIndex >= 0 ? this._activeIndex : (this._results.length === 1 ? 0 : -1);
      if (index >= 0 && this._results[index]) {
        e.preventDefault();
        this.openSession(this._results[index].id);
      }
    }
  },

  /* ---------- 数据：读本地会话，沿活跃消息链收集可搜文本 ---------- */
  readSessions: function () {
    var self = this;
    var tx = null, db = null;
    return this.withIdbTimeout(new Promise(function (resolve) {
      var rq = null, settled = false;
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
          tx = db.transaction('sessions', 'readonly');
          var getAll = tx.objectStore('sessions').getAll();
          getAll.onsuccess = function () { done(getAll.result || []); };
          getAll.onerror = function () { done([]); };
          getAll.onabort = function () { done([]); };
          tx.onabort = function () { done([]); };
          tx.onerror = function () { done([]); };
        } catch (e) { done([]); }
      };
    }), [], function () {
      try { if (tx) tx.abort(); } catch (e) {}
      try { if (db) db.close(); } catch (e) {}
    });
  },

  // 侧栏同步只需要摘要，不把 151 条会话的完整消息树全部读进内存。
  readSummaries: function () {
    var self = this;
    var tx = null, db = null;
    return this.withIdbTimeout(new Promise(function (resolve) {
      var rq = null, settled = false;
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
          tx = db.transaction('sessionSummaries', 'readonly');
          var getAll = tx.objectStore('sessionSummaries').getAll();
          getAll.onsuccess = function () { done(getAll.result || []); };
          getAll.onerror = function () { done([]); };
          getAll.onabort = function () { done([]); };
          tx.onabort = function () { done([]); };
          tx.onerror = function () { done([]); };
        } catch (e) { done([]); }
      };
    }), [], function () {
      try { if (tx) tx.abort(); } catch (e) {}
      try { if (db) db.close(); } catch (e) {}
    });
  },

  readSession: function (id) {
    var self = this;
    var tx = null, db = null;
    return this.withIdbTimeout(new Promise(function (resolve) {
      var rq = null, settled = false;
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
          tx = db.transaction('sessions', 'readonly');
          var get = tx.objectStore('sessions').get(id);
          get.onsuccess = function () { done(get.result || null); };
          get.onerror = function () { done(null); };
          get.onabort = function () { done(null); };
          tx.onabort = function () { done(null); };
          tx.onerror = function () { done(null); };
        } catch (e) { done(null); }
      };
    }), null, function () {
      try { if (tx) tx.abort(); } catch (e) {}
      try { if (db) db.close(); } catch (e) {}
    });
  },

  // 后台流没有官方 React reader 帮我们落盘。把桥接已经解析出的官方块形状
  // 合并回会话里的指定 assistant。这里绝不退回“最后一条 assistant”——请求
  // 身份必须先由 bridgeMessageId / assistantMessageId 精确定位，避免并发请求
  // 或重复提示词把内容写进另一轮。
  applyBridgeState: function (session, state) {
    if (!session || !state) return false;
    var wantedId = state.assistantMessageId || state.bridgeMessageId;
    if (!wantedId) return false;
    var target = null;
    (session.messages || []).some(function (m) {
      if (m && m.role === 'assistant' && m.id === wantedId) { target = m; return true; }
      return false;
    });
    if (!target) return false;

    var revision = Number(state.revision != null ? state.revision : state.persistRevision);
    var hasRevision = isFinite(revision);
    if (hasRevision) {
      var current = Number(target.__dcpBridgeRevision);
      if (isFinite(current) && revision < current) return false;
    }
    if (Array.isArray(state.blocks) && state.blocks.length) target.blocks = state.blocks;
    if (state.status) target.status = state.status;
    if (Object.prototype.hasOwnProperty.call(state, 'stopReason')) target.stopReason = state.stopReason;
    if (state.usage) target.usage = state.usage;
    if (hasRevision) target.__dcpBridgeRevision = revision;
    session.updatedAt = Date.now();
    return true;
  },

  // 官方 assistant 占位符可能在校验会话前就已存在，也可能在 message_start
  // 之后才由 React 写入 IndexedDB。只认两类安全身份：精确 bridge id，或父
  // 消息已匹配、且全库唯一的 pending/streaming 空占位符。
  isBridgePlaceholder: function (m) {
    if (!m || m.role !== 'assistant') return false;
    if (m.status === 'pending' || m.status === 'streaming') return true;
    var emptyBlocks = !Array.isArray(m.blocks) || m.blocks.length === 0;
    return !m.status && emptyBlocks && !m.stopReason;
  },

  captureBridgeAssistantId: function (ctx, session, bodyMessages) {
    if (!ctx || !session) return null;
    if (ctx.assistantMessageId) return ctx.assistantMessageId;
    var messages = session.messages || [];
    if (ctx.bridgeMessageId) {
      for (var i = 0; i < messages.length; i++) {
        if (messages[i] && messages[i].role === 'assistant' && messages[i].id === ctx.bridgeMessageId) {
          ctx.assistantMessageId = messages[i].id;
          return ctx.assistantMessageId;
        }
      }
    }

    var chain = this.chain(session);
    var expectedParentId = null;
    if (Array.isArray(bodyMessages)) {
      var lastBodyUser = null;
      for (var b = bodyMessages.length - 1; b >= 0; b--) {
        if (bodyMessages[b] && bodyMessages[b].role === 'user') { lastBodyUser = bodyMessages[b]; break; }
      }
      if (lastBodyUser) {
        for (var c = chain.length - 1; c >= 0; c--) {
          if (chain[c] && chain[c].role === 'user' && this.shapeCompatible(chain[c], lastBodyUser, false)) {
            expectedParentId = chain[c].id;
            break;
          }
        }
      }
    }
    if (!expectedParentId && chain.length && chain[chain.length - 1].role === 'user') {
      expectedParentId = chain[chain.length - 1].id;
    }

    var candidates = messages.filter(function (m) {
      if (!this.isBridgePlaceholder(m)) return false;
      return !expectedParentId || m.parentId === expectedParentId;
    }, this);
    if (!candidates.length && !expectedParentId) {
      var tail = chain[chain.length - 1];
      if (tail && this.isBridgePlaceholder(tail)) candidates = [tail];
    }
    if (candidates.length !== 1) return null;
    ctx.assistantMessageId = candidates[0].id;
    return ctx.assistantMessageId;
  },

  // 单次 IDB 写入。调用方负责串行化；这里只做“读取指定会话 → 精确更新
  // assistantMessageId → 原子提交”。任何迟到回调在超时/失败后都不会再写。
  _persistBridgeStateOnce: function (sessionId, state) {
    var self = this;
    var tx = null, db = null;
    return this.withIdbTimeout(new Promise(function (resolve) {
      var rq = null, settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        if (db) { try { db.close(); } catch (e) {} }
        resolve(!!value);
      }
      try { rq = indexedDB.open('chat-demo'); } catch (e) { return done(false); }
      if (!rq) return done(false);
      rq.onerror = function () { done(false); };
      rq.onabort = function () { done(false); };
      rq.onblocked = function () { done(false); };
      rq.onsuccess = function () {
        if (settled) {
          try { rq.result.close(); } catch (e) {}
          return;
        }
        try {
          db = rq.result;
          if (!db.objectStoreNames || !db.objectStoreNames.contains('sessions')) return done(false);
          tx = db.transaction('sessions', 'readwrite');
          var store = tx.objectStore('sessions');
          var wrote = false;
          var get = store.get(sessionId);
          get.onsuccess = function () {
            if (settled) return;
            var session = get.result;
            if (!session || !self.applyBridgeState(session, state)) {
              try { tx.abort(); } catch (e) {}
              return done(false);
            }
            try { store.put(session); wrote = true; } catch (e) {
              try { tx.abort(); } catch (err) {}
              return done(false);
            }
          };
          get.onerror = function () { done(false); };
          get.onabort = function () { done(false); };
          tx.oncomplete = function () { done(wrote); };
          tx.onerror = function () { done(false); };
          tx.onabort = function () { done(false); };
        } catch (e) { done(false); }
      };
    }), false, function () {
      try { if (tx) tx.abort(); } catch (e) {}
      try { if (db) db.close(); } catch (e) {}
    });
  },

  persistBridgeState: function (sessionId, state, ctx) {
    if (!sessionId || !state) return Promise.resolve(false);
    var self = this;
    // 入队时冻结快照：队列前的调用若随后继续修改 blocks，不能污染旧 revision。
    var snapshot;
    try { snapshot = JSON.parse(JSON.stringify(state)); } catch (e) { snapshot = state; }
    var queue = ctx && ctx.persistQueue ? Promise.resolve(ctx.persistQueue) : null;
    if (!queue) {
      this._bridgeWriteQueues = this._bridgeWriteQueues || Utils.dict();
      queue = this._bridgeWriteQueues[sessionId] || Promise.resolve();
    }
    var result = queue.then(function () {
      return self._persistBridgeStateOnce(sessionId, snapshot);
    }, function () {
      return self._persistBridgeStateOnce(sessionId, snapshot);
    });
    var tail = result.then(function () {}, function () {});
    if (ctx) ctx.persistQueue = tail;
    else this._bridgeWriteQueues[sessionId] = tail;
    return result;
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
    var queues = this.dict(), titleCounts = this.dict();
    summaries.forEach(function (s) {
      var title = DemoSearch.normalizeTitle(s.title);
      (queues[title] || (queues[title] = [])).push(s);
      titleCounts[title] = (titleCounts[title] || 0) + 1;
    });
    var rowTitleCounts = this.dict();
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
    var byId = this.dict(), msgs = session.messages || [], i;
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
    var out = [], seen = this.dict(), self = this;
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
    var out = [], seen = this.dict();
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
  _requests: Object.create(null),
  invalidateRequests: function () {
    this._sessionEpoch++;
    this._requests = this.dict();
  },
  beginRequest: function () {
    var self = this;
    var id = 'dcpr_' + Date.now().toString(36) + '_' + (++this._requestSeq).toString(36);
    var ctx = {
      requestId: id, epoch: this._sessionEpoch, sessionId: null, session: null,
      bridgeMessageId: null, assistantMessageId: null,
      persistRevision: 0, persistQueue: Promise.resolve()
    };
    ctx.session = this.currentSession().then(function (s) {
      if (ctx.epoch !== self._sessionEpoch) return null;
      ctx.session = s || null;
      ctx.sessionId = s && s.id || null;
      if (s) self.captureBridgeAssistantId(ctx, s);
      return ctx.session;
    }, function () { return null; });
    this._requests[id] = ctx;
    return ctx;
  },
  refreshRequestSession: async function (ctx) {
    if (!ctx || !this._requests[ctx.requestId] || ctx.epoch !== this._sessionEpoch) return null;
    try {
      var s = await Utils.withTimeout(this.currentSession(), this.SESSION_REFRESH_TIMEOUT_MS, 'session refresh timed out');
      if (ctx.epoch !== this._sessionEpoch || !this._requests[ctx.requestId]) return null;
      ctx.session = s || null;
      ctx.sessionId = s && s.id || null;
      if (s) this.captureBridgeAssistantId(ctx, s);
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
    this.cancelQuery();
    if (!q) {
      this._results = [];
      this._activeIndex = -1;
      if (this.list) this.list.innerHTML = '';
      return;
    }
    var token = DCP.ui && typeof DCP.ui.createQueryToken === 'function'
      ? DCP.ui.createQueryToken()
      : { id: Date.now(), epoch: 0, sid: '', cancelled: false };
    this._queryToken = token;
    var sessions;
    try { sessions = await this.readSessions(); }
    catch (e) { return; }
    if (!this.isQueryCurrent(token)) return;
    // 与侧栏同序：updatedAt 降序
    sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var ql = q.toLowerCase(), self = this, results = [];
    sessions.forEach(function (s) {
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
        results.push({ id: s.id, title: title, updatedAt: s.updatedAt || 0, text: h.text, n: i + 1, m: hits.length });
      });
    });
    if (!this.isQueryCurrent(token)) return;
    this.render(q, results, token);
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

  render: function (q, results, token) {
    if (token && !this.isQueryCurrent(token)) return;
    var self = this, p = this.pal();
    this._results = results || [];
    this._activeIndex = -1;
    this.setAttr(this.input, 'aria-activedescendant', null);
    this.list.innerHTML = '';
    if (!this._results.length) {
      var empty = document.createElement('div');
      empty.setAttribute('role', 'status');
      empty.style.cssText = 'box-sizing:border-box;padding:24px 16px;text-align:center;font-size:13px;color:' + p.dim;
      this.setText(empty, DCP.t('暂无相关结果'));
      this.list.appendChild(empty);
      return;
    }
    this._results.forEach(function (r, resultIndex) {
      var item = document.createElement('div');
      item.id = 'dcp-search-option-' + resultIndex;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.tabIndex = -1;
      // 官方实测：flex/center/gap 12、padding 10 12 10 10、圆角 16
      item.style.cssText = 'box-sizing:border-box;display:flex;align-items:center;gap:12px;' +
        'padding:10px 12px 10px 10px;border-radius:16px;cursor:pointer;flex:0 0 auto';
      item.addEventListener('mouseenter', function () { self.setActiveIndex(resultIndex); });
      item.addEventListener('mouseleave', function () { item.style.background = 'transparent'; });
      item.addEventListener('click', function () { self.openSession(r.id); });

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
      this.setText(title, r.title || DCP.t('新对话'));
      var date = document.createElement('span');
      date.setAttribute('data-dcp-s-dim', '1');
      date.style.cssText = 'flex:0 0 auto;font-size:13px;line-height:20px;color:' + p.dim;
      this.setText(date, this.fmtDate(r.updatedAt));
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

  /* ---------- 打开会话（稳定 sid，不依赖侧栏排序） ---------- */
  openSession: function (sid) {
    this.close();
    if (!sid) return;
    if (DCP.ui && typeof DCP.ui.stableNavigateToSession === 'function') {
      DCP.ui.stableNavigateToSession(sid);
      return;
    }
    var sync = DCP.modules && DCP.modules.sessionSync;
    if (sync && typeof sync.openSessionById === 'function') {
      Promise.resolve(sync.openSessionById(sid)).catch(function () {});
      return;
    }
    // 最后兜底也只按稳定属性查找，不再用搜索结果索引点击侧栏。
    var SEL = DCP.SEL || {};
    var rows = SEL.sidebarItem ? document.querySelectorAll(SEL.sidebarItem) : [];
    var hit = Array.prototype.find.call(rows, function (row) {
      return (row.__dcpSessionId || row.getAttribute('data-dcp-session-id')) === sid;
    });
    if (hit) Utils.realClick(hit);
  },

  /* ---------- 桥接中断响应恢复 ----------
   * demo 的 IndexedDB 已完整保存 text / thinking / server_tool_use / tool_result，
   * 但官方下一次请求只带文本块。这里从同一份官方记录重建结构化 API 历史，
   * 不另建存储、不截断内容。 */
  requestText: function (m) {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (!Array.isArray(m.content)) return '';
    return m.content.filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text || ''; }).join('\n');
  },

  // 首条消息发起时会话往往还没落盘，currentSession() 会先返回 null。用完整
  // 请求前缀（所有 user/assistant 文本 + 附件特征）在 IndexedDB 中反查。
  // 必须全库唯一：重复提示词、同附件多会话或只能匹配后缀时一律返回 null，
  // 宁可放弃后台持久化，也不能把内容写进另一条会话。
  findSessionByRequestMessages: async function (messages, startedAt) {
    if (!Array.isArray(messages)) return null;
    var body = messages.filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant'); });
    if (!body.length) return null;
    var sessions = await this.readSessions();
    var matches = sessions.filter(function (s) {
      var chain = this.chain(s);
      if (chain.length < body.length) return false;
      return this.matchBodyPrefix(chain, body) === body.length;
    }, this);
    return matches.length === 1 ? matches[0] : null;
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
    var types = this.dict();
    types.thinking = 1; types.text = 1; types.server_tool_use = 1;
    types.web_search_tool_result = 1; types.web_fetch_tool_result = 1;
    return !!(m && Array.isArray(m.blocks) && m.blocks.some(function (b) { return b && types[b.type]; }));
  },

  hasToolBlocks: function (m) {
    return !!(m && Array.isArray(m.blocks) && m.blocks.some(function (b) {
      return b && (b.type === 'server_tool_use' || b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result');
    }));
  },

  // 可继续的不只是工具轮：纯文本/思考在 max_tokens 或手动停止后同样需要
  // 保留 assistant 前缀。搜索块也包含在内，供官网隐藏继续按钮时补入口。
  hasRecoverableBlocks: function (m) {
    return !!(m && Array.isArray(m.blocks) && m.blocks.some(function (b) {
      if (!b) return false;
      if (b.type === 'text') return !!String(b.text || '').trim();
      if (b.type === 'thinking') return !!String(b.thinking || b.signature || '').trim();
      return b.type === 'server_tool_use' || b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result';
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
    // 桥接把中途断流归一成 done + max_tokens；自然达到 max_tokens 的回答
    // 也应按官网语义允许继续。done + end_turn 才是真正完成，不能恢复。
    return !!(m && ((m.status && m.status !== 'done') || (m.status === 'done' && m.stopReason === 'max_tokens')));
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
    var out = [], pending = [], opened = this.dict(), answered = this.dict(), openOrder = [], legacy = 0;
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
        if (extra && extra.role === 'assistant' && this.hasRecoverableBlocks(extra) && this.isRecoverableStatus(extra)) {
          target = extra; mode = 'insert'; chainIndex = body.length;
        } else if (extra && extra.role === 'assistant') {
          // 点击重新生成时，demo 可能先插入一条空 assistant 占位；真正要恢复的是
          // 同一父 user 下最近一条可恢复的历史分支。
          var siblings = (session.messages || []).filter(function (m) {
            return m && m.role === 'assistant' && m.parentId === extra.parentId && m.id !== extra.id &&
              this.hasRecoverableBlocks(m) && this.isRecoverableStatus(m);
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
            this.hasRecoverableBlocks(last) && this.isRecoverableStatus(last)) {
          target = last; mode = 'continue'; chainIndex = body.length - 1;
        }
      }
      // 中断后直接发新消息，且官方仍保留该轮：活跃 user 的父 assistant 就是目标。
      if (!target && chain.length === body.length) {
        var tail = chain[chain.length - 1];
        if (tail && tail.role === 'user') {
          var parent = (session.messages || []).find(function (m) { return m.id === tail.parentId; });
          if (parent && parent.role === 'assistant' && this.hasRecoverableBlocks(parent) && this.isRecoverableStatus(parent)) {
            target = parent; mode = 'replace'; chainIndex = chain.length - 2;
          }
        }
      }
    }

    // 官方在“停止后直接发消息”时可能把中断轮及其父 user 整段从请求中跳过，
    // 前缀匹配因此失败。只在本会话内用最后一条 user 做锚点，沿会话树向上找
    // 最近的含可恢复内容的中断响应；遇到真正完成的轮次立即停止。
    if (!target && body.length && body[body.length - 1].role === 'user') {
      var lastBodyUser = body[body.length - 1];
      var byId = this.dict();
      (session.messages || []).forEach(function (m) { byId[m.id] = m; });
      for (var li = chain.length - 1; li >= 0 && !target; li--) {
        if (chain[li].role !== 'user' || !this.shapeCompatible(chain[li], lastBodyUser, false)) continue;
        var cur = byId[chain[li].parentId], guard = 0;
        while (cur && guard++ < 8) {
          if (cur.role === 'assistant') {
            if (this.hasRecoverableBlocks(cur) && this.isRecoverableStatus(cur)) {
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
