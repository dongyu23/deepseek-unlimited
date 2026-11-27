/* ============================================================
 * modules/codedownload：代码块下载
 *
 * 在原生代码块横幅里补一个同风格“下载”按钮；复制按钮按中英文 label
 * 定位，注入按钮带 data-dcp-owned，避免观察器自我触发。
 * ============================================================ */
var CodeDownload = {
  ICON: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M8 1.5v8.2m0 0 3.1-3.1M8 9.7 4.9 6.6M2.4 10.2v3.1c0 .7.6 1.2 1.2 1.2h8.8c.7 0 1.2-.6 1.2-1.2v-3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  EXT: {
    python: 'py', py: 'py', javascript: 'js', js: 'js', node: 'js', nodejs: 'js',
    typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', java: 'java', c: 'c',
    'c++': 'cpp', cpp: 'cpp', 'c#': 'cs', csharp: 'cs', cs: 'cs', go: 'go',
    golang: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', rb: 'rb', php: 'php',
    swift: 'swift', kotlin: 'kt', kt: 'kt', scala: 'scala', dart: 'dart',
    bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1',
    sql: 'sql', mysql: 'sql', postgresql: 'sql', json: 'json', json5: 'json5',
    yaml: 'yml', yml: 'yml', toml: 'toml', xml: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', markdown: 'md', md: 'md',
    text: 'txt', txt: 'txt', plaintext: 'txt', diff: 'diff', patch: 'diff',
    dockerfile: 'dockerfile', makefile: 'mk', lua: 'lua', r: 'r', perl: 'pl',
    matlab: 'm', 'objective-c': 'm', 'objective-c++': 'mm', assembly: 'asm', asm: 'asm'
  },

  languageOf: function (block) {
    var banner = DCP.qs('codeBanner', block);
    if (!banner) return '';
    var named = banner.querySelector('[class*="name-"]');
    if (named && named.textContent) return named.textContent.trim().toLowerCase();
    var text = (banner.textContent || '').trim();
    if (!text) return '';
    return text.split(/\s+/)[0].toLowerCase();
  },

  extOf: function (lang) {
    lang = String(lang || '').toLowerCase();
    if (UI.own(this.EXT, lang)) return this.EXT[lang];
    if (/^[a-z0-9_+-]{1,16}$/.test(lang)) return lang;
    return 'txt';
  },

  copyButton: function (banner) {
    return UI.findByLabels(banner, ['复制', 'Copy', '复制代码', 'Copy code'], 'button', false);
  },

  updateButton: function (btn) {
    if (!btn) return;
    var label = DCP.t('下载代码');
    UI.setAttributeIfChanged(btn, 'aria-label', label);
    UI.setAttributeIfChanged(btn, 'title', label);
    var text = btn.querySelector('span');
    UI.setTextIfChanged(text, DCP.t('下载'));
    UI.markOwned(btn);
  },

  ensure: function (block) {
    if (!block) return false;
    var existing = block.querySelector('.dcp-code-download');
    if (existing && existing.isConnected) {
      this.updateButton(existing);
      return false;
    }
    var banner = DCP.qs('codeBanner', block);
    if (!banner) return false;
    var copy = this.copyButton(banner);
    if (!copy) return false;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = copy.className + ' dcp-code-download';
    btn.innerHTML = this.ICON + '<span>' + DCP.t('下载') + '</span>';
    this.updateButton(btn);
    var self = this;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      self.download(block);
    }, true);
    copy.insertAdjacentElement('afterend', btn);
    return true;
  },

  download: function (block) {
    var pre = block && block.querySelector('pre');
    if (!pre) return;
    var lang = this.languageOf(block);
    var name = 'code.' + this.extOf(lang);
    var code = pre.textContent || '';
    var blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    Utils.toast(DCP.t('已下载 {name}', { name: name }), 1600);
  },

  scan: function () {
    var blocks = DCP.qsa('codeBlock');
    for (var i = 0; i < blocks.length; i++) {
      try { this.ensure(blocks[i]); } catch (e) {}
    }
  },

  init: function () {
    if (this._inited) return;
    this._inited = true;
    if (!this._styleInjected) {
      this._styleInjected = true;
      DCP.bridge.addStyle('.dcp-code-download:focus-visible{outline:2px solid var(--dcp-accent,#3b6cf6);outline-offset:2px}');
    }
    var self = this;
    Utils.onReady(function () {
      self.scan();
      self._observer = UI.observeRelevant(document.body, function () { self.scan(); }, {
        childList: true,
        subtree: true
      });
    });
  },

  destroy: function () {
    if (this._observer) this._observer.disconnect();
    this._observer = null;
  }
};
DCP.modules.codeDownload = CodeDownload;
