'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const encoder = new TextEncoder();

function sse(type, obj) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n';
}

function responseFrom(chunks, options = {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
        return;
      }
      if (options.error) controller.error(options.error);
      else controller.close();
    }
  });
  return new Response(body, {
    status: options.status || 200,
    headers: { 'Content-Type': options.contentType || 'text/event-stream' }
  });
}

function parseEvents(text) {
  return text.split('\n\n').map(function (frame) {
    const data = frame.split('\n').filter(function (line) { return line.startsWith('data: '); })
      .map(function (line) { return line.slice(6); }).join('\n');
    return data ? JSON.parse(data) : null;
  }).filter(Boolean);
}

function makeContext() {
  const events = [];
  const toasts = [];
  const config = {
    demoCustom: true,
    demoEndpoint: 'https://mock.invalid/v1',
    demoKey: 'test-key',
    demoModel: 'fixture-model',
    demoBridge: 'auto',
    demoTitleSource: 'off',
    demoToolMode: 'searchapi',
    demoSearchLimit: 'unlimited',
    demoMultimodal: false
  };
  const search = {
    beginRequest: function () {
      const ctx = {
        requestId: 'req_test', epoch: 0, sessionId: null,
        session: Promise.resolve(null)
      };
      return ctx;
    },
    isRequestCurrent: function () { return true; },
    refreshRequestSession: async function () { return null; },
    finishRequest: function () {},
    recoverBridgeRequest: async function () { return null; }
  };
  const DCP = {
    config: { get: function (key) { return config[key]; }, set: function (key, value) { config[key] = value; } },
    modules: {
      demoApi: {
        _origFetch: function () { throw new Error('fake fetch not installed'); },
        isOfficialEndpoint: function () { return false; }
      },
      demoSearch: search
    },
    emit: function (name, payload) { events.push({ name: name, payload: payload }); },
    on: function () {},
    t: function (text) { return text; }
  };
  const context = vm.createContext({
    DCP: DCP,
    console: { log: function () {}, warn: function () {}, error: function () {} },
    Utils: {
      estimateTokens: function (text) { return Math.ceil(String(text || '').length / 4); },
      toast: function (message) { toasts.push(message); },
      isDark: function () { return false; },
      debounce: function (fn) { return fn; },
      dict: function () { return Object.create(null); },
      own: function (obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); },
      setTextIfChanged: function (el, text) {
        if (!el) return false;
        text = String(text == null ? '' : text);
        if (el.textContent === text) return false;
        el.textContent = text;
        return true;
      },
      isAbortError: function (e) { return !!(e && (e.name === 'AbortError' || e.code === 20)); },
      timeoutError: function (message) { var e = new Error(message || 'operation timed out'); e.name = 'TimeoutError'; return e; },
      withTimeout: function (promise, ms, message) {
        return new Promise(function (resolve, reject) {
          var settled = false;
          var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            var timeout = new Error(message || 'operation timed out');
          timeout.name = 'TimeoutError';
          reject(timeout);
          }, ms);
          Promise.resolve(promise).then(function (v) {
            if (settled) return;
            settled = true; clearTimeout(timer); resolve(v);
          }, function (e) {
            if (settled) return;
            settled = true; clearTimeout(timer); reject(e);
          });
        });
      },
      cancelReader: function (reader) {
        if (!reader || typeof reader.cancel !== 'function') return Promise.resolve(false);
        try { return Promise.resolve(reader.cancel()).then(function () { return true; }, function () { return false; }); }
        catch (e) { return Promise.resolve(false); }
      },
      redact: function (value) { return String(value == null ? '' : value).slice(0, 500); }
    },
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    ReadableStream: ReadableStream,
    Response: Response,
    Request: Request,
    Headers: Headers,
    URL: URL,
    AbortController: AbortController,
    DOMException: DOMException,
    performance: performance,
    setInterval: setInterval,
    clearInterval: clearInterval,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  });
  return { context: context, DCP: DCP, events: events, toasts: toasts, config: config };
}

function load(context, file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
}

function requestBody() {
  return {
    model: 'fixture-model',
    messages: [{ role: 'user', content: '请继续输出一段文字' }]
  };
}

async function runBridge(fakeFetch, options = {}) {
  const env = makeContext();
  if (options.search) Object.assign(env.DCP.modules.demoSearch, options.search);
  env.DCP.modules.demoApi._origFetch = fakeFetch;
  load(env.context, 'src/modules/demobridge.js');
  const bridge = env.DCP.modules.demoBridge;
  bridge.SESSION_WAIT_MS = options.sessionWaitMs == null ? 1200 : options.sessionWaitMs;
  if (options.bridge) Object.assign(bridge, options.bridge);
  if (options.beforeIntercept) options.beforeIntercept(bridge, env);
  const init = {
    method: 'POST',
    headers: {},
    body: JSON.stringify(options.body || requestBody())
  };
  if (options.signal) init.signal = options.signal;
  const response = await env.DCP.modules.demoBridge.intercept('https://mock.invalid/v1/messages', init, '');
  if (options.reader) return { env: env, response: response, reader: response.body.getReader() };
  const text = await response.text();
  return { env: env, text: text, events: parseEvents(text), toasts: env.toasts };
}

async function readUntil(reader, predicate) {
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    text += decoder.decode(part.value, { stream: true });
    if (predicate(text)) break;
  }
  return text;
}

async function readRest(reader) {
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    text += decoder.decode(part.value, { stream: true });
  }
  return text;
}

function partialChunks() {
  return [
    sse('message_start', { type: 'message_start', message: { model: 'fixture-model', usage: { input_tokens: 3, output_tokens: 0 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已经输出的前半段' } })
  ];
}

function completeChunks(stopReason = 'end_turn') {
  return partialChunks().concat([
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 12 } }),
    sse('message_stop', { type: 'message_stop' })
  ]);
}

function activity(env, state) {
  return env.events.some(function (e) { return e.name === 'session:activity' && e.payload.state === state; });
}

test('partial text followed by clean EOF becomes max_tokens, not end_turn', async function () {
  const result = await runBridge(function () { return Promise.resolve(responseFrom(partialChunks())); });
  assert.deepEqual(result.events.map(function (e) { return e.type; }), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop'
  ]);
  assert.equal(result.events[4].delta.stop_reason, 'max_tokens');
  assert.equal(activity(result.env, 'error'), true);
  assert.equal(activity(result.env, 'done'), false);
  assert.deepEqual(result.toasts, ['连接中断，已保留生成内容，可点击继续生成']);
});

test('truncated JSON after partial text becomes max_tokens', async function () {
  const chunks = partialChunks().concat(['event: message_delta\ndata: {"type":"message_delta","delta":']);
  const result = await runBridge(function () { return Promise.resolve(responseFrom(chunks)); });
  assert.equal(result.events.at(-2).delta.stop_reason, 'max_tokens');
  assert.equal(result.events.at(-1).type, 'message_stop');
});

