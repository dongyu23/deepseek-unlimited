'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadModule() {
  const DCP = { SEL: { msgEditor: 'textarea[aria-label="编辑消息"]' }, modules: {} };
  const context = vm.createContext({
    DCP: DCP,
    requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/modules/editcaret.js'), 'utf8'), context);
  return DCP.modules.editCaret;
}

function fakeElement(value) {
  const listeners = {};
  return {
    value: value,
    isConnected: true,
    calls: [],
    focus: function (options) { this.calls.push(['focus', options]); },
    setSelectionRange: function (start, end) { this.calls.push(['selection', start, end]); },
    addEventListener: function (type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      listeners[type] = (listeners[type] || []).filter(function (item) { return item !== fn; });
    },
    dispatch: function (type) {
      (listeners[type] || []).slice().forEach(function (fn) { fn({ target: this }); }, this);
    }
  };
}

test('moveToEnd focuses the editor and places the caret at value.length', function () {
  const module = loadModule();
  const el = fakeElement('已经发送的消息');
  module.moveToEnd(el);
  assert.equal(el.calls.length, 2);
  assert.equal(el.calls[0][0], 'focus');
  assert.equal(el.calls[0][1].preventScroll, true);
  assert.deepEqual(Array.from(el.calls[1]), ['selection', 7, 7]);
});

test('arm applies the caret correction after React commits', async function () {
  const module = loadModule();
  const el = fakeElement('hello');
  module.arm(el);
  await new Promise(function (resolve) { setTimeout(resolve, 100); });
  assert.equal(el.calls.some(function (call) { return call[0] === 'selection' && call[1] === 5 && call[2] === 5; }), true);
  module.cleanup();
});

test('arm stops correcting after the user interacts with the editor', async function () {
  const module = loadModule();
  const el = fakeElement('hello');
  module.arm(el);
  el.dispatch('keydown');
  await new Promise(function (resolve) { setTimeout(resolve, 100); });
  assert.equal(el.calls.some(function (call) { return call[0] === 'selection'; }), false);
});
