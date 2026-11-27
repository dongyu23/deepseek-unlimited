/* ============================================================
 * modules/demoPasteTxt：复刻官方「粘贴大段文本自动转成 txt 附件」
 *
 * 每次转换都是一个 operation/session/input-version 事务。只有仍处于同一
 * 会话、同一输入框且输入版本未变化时才恢复文本或记录撤销；轮询可取消，
 * 附件卡按文件名精确关联，避免把并发上传的其它卡片当成本次结果。
 * ============================================================ */
var DemoPasteTxt = {
  LIMIT: 2000,
  POLL_MS: 100,
  POLL_TIMEOUT: 4000,

  _bound: new WeakSet(),
  _versions: new WeakMap(),
  _active: null,
  _rec: null,
  _internalInput: null,
  _observer: null,
  _operationSequence: 0,

  /* ---------- 定位 ---------- */
  findInput: function () {
    var list = DCP.qsa('input[type="file"]');
    for (var i = 0; i < list.length; i++) {
      if (/\.txt/i.test(list[i].accept || '')) return list[i];
    }
    return null;
  },

  findUploadBtn: function (input) {
    var node = input ? input.previousElementSibling : null;
    while (node) {
      if (node.tagName === 'BUTTON') return node;
      var button = node.querySelector ? node.querySelector('button') : null;
      if (button) return button;
      node = node.previousElementSibling;
    }
    return null;
  },

  findComposer: function (input) {
    var node = input;
    while (node && node !== document.body) {
      if (node.querySelector && node.querySelector('textarea')) return node;
      node = node.parentElement;
    }
    return null;
  },

  cardList: function (composer) {
    if (!composer) return [];
    return DCP.qsa('fileCard', composer).filter(function (card) {
      return !!(card.querySelector && (card.querySelector('button') || card.querySelector('a[download]')));
    });
  },

  countCards: function (composer) {
    return this.cardList(composer).length;
  },

  /* ---------- 版本与事务 ---------- */
  getVersion: function (ta) {
    if (!ta) return 0;
    return this._versions.get(ta) || 0;
  },

  bumpVersion: function (ta) {
    if (!ta) return 0;
    var next = this.getVersion(ta) + 1;
    this._versions.set(ta, next);
    return next;
  },

  invalidateUndo: function (ta) {
    if (this._rec && (!ta || this._rec.ta === ta)) this._rec = null;
  },

  isOperationCurrent: function (op) {
    return !!(op && !op.cancelled && op.epoch === UI.sessionEpoch() && op.sid === UI.currentSid() &&
      op.composer && op.composer.isConnected && op.ta && op.ta.isConnected);
  },

  isRecordCurrent: function (rec) {
    return !!(rec && this.isOperationCurrent(rec) && rec.card && rec.card.isConnected &&
      this.getVersion(rec.ta) === rec.inputVersion);
  },

  cancelOperation: function (op) {
    if (!op) return;
    op.cancelled = true;
    if (op.pollTimer) clearTimeout(op.pollTimer);
    op.pollTimer = null;
    if (typeof op.resolveFeed === 'function') {
      var resolve = op.resolveFeed;
      op.resolveFeed = null;
      resolve({ ok: false, card: null, cancelled: true });
    }
    if (this._active === op) this._active = null;
  },

  cancelActive: function () {
    if (this._active) this.cancelOperation(this._active);
  },

  resetSession: function () {
    this.cancelActive();
    this._rec = null;
    this._internalInput = null;
  },

  /* ---------- 粘贴判定 ---------- */
  onPaste: function (e) {
    var cd = e.clipboardData;
    if (!cd) return;
    var items = cd.items;
    if (items) {
      for (var i = 0; i < items.length; i++) {
        if (items[i] && items[i].kind === 'file') return;
      }
    }
    var text = cd.getData('text/plain');
    if (!text) return;
    var ta = e.currentTarget;
    if (!ta || ta.tagName !== 'TEXTAREA') return;
    if (ta.matches && ta.matches(DCP.SEL.msgEditor)) return;
    var input = this.findInput();
    if (!input) return;
    var composer = this.findComposer(input);
    if (!composer || !composer.contains(ta)) return;
    var btn = this.findUploadBtn(input);
    if (!btn || btn.disabled) return;
    if (text.length <= this.LIMIT) return;

    e.preventDefault();
    this.cancelActive();
    this._rec = null;
    var s0 = ta.selectionStart;
    var s1 = ta.selectionEnd;
    var op = {
      id: ++this._operationSequence,
      epoch: UI.sessionEpoch(),
      sid: UI.currentSid(),
      composer: composer,
      input: input,
      ta: ta,
      text: text,
      at: s0,
      cancelled: false,
      pollTimer: null,
      resolveFeed: null,
      startedAt: Date.now()
    };
    this._active = op;
    var delInUndo = false;
    this._internalInput = ta;
    try {
      delInUndo = this.deleteSelection(ta, s0, s1);
    } finally {
      this._internalInput = null;
    }
    op.delInUndo = delInUndo;
    this.bumpVersion(ta);
    op.inputVersion = this.getVersion(ta);

    var file;
    try {
      file = new File([text], this.txtName(text), { type: 'text/plain;charset=utf-8' });
    } catch (err) {
      if (this.isOperationCurrent(op) && this.getVersion(ta) === op.inputVersion) {
        this.insertText(ta, text, s0, false);
      }
      this.cancelOperation(op);
      return;
    }
    op.file = file;
    var self = this;
    this.feed(input, file, composer, op).then(function (result) {
      if (self._active === op) self._active = null;
      if (!result || !result.ok || result.cancelled) {
        if (!result || result.cancelled || !self.isOperationCurrent(op)) return;
        if (self.getVersion(ta) !== op.inputVersion) return;
        self.insertText(ta, text, s0, false);
        Utils.toast(DCP.t('内容已恢复到输入框'));
        return;
      }
      if (!self.isOperationCurrent(op) || self.getVersion(ta) !== op.inputVersion) return;
      self._rec = {
        kind: 'converted',
        text: text,
        at: s0,
        card: result.card,
        delInUndo: delInUndo,
        composer: composer,
        input: input,
        ta: ta,
        epoch: op.epoch,
        sid: op.sid,
        inputVersion: op.inputVersion,
        cancelled: false
      };
    });
  },

  /* ---------- 选区删除 ---------- */
  setNativeValue: function (ta, value) {
    var setter = null;
    try {
      setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    } catch (e) {}
    if (setter) setter.call(ta, value);
    else ta.value = value;
  },

  deleteSelection: function (ta, s0, s1) {
    if (s0 === s1) return false;
    ta.focus();
    if (document.activeElement === ta && document.execCommand && document.execCommand('delete', false)) return true;
    this.setNativeValue(ta, ta.value.slice(0, s0) + ta.value.slice(s1));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(s0, s0);
    return false;
  },

  /* ---------- 把 File 交给页面上传管线 ---------- */
  cardName: function (card) {
    if (!card) return '';
    var link = card.querySelector ? card.querySelector('a[download]') : null;
    return String(card.getAttribute('title') || card.getAttribute('data-file-name') ||
      (link && link.getAttribute('download')) || card.getAttribute('aria-label') || '').trim();
  },

  cardMatchesFile: function (card, file) {
    if (!card || !file) return false;
    var name = this.cardName(card);
    return !!name && name === String(file.name || '');
  },

  findCardForOperation: function (op) {
    var cards = this.cardList(op.composer);
    var matches = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (op.beforeCards && op.beforeCards.has(card)) continue;
      if (this.cardMatchesFile(card, op.file)) matches.push(card);
    }
    return matches.length === 1 ? matches[0] : null;
  },

  feed: function (input, file, composer, op) {
    op.beforeCards = new Set(this.cardList(composer));
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      return Promise.resolve({ ok: false, card: null, cancelled: false });
    }
    var self = this;
    return new Promise(function (resolve) {
      var settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (op.pollTimer) clearTimeout(op.pollTimer);
        op.pollTimer = null;
        op.resolveFeed = null;
        resolve(result);
      }
      op.resolveFeed = finish;
      (function poll() {
        if (settled) return;
        if (!self.isOperationCurrent(op)) return finish({ ok: false, card: null, cancelled: true });
        var card = self.findCardForOperation(op);
        if (card) return finish({ ok: true, card: card });
        if (Date.now() - op.startedAt > self.POLL_TIMEOUT) {
          return finish({ ok: false, card: null, cancelled: false });
        }
        op.pollTimer = setTimeout(poll, self.POLL_MS);
      })();
    });
  },

  /* ---------- 文本写回输入框 ---------- */
  insertText: function (ta, text, pos, focus) {
    if (!ta || !ta.isConnected) return false;
    if (focus) ta.focus();
    var at = pos == null ? ta.value.length : Math.max(0, Math.min(pos, ta.value.length));
    if (focus && document.activeElement === ta && document.execCommand && document.execCommand('insertText', false, text)) {
      this.bumpVersion(ta);
      return true;
    }
    this._internalInput = ta;
    this.setNativeValue(ta, ta.value.slice(0, at) + text + ta.value.slice(at));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    this._internalInput = null;
    try { ta.setSelectionRange(at + text.length, at + text.length); } catch (e) {}
    this.bumpVersion(ta);
    return true;
  },

  /* ---------- Ctrl/Cmd+Z 撤销这次转换 ---------- */
  isUndoEvent: function (e) {
    if (String(e.key || '').toLowerCase() !== 'z' || e.altKey || e.shiftKey) return false;
    var platform = '';
    try { platform = navigator.platform || navigator.userAgent || ''; } catch (err) {}
    var mac = /mac|iphone|ipad|ipod/i.test(platform);
    if (mac) return !!(e.metaKey && !e.ctrlKey);
    if (platform) return !!(e.ctrlKey && !e.metaKey);
    return e.ctrlKey !== e.metaKey;
  },

  deleteButton: function (card) {
    if (!card) return null;
    return UI.findByLabels(card, ['删除', '移除', 'Remove', 'Delete'], 'button', true) ||
      (card.querySelector ? card.querySelector('button') : null);
  },

  onKey: function (e) {
    var rec = this._rec;
    if (!rec) return;
    if (e.currentTarget !== rec.ta && e.target !== rec.ta) return;
    if (!this.isRecordCurrent(rec)) {
      this._rec = null;
      return;
    }
    if (!this.isUndoEvent(e)) {
      this._rec = null;
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    this._rec = null;
    var remove = this.deleteButton(rec.card);
    if (remove) Utils.realClick(remove);
    if (rec.delInUndo && document.execCommand) {
      this._internalInput = rec.ta;
      try { document.execCommand('undo', false); } catch (err) {}
      this._internalInput = null;
    }
    if (this.isOperationCurrent(rec) && this.getVersion(rec.ta) === rec.inputVersion) {
      this.insertText(rec.ta, rec.text, rec.at, false);
    }
  },

  /* ---------- 绑定 ---------- */
  bind: function () {
    var input = this.findInput();
    if (!input) return;
    var composer = this.findComposer(input);
    if (!composer) return;
    var self = this;
    DCP.qsa('textarea', composer).forEach(function (ta) {
      if (ta.matches && ta.matches(DCP.SEL.msgEditor)) return;
      if (self._bound.has(ta)) return;
      self._bound.add(ta);
      ta.addEventListener('paste', function (e) { self.onPaste(e); }, true);
      ta.addEventListener('keydown', function (e) { self.onKey(e); }, true);
      ta.addEventListener('input', function () {
        if (self._internalInput === ta) return;
        self.bumpVersion(ta);
        self.invalidateUndo(ta);
      });
    });
  },

  /* ---------- 文件名（官方算法） ---------- */
  txtName: function (text) {
    var RE_WORD = /[\p{L}\p{N}]/u;
    var RE_NON_LATIN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
    var isWord = function (ch) { return !!ch && RE_WORD.test(ch) && !RE_NON_LATIN.test(ch); };
    var RE_BAD = /[\\/:*?"<>|\x00-\x1f]/g;
    var newline = text.search(/\r|\n/);
    var first = newline === -1 ? text : text.slice(0, newline);
    if (first.length > 50) {
      var cut = 50;
      if (isWord(first[49]) && isWord(first[50])) {
        var at = 50;
        while (at > 0 && isWord(first[at - 1])) at -= 1;
        if (at > 0) cut = at;
      }
      first = first.slice(0, cut);
    }
    var name = first.replace(RE_BAD, '').replace(/\s+/g, ' ').trim();
    return (name || this.fallbackName()) + '.txt';
  },

  fallbackName: function () {
    var lang = '';
    try { lang = localStorage.getItem('latestReminderLanguage') || navigator.language || ''; } catch (e) {}
    return /^zh/i.test(lang) ? '粘贴的文本' : 'Pasted text';
  },

  init: function () {
    if (location.hostname !== 'cdn.deepseek.com') return;
    if (this._inited) return;
    this._inited = true;
    var self = this;
    Utils.onReady(function () {
      self.bind();
      self._observer = UI.observeRelevant(document.body, function () { self.bind(); }, {
        childList: true,
        subtree: true
      });
    });
    DCP.on('session:change', function () { self.resetSession(); });
    DCP.on('session:leave', function () { self.resetSession(); });
  },

  destroy: function () {
    if (this._observer) this._observer.disconnect();
    this._observer = null;
    this.resetSession();
  }
};
DCP.modules.demoPasteTxt = DemoPasteTxt;