test('explicit SSE error after partial text becomes max_tokens', async function () {
  const chunks = partialChunks().concat([
    sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'upstream disconnected' } })
  ]);
  const result = await runBridge(function () { return Promise.resolve(responseFrom(chunks)); });
  assert.equal(result.events.at(-2).delta.stop_reason, 'max_tokens');
  assert.equal(result.events.some(function (e) { return e.type === 'error'; }), false);
});

test('network read rejection after partial text becomes max_tokens', async function () {
  const result = await runBridge(function () {
    return Promise.resolve(responseFrom(partialChunks(), { error: new TypeError('socket reset') }));
  });
  assert.equal(result.events.at(-2).delta.stop_reason, 'max_tokens');
  assert.equal(result.events.at(-1).type, 'message_stop');
});

test('HTTP failure before visible content remains an error event', async function () {
  const result = await runBridge(function () {
    return Promise.resolve(responseFrom(['{"error":{"message":"rate limited"}}'], {
      status: 429,
      contentType: 'application/json'
    }));
  });
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, 'message_start');
  assert.equal(result.events[1].type, 'error');
  assert.match(result.events[1].error.message, /429/);
  assert.equal(activity(result.env, 'error'), true);
  assert.deepEqual(result.toasts, []);
});

test('user abort stays stopped and does not synthesize max_tokens', async function () {
  const controller = new AbortController();
  const result = await runBridge(function (url, init) {
    const body = new ReadableStream({
      start(c) {
        init.signal.addEventListener('abort', function () {
          c.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    });
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, { signal: controller.signal, reader: true });
  const decoder = new TextDecoder();
  const first = await result.reader.read();
  assert.match(decoder.decode(first.value), /message_start/);
  controller.abort();
  let rest = '';
  while (true) {
    const part = await result.reader.read();
    if (part.done) break;
    rest += decoder.decode(part.value, { stream: true });
  }
  assert.doesNotMatch(rest, /max_tokens|message_stop/);
  assert.equal(activity(result.env, 'stopped'), true);
  assert.deepEqual(result.env.toasts, []);
});

test('message_start and generating are emitted before session resolution', async function () {
  let resolveSession;
  const session = new Promise(function (resolve) { resolveSession = resolve; });
  const result = await runBridge(function () {
    return Promise.resolve(responseFrom(completeChunks()));
  }, {
    sessionWaitMs: 1000,
    reader: true,
    search: {
      beginRequest: function () {
        return { requestId: 'req_deferred', epoch: 0, sessionId: null, session: session };
      }
    }
  });
  const first = await readUntil(result.reader, function (text) { return text.includes('message_start'); });
  assert.match(first, /message_start/);
  assert.equal(result.env.events.some(function (e) {
    return e.name === 'session:activity' && e.payload.state === 'generating' && e.payload.sessionId === null;
  }), true);
  resolveSession({ id: 's1' });
  const rest = await readRest(result.reader);
  assert.match(rest, /message_stop/);
  assert.equal(result.env.events.some(function (e) {
    return e.name === 'session:activity' && e.payload.state === 'generating' && e.payload.sessionId === 's1';
  }), true);
});

test('session preflight timeout does not block the upstream request', async function () {
  let fetchCalled = false;
  const result = await runBridge(function () {
    fetchCalled = true;
    return Promise.resolve(responseFrom(completeChunks()));
  }, {
    sessionWaitMs: 20,
    search: {
      beginRequest: function () {
        return { requestId: 'req_timeout', epoch: 0, sessionId: null, session: new Promise(function () {}) };
      }
    }
  });
  assert.equal(fetchCalled, true);
  assert.equal(result.events.at(-1).type, 'message_stop');
});

test('abort during session preflight prevents the upstream fetch', async function () {
  const controller = new AbortController();
  let fetchCalled = false;
  const result = await runBridge(function () {
    fetchCalled = true;
    return Promise.resolve(responseFrom(completeChunks()));
  }, {
    signal: controller.signal,
    sessionWaitMs: 1000,
    reader: true,
    search: {
      beginRequest: function () {
        return { requestId: 'req_preflight_abort', epoch: 0, sessionId: null, session: new Promise(function () {}) };
      }
    }
  });
  await readUntil(result.reader, function (text) { return text.includes('message_start'); });
  controller.abort();
  await readRest(result.reader);
  assert.equal(fetchCalled, false);
  assert.equal(activity(result.env, 'stopped'), true);
});

test('stale abort from conversation switch keeps the upstream stream alive', async function () {
  const controller = new AbortController();
  let current = true;
  let upstreamSignal = null;
  let upstreamController = null;
  let notifyFetch;
  const fetchStarted = new Promise(function (resolve) { notifyFetch = resolve; });
  const firstChunk = partialChunks().join('');
  const restChunks = completeChunks().slice(partialChunks().length).join('');
  const result = await runBridge(function (url, init) {
    upstreamSignal = init.signal;
    const body = new ReadableStream({
      start: function (c) {
        upstreamController = c;
        c.enqueue(encoder.encode(firstChunk));
      }
    });
    notifyFetch();
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, {
    signal: controller.signal,
    reader: true,
    search: {
      beginRequest: function () {
        return { requestId: 'req_switch', epoch: 0, sessionId: 's1', session: Promise.resolve({ id: 's1' }) };
      },
      isRequestCurrent: function () { return current; }
    }
  });
  await readUntil(result.reader, function (text) { return text.includes('已经输出的前半段'); });
  await fetchStarted;
  current = false;
  const done = new Promise(function (resolve) {
    const original = result.env.DCP.emit;
    result.env.DCP.emit = function (name, payload) {
      original(name, payload);
      if (name === 'session:activity' && payload && payload.state === 'done') resolve();
    };
  });
  controller.abort();
  assert.equal(upstreamSignal.aborted, false);
  upstreamController.enqueue(encoder.encode(restChunks));
  upstreamController.close();
  await done;
  assert.equal(activity(result.env, 'done'), true);
  assert.equal(result.env.events.some(function (e) {
    return e.name === 'session:activity' && e.payload.state === 'done' && e.payload.sessionId === 's1';
  }), true);
  assert.deepEqual(result.env.toasts, []);
});

test('stale reader cancellation detaches without aborting upstream', async function () {
  let current = true;
  let upstreamSignal = null;
  let upstreamController = null;
  let notifyFetch;
  const fetchStarted = new Promise(function (resolve) { notifyFetch = resolve; });
  const result = await runBridge(function (url, init) {
    upstreamSignal = init.signal;
    const body = new ReadableStream({
      start: function (c) {
        upstreamController = c;
        c.enqueue(encoder.encode(partialChunks().join('')));
      }
    });
    notifyFetch();
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, {
    reader: true,
    search: {
      beginRequest: function () {
        return { requestId: 'req_cancel', epoch: 0, sessionId: 's1', session: Promise.resolve({ id: 's1' }) };
      },
      isRequestCurrent: function () { return current; }
    }
  });
  await readUntil(result.reader, function (text) { return text.includes('已经输出的前半段'); });
  await fetchStarted;
  const done = new Promise(function (resolve) {
    const original = result.env.DCP.emit;
    result.env.DCP.emit = function (name, payload) {
      original(name, payload);
      if (name === 'session:activity' && payload && payload.state === 'done') resolve();
    };
  });
  current = false;
  await result.reader.cancel();
  assert.equal(upstreamSignal.aborted, false);
  upstreamController.enqueue(encoder.encode(completeChunks().slice(partialChunks().length).join('')));
  upstreamController.close();
  await done;
  assert.equal(activity(result.env, 'done'), true);
});

test('stale request without abort persists parsed blocks in the background', async function () {
  let current = true;
  let upstreamController = null;
  let notifyFetch;
  const fetchStarted = new Promise(function (resolve) { notifyFetch = resolve; });
  const persisted = [];
  const result = await runBridge(function (url, init) {
    const body = new ReadableStream({
      start: function (c) {
        upstreamController = c;
        c.enqueue(encoder.encode(partialChunks().join('')));
      }
    });
    notifyFetch();
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, {
    reader: true,
    search: {
      beginRequest: function () {
        return { requestId: 'req_bg_persist', epoch: 0, sessionId: 's1', session: Promise.resolve({ id: 's1' }) };
      },
      isRequestCurrent: function () { return current; },
      persistBridgeState: async function (sid, state) { persisted.push({ sid: sid, state: state }); return true; }
    }
  });
  await readUntil(result.reader, function (text) { return text.includes('已经输出的前半段'); });
  await fetchStarted;
  const done = new Promise(function (resolve) {
    const original = result.env.DCP.emit;
    result.env.DCP.emit = function (name, payload) {
      original(name, payload);
      if (name === 'session:activity' && payload && payload.state === 'done') resolve();
    };
  });
  current = false;
  upstreamController.enqueue(encoder.encode(completeChunks().slice(partialChunks().length).join('')));
  upstreamController.close();
  await done;
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  assert.equal(persisted.length > 0, true);
  const last = persisted[persisted.length - 1];
  assert.equal(last.sid, 's1');
  assert.equal(last.state.status, 'done');
  assert.equal(last.state.blocks[0].text, '已经输出的前半段');
});

test('normal end_turn stream is unchanged', async function () {
  const result = await runBridge(function () { return Promise.resolve(responseFrom(completeChunks('end_turn'))); });
  assert.equal(result.events.at(-2).delta.stop_reason, 'end_turn');
  assert.equal(result.events.at(-1).type, 'message_stop');
  assert.equal(activity(result.env, 'done'), true);
  assert.deepEqual(result.toasts, []);
});

test('natural max_tokens stream is preserved', async function () {
  const result = await runBridge(function () { return Promise.resolve(responseFrom(completeChunks('max_tokens'))); });
  assert.equal(result.events.at(-2).delta.stop_reason, 'max_tokens');
  assert.equal(result.events.at(-1).type, 'message_stop');
  assert.equal(activity(result.env, 'done'), true);
});

test('[DONE] after message_delta is accepted as a terminal marker', async function () {
  const chunks = completeChunks('end_turn').slice(0, -1).concat(['data: [DONE]\n\n']);
  const result = await runBridge(function () { return Promise.resolve(responseFrom(chunks)); });
  assert.equal(result.events.at(-2).delta.stop_reason, 'end_turn');
  assert.equal(result.events.at(-1).type, 'message_stop');
});

test('recovery accepts done + max_tokens text-only continuation', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const session = {
    id: 's1', rootMessageId: 'u1', messages: [
      { id: 'u1', parentId: null, role: 'user', content: '问题', selectedChildId: 'a1' },
      { id: 'a1', parentId: 'u1', role: 'assistant', status: 'done', stopReason: 'max_tokens', selectedChildId: null,
        blocks: [{ type: 'thinking', thinking: '想' }, { type: 'text', text: '前半段' }] }
    ]
  };
  const recovered = await search.recoverBridgeRequest([
    { role: 'user', content: '问题' },
    { role: 'assistant', content: [{ type: 'text', text: '前半段' }] }
  ], session);
  assert.equal(recovered.mode, 'continue');
  assert.equal(recovered.messages.at(-1).role, 'assistant');
  assert.equal(recovered.messages.at(-1).content.at(-1).text, '前半段');
});

test('recovery rejects a normally completed end_turn answer', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const session = {
    id: 's1', rootMessageId: 'u1', messages: [
      { id: 'u1', parentId: null, role: 'user', content: '问题', selectedChildId: 'a1' },
      { id: 'a1', parentId: 'u1', role: 'assistant', status: 'done', stopReason: 'end_turn', selectedChildId: null,
        blocks: [{ type: 'text', text: '完整回答' }] }
    ]
  };
  const recovered = await search.recoverBridgeRequest([
    { role: 'user', content: '问题' },
    { role: 'assistant', content: [{ type: 'text', text: '完整回答' }] }
  ], session);
  assert.equal(recovered, null);
});

test('tool history recovery keeps ids paired and closes dangling calls', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const blocks = [
    { type: 'text', text: '前半段' },
    { type: 'server_tool_use', id: 'srv1', name: 'deepseek_web_search', bridge_tool_id: 'tool1', bridge_tool_input: { query: '测试' }, input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [{ type: 'web_search_result', title: '结果' }] },
    { type: 'server_tool_use', id: 'srv2', name: 'deepseek_read_url', bridge_tool_id: 'tool2', bridge_tool_input: { url: 'https://example.com' }, input: {} }
  ];
  const rebuilt = search.rebuildBridgeMessages(blocks);
  const uses = rebuilt.flatMap(function (m) { return Array.isArray(m.content) ? m.content : []; })
    .filter(function (b) { return b.type === 'tool_use'; });
  const results = rebuilt.flatMap(function (m) { return Array.isArray(m.content) ? m.content : []; })
    .filter(function (b) { return b.type === 'tool_result'; });
  assert.deepEqual(Array.from(uses.map(function (b) { return b.id; }).sort()), ['tool1', 'tool2']);
  assert.deepEqual(Array.from(results.map(function (b) { return b.tool_use_id; }).sort()), ['tool1', 'tool2']);
  assert.match(results.find(function (b) { return b.tool_use_id === 'tool2'; }).content, /中断/);
});

test('findSessionByRequestMessages resolves a newly persisted origin session', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const now = Date.now();
  search.readSessions = async function () {
    return [
      { id: 'old', createdAt: now - 60000, messages: [{ role: 'user', content: '旧问题' }] },
      { id: 'new', createdAt: now, messages: [{ role: 'user', content: '原会话问题' }] }
    ];
  };
  const found = await search.findSessionByRequestMessages([{ role: 'user', content: '原会话问题' }], now);
  assert.equal(found && found.id, 'new');
});

test('applyBridgeState updates the active assistant for background persistence', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const session = {
    id: 's1', rootMessageId: 'u1', updatedAt: 1, messages: [
      { id: 'u1', parentId: null, role: 'user', content: '问题', selectedChildId: 'a1' },
      { id: 'a1', parentId: 'u1', role: 'assistant', status: 'pending', blocks: [], selectedChildId: null }
    ]
  };
  const blocks = [{ type: 'text', text: '后台完成', citations: [] }];
  assert.equal(search.applyBridgeState(session, {
    assistantMessageId: 'a1',
    blocks: blocks, status: 'done', stopReason: 'end_turn', usage: { output_tokens: 8 }, revision: 3
  }), true);
  assert.equal(session.messages[1].status, 'done');
  assert.equal(session.messages[1].stopReason, 'end_turn');
  assert.equal(session.messages[1].blocks[0].text, '后台完成');
  assert.equal(session.messages[1].usage.output_tokens, 8);
  assert.equal(session.messages[1].__dcpBridgeRevision, 3);
  assert.equal(session.updatedAt > 1, true);
});

test('applyBridgeState never falls back to the last assistant and rejects stale revisions', function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const session = {
    id: 's1', messages: [
      { id: 'u1', parentId: null, role: 'user', content: '问题', selectedChildId: 'a1' },
      { id: 'a1', parentId: 'u1', role: 'assistant', status: 'done', blocks: [{ type: 'text', text: '旧回答' }], selectedChildId: null }
    ]
  };
  assert.equal(search.applyBridgeState(session, {
    blocks: [{ type: 'text', text: '不能写到这里' }], status: 'done', revision: 1
  }), false);
  assert.equal(session.messages[1].blocks[0].text, '旧回答');
  assert.equal(search.applyBridgeState(session, {
    assistantMessageId: 'a1', blocks: [{ type: 'text', text: '新回答' }], status: 'done', revision: 5
  }), true);
  assert.equal(search.applyBridgeState(session, {
    assistantMessageId: 'a1', blocks: [{ type: 'text', text: '迟到旧写入' }], status: 'pending', revision: 4
  }), false);
  assert.equal(session.messages[1].blocks[0].text, '新回答');
  assert.equal(session.messages[1].__dcpBridgeRevision, 5);
});

test('custom continue is offered only for recoverable search-block answers', function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  load(env.context, 'src/modules/continuegen.js');
  const module = env.DCP.modules.continueGen;
  const tool = { type: 'server_tool_use', id: 'srv1', name: 'deepseek_web_search' };
  assert.equal(module.shouldOffer({ role: 'assistant', status: 'stopped', blocks: [tool, { type: 'text', text: '正文' }] }), true);
  assert.equal(module.shouldOffer({ role: 'assistant', status: 'done', stopReason: 'max_tokens', blocks: [tool, { type: 'text', text: '正文' }] }), true);
  assert.equal(module.shouldOffer({ role: 'assistant', status: 'done', stopReason: 'max_tokens', blocks: [{ type: 'text', text: '正文' }] }), false);
  assert.equal(module.shouldOffer({ role: 'assistant', status: 'done', stopReason: 'end_turn', blocks: [tool, { type: 'text', text: '正文' }] }), false);
  assert.equal(module.shouldOffer({ role: 'assistant', status: 'stopped', blocks: [tool] }), false);
});

