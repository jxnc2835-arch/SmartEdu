// Debug script for system.js report endpoint
process.env.JWT_SECRET = 'test-secret-for-unit-testing-only-32ch!';
const express = require('express');
const dbMock = {
  exec(sql, params) {
    console.log('EXEC:', sql.substring(0, 100));
    return [{ values: [] }];
  },
  run(sql, params) {
    console.log('RUN:', sql.substring(0, 100));
  }
};
const app = express();
app.use(express.json());
const { init } = require('./routes/system');
const router = init(dbMock, () => {}, () => {}, () => {}, () => {}, () => {}, null, null, null, null, 'C:/x', 'C:/x/uploads', 'C:/x/backups');
app.use(router);
app.use((e, r, q, n) => {
  console.log('CATCH:', e.message.substring(0, 300));
  q.status(500).json({ code: 1, message: e.message });
});
const s = app.listen(0, async () => {
  const port = s.address().port;
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ userId: 'admin', role: 'admin', classScope: [] }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const r = await fetch('http://localhost:' + port + '/api/report', { headers: { 'x-auth-token': token } });
  console.log('STATUS:', r.status);
  const d = await r.text();
  console.log('BODY:', d.substring(0, 500));
  s.close();
});
