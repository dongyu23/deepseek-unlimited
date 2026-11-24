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
  'modules/tpsmeter.js',
  'modules/demosearch.js',
  'modules/sessionsync.js',
  'modules/thinktimer.js',
  'modules/codedownload.js',
  'modules/sessionpin.js',
  'modules/officialanimations.js',
  'modules/preview.js',
  'modules/demopastetxt.js',
  'modules/tabtitle.js',
  'main.js', 'footer.js'
];

const header = read('header.user.js').trim();
const _ver = (header.match(/@version\s+([\d.]+)/) || [])[1] || '0.0.0';
let body = ORDER.map((f) => '\n/* ===== ' + f + ' ===== */\n' + read(f).trim()).join('\n');
body = body.replace(/version: '[^']*'/, "version: '" + _ver + "'");

// 资源内联：源码里的 __DCP_XXX__ 占位符替换成 src/assets 下对应文件内容。
// 官方标识 SVG 只存在于主站 bundle、没有静态 URL，只能随脚本分发——少了这步
// 左上角会直接渲染出占位符文本（2026-11-19 实测复现）
const ASSETS = { '__DCP_LOGO_SVG__': 'assets/official-logo.svg' };
Object.keys(ASSETS).forEach((k) => {
  const asset = read(ASSETS[k]).trim();
  if (!body.includes(k)) throw new Error('asset placeholder not found: ' + k);
  body = body.split(k).join(asset);
});

const userJs = header + '\n' + body + '\n';
const meta = header.split('\n').filter((l) => l.startsWith('// ==UserScript==') ||
  l.startsWith('// ==/UserScript==') || /^\/\/\s*@/.test(l)).join('\n') + '\n';

fs.writeFileSync(path.join(ROOT, 'deepseek-unlimited.user.js'), userJs);
fs.writeFileSync(path.join(ROOT, 'deepseek-unlimited.meta.js'), meta);

// 语法校验
const tmp = path.join(ROOT, '_check.js');
fs.writeFileSync(tmp, body);
try { execSync('node --check "' + tmp + '"', { stdio: 'inherit' }); }
finally { fs.unlinkSync(tmp); }

console.log('build ok: deepseek-unlimited.user.js', (userJs.length / 1024).toFixed(1) + 'KB',
  userJs.split('\n').length, 'lines');