test('native fetch rejection clears the session generating state', async function () {
  const env = makeContext();
  const calls = [];
  const win = { fetch: function () { return Promise.reject(new TypeError('network down')); } };
  env.context.window = win;
  env.context.pageWindow = function () { return win; };
  env.DCP.modules.sessionSync = {
    enabled: function () { return true; },
    beginNativeRequest: function () { return { requestId: 'native1' }; },
    observeNativeResponse: function (resp) { return resp; },
    finishNativeRequest: function (rec, state) { calls.push({ id: rec.requestId, state: state }); }
  };
  load(env.context, 'src/modules/demoapi.js');
  env.DCP.modules.demoApi.patchFetch();
  await assert.rejects(win.fetch('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] })
  }), /network down/);
  assert.deepEqual(calls, [{ id: 'native1', state: 'error' }]);
});

function makeSession(id, users) {
  const messages = [];
  users.forEach(function (user, index) {
    const uid = id + '_u' + index;
    const aid = id + '_a' + index;
    const u = {
      id: uid,
      parentId: index ? id + '_a' + (index - 1) : null,
      role: 'user',
      content: user.content,
      selectedChildId: aid
    };
    if (user.files) u.files = user.files;
    messages.push(u);
    messages.push({
      id: aid,
      parentId: uid,
      role: 'assistant',
      status: 'done',
      stopReason: 'end_turn',
      blocks: [{ type: 'text', text: user.answer || ('answer-' + index) }],
      selectedChildId: null
    });
  });
  return { id: id, title: id, messages: messages };
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test('beginRequest carries bridge identity, revision, and a serialized persistence queue', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  search.currentSession = async function () { return null; };
  const ctx = search.beginRequest();
  assert.equal(typeof ctx.requestId, 'string');
  assert.equal(ctx.bridgeMessageId, null);
  assert.equal(ctx.assistantMessageId, null);
  assert.equal(ctx.persistRevision, 0);
  assert.equal(typeof ctx.persistQueue.then, 'function');
  await ctx.session;
});

