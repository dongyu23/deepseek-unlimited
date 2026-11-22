/* ============================================================
 * modules/tpsmeter：自定义模型实时输出速率（thinking + 正文）
 *
 * demobridge 每轮请求按 message_start → message_delta 计算平均
 * token/秒，并通过 tps:start / tps:update / tps:idle 广播。本模块只在
 * 输入工具条上下文环左侧显示纯文本速率；默认关闭，可在高级选项开启。
 * ============================================================ */
var TpsMeter = {
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

  render: function () {
    var el = document.getElementById('dcp-tps-meter') || this.inject();
    if (!el) return;
    if (this._active) {
      el.textContent = this._last
        ? DCP.t('实时 {n} tok/s', { n: this.fmt(this._last.tps) })
        : DCP.t('实时 -- tok/s');
    } else {
      el.textContent = this._last
        ? DCP.t('平均 {n} tok/s', { n: this.fmt(this._last.tps) })
        : DCP.t('-- tok/s');
    }
    if (this._last) {
      el.title = DCP.t('本轮已输出 {tokens} tokens，用时 {sec} 秒（{kind}）', {
        tokens: Math.round(this._last.tokens || 0),
        sec: (Number(this._last.elapsed) || 0).toFixed(2),
        kind: this._last.estimated ? DCP.t('实时估算') : DCP.t('接口 usage 精确值')
      });
    } else {
      el.title = '';
    }
    el.style.display = this.canShow() ? 'inline-flex' : 'none';
  },

  start: function (payload) {
    var tracker = DCP.modules && DCP.modules.demoSearch;
    if (payload && payload.requestId && tracker && typeof tracker.isRequestCurrent === 'function' &&
        !tracker.isRequestCurrent(payload)) return;
    this._active = true;
    this.render();
  },

  paint: function (data, payload) {
    var tracker = DCP.modules && DCP.modules.demoSearch;
    if (payload && payload.requestId && tracker && typeof tracker.isRequestCurrent === 'function' &&
        !tracker.isRequestCurrent(payload)) return;
    if (data && data.tps > 0) this._last = data;
    this._active = true;
    this.render();
  },

  idle: function (payload) {
    var tracker = DCP.modules && DCP.modules.demoSearch;
    if (payload && payload.requestId && tracker && typeof tracker.isRequestCurrent === 'function' &&
        !tracker.isRequestCurrent(payload)) return;
    this._active = false;
    this.render();
    // 只在请求收尾时持久化一次权威/最终均值，避免 250ms 实时更新把整个
    // 会话表反复序列化并同步写 GM_setValue。
    this.saveLast(payload && payload.sessionId);
  },

  saveLast: function (sid) {
    if (!this._last) return;
    sid = sid || (DCP.modules.ctxRing && DCP.modules.ctxRing._sessionId);
    if (!sid) return;
    var all = DCP.config.sessions();
    all[sid] = Object.assign({}, all[sid], { tps: this._last, savedAt: Date.now() });
    DCP.config.saveSessions();
  },

  restore: function (sid) {
    var saved = sid && DCP.config.sessions()[sid];
    this._last = saved && saved.tps ? saved.tps : null;
    this._active = false;
    this.render();
  },

  init: function () {
    var self = this;
    Utils.onReady(function () {
      self.inject();
      self.render();
      DCP.on('tps:start', function (p) { self.start(p); });
      DCP.on('tps:update', function (p) { if (p) self.paint(p, p); });
      DCP.on('tps:idle', function (p) { self.idle(p); });
      DCP.on('session:change', function (e) { self.restore(e && e.sessionId); });
      DCP.on('cfg:change', function (e) {
        if (e.path === 'demoCustom' || e.path === 'demoEndpoint' || e.path === 'demoBridge' || e.path === 'demoShowTps') {
          self.render();
        }
      });
      // 工具条会随会话切换重建；与上下文环相同，掉了就补回来。
      new MutationObserver(Utils.throttle(function () {
        if (!document.getElementById('dcp-tps-meter')) {
          self.inject();
          self.render();
        }
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  }
};
DCP.modules.tpsMeter = TpsMeter;
