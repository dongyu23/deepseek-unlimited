/* 构建脚本：按固定顺序拼接 src → 根目录 .user.js / .meta.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const ORDER = [
  'bootstrap.js',
  'core/config.js', 'core/selectors.js', 'core/utils.js', 'core/ui.js', 'core/i18n.js',
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
  'modules/continuegen.js',
  'modules/editcaret.js',
  'modules/officialanimations.js',
  'modules/preview.js',
  'modules/demopastetxt.js',
  'modules/tabtitle.js',
  'main.js', 'footer.js'
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC)
  .filter((file) => file.endsWith('.js') && path.basename(file) !== 'header.user.js')
  .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
  .sort();
const ordered = ORDER.slice().sort();
const missing = sourceFiles.filter((file) => !ordered.includes(file));
const stale = ordered.filter((file) => !sourceFiles.includes(file));
if (missing.length || stale.length) {
  throw new Error('build manifest mismatch: missing=[' + missing.join(',') + '] stale=[' + stale.join(',') + ']');
}

const header = read('header.user.js').trim();
const _ver = (header.match(/@version\s+([\d.]+)/) || [])[1] || '0.0.0';
let body = ORDER.map((f) => '\n/* ===== ' + f + ' ===== */\n' + read(f).trim()).join('\n');
body = body.replace(/version: '[^']*'/, "version: '" + _ver + "'");

// 资源内联：源码里的 __DCP_XXX__ 占位符替换成 src/assets 下对应文件内容。
// 官方标识 SVG 只存在于主站 bundle、没有静态 URL，只能随脚本分发——少了这步
// 左上角会渲染出占位符文本（2026-11-19 实测踩到）
const ASSETS = { '__DCP_LOGO_SVG__': 'assets/official-logo.svg' };
Object.keys(ASSETS).forEach((k) => {
  const asset = read(ASSETS[k]).trim();
  if (!body.includes(k)) throw new Error('asset placeholder not found: ' + k);
  body = body.split(k).join(asset);
});

const userJs = header + '\n' + body + '\n';
const meta = header.split('\n').filter((l) => l.startsWith('// ==UserScript==') ||
  l.startsWith('// ==/UserScript==') || /^\/\/\s*@/.test(l)).join('\n') + '\n';

// 先在独立临时目录校验，成功后再原子替换产物；并行构建不共享 _check.js。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-build-'));
try {
  const checkFile = path.join(tmpDir, '_check.js');
  fs.writeFileSync(checkFile, body);
  execFileSync(process.execPath, ['--check', checkFile], { stdio: 'inherit' });

  const userTmp = path.join(ROOT, '.deepseek-unlimited.user.js.tmp');
  const metaTmp = path.join(ROOT, '.deepseek-unlimited.meta.js.tmp');
  fs.writeFileSync(userTmp, userJs);
  fs.writeFileSync(metaTmp, meta);
  fs.renameSync(userTmp, path.join(ROOT, 'deepseek-unlimited.user.js'));
  fs.renameSync(metaTmp, path.join(ROOT, 'deepseek-unlimited.meta.js'));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('build ok: deepseek-unlimited.user.js', (userJs.length / 1024).toFixed(1) + 'KB',
  userJs.split('\n').length, 'lines');
