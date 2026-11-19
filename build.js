/* 构建脚本：按固定顺序拼接 src → 根目录 .user.js / .meta.js */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const ORDER = [
  'bootstrap.js',
  'core/config.js', 'core/selectors.js', 'core/utils.js', 'core/i18n.js',
  'modules/toolbar.js',
  'modules/demoapi.js',
  'modules/demobridge.js',
  'modules/ctxring.js',
  'modules/demosearch.js',
  'modules/demopastetxt.js',
  'modules/tabtitle.js',
  'main.js', 'footer.js'
];

const header = read('header.user.js').trim();
const _ver = (header.match(/@version\s+([\d.]+)/) || [])[1] || '0.0.0';
let body = ORDER.map((f) => '\n/* ===== ' + f + ' ===== */\n' + read(f).trim()).join('\n');
body = body.replace(/version: '[^']*'/, "version: '" + _ver + "'");

const userJs = header + '\n' + body + '\n';
const meta = header.split('\n').filter((l) => l.startsWith('// ==UserScript==') ||
  l.startsWith('// ==/UserScript==') || /^\/\/\s*@/.test(l)).join('\n') + '\n';

fs.writeFileSync(path.join(ROOT, 'deepseek-chat-demo-plus.user.js'), userJs);
fs.writeFileSync(path.join(ROOT, 'deepseek-chat-demo-plus.meta.js'), meta);

// 语法校验
const tmp = path.join(ROOT, '_check.js');
fs.writeFileSync(tmp, body);
try { execSync('node --check "' + tmp + '"', { stdio: 'inherit' }); }
finally { fs.unlinkSync(tmp); }

console.log('build ok: deepseek-chat-demo-plus.user.js', (userJs.length / 1024).toFixed(1) + 'KB',
  userJs.split('\n').length, 'lines');
