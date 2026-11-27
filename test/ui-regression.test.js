'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

class FakeEvent {
  constructor(type, options) {
    this.type = type;
    Object.assign(this, options || {});
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediatePropagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.immediatePropagationStopped = true; }
}

class FakeClassList {
  constructor(el) { this.el = el; }
  _set() {
    return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean));
  }
  contains(name) { return this._set().has(name); }
  add(name) {
    const values = this._set();
    values.add(name);
    this.el.className = Array.from(values).join(' ');
  }
  remove(name) {
    const values = this._set();
    values.delete(name);
    this.el.className = Array.from(values).join(' ');
  }
}

class FakeElement {
  constructor(tagName, doc) {
    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = doc || null;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this._text = '';
    this._connected = false;
    this._rects = [{}];
    this._rect = { left: 0, top: 0, width: 100, height: 40 };
    this.disabled = false;
    this.tabIndex = -1;
    this._value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  get value() { return this._value; }
  set value(value) { this._value = String(value == null ? '' : value); }
  get parentElement() { return this.parentNode; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }
  get isConnected() {
    if (this._connected) return true;
    let node = this;
    while (node) {
      if (node === this.ownerDocument || node === this.ownerDocument?.body) return true;
      node = node.parentNode;
    }
    return false;
  }
  set isConnected(value) { this._connected = !!value; }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent || '').join('');
  }
  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
  }
  set innerHTML(value) {
    this._text = '';
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
  }
  get innerHTML() { return this._text; }
  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, before) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item !== fn));
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    const list = (this.listeners.get(event.type) || []).slice();
    for (const fn of list) {
      fn(event);
      if (event.immediatePropagationStopped) break;
    }
    return !event.defaultPrevented;
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  matches(selector) {
    if (this._matches) return this._matches(selector);
    return FakeElement.matchesSimple(this, selector);
  }
  static matchesSimple(el, selector) {
    selector = String(selector || '').trim();
    if (!selector) return false;
    const negations = Array.from(selector.matchAll(/:not\(([^)]+)\)/g));
    selector = selector.replace(/:not\([^)]+\)/g, '');
    for (const match of negations) {
      if (FakeElement.matchesSimple(el, match[1])) return false;
    }
    const lastChild = /:last-child$/.test(selector);
    selector = selector.replace(/:last-child$/, '');
    if (lastChild && (!el.parentNode || el.parentNode.children[el.parentNode.children.length - 1] !== el)) return false;
    const tag = selector.match(/^[a-zA-Z][\w-]*/);
    if (tag && el.tagName !== tag[0].toUpperCase()) return false;
    const attrs = Array.from(selector.matchAll(/\[([^\]=]+)(?:(\^=|\*=|=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g));
    for (const attr of attrs) {
      const name = attr[1];
      const actual = el.getAttribute(name);
      if (actual === null) return false;
      if (attr[2]) {
        const expected = attr[3] ?? attr[4] ?? attr[5] ?? '';
        if (attr[2] === '=' && actual !== expected) return false;
        if (attr[2] === '^=' && !actual.startsWith(expected)) return false;
        if (attr[2] === '*=' && !actual.includes(expected)) return false;
      }
    }
    const withoutAttrs = selector.replace(/\[[^\]]+\]/g, '');
    const classes = Array.from(withoutAttrs.matchAll(/\.([\w-]+)/g));
    for (const item of classes) {
      if (!el.classList.contains(item[1])) return false;
    }
    return true;
  }
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (this._qsa) return this._qsa(selector);
    const out = [];
    const selectors = String(selector || '').split(',');
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((item) => FakeElement.matchesSimple(child, item.trim()))) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return this._rects; }
  getBoundingClientRect() { return this._rect; }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  cloneNode() {
    const copy = new FakeElement(this.tagName, this.ownerDocument);
    copy.className = this.className;
    copy._text = this._text;
    return copy;
  }
}

class FakeDocument {
  constructor() {
    this.nodeType = 9;
    this.body = new FakeElement('body', this);
    this.body._connected = true;
    this.activeElement = this.body;
    this.listeners = new Map();
    this.title = 'Original';
  }
  createElement(tag) { return new FakeElement(tag, this); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  querySelector(selector) { return this.body.querySelector(selector); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn));
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    for (const fn of (this.listeners.get(event.type) || []).slice()) fn(event);
    return !event.defaultPrevented;
  }
}

