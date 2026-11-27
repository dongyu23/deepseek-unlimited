'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src/modules/demoapi.js'), 'utf8');

function makeEnv(configOverrides, options = {}) {
  const config = Object.assign({
    demoCustom: true,
    demoMultimodal: true
  }, configOverrides || {});
  const listeners = Object.create(null);
  const DCP = {
    config: {
      get(key) { return config[key]; },
      set(key, value) { config[key] = value; return { ok: true }; }
    },
    modules: {},
    t(key) { return key; },
    emit(name, payload) { (listeners[name] || []).forEach((fn) => fn(payload)); },
    on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); }
  };
  const Utils = {
    timeoutError(message) {
      const error = new Error(message || 'timeout');
      error.name = 'TimeoutError';
      return error;
    },
    withTimeout(promise, ms, message) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(Utils.timeoutError(message));
        }, ms);
        Promise.resolve(promise).then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });
    }
  };
  const context = vm.createContext({
    DCP,
    Utils,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    isFinite,
    FileReader: options.FileReader
  });
  vm.runInContext(source, context, { filename: 'src/modules/demoapi.js' });
  return { api: DCP.modules.demoApi, DCP, config, listeners };
}

function textFile(name, size, text, slicedText) {
  const sliceCalls = [];
  return {
    name,
    type: 'text/plain',
    size,
    sliceCalls,
    text() { return Promise.resolve(text == null ? 'full-text' : text); },
    slice(start, end) {
      sliceCalls.push([start, end]);
      return { text() { return Promise.resolve(slicedText == null ? 'slice-text' : slicedText); } };
    }
  };
}

