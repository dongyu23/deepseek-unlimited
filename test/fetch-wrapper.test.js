'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const demoApiSource = fs.readFileSync(path.join(ROOT, 'src/modules/demoapi.js'), 'utf8');

function officialBody(overrides) {
  return JSON.stringify(Object.assign({
    model: 'deepseek-flash',
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: 'hello' }]
  }, overrides || {}));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeEnv(configOverrides, options = {}) {
  const config = Object.assign({
    demoCustom: true,
    demoEndpoint: 'https://third.invalid/v1',
    demoKey: 'third-secret',
    demoModel: 'custom-model',
    demoBridge: 'off',
    demoMultimodal: true,
    demoSessionSync: true
  }, configOverrides || {});
  const calls = [];
  const sync = {
    begins: 0,
    observes: 0,
    finishes: [],
    enabled() { return config.demoSessionSync !== false; },
    beginNativeRequest() { this.begins++; return { id: this.begins }; },
    observeNativeResponse(response) { this.observes++; return response; },
    finishNativeRequest(record, state) { this.finishes.push([record, state]); }
  };
  const DCP = {
    config: {
      get(key) { return config[key]; },
      set(key, value) { config[key] = value; return { ok: true, keyStored: key !== 'demoKey' }; }
    },
    modules: { sessionSync: sync },
    t(key) { return key; },
    emit() {},
    on() {}
  };
  const window = {
    fetch(input, init) {
      calls.push({ input, init, self: this });
      if (options.fetchImpl) return options.fetchImpl(input, init);
      return Promise.resolve(jsonResponse({ content: [{ type: 'text', text: 'ok' }], model: 'native-model' }));
    }
  };
  const Utils = {
    timeoutError(message) {
      const error = new Error(message || 'operation timed out');
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
    },
    isAbortError(error) { return !!error && (error.name === 'AbortError' || error.code === 20); },
    toast() {}
  };
  const context = vm.createContext({
    DCP,
    window,
    pageWindow() { return window; },
    Utils,
    Request,
    Headers,
    URL,
    Response,
    AbortController,
    FormData,
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(demoApiSource, context, { filename: 'src/modules/demoapi.js' });
  const api = DCP.modules.demoApi;
  api.patchFetch();
  return { api, DCP, config, calls, sync, window };
}

function fakeInput() {
  const listeners = Object.create(null);
  const attributes = Object.create(null);
  return {
    value: '',
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    dispatch(type) { (listeners[type] || []).slice().forEach((fn) => fn({ type, target: this })); },
    setAttribute(name, value) { attributes[name] = value; },
    getAttribute(name) { return attributes[name] == null ? null : attributes[name]; }
  };
}

test('fetch wrapper normalizes strings, uses Headers, and rewrites only validated official requests', async () => {
  const env = makeEnv();
  const originalHeaders = new Headers({
    'x-api-key': 'official-secret',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
  });
  await env.window.fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: originalHeaders,
    body: officialBody()
  });

  assert.equal(env.calls.length, 1);
  const request = env.calls[0].input;
  assert.equal(request instanceof Request, true);
  assert.equal(request.url, 'https://third.invalid/v1/messages');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('x-api-key'), 'third-secret');
  assert.equal(request.headers.get('authorization'), null);
  assert.equal(request.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(JSON.parse(await request.clone().text()).model, 'custom-model');
  assert.equal(originalHeaders.get('x-api-key'), 'official-secret');
});

test('fetch wrapper accepts the demo CDN origin without accepting foreign origins', async () => {
  const env = makeEnv();
  await env.window.fetch('https://cdn.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'x-api-key': 'official-secret', 'content-type': 'application/json' }),
    body: officialBody()
  });
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].input.url, 'https://third.invalid/v1/messages');
  assert.equal(env.calls[0].input.headers.get('x-api-key'), 'third-secret');
});

test('fetch wrapper accepts the demo request body without max_tokens', async () => {
  const env = makeEnv();
  const body = JSON.parse(officialBody());
  delete body.max_tokens;
  await env.window.fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'x-api-key': 'official-secret', 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  });
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].input.url, 'https://third.invalid/v1/messages');
});

test('foreign URLs containing the messages path are never rewritten or given the configured key', async () => {
  const env = makeEnv();
  await env.window.fetch(new URL('https://evil.example/anthropic/v1/messages'), {
    method: 'POST',
    headers: new Headers({ 'x-api-key': 'caller-key', 'content-type': 'application/json' }),
    body: officialBody()
  });

  assert.equal(env.calls.length, 1);
  const request = env.calls[0].input;
  assert.equal(request.url, 'https://evil.example/anthropic/v1/messages');
  assert.equal(request.headers.get('x-api-key'), 'caller-key');
  assert.equal(request.headers.get('x-api-key') === 'third-secret', false);
});

