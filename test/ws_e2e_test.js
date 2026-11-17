// 端到端验证：broadcast 双通道（HTTP ws://3100 + HTTPS wss://3543）
// 流程：自签 JWT → 双通道各连一个 WS 客户端 → POST /api/tasks 发布测试任务
//       → 断言两个客户端都收到 checkin_task → DELETE 清理测试任务
// 用法：node test/ws_e2e_test.js
process.env.NODE_ENV = 'e2e';
require('dotenv').config();
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const http = require('http');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('FAIL: .env 缺少 JWT_SECRET'); process.exit(1); }

const token = jwt.sign({ userId: 'e2e-ws-test', role: 'admin', classScope: [] }, SECRET, { expiresIn: '3m' });
const AUTH = { 'x-auth-token': token, 'Content-Type': 'application/json' };

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url + '?token=' + encodeURIComponent(token), { rejectUnauthorized: false });
    const msgs = [];
    ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch (_) {} });
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout: ' + url)), 6000);
  });
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: 3100, path, method, headers: AUTH }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  let taskId = null;
  try {
    const c1 = await connect('ws://localhost:3100/');
    const c2 = await connect('wss://localhost:3543/');
    console.log('WS(3100) connected:', c1.ws.readyState === 1, '| WSS(3543) connected:', c2.ws.readyState === 1);

    const r = await api('POST', '/api/tasks', { date: new Date().toISOString().slice(0, 10), class_name: '__WS_E2E_TEST__', remark: '端到端测试任务，稍后自动删除' });
    console.log('POST /api/tasks:', JSON.stringify(r));
    if (r.code !== 0) throw new Error('发布任务失败');
    taskId = r.data.id;

    await new Promise(r2 => setTimeout(r2, 1200));
    const hit1 = c1.msgs.filter(m => m.type === 'checkin_task' && m.data && m.data.class_name === '__WS_E2E_TEST__');
    const hit2 = c2.msgs.filter(m => m.type === 'checkin_task' && m.data && m.data.class_name === '__WS_E2E_TEST__');
    console.log('WS(3100)  收到 checkin_task:', hit1.length > 0 ? 'YES ✅' : 'NO ❌');
    console.log('WSS(3543) 收到 checkin_task:', hit2.length > 0 ? 'YES ✅' : 'NO ❌');

    const ok = hit1.length > 0 && hit2.length > 0;
    console.log(ok ? '\n=== PASS：双通道广播均送达 ===' : '\n=== FAIL：存在通道未送达 ===');
    c1.ws.close(); c2.ws.close();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally {
    if (taskId) { try { await api('DELETE', '/api/tasks/' + taskId); console.log('测试任务已清理:', taskId); } catch (_) {} }
  }
})();