test('captureBridgeAssistantId supports preexisting, delayed, and exact-id placeholders without last-assistant fallback', function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;

  const preexisting = makeSession('pre', [{ content: 'question' }]);
  preexisting.messages[1].status = 'pending';
  preexisting.messages[1].blocks = [];
  const ctx1 = { bridgeMessageId: 'msg_bridge_1', assistantMessageId: null };
  assert.equal(search.captureBridgeAssistantId(ctx1, preexisting, [{ role: 'user', content: 'question' }]), 'pre_a0');
  assert.equal(ctx1.assistantMessageId, 'pre_a0');

  const delayed = makeSession('late', [{ content: 'question' }]);
  delayed.messages[1].status = 'done';
  const ctx2 = { bridgeMessageId: 'msg_bridge_2', assistantMessageId: null };
  assert.equal(search.captureBridgeAssistantId(ctx2, delayed, [{ role: 'user', content: 'question' }]), null);
  delayed.messages[1].status = 'streaming';
  delayed.messages[1].blocks = [];
  assert.equal(search.captureBridgeAssistantId(ctx2, delayed, [{ role: 'user', content: 'question' }]), 'late_a0');

  const exact = makeSession('exact', [{ content: 'question' }]);
  exact.messages[1].id = 'msg_bridge_exact';
  const ctx3 = { bridgeMessageId: 'msg_bridge_exact', assistantMessageId: null };
  assert.equal(search.captureBridgeAssistantId(ctx3, exact, [{ role: 'user', content: 'question' }]), 'msg_bridge_exact');

  const completed = makeSession('done', [{ content: 'question' }]);
  const ctx4 = { bridgeMessageId: 'msg_bridge_missing', assistantMessageId: null };
  assert.equal(search.captureBridgeAssistantId(ctx4, completed, [{ role: 'user', content: 'question' }]), null);
});

