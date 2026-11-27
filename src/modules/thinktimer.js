/* ============================================================
 * modules/thinktimer：思考过程实时秒表
 *
 * 官方在思考结束后才把“正在思考”改成“已思考（用时 n 秒）”。本模块
 * 在发送后开始计时，思考块出现时显示实时秒数，官方一旦给出最终文案
 * 就停止改写；不碰图标、不移动节点，也不干扰正文流式输出。
 *
 * 计时器必须绑定 requestId / sessionId / epoch：切会话或旧请求的迟到
 * idle 事件不能停掉新请求，也不能改写其它聊天区的思考块。
 * ============================================================ */
var ThinkTimer = {
  _active: false,
  _timer: null,
  _start: 0,
  _block: null,
  _blockStart: 0,
  _sawStop: false,
  _requestId: null,
  _sessionId: null,
  _epoch: null,
  _minEpoch: null,

  liveText: function (sec) {
    return DCP.t('正在思考（用时 {n} 秒）', { n: sec });
  },

  reset: function () {
    this._active = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._block = null;
    this._blockStart = 0;
    this._sawStop = false;
    this._requestId = null;
  },

  stop: function () {
    this.reset();
  },

  // epoch 由 DemoSearch 在切会话时递增。session:change 后先记住旧 epoch，
  // 低于或等于它的迟到事件全部忽略；新请求必须带来更大的 epoch。
  acceptsEpoch: function (meta) {
    if (!meta || meta.epoch == null) return true;
    if (this._minEpoch != null && meta.epoch <= this._minEpoch) return false;
    if (this._epoch != null && meta.epoch < this._epoch) return false;
    return true;
  },

  matches: function (meta) {
    if (!meta) return true;
    if (!this.acceptsEpoch(meta)) return false;
    if (meta.requestId && this._requestId && meta.requestId !== this._requestId) return false;
    if (meta.sessionId && this._sessionId && meta.sessionId !== this._sessionId) return false;
    return true;
  },

  start: function (meta) {
    meta = meta || {};
    if (!this.acceptsEpoch(meta)) return false;
    if (meta.sessionId && this._sessionId && meta.sessionId !== this._sessionId) return false;
    if (meta.requestId && this._requestId && meta.requestId !== this._requestId) this.reset();
    if (meta.epoch != null) this._epoch = meta.epoch;
    this._minEpoch = null;
    if (meta.requestId) this._requestId = meta.requestId;
    if (meta.sessionId) this._sessionId = meta.sessionId;
    if (this._active) return true;
    this._active = true;
    this._start = Date.now();
    this._block = null;
    this._blockStart = 0;
    this._sawStop = false;
    var self = this;
    this._timer = setInterval(function () { self.tick(); }, 200);
    this.tick();
    return true;
  },

  latestBlock: function () {
    var SEL = DCP.SEL || {};
    if (!SEL.chatView || !SEL.thinkBlock) return null;
    var view = document.querySelector(SEL.chatView);
    if (!view) return null;
    var blocks = view.querySelectorAll(SEL.thinkBlock);
    return blocks.length ? blocks[blocks.length - 1] : null;
  },

  stopButton: function () {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].getAttribute('aria-label') || '').trim() === '停止生成') return btns[i];
    }
    return null;
  },

  tick: function () {
    if (!this._active) return;
    var stop = this.stopButton();
    if (stop) this._sawStop = true;

    // 只修改当前 chatView 里的最后一个思考块；侧栏、旧会话或其它聊天区
    // 的同名节点一律不碰。
    var block = this.latestBlock();
    if (block) {
      if (block !== this._block) {
        this._block = block;
        // 第一个思考块通常紧接发送出现，计时起点对齐到发送时刻；后续
        // 工具轮的新思考块从它自己出现时重新计时，与官方每块独立计时一致。
        this._blockStart = (this._blockStart === 0 && Date.now() - this._start < 2000) ? this._start : Date.now();
      }
      var title = block.querySelector((DCP.SEL || {}).thinkHeader || '.title-_3d93a');
      var text = title && title.querySelector('[class*="titleText-"]');
      if (text) {
        var cur = String(text.textContent || '').trim();
        // 官方最终文案或停止文案出现后不再覆盖，交还给官网。
        if (cur === '正在思考' || cur.indexOf('正在思考（用时') === 0) {
          var sec = Math.max(0, Math.floor((Date.now() - this._blockStart) / 1000));
          if (Utils.setTextIfChanged) Utils.setTextIfChanged(text, this.liveText(sec));
          else text.textContent = this.liveText(sec);
        }
      }
    }

    // 停止按钮出现过又消失，说明本轮生成结束；网络异常也会走这里。
    if (this._sawStop && !stop) { this.stop(); return; }
    // 空发送/极早失败：5 秒内既没进入生成态也没出现思考块，放弃计时。
    if (!this._sawStop && !block && Date.now() - this._start > 5000) this.stop();
  },

  onSendKey: function (e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    var ta = e.target;
    if (!ta || ta.tagName !== 'TEXTAREA') return;
    if (!String(ta.value || '').trim()) return;
    this.start();
  },

  onClick: function (e) {
    if (!e.target || !e.target.closest) return;
    var btn = e.target.closest('button');
    if (!btn) return;
    var aria = btn.getAttribute('aria-label') || '';
    if (aria === '停止生成') { this.stop(); return; }
    if (aria === '发送' || /sendButton-/.test(btn.className || '')) this.start();
  },

  onSessionChange: function (e) {
    var sid = (e && e.sessionId) || null;
    if (sid === this._sessionId) return;
    if (this._epoch != null) this._minEpoch = this._epoch;
    this._epoch = null;
    this._sessionId = sid;
    this.reset();
  },

  onActivity: function (p) {
    if (!p) return;
    if (p.state === 'generating') this.start(p);
    else if (this._active && this.matches(p)) this.stop();
  },

  onTpsStart: function (p) {
    this.start(p);
  },

  onTpsIdle: function (p) {
    if (this._active && this.matches(p)) this.stop();
  },

  init: function () {
    var self = this;
    document.addEventListener('keydown', function (e) { self.onSendKey(e); }, true);
    document.addEventListener('click', function (e) { self.onClick(e); }, true);
    // 程序化发送/桥接请求的兜底；与真实 UI 路径命中同一个 start()。
    DCP.on('session:activity', function (p) { self.onActivity(p); });
    DCP.on('session:change', function (e) { self.onSessionChange(e); });
    DCP.on('tps:start', function (p) { self.onTpsStart(p); });
    DCP.on('tps:idle', function (p) { self.onTpsIdle(p); });
  }
};
DCP.modules.thinkTimer = ThinkTimer;
