/* ============================================================
 * modules/demoapi：chat-demo 页 API 覆盖（端点 / Key / 模型，三项各自独立）
 *
 * 背景：官方 API demo（cdn.deepseek.com/chat-demo）把端点与模型写死
 * （api.deepseek.com/anthropic/v1 + deepseek-flash），Key 存在页面
 * localStorage。用户需要换模型、以及换模型提供方的端点。
 *
 * 做法：拦截发往 /anthropic/v1/messages 的请求，按配置改写三项，
 * **彼此独立、留空即不干预**：
 *   - demoEndpoint：替换请求 URL 的 base（官方默认
 *     https://api.deepseek.com/anthropic/v1；填到不含 /messages 为止）
 *   - demoKey：替换 x-api-key 请求头（空 = 用页面里填的官方 Key）
 *   - demoModel：替换 body.model（空 = 官方默认 deepseek-flash）
 * **请求体其余部分一律原样**——deepseek_* 服务端工具（联网搜索/读链接）、
 * 系统提示、thinking / safety_check / title 等私有字段全都不碰。
 *
 * 协议实测（2026-11-17，bundle 分析）：demo 用 Anthropic Messages API，
 * POST {base}/messages，头 x-api-key，SSE 流式。该 URL 模式只存在于
 * demo 页，主站（/api/v0/chat/completion）不受影响。
 *
 * 端点兼容性（如实说明）：
 *   - 换成 DeepSeek 的中转/镜像（同协议）→ 全部照旧，工具也照样工作；
 *   - 换成别家提供方 → 请求原样直达，deepseek_* 工具类型对方不认
 *     （报错或被忽略），且对方必须说 Anthropic 协议；OpenAI 协议的
 *     端点需要额外的协议翻译层（未做）。
 *   - 模型与工具在当前实现里是同一个请求发出的（服务端工具），详见
 *     代码注释与交付说明——解耦需要客户端 agent 桥接，未做。
 * ============================================================ */
