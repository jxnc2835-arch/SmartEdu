// 量出各模型真实耗时，坐实 callLLM 里 配置模型 超时=8000ms 太短导致静默降级到 flash
// key 从 data/ai_config.json 读取（.env 可能被截断），仅本地前台运行，日志不打印 key
import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
let KEY = process.env.ZHIPU_AI_API_KEY || '';
if (!KEY) {
  try { KEY = localRequire('../data/ai_config.json').apiKey || ''; } catch (e) {}
}
const BASE = (process.env.ZHIPU_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
const q = '用两三句话解释什么是考勤管理，并给出两条建议';

async function time(model, maxMs) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), maxMs);
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: q }], temperature: 0.7, max_tokens: 400 }),
      signal: ctl.signal,
    });
    const j = await r.json();
    const ms = Date.now() - t0;
    const ok = r.status === 200 && j.choices;
    console.log(`${model}  ${maxMs}ms窗口  → HTTP ${r.status} ${ms}ms ${ok ? '✅完整' : '❌ ' + String(j.error?.message || j.message || '').slice(0, 40)}`);
  } catch (e) {
    console.log(`${model}  ${maxMs}ms窗口  → ${e.name === 'AbortError' ? '超时/取消(ERR_CANCELED)' : String(e.message).slice(0, 40)}  ${Date.now() - t0}ms`);
  }
  clearTimeout(timer);
}

(async () => {
  if (!KEY) { console.log('无 API key，退出'); return; }
  console.log('--- 模拟 callLLM 现状: 配置模型只给 8000ms 窗口 ---');
  await time('glm-4.7', 8000);
  await time('glm-4.7', 8000);
  console.log('--- 放宽到 60000ms ---');
  await time('glm-4.7', 60000);
  console.log('--- flash 对照 ---');
  await time('glm-4-flash', 30000);
})();
