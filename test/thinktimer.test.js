'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function makeTextElement(text) {
  return { textContent: text };
}

function makeThinkBlock(text) {
  const titleText = makeTextElement(text || '正在思考');
  const header = {
    querySelector: function () { return titleText; }
  };
  return {
    header: header,
    titleText: titleText,
    querySelector: function (selector) {
      return selector === '.title-_3d93a' ? header : null;
    }
  };
}

function makeEnv() {
  const handlers = {};
  const inside = makeThinkBlock();
  const outside = makeThinkBlock();
  const view = {
    querySelectorAll: function (selector) {
      return selector === '.area-_3d93a' ? [inside] : [];
    }
  };
  const document = {
    querySelector: function (selector) {
      if (selector === '.view-_5fa77') return view;
      return null;
    },
    querySelectorAll: function (selector) {
      if (selector === 'button') return [];
      return [];
    },
    addEventListener: function () {}
  };
  const DCP = {
    SEL: {
      chatView: '.view-_5fa77',
      thinkBlock: '.area-_3d93a',
      thinkHeader: '.title-_3d93a'
    },
    modules: {},
    t: function (text, vars) {
      return String(text).replace('{n}', vars && vars.n != null ? vars.n : '');
    },
    on: function (name, fn) { (handlers[name] || (handlers[name] = [])).push(fn); },
    emit: function (name, payload) {
      (handlers[name] || []).forEach(function (fn) { fn(payload); });
    }
  };
  const context = vm.createContext({
    DCP: DCP,
    document: document,
    Utils: {
      setTextIfChanged: function (el, text) {
        if (!el) return false;
        text = String(text == null ? '' : text);
        if (el.textContent === text) return false;
        el.textContent = text;
        return true;
      }
    },
    setInterval: setInterval,
    clearInterval: clearInterval,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Date: Date
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/modules/thinktimer.js'), 'utf8'), context);
  return { timer: DCP.modules.thinkTimer, DCP: DCP, inside: inside, outside: outside, view: view };
}

test('ThinkTimer only mutates the thinking block inside the current chatView', function () {
  const env = makeEnv();
  env.outside.titleText.textContent = '正在思考';
  env.timer.start({ requestId: 'r1', sessionId: 's1', epoch: 1 });
  env.timer.tick();
  assert.match(env.inside.titleText.textContent, /^正在思考（用时 \d+ 秒）$/);
  assert.equal(env.outside.titleText.textContent, '正在思考');
  env.timer.stop();
});

test('ThinkTimer ignores idle events from an older request', function () {
  const env = makeEnv();
  env.timer.start({ requestId: 'r1', sessionId: 's1', epoch: 1 });
  env.timer.start({ requestId: 'r2', sessionId: 's1', epoch: 2 });
  env.timer.onTpsIdle({ requestId: 'r1', sessionId: 's1', epoch: 1 });
  assert.equal(env.timer._active, true);
  assert.equal(env.timer._requestId, 'r2');
  env.timer.onTpsIdle({ requestId: 'r2', sessionId: 's1', epoch: 2 });
  assert.equal(env.timer._active, false);
});

test('ThinkTimer resets on session change and ignores the previous epoch', function () {
  const env = makeEnv();
  env.timer.start({ requestId: 'r1', sessionId: 's1', epoch: 4 });
  env.timer.onSessionChange({ sessionId: 's2' });
  assert.equal(env.timer._active, false);
  env.timer.onActivity({ requestId: 'r1', sessionId: 's1', epoch: 4, state: 'generating' });
  assert.equal(env.timer._active, false);
  env.timer.onActivity({ requestId: 'r2', sessionId: 's2', epoch: 5, state: 'generating' });
  assert.equal(env.timer._active, true);
  assert.equal(env.timer._requestId, 'r2');
  env.timer.stop();
});

test('ThinkTimer ignores events for a different session and accepts id completion for the same request', function () {
  const env = makeEnv();
  env.timer.onSessionChange({ sessionId: 's1' });
  env.timer.onActivity({ requestId: 'r1', sessionId: null, epoch: 1, state: 'generating' });
  assert.equal(env.timer._active, true);
  env.timer.onActivity({ requestId: 'r1', sessionId: 's1', epoch: 1, state: 'generating' });
  assert.equal(env.timer._sessionId, 's1');
  env.timer.onActivity({ requestId: 'old', sessionId: 's0', epoch: 2, state: 'generating' });
  assert.equal(env.timer._requestId, 'r1');
  env.timer.onSessionChange({ sessionId: null });
  assert.equal(env.timer._active, false);
});