async function capture(api, file, meta) {
  const req = {
    clone() {
      return { formData() { return Promise.resolve({ get() { return file; } }); } };
    }
  };
  const response = new Response(JSON.stringify(meta), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
  await api.captureFile(req, () => Promise.resolve(response), {});
  await new Promise((resolve) => setImmediate(resolve));
  return api._fileTexts[meta.id];
}

test('attachment records expose ready, size, last-used, truncation, and error state', async () => {
  const env = makeEnv();
  env.api.FILE_TEXT_MAX_BYTES = 4;
  const file = textFile('notes.txt', 10, 'unused', 'abcd');
  const rec = await capture(env.api, file, { id: 'file-1', filename: 'notes.txt', mime_type: 'text/plain', size_bytes: 10 });

  assert.ok(rec);
  assert.equal(rec.ready instanceof Promise, true);
  assert.equal(await rec.ready, rec);
  assert.equal(rec.id, 'file-1');
  assert.equal(rec.size, 10);
  assert.equal(typeof rec.lastUsed, 'number');
  assert.equal(rec.truncated, true);
  assert.equal(rec.error, null);
  assert.equal(rec.text, 'abcd');
  assert.deepEqual(file.sliceCalls, [[0, 4]]);
});

test('text read failures settle ready and retain a structured error', async () => {
  const env = makeEnv();
  const file = textFile('broken.txt', 5, 'unused');
  file.text = () => Promise.reject(new Error('disk failed'));
  const rec = await capture(env.api, file, { id: 'file-err', filename: 'broken.txt', mime_type: 'text/plain', size_bytes: 5 });

  assert.equal(await rec.ready, rec);
  assert.equal(rec.error, 'text_read_failed');
  assert.equal(rec.text, undefined);
});

test('image reads enforce the per-file cap before invoking FileReader', async () => {
  let readerCalls = 0;
  class Reader {
    readAsDataURL() { readerCalls++; }
  }
  const env = makeEnv({}, { FileReader: Reader });
  env.api.FILE_IMAGE_MAX_BYTES = 4;
  const file = { name: 'large.png', type: 'image/png', size: 10 };
  const rec = await capture(env.api, file, { id: 'img-large', filename: 'large.png', mime_type: 'image/png', size_bytes: 10 });

  assert.equal(await rec.ready, rec);
  assert.equal(readerCalls, 0);
  assert.equal(rec.error, 'image_too_large');
  assert.equal(rec.dataUrl, undefined);
});

test('image data URLs are cached only when multimodal mode needs them', async () => {
  let readerCalls = 0;
  class Reader {
    readAsDataURL() {
      readerCalls++;
      this.result = 'data:image/png;base64,AAAA';
      this.onload();
    }
  }
  const enabled = makeEnv({ demoMultimodal: true }, { FileReader: Reader });
  const file = { name: 'small.png', type: 'image/png', size: 4 };
  const rec = await capture(enabled.api, file, { id: 'img-ok', filename: 'small.png', mime_type: 'image/png', size_bytes: 4 });
  assert.equal(readerCalls, 1);
  assert.equal(rec.dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(rec.mediaType, 'image/png');

  const disabled = makeEnv({ demoMultimodal: false }, { FileReader: Reader });
  const skipped = await capture(disabled.api, file, { id: 'img-skip', filename: 'small.png', mime_type: 'image/png', size_bytes: 4 });
  assert.equal(readerCalls, 1);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.dataUrl, undefined);
});

test('official mode does not parse FormData or populate the attachment cache', async () => {
  const env = makeEnv({ demoCustom: false });
  let origCalls = 0;
  let cloneCalls = 0;
  const req = { clone() { cloneCalls++; throw new Error('must not clone'); } };
  const response = new Response('{}', { status: 200 });
  const result = await env.api.captureFile(req, () => {
    origCalls++;
    return Promise.resolve(response);
  }, {});
  assert.equal(result, response);
  assert.equal(origCalls, 1);
  assert.equal(cloneCalls, 0);
  assert.equal(Object.keys(env.api._fileTexts).length, 0);
});

test('LRU eviction honors entry limits and waitForFiles refreshes recency', async () => {
  const env = makeEnv();
  env.api.FILE_CACHE_MAX_ENTRIES = 2;
  env.api.FILE_CACHE_MAX_BYTES = 1024;
  const first = env.api._createFileRecord('f1', textFile('1.txt', 1, '1'), {});
  const second = env.api._createFileRecord('f2', textFile('2.txt', 1, '2'), {});
  await Promise.all([first.ready, second.ready]);
  await env.api.waitForFiles(['f2'], 100);
  const third = env.api._createFileRecord('f3', textFile('3.txt', 1, '3'), {});
  await third.ready;

  assert.equal(first.evicted, true);
  assert.equal(env.api._fileTexts.f1, undefined);
  assert.ok(env.api._fileTexts.f2);
  assert.ok(env.api._fileTexts.f3);
});

test('LRU eviction honors the total byte budget', async () => {
  const env = makeEnv();
  env.api.FILE_CACHE_MAX_ENTRIES = 10;
  env.api.FILE_CACHE_MAX_BYTES = 5;
  env.api.FILE_TEXT_MAX_BYTES = 100;
  const first = env.api._createFileRecord('b1', textFile('1.txt', 3, '111'), {});
  const second = env.api._createFileRecord('b2', textFile('2.txt', 3, '222'), {});
  await Promise.all([first.ready, second.ready]);

  assert.equal(first.evicted, true);
  assert.equal(env.api._fileTexts.b1, undefined);
  assert.ok(env.api._fileTexts.b2);
  assert.ok(env.api._fileBytes <= 5);
});

test('waitForFiles waits for upload metadata that appears shortly after the request', async () => {
  const env = makeEnv();
  const waiting = env.api.waitForFiles(['late-file'], 200);
  setTimeout(() => {
    env.api._createFileRecord('late-file', textFile('late.txt', 4, 'late-text'), {});
  }, 10);
  const result = await waiting;
  assert.equal(result['late-file'].text, 'late-text');
  assert.equal(result['late-file'].error, null);
});

test('waitForFiles deduplicates IDs, reports missing files, and times out pending reads', async () => {
  const env = makeEnv();
  let resolveText;
  const file = textFile('slow.txt', 4, 'unused');
  file.text = () => new Promise((resolve) => { resolveText = resolve; });
  const rec = env.api._createFileRecord('slow', file, {});

  const result = await env.api.waitForFiles(['slow', 'missing', 'slow'], 20);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(Object.keys(result).sort(), ['missing', 'slow']);
  assert.equal(result.slow, rec);
  assert.equal(result.slow.timedOut, true);
  assert.equal(result.slow.error, 'timeout');
  assert.equal(result.missing.error, 'not_found');
  assert.equal(result.missing.cached, false);

  resolveText('late-text');
  await rec.ready;
  assert.equal(rec.text, 'late-text');
  assert.equal(rec.error, null);
});
