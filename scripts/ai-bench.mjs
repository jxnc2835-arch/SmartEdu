// AI 实测：延迟 / 意图路由 / 是否触发回退  （node scripts/ai-bench.mjs）
import fs from 'node:fs';

const base = 'http://localhost:3000';
const loginRes = await fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const login = await loginRes.json();
const token = login.token;

const cases = [
  { label: '业务-今日签到', q: '今天签到率怎么样' },
  { label: '业务-高风险名单', q: '哪些学生是高风险' },
  { label: '通用-写短信', q: '给未归学生家长写一条提醒短信，语气委婉' },
  { label: '通用-知识', q: 'TCP和UDP的区别' },
  { label: '通用-建议', q: '如何缓解考前焦虑' },
];

for (const c of cases) {
  const t0 = Date.now();
  const url = base + '/ai/smart?question=' + encodeURIComponent(c.q) + '&session_id=bench_' + Date.now();
  const r = await fetch(url, { headers: { 'x-auth-token': token } });
  const ms = Date.now() - t0;
  let j;
  try { j = await r.json(); } catch (e) { console.log(`${c.label}: HTTP ${r.status} ${ms}ms (非JSON)`); continue; }
  const d = j.data || {};
  const head = (d.answer || '').replace(/\n/g, ' ').slice(0, 60);
  console.log(`\n${c.label} | ${ms}ms | source=${d.source} | intent=${d.intent} | model=${d.modelInfo?.model || '-'} | suggestions=${(d.suggestions || []).length}`);
  console.log(`  答: ${head}...`);
}