var DemoApi = {
  KEYS: { endpoint: 'demoEndpoint', key: 'demoKey', model: 'demoModel', multimodal: 'demoMultimodal', bridge: 'demoBridge', ctxLimit: 'demoCtxLimit', showCtxRing: 'demoShowCtxRing', showTps: 'demoShowTps', sessionSync: 'demoSessionSync', searchLimit: 'demoSearchLimit', toolMode: 'demoToolMode', titleSource: 'demoTitleSource', lang: 'lang' },
  DEFAULT_BASE: 'https://api.deepseek.com/anthropic/v1',
  OFFICIAL_ORIGINS: ['https://api.deepseek.com', 'https://cdn.deepseek.com'],
  OFFICIAL_MESSAGES_PATH: '/anthropic/v1/messages',
  OFFICIAL_FILES_PATH: '/anthropic/v1/files',
  TEST_TIMEOUT_MS: 30000,
  // 只有精确官方端点才允许回退使用页面里的官方 Key。
  isOfficialEndpoint: function (ep) {
    var raw = String(ep || this.DEFAULT_BASE).trim();
    try {
      var u = new URL(raw);
      return u.protocol === 'https:' && u.origin === this.OFFICIAL_ORIGIN &&
        !u.username && !u.password && !u.search && !u.hash &&
        /^\/anthropic\/v1(?:\/messages)?\/?$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  },
  // 模型输入建议（datalist），不限制手输
  HINTS: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'],

  /* ---------- 附件捕获与有界 LRU 缓存 ----------
   * 页面把文件 POST 到 /anthropic/v1/files，响应只回 {id,size_bytes,filename,
   * mime_type}——没有正文。DeepSeek 自己的 Files API 也不支持下载原文件，所以
   * 第三方模型需要的正文只能在上传时从 FormData 里留下来。
   *
   * 每条记录都有 ready promise、大小、LRU 时间、截断与错误状态。文本只读前
   * 1 MiB，图片最多 8 MiB；总缓存限制 64 条 / 32 MiB，超限按 LRU 逐出。
   * 自定义模式关闭时不解析 FormData、不建立缓存，官方原生路径零额外开销。 */
  FILE_TEXT_MAX_BYTES: 1024 * 1024,
  FILE_IMAGE_MAX_BYTES: 8 * 1024 * 1024,
  FILE_CACHE_MAX_ENTRIES: 64,
  FILE_CACHE_MAX_BYTES: 32 * 1024 * 1024,
  FILE_WAIT_TIMEOUT_MS: 8000,
  _fileTexts: Object.create(null),
  _fileBytes: 0,
  _fileSeq: 0,
  _textExtRe: /\.(txt|md|csv|tsv|json|log|ya?ml|yml|ini|conf|cfg|html?|css|js|mjs|cjs|ts|tsx|jsx|py|go|java|c|cc|cpp|cxx|h|hpp|rs|rb|sh|bash|zsh|sql|xml|toml|dot|gv|proto|tex|bib|sty|cls|lisp|el|vim|r|lua|pl|pm|php|ps1|bat|cmd|awk|sed|make|mk|cmake|gradle|sbt|scala|kt|kts|swift|m|mm|dart|erl|hrl|ex|exs|clj|hs|lhs|ml|mli|fs|fsi|fsx|nim|cr|d|zig|v|sv|vhd|asm|s)$/i,

  _shouldCacheFiles: function () {
    return !!DCP.config.get('demoCustom');
  },
  _touchFileRecord: function (rec) {
    if (!rec) return;
    rec.lastUsed = Date.now();
    rec.usedSeq = ++this._fileSeq;
  },
  _evictFileRecord: function (id) {
    var rec = this._fileTexts[id];
    if (!rec) return;
    rec.evicted = true;
    rec.cached = false;
    this._fileBytes -= rec.weightBytes || 0;
    if (this._fileBytes < 0) this._fileBytes = 0;
    delete this._fileTexts[id];
    if (!rec._readyDone) {
      rec.error = 'evicted';
      this._finishFileRead(rec);
    }
  },
  _enforceFileLimits: function () {
    while (Object.keys(this._fileTexts).length > this.FILE_CACHE_MAX_ENTRIES ||
           this._fileBytes > this.FILE_CACHE_MAX_BYTES) {
      var oldestId = null;
      var oldest = null;
      Object.keys(this._fileTexts).forEach(function (id) {
        var rec = this._fileTexts[id];
        if (!oldest || rec.usedSeq < oldest.usedSeq ||
            (rec.usedSeq === oldest.usedSeq && rec.lastUsed < oldest.lastUsed)) {
          oldest = rec;
          oldestId = id;
        }
      }, this);
      if (oldestId == null) break;
      this._evictFileRecord(oldestId);
    }
  },
  _cacheFileRecord: function (rec) {
    if (!rec || !rec.id) return;
    if (this._fileTexts[rec.id]) this._evictFileRecord(rec.id);
    this._fileTexts[rec.id] = rec;
    this._fileBytes += rec.weightBytes || 0;
    this._touchFileRecord(rec);
    this._enforceFileLimits();
  },
  clearFileCache: function () {
    var self = this;
    Object.keys(this._fileTexts).forEach(function (id) {
      var rec = self._fileTexts[id];
      if (rec) {
        rec.evicted = true;
        rec.cached = false;
        if (!rec._readyDone) {
          rec.error = 'cache_cleared';
          self._finishFileRead(rec);
        }
      }
      delete self._fileTexts[id];
    });
    this._fileBytes = 0;
  },
  _finishFileRead: function (rec, error) {
    if (!rec || rec._readyDone) return;
    rec._readyDone = true;
    if (error && rec.error !== 'timeout') rec.error = error;
    if (!error && rec.error === 'timeout') rec.error = null;
    try { rec._resolveReady(rec); } catch (e) {}
  },
  _readBlobText: function (blob) {
    if (blob && typeof blob.text === 'function') return blob.text();
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'undefined') { reject(new Error('FileReader unavailable')); return; }
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      try { reader.readAsText(blob); } catch (e) { reject(e); }
    });
  },
  _readTextFile: function (rec, file) {
    var self = this;
    var cap = this.FILE_TEXT_MAX_BYTES;
    rec.truncated = rec.size > cap;
    var source = file;
    if (rec.truncated) {
      if (!file || typeof file.slice !== 'function') {
        rec.error = 'bounded_read_unavailable';
        self._finishFileRead(rec);
        return;
      }
      source = file.slice(0, cap);
    } else if (!file || (typeof file.text !== 'function' && typeof file.slice !== 'function')) {
      rec.error = 'text_reader_unavailable';
      self._finishFileRead(rec);
      return;
    }
    try {
      Promise.resolve(self._readBlobText(source)).then(function (text) {
        rec.text = String(text == null ? '' : text);
        self._finishFileRead(rec);
      }, function () {
        rec.error = 'text_read_failed';
        rec.text = undefined;
        self._finishFileRead(rec);
      });
    } catch (e) {
      rec.error = 'text_read_failed';
      rec.text = undefined;
      self._finishFileRead(rec);
    }
  },
  _readImageFile: function (rec, file) {
    var self = this;
    if (rec.size > this.FILE_IMAGE_MAX_BYTES) {
      rec.error = 'image_too_large';
      self._finishFileRead(rec);
      return;
    }
    if (typeof FileReader === 'undefined') {
      rec.error = 'image_reader_unavailable';
      self._finishFileRead(rec);
      return;
    }
    try {
      var reader = new FileReader();
      reader.onload = function () {
        rec.dataUrl = String(reader.result || '');
        var match = rec.dataUrl.match(/^data:([^;]+);base64,/i);
        rec.mediaType = (match && match[1]) || file.type || '';
        self._finishFileRead(rec);
      };
      reader.onerror = function () {
        rec.error = 'image_read_failed';
        rec.dataUrl = undefined;
        self._finishFileRead(rec);
      };
      reader.onabort = function () {
        rec.error = 'image_read_aborted';
        rec.dataUrl = undefined;
        self._finishFileRead(rec);
      };
      reader.readAsDataURL(file);
    } catch (e) {
      rec.error = 'image_read_failed';
      rec.dataUrl = undefined;
      self._finishFileRead(rec);
    }
  },
  _createFileRecord: function (id, file, meta) {
    if (!id || !this._shouldCacheFiles()) return null;
    id = String(id);
    meta = meta && typeof meta === 'object' ? meta : {};
    var name = String(meta.filename || (file && file.name) || '');
    var type = String(meta.mime_type || (file && file.type) || '');
    var size = Number(meta.size_bytes);
    var fileSize = Number(file && file.size) || 0;
    if (!isFinite(size) || size < 0) size = fileSize;
    else size = Math.max(size, fileSize);
    var rec = {
      id: id,
      name: name,
      type: type,
      size: size,
      lastUsed: 0,
      usedSeq: 0,
      truncated: false,
      error: null,
      timedOut: false,
      skipped: false,
      text: undefined,
      dataUrl: undefined,
      mediaType: type,
      weightBytes: 0,
      cached: true,
      evicted: false,
      ready: null,
      _readyDone: false,
      _resolveReady: null
    };
    rec.ready = new Promise(function (resolve) { rec._resolveReady = resolve; });
    var looksText = /^text\//.test(type) || this._textExtRe.test(name);
    var looksImage = /^image\//.test(type);
    if (looksText) rec.weightBytes = Math.min(size, this.FILE_TEXT_MAX_BYTES);
    else if (looksImage && DCP.config.get('demoMultimodal')) rec.weightBytes = Math.min(size, this.FILE_IMAGE_MAX_BYTES);
    this._cacheFileRecord(rec);
    if (rec.evicted) {
      rec.error = 'evicted';
      this._finishFileRead(rec);
      return rec;
    }
    if (looksText) this._readTextFile(rec, file);
    else if (looksImage) {
      if (!DCP.config.get('demoMultimodal')) {
        rec.skipped = true;
        this._finishFileRead(rec);
      } else this._readImageFile(rec, file);
    } else this._finishFileRead(rec);
    return rec;
  },
  _missingFileRecord: function (id) {
    var rec = {
      id: id, name: '', type: '', size: 0, lastUsed: Date.now(), usedSeq: 0,
      truncated: false, error: 'not_found', timedOut: false, skipped: false,
      text: undefined, dataUrl: undefined, mediaType: '', weightBytes: 0, cached: false,
      evicted: false, ready: null, _readyDone: true, _resolveReady: null
    };
    rec.ready = Promise.resolve(rec);
    return rec;
  },
  _waitForFileRecord: function (id, deadline) {
    var self = this;
    return new Promise(function (resolve) {
      var settled = false;
      var pollTimer = null;
      var done = function (rec) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearTimeout(pollTimer);
        resolve(rec);
      };
      var awaitReady = function (rec) {
        self._touchFileRecord(rec);
        var remaining = Math.max(1, deadline - Date.now());
        var wait;
        if (Utils && typeof Utils.withTimeout === 'function') {
          wait = Utils.withTimeout(rec.ready, remaining, 'attachment read timed out');
        } else {
          wait = new Promise(function (resolveWait, rejectWait) {
            var timer = setTimeout(function () { rejectWait(new Error('attachment read timed out')); }, remaining);
            rec.ready.then(function (value) { clearTimeout(timer); resolveWait(value); }, function (error) { clearTimeout(timer); rejectWait(error); });
          });
        }
        wait.then(function () { done(rec); }, function () {
          rec.timedOut = true;
          if (!rec.error) rec.error = 'timeout';
          done(rec);
        });
      };
      var check = function () {
        var rec = self._fileTexts[id];
        if (rec) { awaitReady(rec); return; }
        var remaining = deadline - Date.now();
        if (remaining <= 0) { done(self._missingFileRecord(id)); return; }
        pollTimer = setTimeout(check, Math.min(25, remaining));
      };
      check();
    });
  },
  waitForFiles: function (fileIds, timeoutMs) {
    var self = this;
    var list = Array.isArray(fileIds) ? fileIds : (fileIds == null ? [] : [fileIds]);
    var ids = [];
    var seen = Object.create(null);
    list.forEach(function (value) {
      var id;
      try { id = String(value); } catch (e) { return; }
      if (!id || seen[id]) return;
      seen[id] = true;
      ids.push(id);
    });
    var timeout = Number(timeoutMs == null ? this.FILE_WAIT_TIMEOUT_MS : timeoutMs);
    if (!isFinite(timeout) || timeout <= 0) timeout = this.FILE_WAIT_TIMEOUT_MS;
    var deadline = Date.now() + timeout;
    var waits = ids.map(function (id) { return self._waitForFileRecord(id, deadline); });
    return Promise.all(waits).then(function (records) {
      var out = Object.create(null);
      records.forEach(function (rec) { if (rec && rec.id) out[rec.id] = rec; });
      return out;
    });
  },

  captureFile: function (req, orig, selfArg) {
    if (!this._shouldCacheFiles()) return orig.call(selfArg, req);
    var self = this;
    var readForm = function () {
      try { return req.clone().formData(); }
      catch (e) { return Promise.reject(e); }
    };
    return readForm().then(function (fd) {
      var file = null;
      try { file = fd && fd.get('file'); } catch (e) {}
      if (!file) return orig.call(selfArg, req);
      return orig.call(selfArg, req).then(function (resp) {
        if (!resp || resp.ok === false || typeof resp.clone !== 'function') return resp;
        try {
          resp.clone().json().then(function (meta) {
            if (!meta || !meta.id) return;
            self._createFileRecord(meta.id, file, meta);
          }, function () {});
        } catch (e) {}
        return resp;
      });
    }, function () {
      // 非 FormData 或不可读取的 body 保持官方原生行为。
      return orig.call(selfArg, req);
    });
  },

  // 注意：配置值不一定是字符串（如 demoCtxLimit 默认是数字 128000），
  // 直接 .trim() 会抛 TypeError 导致整个设置块注入失败
  cfg: function (k) {
    var v = DCP.config.get(this.KEYS[k]);
    return (v == null) ? '' : String(v);
  },
  base: function () { return this.cfg('endpoint').replace(/\/+$/, ''); },
  // 完整接口地址（含 /messages）。与 demobridge.normUrl 同一套归一逻辑——
  // 只填 base（StepFun 文档就是这格式）时补 /v1/messages，别再 404
  fullUrl: function () {
    var ep = this.base();
    if (!ep) return '';
    var B = DCP.modules.demoBridge;
    return (B && B.normUrl) ? B.normUrl(ep) : ep + '/messages';
  },

  /* ---------- 请求改写：端点 / Key / 模型 ---------- */
  // 必须写到 pageWindow()：油猴沙箱里 window 不是页面的 window，`window.fetch =`
  // 只改到沙箱全局、页面的 fetch 原封不动——demo 页整页走 fetch，桥接因此整个
  // 不工作（圆圈永远 0%，而主站走 XHR 不受影响，故只有 demo 页炸）
  patchFetch: function () {
    var self = this;
    var win = (typeof pageWindow === 'function') ? pageWindow() : window;
    if (!win.fetch || typeof Request === 'undefined' || typeof Headers === 'undefined') return;
    if (win.__dcpFetchPatched) return;
    var orig = win.fetch;
    DemoApi._origFetch = orig;
    win.__dcpFetchPatched = true;
    win.fetch = function (input, init) {
      var fetchSelf = this;
      var req;
      try { req = new Request(input, init); }
      catch (e) { return orig.call(fetchSelf, input, init); }

      if (!self._isOfficialRequest(req, self.OFFICIAL_MESSAGES_PATH)) {
        if (self._isOfficialRequest(req, self.OFFICIAL_FILES_PATH)) return self.captureFile(req, orig, fetchSelf);
        return self._nativeFetch(orig, fetchSelf, req, false, false);
      }
      if (!DCP.config.get('demoCustom')) return self._nativeFetch(orig, fetchSelf, req, true, false);

      return req.clone().text().then(function (text) {
        var body;
        try { body = JSON.parse(text); }
        catch (e) { return self._nativeFetch(orig, fetchSelf, req, true, false); }
        if (!self._isOfficialMessageBody(body)) return self._nativeFetch(orig, fetchSelf, req, true, false);
        return self._rewriteAndFetch(orig, fetchSelf, req, text, body);
      }, function () {
        return self._nativeFetch(orig, fetchSelf, req, true, false);
      });
    };
  },

  _isOfficialRequest: function (req, path) {
    try {
      var u = new URL(req.url);
      return req.method === 'POST' && this.OFFICIAL_ORIGINS.indexOf(u.origin) !== -1 &&
        u.pathname === path && !u.search && !u.hash;
    } catch (e) {
      return false;
    }
  },
  _isOfficialMessageBody: function (body) {
    return !!body && typeof body === 'object' && !Array.isArray(body) &&
      typeof body.model === 'string' && body.model.length > 0 &&
      Array.isArray(body.messages) && body.messages.length > 0 &&
      body.stream === true;
  },
  _nativeFetch: function (orig, selfArg, req, isMessages, bridgeHandled) {
    var sync = DCP.modules.sessionSync;
    var syncRec = (isMessages && !bridgeHandled && sync && typeof sync.enabled === 'function' && sync.enabled())
      ? sync.beginNativeRequest() : null;
    try {
      var p = orig.call(selfArg, req);
      if (!syncRec) return p;
      return p.then(function (resp) {
        return sync.observeNativeResponse(resp, syncRec);
      }, function (e) {
        sync.finishNativeRequest(syncRec, 'error');
        throw e;
      });
    } catch (e) {
      if (syncRec) sync.finishNativeRequest(syncRec, 'error');
      throw e;
    }
  },
  _rewriteAndFetch: function (orig, selfArg, req, text, body) {
    var base = this.base() || this.DEFAULT_BASE;
    var officialEndpoint = this.isOfficialEndpoint(base);
    var key = this.cfg('key');
    if (!officialEndpoint && !key) {
      return Promise.reject(new Error(DCP.t('第三方端点必须填写独立的 API Key；脚本不会把官方 DeepSeek Key 发送到非官方地址。')));
    }

    var full = this.fullUrl() || (this.DEFAULT_BASE.replace(/\/+$/, '') + '/messages');
    try { new URL(full); }
    catch (e) { return Promise.reject(new Error('Invalid API endpoint URL')); }

    var model = this.cfg('model');
    if (!key && !model && full === req.url) return this._nativeFetch(orig, selfArg, req, true, false);

    var headers = new Headers(req.headers);
    var origDsKey = headers.get('x-api-key') || '';
    if (!origDsKey) {
      var auth = headers.get('authorization') || '';
      origDsKey = auth.replace(/^Bearer\s+/i, '');
    }
    if (!officialEndpoint) {
      headers.delete('x-api-key');
      headers.delete('authorization');
      headers.delete('proxy-authorization');
      headers.delete('cookie');
    } else if (key) {
      headers.delete('x-api-key');
      headers.delete('authorization');
    }
    if (key) headers.set('x-api-key', key);

    var outBody = text;
    if (model && body.model !== model) {
      body.model = model;
      outBody = JSON.stringify(body);
      headers.delete('content-length');
    }
    var outReq = new Request(full, {
      method: req.method,
      headers: headers,
      body: outBody,
      signal: req.signal,
      credentials: req.credentials,
      mode: req.mode,
      cache: req.cache,
      redirect: req.redirect,
      referrer: req.referrer,
      referrerPolicy: req.referrerPolicy,
      integrity: req.integrity,
      keepalive: req.keepalive
    });

    var bridge = DCP.modules.demoBridge;
    if (bridge && typeof bridge.active === 'function' && bridge.active()) {
      try {
        var bridged = bridge.intercept(full, {
          method: 'POST', headers: headers, body: outBody, signal: req.signal
        }, origDsKey);
        if (bridged) return bridged;
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return this._nativeFetch(orig, selfArg, outReq, true, false);
  },

  /* ---------- 敏感输入与连接测试 ---------- */
  bindKeyInput: function (input) {
    input.value = '';
    input.autocomplete = 'off';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('data-dcp-sensitive', '1');
    var saved = '';
    var dirty = false;
    var timer = null;
    var commit = function () {
      if (!dirty) return { ok: true, skipped: true };
      var value = input.value.trim();
      var result = DCP.config.set('demoKey', value);
      saved = value;
      dirty = false;
      return result;
    };
    input._dseCommit = commit;
    input._dseClear = function () {
      clearTimeout(timer); timer = null;
      if (dirty) commit();
      input.value = '';
      dirty = false;
    };
    input.addEventListener('focus', function () {
      if (dirty || input.value) return;
      saved = String(DCP.config.get('demoKey') || '');
      input.value = saved;
    });
    input.addEventListener('input', function () {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        commit();
      }, 300);
    });
    input.addEventListener('blur', function () {
      clearTimeout(timer); timer = null;
      if (dirty) commit();
      input.value = '';
      dirty = false;
    });
    return input;
  },
  _clearSensitiveInputs: function (root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('input[data-dcp-sensitive]'), function (input) {
      if (typeof input._dseClear === 'function') input._dseClear();
      else input.value = '';
    });
  },
  runConnectionTest: function (options) {
    if (this._testInFlight) return this._testInFlight;
    options = options || {};
    var self = this;
    var fetchImpl = options.fetchImpl || this._origFetch || window.fetch;
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('fetch is unavailable'));
    }
    var timeoutMs = Number(options.timeoutMs || this.TEST_TIMEOUT_MS);
    if (!isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = this.TEST_TIMEOUT_MS;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, timeoutMs);
    var startedAt = Date.now();
    var task = (async function () {
      var headers = { 'Content-Type': 'application/json' };
      if (options.key) headers.Authorization = 'Bearer ' + options.key;
      var init = {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: options.model || 'deepseek-flash',
          max_tokens: 1024,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: DCP.t('你是什么AI模型？请用一句话直接说明你的模型名称和开发方，不要复述这个问题。') }]
        })
      };
      if (controller) init.signal = controller.signal;
      var resp = await fetchImpl(options.url, init);
      var ms = Date.now() - startedAt;
      if (!resp.ok) {
        var text = await resp.text();
        var message = text;
        try {
          var parsed = JSON.parse(text);
          message = (parsed.error && parsed.error.message) || text;
        } catch (e) {}
        return { ok: false, status: resp.status, ms: ms, message: String(message).slice(0, 200) };
      }
      var json = await resp.json();
      var content = Array.isArray(json.content) ? json.content : [];
      var reply = content.filter(function (block) { return block && block.type === 'text'; })
        .map(function (block) { return block.text || ''; }).join('').trim();
      return {
        ok: true,
        status: resp.status,
        ms: ms,
        model: json.model || options.model || 'deepseek-flash',
        text: reply,
        stopReason: json.stop_reason || '?',
        types: content.map(function (block) { return block && block.type; }).join(',')
      };
    })();

    var timeoutMessage = DCP.t('连接测试超时，请检查端点或稍后重试。');
    var wait = (Utils && typeof Utils.withTimeout === 'function')
      ? Utils.withTimeout(task, timeoutMs, timeoutMessage)
      : new Promise(function (resolve, reject) {
          var t = setTimeout(function () { reject(Utils.timeoutError(timeoutMessage)); }, timeoutMs);
          task.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
        });
    var guarded = wait.then(function (result) {
      clearTimeout(timer);
      self._testInFlight = null;
      return result;
    }, function (error) {
      clearTimeout(timer);
      self._testInFlight = null;
      if (timedOut || (controller && controller.signal.aborted)) throw Utils.timeoutError(timeoutMessage);
      throw error;
    });
    this._testInFlight = guarded;
    return guarded;
  },

  /* ---------- UI：注入官方设置弹窗（独立「自定义模型」tab） ---------- */
  // 官方弹窗是左侧导航（通用设置/数据管理）+ 右侧内容容器的结构。我们把配置块
  // 收进自建的第三个 tab：导航按钮插进左侧 rail，配置块作为内容容器的直接子
  // 级（与原生行同为 flex 列子级，天然对齐）；tab 显隐自己管，不猜官方机制。
  // 导航按钮直接复制原生按钮的 className（含构建哈希——运行时复制，官方重建
  // 后自动跟随），激活态令牌从"激活/未激活"两个原生按钮的类名差里取。
  injectUI: function () {
    var dlg = document.querySelector('[class*="dialogMain-"]');
    if (!dlg) return;
    this._clearSensitiveInputs(dlg);
    var self = this;
    // 导航 = 含「通用设置/数据管理」文字的按钮的父容器；内容容器 = rail 兄弟
    // 里那个 flex 列的容器（都不依赖哈希类名）
    var navBtns = Array.prototype.filter.call(dlg.querySelectorAll('button'), function (b) {
      var t = (b.textContent || '').replace(/\s/g, '');
      return t === '通用设置' || t === '数据管理';
    });
    if (!navBtns.length) return;
    var rail = navBtns[0].parentElement;
    var content = null;
    Array.prototype.forEach.call(rail.parentElement.children, function (c) {
      if (!content && c !== rail && getComputedStyle(c).flexDirection === 'column') content = c;
    });
    if (!content) return;
    // 锚点仍用于取官方行的计算样式（标签/控件配色）——弹窗默认开在通用设置，
    // 该行可见；取不到就不注入（样式对齐优先）
    var anchor = null;
    Array.prototype.forEach.call(dlg.querySelectorAll('[class*="cell-"]'), function (c) {
      var t = (c.textContent || '').replace(/\s/g, '');
      if (/^(主题|语言|朗读音色|位置信息)/.test(t) && c.offsetParent !== null) anchor = c;
    });
    if (!anchor) return;
    // 接管：另一个脚本（deepseek-enhance）也往这个弹窗里注入「自定义模型」面
    // 板，而且它不管自己开没开自定义模型都会注入——两边用的是同一批 DOM id/
    // 属性（它那边是 dse- 前缀），谁先注入谁占位，后到的那个 injectUI 会当成
    // 「已在位」直接早退，面板永远显示不出来。本项目活动时先把对方那一份摘掉，
    // 用自己的 dcp- 前缀重建，两边各管各的、互不遮挡。
    var foreign = dlg.querySelector('[data-dse-api-wrap]');
    if (foreign) foreign.remove();
    var foreignNav = document.getElementById('dse-demo-tab');
    if (foreignNav) foreignNav.remove();
    var existing = dlg.querySelector('[data-dcp-api-wrap]');
    var navExisting = document.getElementById('dcp-demo-tab');
    if (existing && navExisting && existing.parentElement === content) {
      if (this._tabCtl) this._tabCtl.sync();   // 已在位：只同步显隐状态
      return;
    }
    if (existing) existing.remove();
    if (navExisting) navExisting.remove();
    // 上次注入绑定的监听/观察器先摘掉，避免重复累积
    if (this._tabCtl) {
      try { this._tabCtl.mo.disconnect(); } catch (e) {}
      try { this._tabCtl.rail.removeEventListener('click', this._tabCtl.onNativeClick, true); } catch (e) {}
      this._tabCtl = null;
    }
    var pick = function (el, props) {
      var cs = getComputedStyle(el), o = {};
      props.forEach(function (p) { o[p] = cs[p]; });
      return o;
    };
    var refLabel = anchor.querySelector('[class*="label-"]') || anchor;
    var refCtrl = anchor.querySelector('button') || anchor;
    var labelCss = pick(refLabel, ['color', 'fontSize']);
    var ctrlCss = pick(refCtrl, ['backgroundColor', 'color']);
    // 注意 box-sizing：demo 的全局 reset 不覆盖注入节点，默认 content-box 会
    // 让 60px 的行变成 84px（padding 外加）——与官方行观感不一致
    // 紧凑规格：行高从 60px 收到 44px、控件 36→32px、说明行 12→11px。
    // 这一屏有 6 行 + 2 条说明，按原规格设置面板要滚好长才能看到「高级选项」
    var rowBase = 'display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:44px;padding:6px 0;font-size:14px';
    var ctrlStyle = 'box-sizing:border-box;width:240px;height:32px;border:none;outline:none;border-radius:16px;padding:0 14px;' +
      'font-size:14px;background:' + (ctrlCss.backgroundColor || 'rgba(127,127,127,.18)') + ';' +
      'color:' + (ctrlCss.color || 'inherit');
    var descStyle = 'box-sizing:border-box;font-size:11px;line-height:1.4;opacity:.55;padding:0 0 3px';

    var self = this;
    var mkRow = function (labelText, cfgKey, placeholder, title, isPassword, hints, listId) {
      var row = document.createElement('div');
      row.setAttribute('data-dcp-api-row', cfgKey);
      row.style.cssText = rowBase;
      var label = document.createElement('div');
      label.setAttribute('data-i18n', labelText);
      label.textContent = DCP.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var input = document.createElement('input');
      input.type = isPassword ? 'password' : 'text';
      if (hints && listId) input.setAttribute('list', listId);
      else if (cfgKey === 'model') input.setAttribute('list', 'dcp-model-hints');
      input.placeholder = placeholder;
      input.title = title;
      input.style.cssText = ctrlStyle;
      if (cfgKey === 'key') {
        self.bindKeyInput(input);
      } else {
        input.value = self.cfg(cfgKey);
        // 即改即存（输入 300ms 防抖、失焦立即）。commit 挂到 input._dseCommit 上，
        // 底部「保存」按钮靠它冲掉还没落盘的防抖值。
        var commit = function () { return DCP.config.set(self.KEYS[cfgKey], input.value.trim()); };
        input._dseCommit = commit;
        input.addEventListener('input', function () {
          clearTimeout(input._dseT);
          input._dseT = setTimeout(function () { input._dseT = null; commit(); }, 300);
        });
        input.addEventListener('blur', function () {
          clearTimeout(input._dseT); input._dseT = null;
          commit();
        });
      }
      row.appendChild(label);
      row.appendChild(input);
      return row;
    };

    // 固定选项（鉴权头/桥接）用原生下拉，不用带 datalist 的文本框
    var CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23888' fill='none' stroke-width='1.5' stroke-linecap='round'/></svg>\")";
    var mkSelect = function (labelText, cfgKey, options, defVal, title) {
      var row = document.createElement('div');
      row.setAttribute('data-dcp-api-row', cfgKey);
      row.style.cssText = rowBase;
      var label = document.createElement('div');
      label.setAttribute('data-i18n', labelText);
      label.textContent = DCP.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var sel = document.createElement('select');
      sel.title = title;
      sel.style.cssText = ctrlStyle + 'appearance:none;-webkit-appearance:none;cursor:pointer;' +
        'padding-right:32px;background-image:' + CHEVRON + ';background-repeat:no-repeat;background-position:right 12px center;';
      options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o[0];
        opt.setAttribute('data-i18n', o[1]);
        opt.textContent = DCP.t(o[1]);
        sel.appendChild(opt);
      });
      sel.value = self.cfg(cfgKey) || defVal;
      sel.addEventListener('change', function () { DCP.config.set(self.KEYS[cfgKey], sel.value); });
      row.appendChild(label);
      row.appendChild(sel);
      return row;
    };

    var wrap = document.createElement('div');
    wrap.setAttribute('data-dcp-api-wrap', '1');

    // 主开关：关=完全官方逻辑（DeepSeek 全套）；开=才允许自定义
    var swRow = document.createElement('div');
    swRow.setAttribute('data-dcp-api-row', 'custom');
    swRow.style.cssText = rowBase + 'cursor:pointer;user-select:none';
    var swLabel = document.createElement('div');
    swLabel.setAttribute('data-i18n', '自定义模型');
    swLabel.textContent = DCP.t('自定义模型');
    swLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var swTrack = document.createElement('div');
    var swKnob = document.createElement('div');
    swTrack.style.cssText = 'width:44px;height:26px;border-radius:13px;position:relative;transition:background .15s;flex:0 0 auto';
    swKnob.style.cssText = 'position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 3px rgba(0,0,0,.3)';
    swTrack.appendChild(swKnob);
    var cfgBox = document.createElement('div');
    cfgBox.setAttribute('data-dcp-cfg-box', '1');
    var paintSw = function (on) {
      var accent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
      swTrack.style.background = on ? accent : 'rgba(127,127,127,.35)';
      swKnob.style.left = on ? '20px' : '2px';
      cfgBox.style.display = on ? 'block' : 'none';
    };
    swRow.addEventListener('click', function () {
      var v = !DCP.config.get('demoCustom');
      DCP.config.set('demoCustom', v);
      paintSw(v);
    });
    paintSw(!!DCP.config.get('demoCustom'));
    swRow.appendChild(swLabel); swRow.appendChild(swTrack);
    wrap.appendChild(swRow);
    wrap.appendChild(cfgBox);

    // 行+可见描述行的包装。注意：这是 var 函数表达式，定义必须在所有调用
    // 之前——早前端点/Key 行在定义之前调用，执行时 withDesc 还是 undefined，
    // TypeError 让整个 injectUI 中断、设置块整体不注入（实机抓到）
    var withDesc = function (row, desc) {
      var d = document.createElement('div');
      d.style.cssText = descStyle;
      d.textContent = DCP.t(desc);
      var box = document.createElement('div');
      box.appendChild(row); box.appendChild(d);
      return box;
    };

    // 布尔开关行（与主开关同款样式）——供高级选项里的布尔配置用
    var mkSwitch = function (labelText, cfgKey, desc) {
      var row = document.createElement('div');
      row.setAttribute('data-dcp-api-row', cfgKey);
      row.style.cssText = rowBase + 'cursor:pointer;user-select:none';
      var label = document.createElement('div');
      label.setAttribute('data-i18n', labelText);
      label.textContent = DCP.t(labelText);
      label.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
      var track = document.createElement('div');
      var knob = document.createElement('div');
      track.style.cssText = swTrack.style.cssText;
      knob.style.cssText = swKnob.style.cssText;
      track.appendChild(knob);
      var paint = function (on) {
        var accent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
        track.style.background = on ? accent : 'rgba(127,127,127,.35)';
        knob.style.left = on ? '20px' : '2px';
      };
      row.addEventListener('click', function () {
        var v = !DCP.config.get(self.KEYS[cfgKey]);
        DCP.config.set(self.KEYS[cfgKey], v);
        paint(!!v);
      });
      paint(!!DCP.config.get(self.KEYS[cfgKey]));
      row.appendChild(label); row.appendChild(track);
      return desc ? withDesc(row, desc) : row;
    };

    // 端点/Key 两行的说明较长，既放可见描述行（withDesc），也放输入框
    // hover 提示（title），两处共用同一字符串
    var ENDPOINT_DESC = DCP.t('填 Base URL 或完整地址都认：https://api.stepfun.com/step_plan（文档里的 Base URL）、https://api.stepfun.com/step_plan/v1、或 .../v1/messages，脚本自动补全。留空 = 官方 {base}', { base: DemoApi.DEFAULT_BASE });
    var KEY_DESC = DCP.t('第三方端点必须填写独立 Key；只有精确官方 api.deepseek.com 端点可留空并使用页面官方 Key');
    cfgBox.appendChild(withDesc(mkRow('API 端点', 'endpoint', DemoApi.DEFAULT_BASE, ENDPOINT_DESC), ENDPOINT_DESC));
    var keyBox = withDesc(mkRow('API Key', 'key', DCP.t('（第三方端点必填）'), KEY_DESC, true), KEY_DESC);
    var isolatedStorage = !!(DCP.bridge && DCP.bridge.capabilities && DCP.bridge.capabilities.isolatedStorage);
    var privacyKey = isolatedStorage
      ? 'API Key 仅保存在用户脚本管理器的隔离存储中，不会写入页面可读的 localStorage；输入框失焦后立即清空。'
      : '当前环境未检测到隔离存储，API Key 不会保存到页面存储，仅在当前页面会话内有效；刷新后需重新输入。';
    var privacy = document.createElement('div');
    privacy.setAttribute('data-i18n', privacyKey);
    privacy.style.cssText = descStyle + 'opacity:.7;padding-top:2px';
    privacy.textContent = DCP.t(privacyKey);
    keyBox.appendChild(privacy);
    cfgBox.appendChild(keyBox);
    cfgBox.appendChild(mkRow('模型', 'model', DCP.t('deepseek-flash（官方默认）'),
      DCP.t('留空 = 官方默认 deepseek-flash；只更换请求中的 model 字段'), false, DemoApi.HINTS, 'dcp-model-hints'));
    cfgBox.appendChild(withDesc(mkSelect('语言', 'lang',
      [['auto', '自动'], ['zh', '中文'], ['en', 'English']], 'auto', DCP.t('界面语言（跟随系统 / 中文 / English）')),
      DCP.t('界面语言（跟随系统 / 中文 / English）')));
    // 多模态开关：决定图片怎么发。开=转 base64 内联（多模态模型）；
    // 关=换成文字说明——纯文本模型即便收到图也是白烧 token，多半还被拒。
    // 注意 mkSwitch 内部已包 withDesc，这里别再套一层（否则描述渲染两遍）
    cfgBox.appendChild(mkSwitch('模型支持图片（多模态）', 'multimodal',
      DCP.t('开=图片转 base64 内联发送；关=只发「当前模型不支持图片」的文字说明。纯文本模型请关掉，省 token 也避免被端点拒')));

    /* ---------- 保存按钮（放在主字段下方、测试行之前：一眼可见，不用滚动） ----------
     * 这些项本来就是即改即存（输入 300ms 防抖、下拉 change 即时、失焦立即），
     * 但用户看不出来，也不确定直接关掉设置会不会丢——于是给一个显式「保存」：
     * 点一下冲掉所有未落盘的防抖写入、立即写盘并反馈；左边一句「改动会自动保存」
     * 把真实行为说明白，关不关面板都不会丢 */
    var saveRow = document.createElement('div');
    saveRow.setAttribute('data-dcp-api-row', 'save');
    saveRow.style.cssText = rowBase + 'margin-top:2px';
    var saveHint = document.createElement('div');
    saveHint.setAttribute('data-i18n', '设置改动会自动保存；点此可立即保存并确认。API Key 的保存取决于隔离存储是否可用。');
    saveHint.textContent = DCP.t('设置改动会自动保存；点此可立即保存并确认。API Key 的保存取决于隔离存储是否可用。');
    saveHint.style.cssText = 'flex:1;font-size:11px;line-height:1.4;opacity:.6;padding-right:8px';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = DCP.t('保存');
    var saveAccent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
    saveBtn.style.cssText = 'box-sizing:border-box;height:32px;border:none;outline:none;cursor:pointer;' +
      'border-radius:16px;padding:0 20px;font-size:13px;background:' + saveAccent + ';color:#fff;flex:0 0 auto';
    var saveBtnTimer = null;
    saveBtn.addEventListener('click', function () {
      var failed = false;
      var keyWarning = false;
      cfgBox.querySelectorAll('input').forEach(function (inp) {
        if (inp._dseT) { clearTimeout(inp._dseT); inp._dseT = null; }
        if (typeof inp._dseCommit === 'function') {
          var committed = inp._dseCommit();
          if (committed && committed.ok === false) failed = true;
          if (committed && committed.keyStored === false) keyWarning = true;
        }
        if (inp.getAttribute('data-dcp-sensitive') === '1' && typeof inp._dseClear === 'function') inp._dseClear();
      });
      var saveResult = DCP.config.save();
      if (!saveResult || saveResult.ok === false) failed = true;
      if (saveResult && saveResult.keyStored === false) keyWarning = true;
      if (failed) {
        Utils.toast(DCP.t('存储写入失败，请检查用户脚本管理器或浏览器存储权限。'), 3200);
        saveBtn.textContent = DCP.t('保存失败');
      } else {
        Utils.toast(DCP.t('已保存'), 1500);
        saveBtn.textContent = DCP.t('已保存 ✓');
        if (keyWarning) {
          Utils.toast(DCP.t('当前环境未检测到隔离存储，API Key 不会保存到页面存储，仅在当前页面会话内有效；刷新后需重新输入。'), 5000);
        }
      }
      clearTimeout(saveBtnTimer);
      saveBtnTimer = setTimeout(function () { saveBtn.textContent = DCP.t('保存'); }, 1600);
    });
    saveRow.appendChild(saveHint);
    saveRow.appendChild(saveBtn);
    cfgBox.appendChild(saveRow);
    // 模型测试：一发极小请求验证端点/Key/模型是否可用，并让模型自述身份——
    // DeepSeek 会答"我是DeepSeek"，第三方模型会答出自己的真实身份，用户据此
    // 确认切换真的生效了
    var testRow = document.createElement('div');
    testRow.setAttribute('data-dcp-api-row', 'test');
    testRow.style.cssText = rowBase;
    var testLabel = document.createElement('div');
    testLabel.setAttribute('data-i18n', '测试连接与模型身份');
    testLabel.textContent = DCP.t('测试连接与模型身份');
    testLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.textContent = DCP.t('测试');
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--dcp-accent').trim() || '#3b6cf6';
    testBtn.style.cssText = 'box-sizing:border-box;height:32px;border:none;outline:none;cursor:pointer;' +
      'border-radius:16px;padding:0 18px;font-size:13px;background:' + accent + ';color:#fff;flex:0 0 auto';
    var testResult = document.createElement('div');
    testResult.setAttribute('data-dcp-test-result', '1');
    testResult.style.cssText = 'display:none;box-sizing:border-box;font-size:11px;line-height:1.5;padding:1px 0 6px;white-space:pre-wrap;word-break:break-all';
    testBtn.addEventListener('click', function () {
      if (self._testInFlight) return;
      var restoreButton = function () {
        testBtn.disabled = false;
        testBtn.textContent = DCP.t('测试');
      };
      testBtn.disabled = true;
      testBtn.textContent = DCP.t('测试中…');
      testResult.style.display = 'block';
      testResult.style.color = 'inherit';
      testResult.textContent = DCP.t('测试中…');
      var u = self.fullUrl() || (DemoApi.DEFAULT_BASE.replace(/\/+$/, '') + '/messages');
      var model = (DCP.config.get('demoModel') || '').trim() || 'deepseek-flash';
      var officialEndpoint = self.isOfficialEndpoint(self.base());
      var key = (DCP.config.get('demoKey') || '').trim();
      if (!key && officialEndpoint) { try { key = localStorage.getItem('chat-demo:api-key') || ''; } catch (e) {} }
      if (!officialEndpoint && !key) {
        testResult.style.color = '#f87171';
        testResult.textContent = '❌ ' + DCP.t('第三方端点必须填写独立的 API Key；脚本不会把官方 DeepSeek Key 发送到非官方地址。');
        restoreButton();
        return;
      }
      self.runConnectionTest({ url: u, model: model, key: key }).then(function (result) {
        if (result.ok) {
          testResult.style.color = '#4ade80';
          testResult.textContent = '✅ ' + DCP.t('连接成功') + '（' + result.ms + 'ms）· ' + DCP.t('模型') + '：' + result.model +
            '\n' + DCP.t('模型自述') + '：' + (result.text ||
            (DCP.t('（未获得文本回复）') + '，stop_reason=' + result.stopReason + '，内容块=' + result.types + '）'));
        } else {
          testResult.style.color = '#f87171';
          testResult.textContent = '❌ ' + DCP.t('连接失败') + '（HTTP ' + result.status + '，' + result.ms + 'ms）\n' + result.message;
        }
      }, function (e) {
        testResult.style.color = '#f87171';
        var hint = (e && e.name === 'TypeError') ? DCP.t('（浏览器安全策略拦截了跨域请求，可在高级选项切换鉴权头试试）') : '';
        testResult.textContent = '❌ ' + DCP.t('连接测试失败') + '：' + String(e && e.message || e).slice(0, 150) + hint;
      }).then(restoreButton, function (e) {
        restoreButton();
        throw e;
      });
    });
    testRow.appendChild(testLabel); testRow.appendChild(testBtn);
    cfgBox.appendChild(testRow);
    cfgBox.appendChild(testResult);

    // 高级选项：默认折叠，配人话说明（这两个是排障开关，不是常规配置）
    var advToggle = document.createElement('div');
    advToggle.setAttribute('data-dcp-api-row', 'advanced');
    advToggle.style.cssText = rowBase + 'cursor:pointer;user-select:none';
    var advLabel = document.createElement('div');
    advLabel.setAttribute('data-i18n', '高级选项');
    advLabel.textContent = DCP.t('高级选项');
    advLabel.style.cssText = 'flex:1;font-size:' + (labelCss.fontSize || '14px') + ';color:' + (labelCss.color || 'inherit');
    var advArrow = document.createElement('span');
    advArrow.textContent = '⌄';
    advArrow.style.cssText = 'transition:transform .15s;opacity:.6;font-size:16px;width:24px;text-align:center';
    advToggle.appendChild(advLabel); advToggle.appendChild(advArrow);
    var advBox = document.createElement('div');
    advBox.setAttribute('data-dcp-advanced', '1');
    advBox.style.display = 'none';
    advToggle.addEventListener('click', function () {
      var open = advBox.style.display !== 'none';
      advBox.style.display = open ? 'none' : 'block';
      advArrow.style.transform = open ? '' : 'rotate(180deg)';
    });
    // 每轮搜索次数上限：默认不限制，预算紧的用户可显式限制。
    var SEARCH_LIMIT_TITLE = DCP.t('每轮回答中 web_search 的次数上限。unlimited=不限制，适合预算充裕、需要多轮检索的任务；2=最多两次；1=最多一次，适合节省预算。');
    var SEARCH_LIMIT_DESC = DCP.t('unlimited：不限制（默认）；2：每轮最多两次；1：每轮最多一次');
    advBox.appendChild(withDesc(mkSelect('每轮搜索次数上限', 'searchLimit',
      [['unlimited', 'unlimited：不限制'], ['2', '2：最多两次'], ['1', '1：最多一次']], 'unlimited', SEARCH_LIMIT_TITLE), SEARCH_LIMIT_DESC));
    // 工具调用方式：选项文本已自明（native：模型自己搜 / searchapi：只付搜索费），
    // 可见描述行给一句人话结论，完整差异（计费/能力）放 hover 提示
    var TOOLMODE_TITLE = DCP.t('模型要搜索时，谁来执行：native=交给 DeepSeek 的模型在对话里完成，能多轮搜、能读网页，但每轮搜索另付约 2 分钱模型费；searchapi=直接调 DeepSeek 的搜索接口，一次约 0.00075 美元、不经模型，搜什么由当前模型决定。两种在界面上看起来一样');
    var TOOLMODE_DESC = DCP.t('模型要搜索时谁来执行：native=DeepSeek 的模型自己搜，另付约 2 分钱/轮模型费；searchapi=直调搜索接口，每次约 0.00075 美元、不经模型');
    advBox.appendChild(withDesc(mkSelect('工具调用方式', 'toolMode',
      [['native', 'native：模型自己搜'], ['searchapi', 'searchapi：只付搜索费']], 'native', TOOLMODE_TITLE), TOOLMODE_DESC));
    // 起名来源：官方页的 title 通道第三方端点没有，用一条极小腿补。来源三选一
    // ——deepseek=官方端点起名腿（title 参数、约 $0.001/次、标题质量官方级）；
    // model=当前自定义模型按提示词起名（费用走当前端点、不经 DeepSeek）；
    // off=不起名（首条消息截断）。任一来源失败都退回首条消息截断
    var TITLE_SOURCE_TITLE = DCP.t('新对话首轮回答后生成会话标题的来源：deepseek=打 DeepSeek 官方端点用 title 参数起名（约 $0.001/次、标题质量官方级、用页面里那把 DeepSeek Key）；model=让当前自定义模型按提示词起名（一次极小非流式请求、费用走当前端点、不经 DeepSeek）；off=不起名，用首条消息截断。任一来源失败都退回首条消息截断');
    var TITLE_SOURCE_DESC = DCP.t('deepseek：官方起名腿，约 $0.001/次；model：自定义模型起名，费用走当前端点；off：用首条消息截断');
    advBox.appendChild(withDesc(mkSelect('起名来源', 'titleSource',
      [['deepseek', 'deepseek：官方起名腿'], ['model', 'model：自定义模型起名'], ['off', 'off：用首条消息截断']], 'deepseek', TITLE_SOURCE_TITLE), TITLE_SOURCE_DESC));
    advBox.appendChild(withDesc(mkRow('上下文窗口', 'ctxLimit', '128000',
      DCP.t('所用模型的上下文窗口（tokens）。可填 128000，也可写 128k / 1m。输入框旁的圆圈按 占用/窗口 显示百分比'), false, null, null),
      DCP.t('所用模型的上下文窗口（tokens）。可填 128000，也可写 128k / 1m。输入框旁的圆圈按 占用/窗口 显示百分比')));
    advBox.appendChild(mkSwitch('显示上下文占用环', 'showCtxRing',
      DCP.t('在输入工具条发送按钮一侧显示上下文占用环；关闭后仍会继续统计，只是不显示')));
    advBox.appendChild(mkSwitch('显示实时 TPS', 'showTps',
      DCP.t('在上下文占用环左侧显示实时输出速率（thinking + 正文 token/秒）；仅自定义模型桥接工作时生效')));
    advBox.appendChild(mkSwitch('跨标签同步会话', 'sessionSync',
      DCP.t('侧栏实时显示生成中的转圈和生成完毕的蓝点；后台标签开着同一条会话时，对方完成后自动同步正文。刷新页面只恢复一次当前会话。')));
    advBox.appendChild(withDesc(mkSelect('搜索来源', 'bridge',
      [['auto', 'auto：DeepSeek 原生搜索'], ['off', 'off：用模型自带的']], 'auto'),
      DCP.t('auto=换第三方模型时，搜索仍由 DeepSeek 原生执行、界面原样呈现（推荐）；off=完全使用第三方自己的能力（多数没有搜索）')));
    cfgBox.appendChild(advToggle);
    cfgBox.appendChild(advBox);

    var mkList = function (id, items) {
      if (document.getElementById(id)) return;
      var dl = document.createElement('datalist');
      dl.id = id;
      items.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m;
        dl.appendChild(o);
      });
      document.body.appendChild(dl);
    };
    mkList('dcp-model-hints', this.HINTS);

    // 配置块作为内容容器的直接子级（与原生行同列，天然对齐）
    content.appendChild(wrap);

    /* ---------- 自建「自定义模型」tab ---------- */
    // 导航按钮复制原生按钮的 className（构建哈希运行时复制，官方重建自动跟随）；
    // 激活态令牌 = 激活按钮与未激活按钮类名差集里的那一项
    var refNav = navBtns.filter(function (b) { return !/Active/.test(b.className); })[0] || navBtns[0];
    var activeItem = navBtns.filter(function (b) { return /Active/.test(b.className); })[0] || null;
    var activeToken = null;
    if (activeItem && activeItem !== refNav) {
      var at = activeItem.className.split(/\s+/), it = refNav.className.split(/\s+/);
      activeToken = at.filter(function (t) { return t && it.indexOf(t) === -1; })[0] || null;
    }
    var nav = document.createElement('button');
    nav.id = 'dcp-demo-tab';
    nav.type = 'button';
    nav.className = refNav.className;
    var navIco = document.createElement('span');
    navIco.style.cssText = 'display:inline-flex;flex:0 0 auto';
    navIco.innerHTML = this.ICON_TAB;
    nav.appendChild(navIco);
    nav.appendChild(document.createTextNode(DCP.t('自定义模型')));
    rail.appendChild(nav);

    var applyState = function (on) {
      if (activeToken) {
        nav.classList.toggle(activeToken, !!on);
        // 只夺不还：原生 tab 的激活态由 React 自己管，我们开机时从原生激活项
        // 手上摘掉令牌即可；点回原生 tab 时 React 会重新打上
        if (on && activeItem) activeItem.classList.remove(activeToken);
      }
      Array.prototype.forEach.call(content.children, function (c) {
        if (c === wrap) c.style.display = on ? '' : 'none';
        else c.style.display = on ? 'none' : '';
      });
    };
    // 我们的 tab 被点 → 藏原生行、显示配置块
    nav.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); applyState(true); });
    // 原生 tab 被点（capture 先行于 React 处理器）→ 回到原生显隐
    var onNativeClick = function (e) {
      if (e.target === nav || (nav.contains && nav.contains(e.target))) return;
      applyState(false);
    };
    rail.addEventListener('click', onNativeClick, true);
    // React 重换内容子级时（重渲染/切 tab），我们的 tab 开着就立刻重新藏原生行
    var mo = new MutationObserver(function () { if (ctl.on) applyState(true); });
    mo.observe(content, { childList: true });
    var ctl = { rail: rail, content: content, nav: nav, wrap: wrap, mo: mo, onNativeClick: onNativeClick, on: false,
      sync: function () { if (ctl.on) applyState(true); } };
    this._tabCtl = ctl;
    applyState(false);
  },

  // demo 页左上角的应用名是纯文字“API 使用 demo”，与 DeepSeek 官方标识不一致。
  // 官方主站的标识是内联 SVG（鲸鱼 + DeepSeek 字标，143×23）——fe-static 上没有
  // 对应静态文件、只存在于主站 bundle，故以资源文件随脚本分发、构建时内联。
  // SVG 的 fill 用 var(--dsw-alias-brand-primary)，该变量由标识元素自身携带
  // （#5686fe，官方主站同款），整套 markup 原样可用、无需替换颜色

  // 自建 tab 的图标：官方「深度思考」原子图标（viewBox 0 0 14 14，原样提取），
  // 渲染 16x16 与导航栏其他图标对齐
  ICON_TAB: '<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z" fill="currentColor"></path>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z" fill="currentColor"></path></svg>',
  OFFICIAL_LOGO: '__DCP_LOGO_SVG__',

  fixLogo: function () {
    if (location.hostname !== 'cdn.deepseek.com') return;
    if (document.querySelector('[data-dcp-logo]')) return;    // 已替换
    // 按文本找应用名元素——类名是 bundle 哈希会变，页面自己的文本稳定
    var el = null;
    Array.prototype.forEach.call(document.querySelectorAll('div,span,a'), function (n) {
      if (el || n.children.length) return;
      if ((n.textContent || '').trim() !== 'API 使用 demo') return;
      if (n.offsetParent === null) return;                    // 只要可见的那个
      el = n;
    });
    if (!el) return;
    el.textContent = '';
    var host = document.createElement('span');
    host.setAttribute('data-dcp-logo', '1');
    // 与官方一致：品牌色变量随标识自身携带；inline-flex + line-height:0 消除
    // 行内 SVG 的基线间隙
    host.style.cssText = '--dsw-alias-brand-primary:#5686fe;display:inline-flex;line-height:0;vertical-align:middle';
    host.innerHTML = this.OFFICIAL_LOGO;
    el.appendChild(host);
  },

  init: function () {
    var self = this;
    // 共存保护：若同页还装着 deepseek-enhance 且它开着自定义模型（demoCustom），
    // 那份补丁已经在管 fetch 了——两个脚本各打一层会互相绕开，表现为请求发两遍
    // 或干脆不生效。此时本脚本待机，把舞台让给它。
    // 判据用 antiRecall 模块：那是 deepseek-enhance 独有、本项目没有的模块，
    // 不会把自己误判成对方。deepseek-enhance 没开 demoCustom 时它在 demo 页完全
    // inert，本项目可放心接管。
    // 注意：这里查的是对方脚本的全局 window.DSE（deepseek-enhance），不是本项目的 DCP
    if (window.DSE && window.DSE.modules && window.DSE.modules.antiRecall &&
        window.DSE.config && window.DSE.config.get('demoCustom')) {
      console.log('[DCP] 检测到 deepseek-enhance 已接管自定义模型，本脚本待机（在它里面关掉 demoCustom 即可由本脚本接管）');
      return;
    }
    if (!this._fileConfigBound) {
      this._fileConfigBound = true;
      DCP.on('cfg:change', function (event) {
        if (!event) return;
        if (event.path === '*' || (event.path === 'demoCustom' && !event.value)) self.clearFileCache();
      });
    }
    if (!this._keyWarningBound) {
      this._keyWarningBound = true;
      DCP.on('cfg:warning', function (event) {
        if (!event || event.code !== 'KEY_NOT_PERSISTED' || self._keyWarningShown) return;
        self._keyWarningShown = true;
        Utils.toast(DCP.t('当前环境未检测到隔离存储，API Key 不会保存到页面存储，仅在当前页面会话内有效；刷新后需重新输入。'), 5000);
      });
    }
    this.patchFetch();
    this.fixFavicon();
    Utils.onReady(function () {
      self.injectUI();
      self.fixLogo();      // 应用名可能还没被 React 渲染出来——下面的 observer 会补
      // 弹窗是 React 组件，开合/切 tab 会重建 DOM——有弹窗时才补注入；
      // 应用名被重绘恢复成文字时也靠这里补。
      // 用节流（带前缘）而非防抖：防抖在弹窗打开时会因 React 连续变 DOM 而
      // 不断重置计时，注入要等变动停 300ms 才发生（实测开弹窗到 tab 出现
      // ~310ms，反复开尤其明显）；节流前缘让弹窗 DOM 一就绪就注入，尾部再补
      // 一次兜底。已注入时 injectUI 是几个 querySelector 的早退，代价可忽略
      new MutationObserver(Utils.throttle(function () {
        if (document.querySelector('[class*="dialogMain-"]')) self.injectUI();
        self.fixLogo();
      }, 100)).observe(document.body, { childList: true, subtree: true });
    });
  },

  // demo 页（cdn.deepseek.com/chat-demo）的 head 里没有任何 favicon 声明，
  // 所在主机也没有 /favicon.ico（实测 404），浏览器只能显示默认空白图标。
  // 官方主站声明的是 fe-static.deepseek.com/chat/favicon.svg（鲸鱼）——
  // 照搬同一份官方资源，不自己画图标
  fixFavicon: function () {
    if (location.hostname !== 'cdn.deepseek.com') return;
    if (document.querySelector('link[rel*="icon"]')) return;   // 页面自己有时不干预
    var link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/x-icon';
    link.href = 'https://fe-static.deepseek.com/chat/favicon.svg';
    (document.head || document.documentElement).appendChild(link);
  }
};
DCP.modules.demoApi = DemoApi;