test('findSessionByRequestMessages requires a unique full prefix and attachment match', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const sessions = [
    makeSession('one', [{ content: 'first' }, { content: 'second' }]),
    makeSession('two', [{ content: 'first' }, { content: 'second' }])
  ];
  search.readSessions = async function () { return sessions; };
  const prefix = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer-0' }] },
    { role: 'user', content: 'second' }
  ];
  assert.equal(await search.findSessionByRequestMessages(prefix, Date.now()), null);
  assert.equal(await search.findSessionByRequestMessages([{ role: 'user', content: 'second' }], Date.now()), null);

  const attached = makeSession('attached', [{
    content: [
      { type: 'document', source: { type: 'file', file_id: 'file-1' } },
      { type: 'text', text: 'read this' }
    ],
    files: [{ serverId: 'file-1', name: 'a.txt', mimeType: 'text/plain' }]
  }]);
  search.readSessions = async function () { return [attached]; };
  const attachedRequest = [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'file', file_id: 'file-1' } },
      { type: 'text', text: 'read this' }
    ]
  }];
  assert.equal((await search.findSessionByRequestMessages(attachedRequest, Date.now())).id, 'attached');
  attachedRequest[0].content[0].source.file_id = 'other-file';
  assert.equal(await search.findSessionByRequestMessages(attachedRequest, Date.now()), null);
});

test('persistBridgeState serializes writes and freezes queued snapshots', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  let active = 0;
  let maxActive = 0;
  const calls = [];
  search._persistBridgeStateOnce = function (sessionId, state) {
    active++;
    maxActive = Math.max(maxActive, active);
    calls.push({ sessionId: sessionId, state: JSON.parse(JSON.stringify(state)) });
    return delay(10).then(function () { active--; return true; });
  };
  const ctx = { persistQueue: Promise.resolve() };
  const state = { assistantMessageId: 'a1', revision: 1, blocks: [{ type: 'text', text: 'original' }] };
  const first = search.persistBridgeState('s1', state, ctx);
  state.blocks[0].text = 'mutated';
  const second = search.persistBridgeState('s1', { assistantMessageId: 'a1', revision: 2, blocks: [{ type: 'text', text: 'second' }] }, ctx);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(maxActive, 1);
  assert.equal(calls[0].state.blocks[0].text, 'original');
  assert.equal(calls[1].state.revision, 2);
});

test('IndexedDB reads and writes have hard deadlines when requests never settle', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  search.IDB_TIMEOUT_MS = 10;
  env.context.indexedDB = { open: function () { return {}; } };
  const started = Date.now();
  assert.equal((await search.readSessions()).length, 0);
  assert.equal(await search.readSession('s1'), null);
  assert.equal(await search.persistBridgeState('s1', { assistantMessageId: 'a1', revision: 1 }), false);
  assert.equal(Date.now() - started < 500, true);
});

test('session refresh returns null instead of hanging on currentSession', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  search.SESSION_REFRESH_TIMEOUT_MS = 10;
  search.currentSession = function () { return new Promise(function () {}); };
  search._requests.r1 = { requestId: 'r1', epoch: search._sessionEpoch, sessionId: null };
  assert.equal(await search.refreshRequestSession(search._requests.r1), null);
});

