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
          }
          setTimeout(function () { self.syncSession(true); }, 0);
        }
      }, true);
      self.syncSession(true);
    });
  }
};
DCP.modules.ctxRing = CtxRing;