test('Request inputs preserve standard request properties and native session sync', async () => {
  const env = makeEnv({ demoCustom: false });
  const controller = new AbortController();
  const input = new Request('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'x-api-key': 'official-secret', 'content-type': 'application/json' }),
    body: officialBody(),
    credentials: 'include',
    redirect: 'manual',
    cache: 'no-store',
    signal: controller.signal
  });
  const response = await env.window.fetch(input);

  assert.equal(response.status, 200);
  assert.equal(env.calls.length, 1);
  const request = env.calls[0].input;
  assert.equal(request instanceof Request, true);
  assert.equal(request.url, input.url);
  assert.equal(request.credentials, 'include');
  assert.equal(request.redirect, 'manual');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.headers.get('x-api-key'), 'official-secret');
  assert.equal(await request.clone().text(), officialBody());
  assert.equal(env.sync.begins, 1);
  assert.equal(env.sync.observes, 1);
});

test('exact origin, path, method, and body validation fail closed to native behavior', async () => {
  const cases = [
    { url: 'https://api.deepseek.com/anthropic/v1/messages/extra', method: 'POST', body: officialBody() },
    { url: 'https://api.deepseek.com/anthropic/v1/messages', method: 'GET', body: null },
    { url: 'https://api.deepseek.com/anthropic/v1/messages', method: 'POST', body: JSON.stringify({ hello: 'world' }) }
  ];
  for (const item of cases) {
    const env = makeEnv();
    const init = { method: item.method, headers: new Headers({ 'x-api-key': 'caller-key' }) };
    if (item.body != null) init.body = item.body;
    await env.window.fetch(item.url, init);
    const request = env.calls[0].input;
    assert.equal(request.url, item.url);
    assert.equal(request.method, item.method);
    assert.equal(request.headers.get('x-api-key'), 'caller-key');
    if (item.body != null) assert.equal(await request.clone().text(), item.body);
  }
});

test('custom third-party endpoints without an independent key reject before fetch', async () => {
  const env = makeEnv({ demoKey: '' });
  await assert.rejects(
    env.window.fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: new Headers({ 'x-api-key': 'official-secret', 'content-type': 'application/json' }),
      body: officialBody()
    }),
    /第三方端点必须填写独立的 API Key/
  );
  assert.equal(env.calls.length, 0);
});

test('key input is blank initially, transient while focused, and cleared on blur', () => {
  const env = makeEnv({ demoKey: 'saved-secret' });
  const input = fakeInput();
  env.api.bindKeyInput(input);

  assert.equal(input.value, '');
  assert.equal(input.getAttribute('data-dcp-sensitive'), '1');
  input.dispatch('focus');
  assert.equal(input.value, 'saved-secret');
  input.value = 'new-secret';
  input.dispatch('input');
  input.dispatch('blur');
  assert.equal(env.config.demoKey, 'new-secret');
  assert.equal(input.value, '');
});

test('connection test has an in-flight guard and only issues one request', async () => {
  let resolveFetch;
  let calls = 0;
  const env = makeEnv({}, {
    fetchImpl() {
      calls++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    }
  });
  const options = {
    url: 'https://third.invalid/v1/messages',
    model: 'custom-model',
    key: 'third-secret',
    timeoutMs: 1000,
    fetchImpl: env.window.fetch
  };
  const first = env.api.runConnectionTest(options);
  const second = env.api.runConnectionTest(options);
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolveFetch(jsonResponse({ content: [{ type: 'text', text: 'ready' }], model: 'custom-model' }));
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'ready');
  assert.equal(env.api._testInFlight, null);
});

test('connection test timeout covers body parsing and clears the in-flight lock', async () => {
  let calls = 0;
  const env = makeEnv({}, {
    fetchImpl() {
      calls++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json() { return new Promise(() => {}); }
      });
    }
  });
  await assert.rejects(
    env.api.runConnectionTest({
      url: 'https://third.invalid/v1/messages',
      model: 'custom-model',
      key: 'third-secret',
      timeoutMs: 20,
      fetchImpl: env.window.fetch
    }),
    (error) => error && error.name === 'TimeoutError'
  );
  assert.equal(calls, 1);
  assert.equal(env.api._testInFlight, null);
});