function toolUseChunks() {
  return [
    sse('message_start', { type: 'message_start', message: { model: 'fixture-model', usage: { input_tokens: 3, output_tokens: 0 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'web_search', input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"test"}' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
    sse('message_stop', { type: 'message_stop' })
  ];
}

test('pump cancels an unfinished reader after a terminal event', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demobridge.js');
  let cancelled = false;
  const reader = {
    read: function () {
      return Promise.resolve({ done: false, value: encoder.encode(sse('message_stop', { type: 'message_stop' })) });
    },
    cancel: function () { cancelled = true; return Promise.resolve(); },
    releaseLock: function () {}
  };
  await env.DCP.modules.demoBridge.pump({ getReader: function () { return reader; } }, function () {});
  assert.equal(cancelled, true);
});

test('pump idle deadline cancels a hanging reader', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demobridge.js');
  const bridge = env.DCP.modules.demoBridge;
  bridge.PUMP_IDLE_TIMEOUT_MS = 10;
  let cancelled = false;
  const reader = {
    read: function () { return new Promise(function () {}); },
    cancel: function () { cancelled = true; return Promise.resolve(); },
    releaseLock: function () {}
  };
  await assert.rejects(
    bridge.pump({ getReader: function () { return reader; } }, function () {}),
    function (e) { return e.name === 'TimeoutError'; }
  );
  assert.equal(cancelled, true);
});

test('main header deadline aborts a hanging fetch and emits an error terminal event', async function () {
  let fetchSignal = null;
  const result = await runBridge(function (url, init) {
    fetchSignal = init.signal;
    return new Promise(function () {});
  }, { bridge: { MAIN_HEADERS_TIMEOUT_MS: 10 } });
  assert.equal(result.events.at(-1).type, 'error');
  assert.equal(activity(result.env, 'error'), true);
  assert.equal(fetchSignal.aborted, true);
});

test('main stream idle deadline terminates a hanging response and cancels its body', async function () {
  let cancelled = false;
  const result = await runBridge(function () {
    const body = new ReadableStream({
      pull: function () { return new Promise(function () {}); },
      cancel: function () { cancelled = true; }
    });
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, { bridge: { PUMP_IDLE_TIMEOUT_MS: 10 } });
  assert.equal(result.events.at(-1).type, 'error');
  assert.equal(cancelled, true);
});

test('search API timeout covers a hanging json body and aborts the request', async function () {
  const env = makeContext();
  let searchSignal = null;
  env.DCP.modules.demoApi._origFetch = function (url, init) {
    searchSignal = init.signal;
    return Promise.resolve({ ok: true, json: function () { return new Promise(function () {}); } });
  };
  load(env.context, 'src/modules/demobridge.js');
  const bridge = env.DCP.modules.demoBridge;
  bridge.SEARCH_API_TIMEOUT_MS = 10;
  await assert.rejects(
    bridge.runLegSearchApi('web_search', { query: 'test' }, 'key', function () {}, function () { return 0; }, null, 'tool-1', 0),
    function (e) { return e.name === 'TimeoutError'; }
  );
  assert.equal(searchSignal.aborted, true);
});

test('tool-leg user AbortError is rethrown immediately', async function () {
  const env = makeContext();
  env.DCP.modules.demoApi._origFetch = function (url, init) {
    return new Promise(function (resolve, reject) {
      init.signal.addEventListener('abort', function () {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  };
  load(env.context, 'src/modules/demobridge.js');
  const controller = new AbortController();
  const pending = env.DCP.modules.demoBridge.runLegSearchApi(
    'web_search', { query: 'test' }, 'key', function () {}, function () { return 0; }, controller.signal, 'tool-1', 0
  );
  controller.abort();
  await assert.rejects(pending, function (e) { return e.name === 'AbortError'; });
});

test('genuine tool-leg errors become search_unavailable and the tool loop continues', async function () {
  let mainCalls = 0;
  const result = await runBridge(function (url) {
    if (url.indexOf('api.deepseek.com/v1/tools/search') !== -1) {
      return Promise.resolve({ ok: false, status: 500, text: function () { return Promise.resolve('boom'); } });
    }
    mainCalls++;
    return Promise.resolve(responseFrom(mainCalls === 1 ? toolUseChunks() : completeChunks()));
  });
  assert.match(result.text, /search_unavailable/);
  assert.equal(result.events.at(-1).type, 'message_stop');
  assert.equal(activity(result.env, 'done'), true);
});

test('user abort during a tool leg never synthesizes search_unavailable', async function () {
  const controller = new AbortController();
  let mainCalls = 0;
  const result = await runBridge(function (url, init) {
    if (url.indexOf('api.deepseek.com/v1/tools/search') !== -1) {
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener('abort', function () {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
    mainCalls++;
    return Promise.resolve(responseFrom(toolUseChunks()));
  }, { signal: controller.signal, reader: true });
  await readUntil(result.reader, function (text) { return text.includes('"type":"tool_use"'); });
  controller.abort();
  const rest = await readRest(result.reader);
  assert.doesNotMatch(rest, /search_unavailable/);
  assert.equal(activity(result.env, 'stopped'), true);
  assert.equal(mainCalls, 1);
});

test('native observer idle deadline cancels its clone reader', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/sessionsync.js');
  const sync = env.DCP.modules.sessionSync;
  sync.NATIVE_IDLE_TIMEOUT_MS = 10;
  sync.NATIVE_OBSERVER_TIMEOUT_MS = 1000;
  const states = [];
  sync.finishNativeRequest = function (rec, state) { states.push(state); };
  let cancelled = false;
  const reader = {
    read: function () { return new Promise(function () {}); },
    cancel: function () { cancelled = true; return Promise.resolve(); },
    releaseLock: function () {}
  };
  const resp = {
    ok: true,
    body: { getReader: function () { return reader; } },
    clone: function () { return { body: { getReader: function () { return reader; } } }; }
  };
  sync.observeNativeResponse(resp, { requestId: 'native-1' });
  await delay(40);
  assert.deepEqual(states, ['stopped']);
  assert.equal(cancelled, true);
});

test('native observer cancels its clone reader on message_stop', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/sessionsync.js');
  const sync = env.DCP.modules.sessionSync;
  sync.NATIVE_IDLE_TIMEOUT_MS = 1000;
  sync.NATIVE_OBSERVER_TIMEOUT_MS = 2000;
  const states = [];
  sync.finishNativeRequest = function (rec, state) { states.push(state); };
  let cancelled = false;
  let reads = 0;
  const reader = {
    read: function () {
      reads++;
      if (reads === 1) {
        return Promise.resolve({ done: false, value: encoder.encode(sse('message_stop', { type: 'message_stop' })) });
      }
      return new Promise(function () {});
    },
    cancel: function () { cancelled = true; return Promise.resolve(); },
    releaseLock: function () {}
  };
  const resp = {
    ok: true,
    body: { getReader: function () { return reader; } },
    clone: function () { return { body: { getReader: function () { return reader; } } }; }
  };
  sync.observeNativeResponse(resp, { requestId: 'native-2' });
  await delay(30);
  assert.deepEqual(states, ['done']);
  assert.equal(cancelled, true);
});

test('native finish deadline clears generating state even if session refresh hangs', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/sessionsync.js');
  const sync = env.DCP.modules.sessionSync;
  sync.SESSION_REFRESH_TIMEOUT_MS = 10;
  sync._nativeRequests.native = { requestId: 'native', ctx: { requestId: 'native', epoch: 0 }, sid: null };
  env.DCP.modules.demoSearch = {
    refreshRequestSession: function () { return new Promise(function () {}); },
    finishRequest: function () {}
  };
  const activities = [];
  sync.onActivity = function (payload) { activities.push(payload); };
  await sync.finishNativeRequest(sync._nativeRequests.native, 'error');
  assert.equal(activities.length, 1);
  assert.equal(activities[0].state, 'error');
});

function makePersistenceSearch(options = {}) {
  const persisted = [];
  let current = options.current !== false;
  let calls = 0;
  const ctx = {
    requestId: 'req_persist', epoch: 0, sessionId: 's1',
    session: Promise.resolve({ id: 's1' }),
    bridgeMessageId: null, assistantMessageId: null,
    persistRevision: 0, persistQueue: Promise.resolve()
  };
  return {
    ctx: ctx,
    persisted: persisted,
    setCurrent: function (value) { current = value; },
    search: {
      beginRequest: function () { return ctx; },
      isRequestCurrent: function () { return current; },
      refreshRequestSession: async function () { return { id: 's1' }; },
      finishRequest: function () {},
      recoverBridgeRequest: async function () { return null; },
      captureBridgeAssistantId: function (requestCtx) {
        requestCtx.assistantMessageId = 'official-assistant-1';
        return requestCtx.assistantMessageId;
      },
      persistBridgeState: async function (sid, state) {
        calls++;
        persisted.push({ sid: sid, state: JSON.parse(JSON.stringify(state)) });
        return !(options.failFirst && calls === 1);
      }
    }
  };
}

test('detached normal completion persists exact bridge identity and retries dirty state', async function () {
  const persistence = makePersistenceSearch({ failFirst: true });
  let upstreamController = null;
  const result = await runBridge(function (url, init) {
    const body = new ReadableStream({
      start: function (c) {
        upstreamController = c;
        c.enqueue(encoder.encode(partialChunks().join('')));
      }
    });
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, { reader: true, search: persistence.search, bridge: { PERSIST_RETRY_MS: 10 } });
  const first = await readUntil(result.reader, function (text) { return text.includes('已经输出的前半段'); });
  assert.match(first, /message_start/);
  persistence.setCurrent(false);
  upstreamController.enqueue(encoder.encode(completeChunks().slice(partialChunks().length).join('')));
  upstreamController.close();
  await readRest(result.reader);
  await delay(80);
  assert.equal(persistence.persisted.length >= 2, true);
  const last = persistence.persisted[persistence.persisted.length - 1];
  assert.equal(last.sid, 's1');
  assert.equal(last.state.assistantMessageId, 'official-assistant-1');
  assert.equal(last.state.bridgeMessageId, persistence.ctx.bridgeMessageId);
  assert.equal(last.state.status, 'done');
  assert.equal(last.state.stopReason, 'end_turn');
  assert.equal(last.state.blocks[0].text, '已经输出的前半段');
  assert.equal(last.state.revision >= 2, true);
});

test('user stop persists a terminal stopped state when the reader is gone', async function () {
  const persistence = makePersistenceSearch({ current: true });
  const result = await runBridge(function () {
    return Promise.resolve(responseFrom(completeChunks()));
  }, { reader: true, search: persistence.search });
  await readUntil(result.reader, function (text) { return text.includes('message_start'); });
  await result.reader.cancel();
  await delay(50);
  assert.equal(activity(result.env, 'stopped'), true);
  const last = persistence.persisted[persistence.persisted.length - 1];
  assert.equal(last.state.status, 'stopped');
  assert.equal(last.state.assistantMessageId, 'official-assistant-1');
});

test('detached HTTP and network failures persist terminal error state', async function () {
  for (const mode of ['http', 'network']) {
    const persistence = makePersistenceSearch({ current: false });
    const result = await runBridge(function () {
      if (mode === 'network') return Promise.reject(new TypeError('network down'));
      return Promise.resolve(responseFrom(['{"error":{"message":"bad gateway"}}'], {
        status: 502,
        contentType: 'application/json'
      }));
    }, { search: persistence.search });
    await result.text;
    await delay(30);
    const last = persistence.persisted[persistence.persisted.length - 1];
    assert.equal(last.state.status, 'error');
    assert.equal(last.state.assistantMessageId, 'official-assistant-1');
  }
});

test('detached visible partial failure persists done plus max_tokens continuation semantics', async function () {
  const persistence = makePersistenceSearch();
  let upstreamController = null;
  const result = await runBridge(function () {
    const body = new ReadableStream({
      start: function (c) {
        upstreamController = c;
        c.enqueue(encoder.encode(partialChunks().join('')));
      }
    });
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, { reader: true, search: persistence.search });
  await readUntil(result.reader, function (text) { return text.includes('已经输出的前半段'); });
  persistence.setCurrent(false);
  upstreamController.error(new TypeError('socket reset'));
  await readRest(result.reader);
  await delay(50);
  const last = persistence.persisted[persistence.persisted.length - 1];
  assert.equal(last.state.status, 'done');
  assert.equal(last.state.stopReason, 'max_tokens');
  assert.equal(last.state.blocks[0].text, '已经输出的前半段');
});

test('outer errors before the main loop still persist a terminal error', async function () {
  const persistence = makePersistenceSearch({ current: false });
  const result = await runBridge(function () {
    return Promise.resolve(responseFrom(completeChunks()));
  }, {
    search: persistence.search,
    body: Object.assign(requestBody(), { title: { enabled: true } }),
    beforeIntercept: function (bridge) {
      bridge.titleSource = function () { throw new Error('outer boom'); };
    }
  });
  await result.text;
  await delay(30);
  const last = persistence.persisted[persistence.persisted.length - 1];
  assert.equal(last.state.status, 'error');
  assert.equal(last.state.assistantMessageId, 'official-assistant-1');
});

function installFakeIndexedDb(env, session) {
  const writes = [];
  const store = {
    get: function () {
      const request = { result: session };
      setTimeout(function () { if (request.onsuccess) request.onsuccess(); }, 0);
      return request;
    },
    put: function (value) {
      writes.push(JSON.parse(JSON.stringify(value)));
      setTimeout(function () { if (tx.oncomplete) tx.oncomplete(); }, 0);
    }
  };
  const tx = {
    objectStore: function () { return store; },
    abort: function () {}
  };
  const db = {
    objectStoreNames: { contains: function () { return true; } },
    transaction: function () { return tx; },
    close: function () {}
  };
  env.context.indexedDB = {
    open: function () {
      const request = {};
      setTimeout(function () {
        request.result = db;
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    }
  };
  return writes;
}

test('persistBridgeState writes only the exact assistant and preserves official fields', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  const session = {
    id: 's1',
    messages: [
      { id: 'u1', parentId: null, role: 'user', content: 'q', selectedChildId: 'a1' },
      { id: 'a1', parentId: 'u1', role: 'assistant', status: 'done', blocks: [{ type: 'text', text: 'first' }], selectedChildId: 'a2' },
      { id: 'a2', parentId: 'a1', role: 'assistant', status: 'pending', blocks: [], officialFlag: 'keep-me', selectedChildId: null }
    ]
  };
  const writes = installFakeIndexedDb(env, session);
  const ok = await search.persistBridgeState('s1', {
    assistantMessageId: 'a2',
    blocks: [{ type: 'text', text: 'second' }],
    status: 'done',
    stopReason: 'end_turn',
    revision: 7
  });
  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].messages[0].content, 'q');
  assert.equal(writes[0].messages[1].blocks[0].text, 'first');
  assert.equal(writes[0].messages[2].blocks[0].text, 'second');
  assert.equal(writes[0].messages[2].officialFlag, 'keep-me');
  assert.equal(writes[0].messages[2].id, 'a2');
  assert.equal(writes[0].messages[2].__dcpBridgeRevision, 7);

  session.messages[2].__dcpBridgeRevision = 9;
  const stale = await search.persistBridgeState('s1', {
    assistantMessageId: 'a2', blocks: [{ type: 'text', text: 'stale' }], status: 'pending', revision: 8
  });
  assert.equal(stale, false);
  assert.equal(writes.length, 1);
});

test('message_start uses bridge id before official assistant id is captured asynchronously', async function () {
  let resolveSession;
  const sessionPromise = new Promise(function (resolve) { resolveSession = resolve; });
  let ctx;
  const result = await runBridge(function () {
    return Promise.resolve(responseFrom(completeChunks()));
  }, {
    reader: true,
    search: {
      beginRequest: function () {
        ctx = {
          requestId: 'req_identity', epoch: 0, sessionId: null,
          session: sessionPromise, bridgeMessageId: null, assistantMessageId: null,
          persistRevision: 0, persistQueue: Promise.resolve()
        };
        return ctx;
      },
      isRequestCurrent: function () { return true; },
      refreshRequestSession: async function () { return null; },
      finishRequest: function () {},
      recoverBridgeRequest: async function () { return null; },
      captureBridgeAssistantId: function (requestCtx) {
        requestCtx.assistantMessageId = 'official-assistant';
        return requestCtx.assistantMessageId;
      }
    }
  });
  const first = await readUntil(result.reader, function (text) { return text.includes('message_start'); });
  const firstEvent = parseEvents(first)[0];
  assert.equal(firstEvent.message.id, ctx.bridgeMessageId);
  assert.match(firstEvent.message.id, /^msg_bridge_/);
  assert.equal(ctx.assistantMessageId, null);
  resolveSession({ id: 's1' });
  await readRest(result.reader);
  assert.equal(ctx.assistantMessageId, 'official-assistant');
});

function makeSearchDom() {
  function element(tagName) {
    const listeners = {};
    return {
      tagName: String(tagName).toUpperCase(),
      children: [],
      style: {},
      attributes: {},
      textContent: '',
      innerHTML: '',
      appendChild: function (child) { this.children.push(child); child.parentNode = this; return child; },
      setAttribute: function (name, value) { this.attributes[name] = String(value); },
      getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
      hasAttribute: function (name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
      removeAttribute: function (name) { delete this.attributes[name]; },
      addEventListener: function (type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
      dispatch: function (type, target) { (listeners[type] || []).forEach(function (fn) { fn({ target: target || this }); }, this); },
      querySelectorAll: function () { return []; },
      querySelector: function () { return null; },
      focus: function () {}
    };
  }
  const body = element('body');
  return {
    body: body,
    createElement: element,
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    addEventListener: function () {},
    removeEventListener: function () {}
  };
}

test('search overlay closes only on the mask and exposes dialog/listbox semantics', function () {
  const env = makeContext();
  env.context.document = makeSearchDom();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  search.build();
  assert.equal(search.surface.getAttribute('role'), 'dialog');
  assert.equal(search.surface.getAttribute('aria-modal'), 'true');
  assert.equal(search.input.getAttribute('role'), 'combobox');
  assert.equal(search.input.getAttribute('aria-controls'), 'dcp-search-list');
  assert.equal(search.list.getAttribute('role'), 'listbox');
  let closes = 0;
  search.close = function () { closes++; };
  search.overlay.dispatch('click', search.surface);
  assert.equal(closes, 0);
  search.overlay.dispatch('click', search.overlay);
  assert.equal(closes, 1);
});

test('search query tokens discard stale results and navigation uses stable sid', async function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  const search = env.DCP.modules.demoSearch;
  let sequence = 0;
  env.DCP.ui = {
    createQueryToken: function () { return { id: ++sequence, cancelled: false }; },
    invalidateQuery: function (token) { token.cancelled = true; },
    isQueryCurrent: function (token) { return !!(token && !token.cancelled); }
  };
  let resolveFirst;
  let resolveSecond;
  search.readSessions = function () {
    return new Promise(function (resolve) {
      if (!resolveFirst) resolveFirst = resolve;
      else resolveSecond = resolve;
    });
  };
  const rendered = [];
  search.render = function (q, results, token) { rendered.push({ q: q, results: results, token: token }); };
  const first = search.runSearch('first');
  const second = search.runSearch('second');
  resolveSecond([makeSession('s2', [{ content: 'second' }])]);
  await second;
  resolveFirst([makeSession('s1', [{ content: 'first' }])]);
  await first;
  assert.deepEqual(rendered.map(function (entry) { return entry.q; }), ['second']);

  const opened = [];
  env.DCP.ui.stableNavigateToSession = function (sid) { opened.push(sid); return Promise.resolve(true); };
  search.close = function () {};
  search.openSession('__proto__');
  assert.deepEqual(opened, ['__proto__']);
});

test('SessionSync uses a fresh tab id for each page instance even with cloned sessionStorage', function () {
  const sharedStorage = {
    value: 'copied-tab-id',
    getItem: function () { return this.value; },
    setItem: function (key, value) { this.value = value; }
  };
  function makeInstance() {
    const env = makeContext();
    const win = { sessionStorage: sharedStorage };
    env.context.window = win;
    env.context.pageWindow = function () { return win; };
    load(env.context, 'src/modules/sessionsync.js');
    return env.DCP.modules.sessionSync;
  }
  const first = makeInstance().ensureTabId();
  const second = makeInstance().ensureTabId();
  assert.notEqual(first, second);
  assert.match(first, /^t_/);
  assert.match(second, /^t_/);
});

test('search and session dictionaries are prototype-safe for special titles and ids', function () {
  const env = makeContext();
  load(env.context, 'src/modules/demosearch.js');
  load(env.context, 'src/modules/sessionsync.js');
  const search = env.DCP.modules.demoSearch;
  const sync = env.DCP.modules.sessionSync;
  assert.equal(Object.getPrototypeOf(search._requests), null);
  assert.equal(Object.getPrototypeOf(sync._generating), null);
  assert.equal(Object.getPrototypeOf(sync._done), null);
  const dict = search.dict();
  dict.__proto__ = 'safe';
  dict.constructor = 'also-safe';
  assert.equal(dict.__proto__, 'safe');
  assert.equal(dict.constructor, 'also-safe');
  sync._done.__proto__ = { at: 1 };
  assert.equal(Object.prototype.hasOwnProperty.call(sync._done, '__proto__'), true);
  delete sync._done.__proto__;
});

test('bridge waits for deferred attachment readiness before the first upstream request', async function () {
  let resolveFiles;
  const filesReady = new Promise(function (resolve) { resolveFiles = resolve; });
  let waitedIds = null;
  let waitedTimeout = null;
  let fetchCalls = 0;
  let payload = null;
  const body = {
    model: 'fixture-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'file', file_id: 'file-1' } },
        { type: 'text', text: 'read this' }
      ]
    }]
  };
  const result = await runBridge(function (url, init) {
    fetchCalls++;
    payload = JSON.parse(init.body);
    return Promise.resolve(responseFrom(completeChunks()));
  }, {
    body: body,
    reader: true,
    beforeIntercept: function (bridge, env) {
      env.DCP.modules.demoApi._fileTexts = Object.create(null);
      env.DCP.modules.demoApi.waitForFiles = function (ids, timeout) {
        waitedIds = Array.from(ids);
        waitedTimeout = timeout;
        return filesReady.then(function () { return Object.create(null); });
      };
    }
  });
  await readUntil(result.reader, function (text) { return text.includes('message_start'); });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(waitedIds, ['file-1']);
  assert.equal(waitedTimeout, 8000);
  result.env.DCP.modules.demoApi._fileTexts['file-1'] = { name: 'a.txt', text: 'ready attachment text' };
  resolveFiles();
  await readRest(result.reader);
  assert.equal(fetchCalls, 1);
  assert.equal(payload.messages[0].content[0].type, 'text');
  assert.match(payload.messages[0].content[0].text, /ready attachment text/);
});
