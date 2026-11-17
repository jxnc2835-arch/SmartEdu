/**
 * 模拟 teacher.html 页面加载，捕获运行时错误
 * 按浏览器实际顺序：head外链脚本(跳过) → 模块脚本 → body内联脚本
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'teacher.html'), 'utf8');

// 收集按顺序出现的 <script src=...>（本地模块）和内联脚本
const scriptRefs = [];
const re = /<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html)) !== null) {
  scriptRefs.push({ src: m[1] || null, inline: m[2] });
}

const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on('jsdomError', (e) => {
  // 忽略资源加载类错误（外部CDN在jsdom里抓不到）
  if (e.detail && (e.detail.message || '').includes('Could not load')) return;
  errors.push('jsdomError: ' + (e.message || String(e)) + (e.detail ? '\n' + (e.detail.stack || '').split('\n').slice(0, 5).join('\n') : ''));
});
virtualConsole.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  url: 'http://localhost:3100/teacher.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

// mock fetch（页面加载时刷新CSRF token等会调用）
window.fetch = async (url, opts) => {
  return {
    ok: true, status: 200,
    json: async () => ({ code: 0, data: {} }),
    text: async () => JSON.stringify({ code: 0, data: {} }),
    headers: { get: () => 'application/json' },
  };
};
// mock WebSocket
window.WebSocket = class {
  constructor(url, sub) { this.readyState = 0; setTimeout(() => this.onclose && this.onclose(), 10); }
  close() {}
  send() {}
};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));

// 按顺序执行本地模块
(async () => {
  for (const s of scriptRefs) {
    if (s.src && s.src.startsWith('js/modules/')) {
      const code = fs.readFileSync(path.join(ROOT, 'public', s.src), 'utf8');
      try {
        window.eval(code);
      } catch (e) {
        errors.push(`MODULE ${s.src} threw: ${e.message}\n${e.stack.split('\n').slice(0, 4).join('\n')}`);
      }
    } else if (s.src) {
      // 外链 CDN (chart.js/face-api/qrcode) 在jsdom中无法加载，跳过并打桩
      if (s.src.includes('chart.js')) {
        window.eval(`window.Chart = class { constructor(){} static plugin={}; destroy(){} };`);
      }
      // face-api / qrcode 打空桩
    } else if (s.inline && s.inline.trim()) {
      try {
        window.eval(s.inline);
      } catch (e) {
        errors.push(`INLINE script threw: ${e.message}\n${e.stack.split('\n').slice(0, 6).join('\n')}`);
      }
    }
  }
  // 给启动逻辑（setTimeout 50/100ms）一点时间
  await new Promise(r => setTimeout(r, 300));

  console.log('=== 模块加载结果 ===');
  const fns = ['loadOverview', 'loadCheckin', 'loadDormStats', 'loadStats', 'loadUsers', 'loadBackups', 'initApp', 'doLogin', 'exportRecords', 'safeSetInnerHTML', 'renderPagedTable'];
  fns.forEach(f => {
    console.log(`  window.${f}: ${window[f] ? 'OK' : '❌ 缺失'}`);
  });
  console.log('\n=== 运行时错误 ===');
  if (errors.length === 0) console.log('  无错误 ✓');
  else errors.forEach(e => console.log(e + '\n'));
  process.exit(0);
})();