class FakeMutationObserver {
  constructor(callback) { this.callback = callback; this.options = null; }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
  trigger(records) { this.callback(records, this); }
}

class FakeFile {
  constructor(parts, name, options) {
    this.name = name;
    this.size = parts.join('').length;
    this.type = options && options.type;
  }
}

class FakeDataTransfer {
  constructor() {
    this._files = [];
    this.items = { add: (file) => this._files.push(file) };
  }
  get files() { return this._files; }
}

function makeEnv(options) {
  options = options || {};
  const state = { sid: options.sid || 's1', toasts: [], realClicks: [], textWrites: 0 };
  const listeners = new Map();
  const config = Object.assign({ demoPinnedSessions: [] }, options.config || {});
  const utils = {
    dict: () => Object.create(null),
    own: (object, key) => !!object && Object.prototype.hasOwnProperty.call(object, key),
    setTextIfChanged(el, text) {
      const next = String(text == null ? '' : text);
      if (el.textContent === next) return false;
      state.textWrites += 1;
      el.textContent = next;
      return true;
    },
    currentSid: () => state.sid,
    isDark: () => false,
    onReady: (fn) => fn(),
    toast: (message) => state.toasts.push(message),
    realClick: (el) => state.realClicks.push(el),
    debounce(fn, delay) {
      let timer = null;
      const wrapped = function () {
        clearTimeout(timer);
        timer = setTimeout(fn, delay);
      };
      wrapped.cancel = () => clearTimeout(timer);
      return wrapped;
    },
    cancelReader(reader) {
      if (!reader || typeof reader.cancel !== 'function') return Promise.resolve(false);
      try { return Promise.resolve(reader.cancel()).then(() => true, () => false); } catch (e) { return Promise.resolve(false); }
    }
  };
  const doc = new FakeDocument();
  const DCP = {
    modules: {},
    version: 'test',
    bridge: { addStyle() {} },
    config: {
      get(key) { return config[key]; },
      set(key, value) { config[key] = value; DCP.emit('cfg:change', { path: key, value }); }
    },
    utils,
    t(key) { return key; },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    emit(name, payload) {
      for (const fn of (listeners.get(name) || []).slice()) fn(payload);
    },
    register(name, api) { this.modules[name] = api; }
  };
  const context = vm.createContext({
    DCP,
    Utils: utils,
    document: doc,
    window: { addEventListener() {}, innerWidth: 1200 },
    location: { hostname: 'cdn.deepseek.com', pathname: '/chat-demo' },
    navigator: { platform: options.platform || 'Linux', language: 'en' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    MutationObserver: FakeMutationObserver,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    JSON,
    RegExp,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    ReadableStream,
    AbortController,
    DOMException,
    Blob,
    URL,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    getComputedStyle: () => ({ backgroundColor: 'rgb(255,255,255)', color: 'rgb(0,0,0)', paddingLeft: '0px', paddingRight: '0px', borderRightWidth: '0px' }),
    localStorage: { getItem: () => null },
    HTMLTextAreaElement: class {
      constructor() { this._value = ''; }
      get value() { return this._value; }
      set value(value) { this._value = value; }
    }
  });
  function load(file) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  load('src/core/selectors.js');
  load('src/core/ui.js');
  return { DCP, doc, state, config, context, load, listeners };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tick(ms) { return new Promise((resolve) => setTimeout(resolve, ms || 0)); }

test('UI helpers keep dictionaries and text writes safe and idempotent', function () {
  const env = makeEnv();
  const dict = env.DCP.ui.dict();
  dict.__proto__ = 'safe';
  dict.constructor = 'also-safe';
  assert.equal(dict.__proto__, 'safe');
  assert.equal(dict.constructor, 'also-safe');
  const el = new FakeElement('span', env.doc);
  assert.equal(env.DCP.ui.setTextIfChanged(el, 'hello'), true);
  assert.equal(env.DCP.ui.setTextIfChanged(el, 'hello'), false);
  assert.equal(env.state.textWrites, 1);
});

test('selector chains skip invalid candidates, dedupe, and expose health warnings', function () {
  const env = makeEnv();
  const first = new FakeElement('div', env.doc);
  const second = new FakeElement('div', env.doc);
  const root = {
    nodeType: 1,
    querySelectorAll(selector) {
      if (selector === '.broken') throw new Error('invalid selector');
      if (selector === '.first') return [first, second];
      if (selector === '.second') return [second];
      return [];
    }
  };
  assert.deepEqual(Array.from(env.DCP.qsa(['.broken', '.first', '.second'], root)), [first, second]);
  assert.equal(env.DCP.qs('.first', root), first);
  const health = env.DCP.selectorHealth(['__proto__', 'constructor']);
  assert.equal(Object.getPrototypeOf(health), null);
  assert.equal(Object.prototype.hasOwnProperty.call(health, '__proto__'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(health, 'constructor'), true);
});

test('observeRelevant ignores DCP-owned mutations and only reports relevant records', function () {
  const env = makeEnv();
  const owned = new FakeElement('span', env.doc);
  env.DCP.ui.markOwned(owned);
  const official = new FakeElement('span', env.doc);
  let calls = 0;
  let received = null;
  const observer = env.DCP.ui.observeRelevant(env.doc.body, (records) => {
    calls += 1;
    received = records;
  }, { childList: true, subtree: true });
  observer.trigger([{ type: 'childList', target: env.doc.body, addedNodes: [owned], removedNodes: [] }]);
  observer.trigger([{ type: 'childList', target: owned, addedNodes: [official], removedNodes: [] }]);
  assert.equal(calls, 0);
  observer.trigger([{ type: 'childList', target: env.doc.body, addedNodes: [official], removedNodes: [] }]);
  assert.equal(calls, 1);
  assert.equal(received.length, 1);
});

test('cancellable wait and debounce reject or stop cleanly', async function () {
  const env = makeEnv();
  const controller = new AbortController();
  const waiting = env.DCP.ui.wait(20, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  let calls = 0;
  const debounced = env.DCP.ui.debounce(() => { calls += 1; }, 10);
  debounced();
  debounced.cancel();
  await tick(20);
  assert.equal(calls, 0);
});

test('query tokens discard stale searches and stable navigation uses the exact sid', async function () {
  const env = makeEnv({ sid: 's1' });
  const token = env.DCP.ui.createQueryToken();
  assert.equal(env.DCP.ui.isQueryCurrent(token), true);
  env.state.sid = 's2';
  env.DCP.emit('session:change', { sid: 's2' });
  assert.equal(env.DCP.ui.isQueryCurrent(token), false);

  const opened = [];
  env.DCP.modules.sessionSync = {
    openSessionById(sid) { opened.push(sid); return Promise.resolve(true); }
  };
  assert.equal(await env.DCP.ui.stableNavigateToSession('sid-with-dash'), true);
  assert.deepEqual(opened, ['sid-with-dash']);

  const pending = deferred();
  env.DCP.modules.sessionSync.openSessionById = () => pending.promise;
  const navigating = env.DCP.ui.stableNavigateToSession('stale-sid');
  env.DCP.modules.sessionSync.openSessionById = async () => true;
  assert.equal(await env.DCP.ui.stableNavigateToSession('newest-sid'), true);
  pending.resolve(true);
  assert.equal(await navigating, false);
});

test('trapFocus wraps Tab and restores the previously focused node', function () {
  const env = makeEnv();
  const previous = new FakeElement('button', env.doc);
  previous.isConnected = true;
  const container = new FakeElement('div', env.doc);
  container.isConnected = true;
  const first = new FakeElement('button', env.doc);
  const last = new FakeElement('button', env.doc);
  container.appendChild(first);
  container.appendChild(last);
  env.doc.activeElement = previous;
  const release = env.DCP.ui.trapFocus(container, { initialFocus: first });
  assert.equal(env.doc.activeElement, first);
  env.doc.activeElement = last;
  const tab = new FakeEvent('keydown', { key: 'Tab', shiftKey: false });
  env.doc.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(env.doc.activeElement, first);
  release();
  assert.equal(env.doc.activeElement, previous);
});

test('selector health warnings are emitted once per missing key', function () {
  const env = makeEnv();
  const warnings = [];
  env.context.console.warn = (message) => warnings.push(message);
  const reports = [];
  env.DCP.on('selectors:health', (report) => reports.push(report));
  env.DCP.checkSelectorHealth(['missing-one']);
  env.DCP.checkSelectorHealth(['missing-one']);
  assert.equal(warnings.length, 1);
  assert.equal(reports.length, 2);
});

test('continue generation discards a scan that finishes after a session change', async function () {
  const env = makeEnv();
  env.load('src/modules/continuegen.js');
  const module = env.DCP.modules.continueGen;
  const pending = deferred();
  env.DCP.modules.demoSearch = {
    currentSession: () => pending.promise,
    chain: () => [{ role: 'assistant', blocks: [{ type: 'text', text: 'x' }] }]
  };
  let ensured = 0;
  module.ensure = () => { ensured += 1; };
  const scanning = module.scan();
  env.DCP.emit('session:change', { sid: 's2' });
  pending.resolve({ id: 's1' });
  await scanning;
  assert.equal(ensured, 0);
});

test('continue generation is idempotent, uses the passed row, and re-queries regenerate on click', function () {
  const env = makeEnv();
  env.load('src/modules/continuegen.js');
  const module = env.DCP.modules.continueGen;
  const row = new FakeElement('div', env.doc);
  row.isConnected = true;
  const otherRow = new FakeElement('div', env.doc);
  otherRow.isConnected = true;
  const bar = new FakeElement('div', env.doc);
  bar.parentNode = row;
  row.children.push(bar);
  const bottom = new FakeElement('div', env.doc);
  bar.parentNode = bottom;
  const regen = new FakeElement('button', env.doc);
  regen.setAttribute('aria-label', 'Regenerate');
  const replacement = new FakeElement('button', env.doc);
  replacement.setAttribute('aria-label', '重新生成');
  let currentButtons = [regen];
  bar.querySelectorAll = (selector) => selector === 'button' ? currentButtons : [];
  bottom.querySelector = (selector) => selector === '.dcp-continue-generate' ? bottom.children[0] || null : null;
  env.DCP.qs = (selector, root) => {
    if (selector === 'aiActionBar') return root === row ? bar : null;
    if (selector === 'continueButton') return null;
    return null;
  };
  env.DCP.qsa = (selector, root) => {
    if (selector === 'button') return currentButtons;
    if (selector === 'msgRowAi') return [otherRow, row];
    return [];
  };
  const message = { role: 'assistant', status: 'max_tokens', blocks: [{ type: 'text', text: 'answer' }, { type: 'server_tool_use' }] };
  env.DCP.modules.demoSearch = {
    hasToolBlocks: (value) => value.blocks.some((block) => block.type === 'server_tool_use'),
    isRecoverableStatus: (value) => value.status === 'max_tokens'
  };
  assert.equal(module.ensure({ row, message }), true);
  const button = bottom.children[0];
  assert.equal(module.ensure({ row, message }), false);
  assert.equal(bottom.children.length, 1);
  assert.equal(bottom.children[0], button);
  currentButtons = [replacement];
  button.dispatchEvent(new FakeEvent('click'));
  assert.equal(env.state.realClicks[0], replacement);
  message.status = 'done';
  assert.equal(module.ensure({ row, message }), true);
  assert.equal(bottom.querySelector('.dcp-continue-generate'), null);
});

test('session pin rows are keyboard accessible, idempotent, and safe for special ids', function () {
  const env = makeEnv({ config: { demoPinnedSessions: ['__proto__', 'constructor'] } });
  env.load('src/modules/sessionpin.js');
  const module = env.DCP.modules.sessionPin;
  const section = module.ensureSection();
  const native = new FakeElement('div', env.doc);
  const first = module.renderRow('__proto__', { title: 'proto title' }, native);
  const writes = env.state.textWrites;
  const second = module.renderRow('__proto__', { title: 'proto title' }, native);
  assert.equal(first, second);
  assert.equal(env.state.textWrites, writes);
  assert.equal(first._dcpOpen.tagName, 'BUTTON');
  assert.equal(first._dcpOpen.type, 'button');
  assert.equal(first._dcpUnpin.getAttribute('aria-label'), '取消置顶');
  module.renderRow('constructor', { title: 'constructor title' }, native);
  assert.equal(module._rows.size, 2);
  assert.equal(section.children.length, 3);
});

test('session pin apply token discards stale async results and hides an empty section', async function () {
  const env = makeEnv({ config: { demoPinnedSessions: ['s1'] } });
  env.load('src/modules/sessionpin.js');
  const module = env.DCP.modules.sessionPin;
  const first = deferred();
  const second = deferred();
  let call = 0;
  env.DCP.modules.demoSearch = {
    sidebarRowsWithIds() { call += 1; return call === 1 ? first.promise : second.promise; }
  };
  const row1 = new FakeElement('div', env.doc);
  row1.isConnected = true;
  const row2 = new FakeElement('div', env.doc);
  row2.isConnected = true;
  const one = module.applyPins();
  const two = module.applyPins();
  second.resolve([{ sid: 's1', row: row2, summary: { title: 'new' } }]);
  await two;
  first.resolve([{ sid: 's1', row: row1, summary: { title: 'stale' } }]);
  await one;
  assert.equal(module._rows.get('s1')._dcpTitle.textContent, 'new');
  env.config.demoPinnedSessions = [];
  env.DCP.modules.demoSearch.sidebarRowsWithIds = async () => [{ sid: 's1', row: row2, summary: { title: 'new' } }];
  await module.applyPins();
  assert.equal(module._rows.size, 0);
  assert.equal(module._section.getAttribute('aria-hidden'), 'true');
});

test('session pin menu matches Rename and binds the current sid only once', function () {
  const env = makeEnv();
  env.load('src/modules/sessionpin.js');
  const module = env.DCP.modules.sessionPin;
  const row = new FakeElement('div', env.doc);
  row.isConnected = true;
  row.setAttribute('data-dcp-session-id', 'current-sid');
  module._menuRow = row;
  module._menuSid = 'current-sid';
  const menu = new FakeElement('div', env.doc);
  const rename = new FakeElement('div', env.doc);
  rename.setAttribute('role', 'menuitem');
  rename.textContent = 'Rename';
  menu.appendChild(rename);
  env.DCP.qsa = (selector, root) => {
    if (selector === 'menu') return [menu];
    if (selector === 'menuItem' && root === menu) return [rename];
    if (selector === 'button') return [];
    return [];
  };
  module.injectMenu();
  module.injectMenu();
  assert.equal(menu.children.length, 2);
  assert.equal(menu.children[1].getAttribute('data-dcp-sid'), 'current-sid');
  assert.equal(menu.children[1].tabIndex, 0);
});

test('paste polling correlates the exact file card and can be cancelled', async function () {
  const env = makeEnv();
  env.load('src/modules/demopastetxt.js');
  const module = env.DCP.modules.demoPasteTxt;
  const composer = new FakeElement('div', env.doc);
  composer.isConnected = true;
  const oldCard = new FakeElement('div', env.doc);
  oldCard.appendChild(new FakeElement('button', env.doc));
  const wrongCard = new FakeElement('div', env.doc);
  wrongCard.setAttribute('title', 'other.txt');
  wrongCard.appendChild(new FakeElement('button', env.doc));
  const rightCard = new FakeElement('div', env.doc);
  rightCard.setAttribute('title', 'wanted.txt');
  rightCard.appendChild(new FakeElement('button', env.doc));
  let cards = [oldCard];
  composer.querySelectorAll = () => cards;
  const input = new FakeElement('input', env.doc);
  input.isConnected = true;
  const file = new FakeFile(['x'], 'wanted.txt', { type: 'text/plain' });
  const op = {
    epoch: env.DCP.ui.sessionEpoch(),
    sid: env.DCP.ui.currentSid(),
    composer,
    input,
    ta: { isConnected: true },
    file,
    startedAt: Date.now(),
    cancelled: false
  };
  const dt = new env.context.DataTransfer();
  dt.items.add(file);
  assert.equal(dt.files[0], file);
  let dispatched = false;
  let addCardsOnChange = true;
  input.dispatchEvent = (event) => {
    if (event.type === 'change') {
      dispatched = true;
      if (addCardsOnChange) cards = [oldCard, wrongCard, rightCard];
    }
  };
  const feeding = module.feed(input, file, composer, op);
  assert.equal(dispatched, true);
  assert.equal(module.cardList(composer).length, 3);
  assert.equal(module.findCardForOperation(op), rightCard);
  const result = await feeding;
  assert.equal(result.ok, true);
  assert.equal(result.card, rightCard);

  addCardsOnChange = false;
  cards = [oldCard];
  const pendingOp = Object.assign({}, op, { startedAt: Date.now() });
  const pending = module.feed(input, file, composer, pendingOp);
  module.cancelOperation(pendingOp);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
});

test('paste failure never restores text across a session change', async function () {
  const env = makeEnv({ sid: 's1' });
  env.load('src/modules/demopastetxt.js');
  const module = env.DCP.modules.demoPasteTxt;
  const ta = new FakeElement('textarea', env.doc);
  ta.isConnected = true;
  ta.value = 'hello';
  ta.selectionStart = 5;
  ta.selectionEnd = 5;
  const input = new FakeElement('input', env.doc);
  input.isConnected = true;
  input.accept = '.txt';
  const upload = new FakeElement('button', env.doc);
  input.previousElementSibling = upload;
  const composer = new FakeElement('div', env.doc);
  composer.isConnected = true;
  composer.appendChild(ta);
  input.parentNode = composer;
  composer.children.push(input);
  composer.querySelector = (selector) => selector === 'textarea' ? ta : null;
  composer.contains = (node) => node === ta || node === input;
  env.DCP.qsa = (selector, root) => {
    if (selector === 'input[type="file"]') return [input];
    if (selector === 'fileCard') return [];
    if (selector === 'textarea') return [ta];
    return [];
  };
  const failure = deferred();
  module.feed = () => failure.promise;
  assert.equal(module.findInput(), input);
  assert.equal(module.findComposer(input), composer);
  assert.equal(module.findUploadBtn(input), upload);
  const paste = new FakeEvent('paste', {
    currentTarget: ta,
    target: ta,
    clipboardData: { items: [], getData: () => 'x'.repeat(module.LIMIT + 1) }
  });
  module.onPaste(paste);
  assert.equal(paste.defaultPrevented, true);
  env.state.sid = 's2';
  env.DCP.emit('session:change', { sid: 's2' });
  failure.resolve({ ok: false, card: null, cancelled: false });
  await tick();
  assert.equal(ta.value, 'hello');
});

test('paste undo is scoped, version-aware, and uses the platform modifier', function () {
  const env = makeEnv({ platform: 'MacIntel' });
  env.load('src/modules/demopastetxt.js');
  const module = env.DCP.modules.demoPasteTxt;
  const ta = new FakeElement('textarea', env.doc);
  ta.isConnected = true;
  ta.value = '';
  const card = new FakeElement('div', env.doc);
  card.isConnected = true;
  const remove = new FakeElement('button', env.doc);
  remove.setAttribute('aria-label', 'Remove');
  card.appendChild(remove);
  module._versions.set(ta, 3);
  module._rec = {
    kind: 'converted', text: 'pasted', at: 0, card, delInUndo: false,
    composer: { isConnected: true }, input: { isConnected: true }, ta,
    epoch: env.DCP.ui.sessionEpoch(), sid: env.DCP.ui.currentSid(), inputVersion: 3, cancelled: false
  };
  assert.equal(module.isUndoEvent({ key: 'z', metaKey: true, ctrlKey: false }), true);
  assert.equal(module.isUndoEvent({ key: 'z', metaKey: false, ctrlKey: true }), false);
  const event = new FakeEvent('keydown', { key: 'z', metaKey: true, ctrlKey: false, currentTarget: ta, target: ta });
  module.onKey(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(env.state.realClicks[0], remove);
  assert.equal(ta.value, 'pasted');
});

test('edit caret does not steal focus and document interaction cancels correction', async function () {
  const env = makeEnv();
  env.load('src/modules/editcaret.js');
  const module = env.DCP.modules.editCaret;
  const outside = new FakeElement('button', env.doc);
  const editor = new FakeElement('textarea', env.doc);
  editor.ownerDocument = env.doc;
  editor.value = 'message';
  let focusCalls = 0;
  let selectionCalls = 0;
  editor.focus = () => { focusCalls += 1; env.doc.activeElement = editor; };
  editor.setSelectionRange = () => { selectionCalls += 1; };
  env.doc.activeElement = outside;
  module.arm(editor);
  await tick(100);
  assert.equal(focusCalls, 0);
  assert.equal(selectionCalls, 0);

  module.cleanup();
  env.doc.activeElement = editor;
  module.arm(editor);
  env.doc.dispatchEvent(new FakeEvent('pointerdown', { target: outside }));
  await tick(100);
  assert.equal(focusCalls, 0);
  assert.equal(selectionCalls, 0);
});

test('preview honors explicit kind and bounds streaming text reads', async function () {
  const env = makeEnv();
  env.load('src/modules/preview.js');
  const module = env.DCP.modules.preview;
  assert.equal(module.resolveKind({ kind: 'text', name: 'image.png', mime: 'image/png' }), 'text');
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('12345'));
      controller.enqueue(encoder.encode('67890'));
    },
    cancel() { cancelled = true; }
  });
  const result = await module.readTextBounded({ body: stream }, 5);
  assert.equal(result.text, '12345');
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test('preview aborts an unbounded read and clears media on close', async function () {
  const env = makeEnv();
  env.load('src/modules/preview.js');
  const module = env.DCP.modules.preview;
  const controller = new AbortController();
  const stream = new ReadableStream({ start() {} });
  const reading = module.readTextBounded({ body: stream }, 100, controller.signal);
  controller.abort();
  await assert.rejects(reading, (error) => error.name === 'AbortError');

  const body = new FakeElement('div', env.doc);
  const frame = new FakeElement('iframe', env.doc);
  frame.setAttribute('src', 'blob:test');
  body.appendChild(frame);
  const overlay = new FakeElement('div', env.doc);
  overlay.classList.add = (name) => { overlay.className += ' ' + name; };
  overlay.classList.remove = (name) => { overlay.className = String(overlay.className || '').split(/\s+/).filter((item) => item !== name).join(' '); };
  const download = new FakeElement('a', env.doc);
  module.overlay = overlay;
  module.bodyEl = body;
  module.downloadEl = download;
  module._current = { href: 'blob:test' };
  module._controller = new AbortController();
  module._prevOverflow = '';
  module.close();
  assert.equal(module._controller, null);
  assert.equal(frame.getAttribute('src'), null);
  assert.equal(body.children.length, 0);
});

test('toolbar picks the smallest valid candidate and matches English labels', function () {
  const env = makeEnv();
  env.load('src/modules/toolbar.js');
  const module = env.DCP.modules.toolbar;
  const ta = new FakeElement('textarea', env.doc);
  ta.isConnected = true;
  const large = new FakeElement('div', env.doc);
  large.isConnected = true;
  large.textContent = 'Deep thinking tools';
  const small = new FakeElement('div', env.doc);
  small.isConnected = true;
  small.textContent = '深度思考';
  large.children = [new FakeElement('span', env.doc), new FakeElement('span', env.doc)];
  small.children = [];
  const largeButton = new FakeElement('button', env.doc);
  const smallButton = new FakeElement('button', env.doc);
  env.DCP.qs = (selector) => selector === 'textarea' ? ta : null;
  env.DCP.qsa = (selector, root) => {
    if (selector === 'inputToolbar') return [large, small];
    if (selector === 'button,[role="button"]') return root === large ? [largeButton] : [smallButton];
    if (selector === 'button,[role="button"],span,div') return [large, small];
    return [];
  };
  assert.equal(module.find(), small);
  env.DCP.qsa = (selector, root) => {
    if (selector === 'inputToolbar') return [];
    if (selector === 'button,[role="button"]') return root === large ? [largeButton] : [smallButton];
    if (selector === 'button,[role="button"],span,div') return [large, small];
    return [];
  };
  assert.equal(module.find(), small);
});

test('code download uses bilingual copy labels and safe extension lookup', function () {
  const env = makeEnv();
  env.load('src/modules/codedownload.js');
  const module = env.DCP.modules.codeDownload;
  assert.equal(typeof module.extOf('__proto__'), 'string');
  assert.notEqual(module.extOf('__proto__'), '[object Object]');
  const banner = new FakeElement('div', env.doc);
  const copy = new FakeElement('button', env.doc);
  copy.setAttribute('aria-label', 'Copy');
  banner.appendChild(copy);
  env.DCP.qsa = (selector, root) => selector === 'button' && root === banner ? [copy] : [];
  assert.equal(module.copyButton(banner), copy);
});
