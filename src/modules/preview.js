/* ============================================================
 * modules/preview：图片 / 附件全屏预览
 *
 * 事件委托捕获消息区的图片链接和历史附件卡片。demo 已经把本地文件变成
 * blob URL，图片与 PDF 可以直接显示；文本类读取 blob 文本。Office 等
 * 浏览器无法内嵌渲染的类型保留下载按钮，不把文件发到第三方预览服务。
 * ============================================================ */
var Preview = {
  TEXT_RE: /\.(txt|md|markdown|csv|tsv|json|json5|ya?ml|toml|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|go|java|c|cc|cpp|cxx|h|hpp|cs|php|rb|sh|bash|zsh|sql|log|ini|conf|cfg|vue|svelte|tex|bib)$/i,
  IMAGE_RE: /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?)$/i,
  MAX_TEXT: 200 * 1024,
  _current: null,
  _prevFocus: null,
  _prevOverflow: '',

  kindOf: function (name, mime) {
    name = String(name || '');
    mime = String(mime || '').toLowerCase();
    if (/^image\//.test(mime) || this.IMAGE_RE.test(name)) return 'image';
    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
    if (/^text\//.test(mime) || this.TEXT_RE.test(name)) return 'text';
    return 'other';
  },

  ensureOverlay: function () {
    if (this.overlay) return this.overlay;
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
    var overlay = document.createElement('div');
    overlay.className = 'dcp-preview-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', DCP.t('预览'));
    overlay.innerHTML =
      '<div class="dcp-preview-panel">' +
        '<div class="dcp-preview-header">' +
          '<span class="dcp-preview-title"></span>' +
          '<a class="dcp-preview-download" href="#" download>' + DCP.t('下载') + '</a>' +
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
    var self = this;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) self.close(); });
    this.closeEl.addEventListener('click', function () { self.close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self._current) { e.preventDefault(); self.close(); }
    }, true);
    return overlay;
  },

  message: function (title, text) {
    this.bodyEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'dcp-preview-msg';
    var strong = document.createElement('strong');
    strong.textContent = title || '';
    var span = document.createElement('span');
    span.textContent = text || '';
    box.appendChild(strong); box.appendChild(span);
    this.bodyEl.appendChild(box);
  },

  loading: function () {
    this.bodyEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'dcp-preview-msg';
    box.textContent = DCP.t('正在加载预览…');
    this.bodyEl.appendChild(box);
  },

  fallback: function (info, extra) {
    var self = this;
    this.message(info.name, DCP.t('该文件类型暂不支持内嵌预览，请下载后查看。') + (extra || ''));
    if (info.href) {
      var a = document.createElement('a');
      a.className = 'dcp-preview-download';
      a.href = info.href; a.download = info.name || '';
      a.textContent = DCP.t('下载');
      if (!/^blob:/.test(info.href)) a.target = '_blank';
      this.bodyEl.appendChild(a);
    }
  },

  render: function (info) {
    var self = this, kind = this.kindOf(info.name, info.mime);
    this.loading();
    if (kind === 'image') {
      var img = document.createElement('img');
      img.alt = info.name || '';
      img.onload = function () {
        if (self._current !== info) return;
        self.bodyEl.innerHTML = ''; self.bodyEl.appendChild(img);
      };
      img.onerror = function () { if (self._current === info) self.fallback(info); };
      img.src = info.href;
      return;
    }
    if (kind === 'pdf') {
      var frame = document.createElement('iframe');
      frame.title = info.name || 'PDF';
      frame.src = info.href;
      this.bodyEl.innerHTML = ''; this.bodyEl.appendChild(frame);
      return;
    }
    if (kind === 'text') {
      fetch(info.href).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.blob();
      }).then(function (blob) {
        var truncated = blob.size > self.MAX_TEXT;
        return (truncated ? blob.slice(0, self.MAX_TEXT) : blob).text().then(function (text) {
          if (self._current !== info) return;
          var pre = document.createElement('pre');
          pre.textContent = text + (truncated ? '\n\n… ' + DCP.t('文件过大，仅显示前 200KB。') : '');
          self.bodyEl.innerHTML = ''; self.bodyEl.appendChild(pre);
        });
      }).catch(function () { if (self._current === info) self.fallback(info); });
      return;
    }
    this.fallback(info, info.sizeHint ? '\n' + info.sizeHint : '');
  },

  open: function (info) {
    if (!info || !info.href) return;
    this.ensureOverlay();
    this._current = info;
    this._prevFocus = document.activeElement;
    this._prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    this.titleEl.textContent = info.name || DCP.t('附件');
    this.downloadEl.href = info.href;
    this.downloadEl.download = info.name || '';
    if (!/^blob:/.test(info.href)) this.downloadEl.target = '_blank';
    else this.downloadEl.removeAttribute('target');
    this.overlay.classList.add('dcp-on');
    this.closeEl.focus();
    this.render(info);
  },

  close: function () {
    if (!this._current) return;
    this._current = null;
    this.overlay.classList.remove('dcp-on');
    this.bodyEl.innerHTML = '';
    document.body.style.overflow = this._prevOverflow || '';
    if (this._prevFocus && this._prevFocus.focus) {
      try { this._prevFocus.focus({ preventScroll: true }); } catch (e) { this._prevFocus.focus(); }
    }
    this._prevFocus = null;
  },

  onClick: function (e) {
    if (!e.target || e.target.closest('.dcp-preview-overlay')) return;
    if (e.target.closest('button,input,textarea,[role="button"]')) return;
    var main = e.target.closest('main');
    if (!main) return;
    var self = this;

    // 图片缩略图 / 消息图片
    var img = e.target.closest('img');
    if (img && main.contains(img)) {
      var link = img.closest('a[href]');
      var src = link ? link.getAttribute('href') : (img.currentSrc || img.src);
      if (src && (/^blob:/.test(src) || /^https?:/.test(src))) {
        e.preventDefault(); e.stopPropagation();
        this.open({ href: src, name: img.alt || link && link.getAttribute('title') || 'image', kind: 'image' });
        return;
      }
    }

    // 历史附件卡片：卡片本身可点，内部隐藏 <a download> 带 blob URL。
    var card = e.target.closest('[class*="card-"]');
    if (card && main.contains(card)) {
      var a = card.querySelector('a[download][href^="blob:"]') || card.closest('a[download][href^="blob:"]');
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      var name = card.getAttribute('title') || a.getAttribute('download') || a.getAttribute('aria-label') || DCP.t('附件');
      this.open({ href: a.getAttribute('href'), name: name, sizeHint: (card.innerText || '').replace(name, '').trim() });
    }
  },

  init: function () {
    this.ensureOverlay();
    document.addEventListener('click', this.onClick.bind(this), true);
  }
};
DCP.modules.preview = Preview;
