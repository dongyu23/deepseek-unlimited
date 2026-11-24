/* ============================================================
 * modules/thinktimer：思考过程实时秒表
 *
 * 官方在思考结束后才把“正在思考”改成“已思考（用时 n 秒）”。本模块
 * 在发送后开始计时，思考块出现时显示实时秒数，官方一旦给出最终文案
 * 就停止改写；不碰图标、不移动节点，也不干扰正文流式输出。
 * ============================================================ */
var ThinkTimer = {
  _active: false,
  _timer: null,
  _start: 0,
  _block: null,
  _blockStart: 0,
  _sawStop: false,

  liveText: function (sec) {
    return DCP.t('正在思考（用时 {n} 秒）', { n: sec });
  },

  start: function () {
    if (this._active) return;
    this._active = true;
    this._start = Date.now();
    this._block = null;
    this._blockStart = 0;
    this._sawStop = false;
    var self = this;
    this._timer = setInterval(function () { self.tick(); }, 200);
    this.tick();
  },

  stop: function () {
    if (!this._active) return;
    this._active = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._block = null;
    this._blockStart = 0;
  },

  latestBlock: function () {
    var SEL = DCP.SEL || {};
    if (!SEL.thinkBlock) return null;
    var blocks = document.querySelectorAll(SEL.thinkBlock);
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
          text.textContent = this.liveText(sec);
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

  init: function () {
    var self = this;
    document.addEventListener('keydown', function (e) { self.onSendKey(e); }, true);
    document.addEventListener('click', function (e) { self.onClick(e); }, true);
    // 程序化发送/桥接请求的兜底；与真实 UI 路径命中同一个 start()。
    DCP.on('session:activity', function (p) {
      if (!p) return;
      if (p.state === 'generating') self.start();
      else self.stop();
    });
    DCP.on('tps:start', function () { self.start(); });
    DCP.on('tps:idle', function () { self.stop(); });
  }
};
DCP.modules.thinkTimer = ThinkTimer;
