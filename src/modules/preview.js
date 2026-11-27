/* ============================================================
 * modules/preview：图片 / 附件全屏预览
 *
 * 支持 image/pdf/text/other 的显式 kind；文本通过有界流式读取，关闭时
 * 中止请求并清理媒体节点。浮层缓存只在节点仍连接时复用。
 * ============================================================ */
var Preview = {
  TEXT_RE: /\.(txt|md|markdown|csv|tsv|json|json5|ya?ml|toml|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|go|java|c|cc|cpp|cxx|h|hpp|cs|php|rb|sh|bash|zsh|sql|log|ini|conf|cfg|vue|svelte|tex|bib)$/i,
  IMAGE_RE: /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?)$/i,
  MAX_TEXT: 200 * 1024,
  _current: null,
  _controller: null,
  _releaseFocus: null,
  _prevOverflow: '',
  _clickBound: false,

  kindOf: function (name, mime) {
    name = String(name || '');
    mime = String(mime || '').toLowerCase();
    if (/^image\//.test(mime) || this.IMAGE_RE.test(name)) return 'image';
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
    if (/^text\//.test(mime) || this.TEXT_RE.test(name)) return 'text';
    return 'other';
  },

  resolveKind: function (info) {
    if (info && ['image', 'pdf', 'text', 'other'].indexOf(info.kind) !== -1) return info.kind;
    return this.kindOf(info && info.name, info && info.mime);
  },

  ensureOverlay: function () {
    if (this.overlay && this.overlay.isConnected) return this.overlay;
    this.overlay = null;
    this.titleEl = null;
    this.bodyEl = null;
    this.downloadEl = null;
    this.closeEl = null;
    if (!this._styleInjected) {
      this._styleInjected = true;
      DCP.bridge.addStyle(
        '.dcp-preview-overlay{position:fixed;inset:0;z-index:2147483600;display:none;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:#f5f7fb;font-family:inherit}' +
        '.dcp-preview-overlay.dcp-on{display:flex}' +
        '.dcp-preview-panel{width:100%;height:100%;display:flex;flex-direction:column;box-sizing:border-box}' +
        '.dcp-preview-header{height:54px;flex:0 0 54px;display:flex;align-items:center;gap:12px;padding:0 18px;' +
        'border-bottom:1px solid rgba(255,255,255,.1);background:rgba(20,22,28,.9)}' +
        '.dcp-preview-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600}' +
        '.dcp-preview-download,.dcp-preview-close{flex:0 0 auto;height:32px;border:1px solid rgba(255,255,255,.16);border-radius:8px;' +
        'background:rgba(255,255,255,.08);color:#f5f7fb;cursor:pointer;text-decoration:none;font-size:13px;padding:0 12px;' +
        'display:inline-flex;align-items:center;justify-content:center}' +
        '.dcp-preview-download:hover,.dcp-preview-close:hover{background:rgba(255,255,255,.16)}' +
        '.dcp-preview-download:focus-visible,.dcp-preview-close:focus-visible{outline:2px solid #8ab4ff;outline-offset:2px}' +
        '.dcp-preview-close{width:34px;padding:0;font-size:20px;line-height:1}' +
        '.dcp-preview-body{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;overflow:auto}' +
        '.dcp-preview-body>img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;box-shadow:0 12px 50px rgba(0,0,0,.45)}' +
        '.dcp-preview-body>iframe,.dcp-preview-body>embed{width:100%;height:100%;border:0;background:#fff;border-radius:6px}' +
        '.dcp-preview-body>pre{width:100%;height:100%;margin:0;padding:18px;box-sizing:border-box;overflow:auto;white-space:pre-wrap;' +
        'word-break:break-word;background:#111319;border:1px solid rgba(255,255,255,.1);border-radius:8px;' +
        'font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6e9ef}' +
        '.dcp-preview-msg{max-width:520px;text-align:center;line-height:1.7;color:rgba(245,247,251,.72);font-size:14px;padding:24px}' +
        '.dcp-preview-msg strong{display:block;color:#f5f7fb;font-size:16px;margin-bottom:8px;word-break:break-all}' +
        '@media (max-width:640px){.dcp-preview-header{padding:0 10px}.dcp-preview-body{padding:8px}.dcp-preview-download{padding:0 9px}}'
      );
    }
    var overlay = document.createElement('div');
    overlay.className = 'dcp-preview-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', DCP.t('预览'));
    UI.markOwned(overlay);
    overlay.innerHTML =
      '<div class="dcp-preview-panel">' +
        '<div class="dcp-preview-header">' +
          '<span id="dcp-preview-title" class="dcp-preview-title"></span>' +
          '<a class="dcp-preview-download" href="#" download rel="noopener">' + DCP.t('下载') + '</a>' +
          '<button type="button" class="dcp-preview-close" aria-label="' + DCP.t('关闭预览') + '">×</button>' +
        '</div>' +
        '<div class="dcp-preview-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.titleEl = overlay.querySelector('.dcp-preview-title');
    this.bodyEl = overlay.querySelector('.dcp-preview-body');
    this.downloadEl = overlay.querySelector('.dcp-preview-download');
    this.closeEl = overlay.querySelector('.dcp-preview-close');
    UI.markOwned(this.titleEl);
    UI.markOwned(this.bodyEl);
    UI.markOwned(this.downloadEl);
    UI.markOwned(this.closeEl);
    overlay.setAttribute('aria-labelledby', 'dcp-preview-title');
    var self = this;
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) self.close();
    });
    this.closeEl.addEventListener('click', function () { self.close(); });
    return overlay;
  },

  message: function (title, text) {
    this.bodyEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'dcp-preview-msg';
    UI.markOwned(box);
    var strong = document.createElement('strong');
    strong.textContent = title || '';
    var span = document.createElement('span');
    span.textContent = text || '';
    box.appendChild(strong);
    box.appendChild(span);
    this.bodyEl.appendChild(box);
  },

  loading: function () {
    this.bodyEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'dcp-preview-msg';
    box.textContent = DCP.t('正在加载预览…');
    UI.markOwned(box);
    this.bodyEl.appendChild(box);
  },

  fallback: function (info, extra) {
    this.message(info.name, DCP.t('该文件类型暂不支持内嵌预览，请下载后查看。') + (extra || ''));
    if (info.href) {
      var a = document.createElement('a');
      a.className = 'dcp-preview-download';
      a.href = info.href;
      a.download = info.name || '';
      a.textContent = DCP.t('下载');
      a.rel = 'noopener';
      if (!/^blob:/.test(info.href)) a.target = '_blank';
      UI.markOwned(a);
      this.bodyEl.appendChild(a);
    }
  },

  readTextBounded: function (response, maxBytes, signal) {
    var self = this;
    maxBytes = Math.max(0, Number(maxBytes) || 0);
    return new Promise(function (resolve, reject) {
      if (!response || !response.body || typeof response.body.getReader !== 'function') {
        reject(new Error('readable stream unavailable'));
        return;
      }
      if (signal && signal.aborted) return reject(self.abortError());
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var chunks = [];
      var total = 0;
      var truncated = false;
      var settled = false;
      function cleanup() {
        settled = true;
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
      }
      function fail(error) {
        if (settled) return;
        cleanup();
        Utils.cancelReader(reader);
        reject(error);
      }
      function onAbort() { fail(self.abortError()); }
      function done() {
        if (settled) return;
        cleanup();
        try { chunks.push(decoder.decode()); } catch (e) {}
        resolve({ text: chunks.join(''), truncated: truncated });
      }
      function pump() {
        if (settled) return;
        reader.read().then(function (result) {
          if (settled) return;
          if (result.done) return done();
          var chunk = result.value || new Uint8Array(0);
          var remaining = maxBytes - total;
          if (chunk.byteLength > remaining) {
            chunk = chunk.subarray(0, Math.max(0, remaining));
            truncated = true;
          }
          if (chunk.byteLength) {
            total += chunk.byteLength;
            try { chunks.push(decoder.decode(chunk, { stream: true })); } catch (e) {}
          }
          if (truncated || total > maxBytes) {
            if (total > maxBytes) truncated = true;
            Utils.cancelReader(reader);
            done();
            return;
          }
          pump();
        }, fail);
      }
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
      pump();
    });
  },

  abortError: function () {
    return UI.abortError();
  },

  render: function (info) {
    var self = this;
    var kind = this.resolveKind(info);
    this.loading();
    if (kind === 'image') {
      var img = document.createElement('img');
      img.alt = info.name || '';
      UI.markOwned(img);
      img.onload = function () {
        if (self._current !== info) return;
        self.bodyEl.innerHTML = '';
        self.bodyEl.appendChild(img);
      };
      img.onerror = function () {
        if (self._current === info) self.fallback(info);
      };
      img.src = info.href;
      return;
    }
    if (kind === 'pdf') {
      var frame = document.createElement('iframe');
      frame.title = info.name || 'PDF';
      frame.src = info.href;
      UI.markOwned(frame);
      this.bodyEl.innerHTML = '';
      this.bodyEl.appendChild(frame);
      return;
    }
    if (kind === 'text') {
      var controller = this._controller;
      fetch(info.href, { signal: controller && controller.signal }).then(function (response) {
        if (!response.ok) throw new Error('http ' + response.status);
        return self.readTextBounded(response, self.MAX_TEXT, controller && controller.signal);
      }).then(function (result) {
        if (self._current !== info) return;
        var pre = document.createElement('pre');
        pre.textContent = result.text + (result.truncated ? '\n\n… ' + DCP.t('文件过大，仅显示前 200KB。') : '');
        UI.markOwned(pre);
        self.bodyEl.innerHTML = '';
        self.bodyEl.appendChild(pre);
      }).catch(function (error) {
        if (error && error.name === 'AbortError') return;
        if (self._current === info) self.fallback(info);
      });
      return;
    }
    this.fallback(info, info.sizeHint ? '\n' + info.sizeHint : '');
  },

  clearMedia: function () {
    if (!this.bodyEl) return;
    var media = this.bodyEl.querySelectorAll('img,iframe,embed,video,audio,source');
    for (var i = 0; i < media.length; i++) {
      try { media[i].removeAttribute('src'); } catch (e) {}
      try { media[i].removeAttribute('href'); } catch (e) {}
    }
    this.bodyEl.innerHTML = '';
  },

  open: function (info) {
    if (!info || !info.href) return;
    var alreadyOpen = !!this._current;
    this.ensureOverlay();
    if (this._releaseFocus) {
      this._releaseFocus();
      this._releaseFocus = null;
    }
    if (this._controller) this._controller.abort();
    this._current = info;
    this._controller = new AbortController();
    if (!alreadyOpen) this._prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    UI.setTextIfChanged(this.titleEl, info.name || DCP.t('附件'));
    this.downloadEl.href = info.href;
    this.downloadEl.download = info.name || '';
    if (!/^blob:/.test(info.href)) {
      this.downloadEl.target = '_blank';
      this.downloadEl.rel = 'noopener';
    } else {
      this.downloadEl.removeAttribute('target');
      this.downloadEl.removeAttribute('rel');
    }
    this.overlay.classList.add('dcp-on');
    this._releaseFocus = UI.trapFocus(this.overlay, {
      initialFocus: this.closeEl,
      onEscape: function () { Preview.close(); }
    });
    this.render(info);
  },

  close: function () {
    if (!this._current) return;
    this._current = null;
    if (this._controller) {
      this._controller.abort();
      this._controller = null;
    }
    if (this._releaseFocus) {
      this._releaseFocus();
      this._releaseFocus = null;
    } else if (this._prevFocus && this._prevFocus.focus) {
      try { this._prevFocus.focus({ preventScroll: true }); } catch (e) { this._prevFocus.focus(); }
    }
    this._prevFocus = null;
    this.overlay.classList.remove('dcp-on');
    this.clearMedia();
    this.downloadEl.href = '#';
    this.downloadEl.removeAttribute('download');
    this.downloadEl.removeAttribute('target');
    this.downloadEl.removeAttribute('rel');
    document.body.style.overflow = this._prevOverflow || '';
  },

  onClick: function (e) {
    if (!e.target || e.target.closest('.dcp-preview-overlay')) return;
    if (UI.isOwned(e.target)) return;
    if (e.target.closest('button,input,textarea,[role="button"]')) return;
    var main = e.target.closest('main');
    if (!main) return;

    var img = e.target.closest('img');
    if (img && main.contains(img)) {
      var link = img.closest('a[href]');
      var src = link ? link.getAttribute('href') : (img.currentSrc || img.src);
      if (src && (/^blob:/.test(src) || /^https?:/.test(src))) {
        e.preventDefault();
        e.stopPropagation();
        this.open({ href: src, name: img.alt || link && link.getAttribute('title') || 'image', kind: 'image' });
        return;
      }
    }

    var card = e.target.closest('[class*="card-"]');
    if (card && main.contains(card)) {
      var anchor = card.querySelector('a[download][href^="blob:"]') || card.closest('a[download][href^="blob:"]');
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();
      var name = card.getAttribute('title') || anchor.getAttribute('download') || anchor.getAttribute('aria-label') || DCP.t('附件');
      this.open({ href: anchor.getAttribute('href'), name: name, sizeHint: (card.innerText || '').replace(name, '').trim() });
    }
  },

  init: function () {
    if (this._inited) return;
    this._inited = true;
    this.ensureOverlay();
    if (!this._clickBound) {
      this._clickBound = true;
      document.addEventListener('click', this.onClick.bind(this), true);
    }
  }
};
DCP.modules.preview = Preview;
