'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const bootstrapSource = fs.readFileSync(path.join(ROOT, 'src/bootstrap.js'), 'utf8');
const configSource = fs.readFileSync(path.join(ROOT, 'src/core/config.js'), 'utf8');
const i18nSource = fs.readFileSync(path.join(ROOT, 'src/core/i18n.js'), 'utf8');

function makeLocalStorage(initial) {
  const values = new Map();
  Object.keys(initial || {}).forEach((key) => values.set(key, String(initial[key])));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    key(index) { return Array.from(values.keys())[index] == null ? null : Array.from(values.keys())[index]; },
    clear() { values.clear(); },
    get length() { return values.size; },
    _dump() { return Object.fromEntries(values); }
  };
}

function makeDocument() {
  const listeners = Object.create(null);
  return {
    documentElement: { lang: 'en-US' },
    head: { appendChild() {} },
    body: { appendChild() {} },
    readyState: 'complete',
    defaultView: null,
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((item) => item !== fn);
    },
    createElement(tag) {
      return {
        tagName: tag,
        attributes: Object.create(null),
        style: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name] == null ? null : this.attributes[name]; },
        appendChild() {}
      };
    },
    querySelectorAll() { return []; }
  };
}

function loadRuntime(options = {}) {
  const localStorage = makeLocalStorage(options.localStorage);
  const windowListeners = Object.create(null);
  const window = {
    innerWidth: 1024,
    localStorage,
    addEventListener(type, fn) { (windowListeners[type] || (windowListeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      windowListeners[type] = (windowListeners[type] || []).filter((item) => item !== fn);
    }
  };
  const document = makeDocument();
  document.defaultView = window;
  const logs = [];
  const context = vm.createContext({
    window,
    document,
    localStorage,
    navigator: { language: options.navigatorLanguage || 'zh-CN' },
    console: {
      log() {},
      warn() {},
      error(...args) { logs.push(args); }
    },
    setTimeout,
    clearTimeout,
    URL,
    isFinite
  });
  if (options.gmGet) context.GM_getValue = options.gmGet;
  if (options.gmSet) context.GM_setValue = options.gmSet;
  if (options.gmDelete) context.GM_deleteValue = options.gmDelete;
  if (options.gmList) context.GM_listValues = options.gmList;
  if (options.gmStyle) context.GM_addStyle = options.gmStyle;

  const exposed = bootstrapSource + '\nglobalThis.__DCP = DCP;\n})();';
  vm.runInContext(exposed, context, { filename: 'src/bootstrap.js' });
  const DCP = context.__DCP;
  context.DCP = DCP;
  context.Bridge = DCP.bridge;
  vm.runInContext(configSource, context, { filename: 'src/core/config.js' });
  vm.runInContext(i18nSource, context, { filename: 'src/core/i18n.js' });
  return { context, DCP, document, window, localStorage, logs, windowListeners };
}

function freshInstance(base) {
  const instance = Object.create(base);
  instance._cache = null;
  instance._sessCache = null;
  instance._dirty = Object.create(null);
  instance._revisions = Object.create(null);
  instance._writers = Object.create(null);
  instance._seq = 0;
  instance._tabId = base._tabId + '_copy';
  instance._crossTabBound = false;
  instance._keyWarningEmitted = false;
  return instance;
}

function fieldKey(field) {
  return 'dcp_config_v1:field:' + encodeURIComponent(field);
}

test('config merges only own properties and rejects prototype-pollution keys', () => {
  const legacy = JSON.parse('{"demoCustom":true,"demoModel":"legacy-model","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}');
  const env = loadRuntime({ localStorage: { dcp_bridge_store: JSON.stringify({ dcp_config_v1: legacy }) } });
  const cfg = env.DCP.config.load();

  assert.equal(cfg.lang, 'auto');
  assert.equal(cfg.demoCustom, true);
  assert.equal(cfg.demoModel, 'legacy-model');
  assert.equal({}.polluted, undefined);
  assert.equal(cfg.polluted, undefined);

  const inherited = Object.create({ demoModel: 'inherited-model' });
  env.DCP.bridge.remove(fieldKey('demoModel'));
  env.DCP.config._cache = null;
  const originalGet = env.DCP.bridge.get;
  env.DCP.bridge.get = function (key, fallback) {
    if (key === 'dcp_config_v1') return inherited;
    return originalGet.call(this, key, fallback);
  };
  assert.equal(env.DCP.config.load().demoModel, '');
});

test('config set rejects special paths and session maps have null prototypes', () => {
  const env = loadRuntime();
  const config = env.DCP.config;

  assert.equal(config.set('__proto__.polluted', true).ok, false);
  assert.equal(config.set('constructor.prototype.polluted', true).ok, false);
  assert.equal(config.set('prototype.polluted', true).ok, false);
  assert.equal({}.polluted, undefined);

  const sessions = config.sessions();
  assert.equal(Object.getPrototypeOf(sessions), null);
  const record = config.session('session-1');
  assert.equal(Object.getPrototypeOf(record), null);
  assert.equal(config.session('__proto__').polluted, undefined);
  assert.equal(sessions.__proto__, undefined);
});

test('lang defaults to auto, prefers document language, and refreshes on cfg:change', () => {
  const env = loadRuntime({ navigatorLanguage: 'zh-CN' });
  const changes = [];
  env.DCP.on('i18n:change', (event) => changes.push(event));

  assert.equal(env.DCP.config.get('lang'), 'auto');
  assert.equal(env.DCP.i18n.refresh(), 'en');
  env.document.documentElement.lang = '';
  assert.equal(env.DCP.i18n.refresh(), 'zh');
  env.document.documentElement.lang = 'en-US';
  env.DCP.config.set('lang', 'zh');
  assert.equal(env.DCP.i18n.lang(), 'zh');
  assert.equal(changes.at(-1).lang, 'zh');

  const node = {
    textContent: '旧文本',
    getAttribute(name) { return name === 'data-i18n' ? '保存' : null; }
  };
  env.DCP.i18n.apply({
    querySelectorAll(selector) { return selector === '[data-i18n]' ? [node] : []; }
  });
  assert.equal(node.textContent, '保存');
});

test('bridge reports manager failures and missing optional GM APIs explicitly', () => {
  const env = loadRuntime({
    gmGet() { throw new Error('read failed'); },
    gmSet() { throw new Error('write failed'); }
  });
  const bridge = env.DCP.bridge;

  assert.equal(bridge.capabilities.storage, 'manager');
  assert.equal(bridge.capabilities.isolatedStorage, true);
  assert.equal(bridge.get('missing', 'fallback'), 'fallback');
  assert.equal(bridge.set('key', 'value').ok, false);
  assert.equal(bridge.remove('key').ok, false);
  assert.match(bridge.remove('key').error, /GM_deleteValue/);
  assert.equal(bridge.list().ok, false);
  assert.match(bridge.list().error, /GM_listValues/);

  const result = env.DCP.config.set('demoModel', 'cannot-save');
  assert.equal(result.ok, false);
  assert.equal(env.DCP.config.get('demoModel'), 'cannot-save');
});

test('partial GM storage does not silently fall back to page-readable storage', () => {
  const env = loadRuntime({ gmGet() { return undefined; } });
  assert.equal(env.DCP.bridge.capabilities.storage, 'memory');
  assert.equal(env.DCP.bridge.capabilities.degraded, true);
  assert.equal(env.DCP.bridge.capabilities.isolatedStorage, false);
  assert.equal(env.DCP.bridge.set('setting', 1).persistent, false);
  assert.deepEqual(env.localStorage._dump(), {});
});

test('field-scoped revisions prevent stale cross-tab whole-object overwrites', () => {
  const env = loadRuntime();
  const first = env.DCP.config;
  const second = freshInstance(first);
  first.load();
  second.load();

  assert.equal(first.set('demoModel', 'model-a').ok, true);
  assert.equal(second.set('demoEndpoint', 'https://second.invalid/v1').ok, true);

  const third = freshInstance(first);
  assert.equal(third.load().demoModel, 'model-a');
  assert.equal(third.load().demoEndpoint, 'https://second.invalid/v1');

  const remote = env.DCP.bridge.get(fieldKey('demoModel'));
  remote.revision += 1;
  remote.writer = 'remote-tab';
  remote.value = 'remote-model';
  env.DCP.bridge.set(fieldKey('demoModel'), remote);
  const changed = second._applyStorageEvent({ key: env.DCP.bridge.storageKey(fieldKey('demoModel')) });
  assert.equal(changed, true);
  assert.equal(second.get('demoModel'), 'remote-model');
  assert.equal(second.get('demoEndpoint'), 'https://second.invalid/v1');
});

test('demoKey is never written to page storage and emits a clear warning', () => {
  const env = loadRuntime();
  const warnings = [];
  env.DCP.on('cfg:warning', (event) => warnings.push(event));

  const result = env.DCP.config.set('demoKey', 'super-secret');
  assert.equal(result.ok, true);
  assert.equal(result.keyStored, false);
  assert.equal(JSON.stringify(env.localStorage._dump()).includes('super-secret'), false);
  assert.equal(warnings.some((event) => event.code === 'KEY_NOT_PERSISTED'), true);
});

test('legacy page-readable demoKey is discarded during migration', () => {
  const legacy = JSON.stringify({ dcp_config_v1: { demoKey: 'old-secret', demoModel: 'keep-me' } });
  const env = loadRuntime({ localStorage: { dcp_bridge_store: legacy } });
  assert.equal(env.DCP.config.load().demoModel, 'keep-me');
  assert.equal(env.DCP.config._keyWarningEmitted, true);
  assert.equal(JSON.stringify(env.localStorage._dump()).includes('old-secret'), false);
});

test('style capability falls back explicitly when GM_addStyle throws', () => {
  const env = loadRuntime({ gmStyle() { throw new Error('style failed'); } });
  assert.equal(env.DCP.bridge.capabilities.style, 'dom');
  assert.equal(env.DCP.bridge.capabilities.styleFallback, true);
});
