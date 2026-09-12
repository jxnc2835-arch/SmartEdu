// checkin 路由集成测试
// 先 mock setInterval，再清除缓存后 require，确保模块级 setInterval 被拦截
jest.mock('../utils/alerts-sync', () => ({
  syncAlertsForToday: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));
jest.mock('sharp', () => jest.fn().mockReturnValue({
  metadata: jest.fn().mockResolvedValue({ width: 100, height: 100 }),
}));
jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  compareSync: jest.fn().mockReturnValue(true),
  hash: jest.fn().mockResolvedValue('hashed'),
}));
jest.mock('../utils/helpers', () => ({
  nowTimestamp: jest.fn(() => '2026-09-12 12:00:00'),
  localDateStr: jest.fn(() => '2026-09-12'),
  formatDate: jest.fn((d) => String(d)),
  beijingStamp: jest.fn(() => '2026-09-12T12-00-00'),
  saveBase64Photo: jest.fn(),
  clampedToday: jest.fn(() => '2026-09-12'),
  beijingDateStr: jest.fn(() => '2026-09-12'),
}));
// routes/checkin.js 顶层解构了 authMiddleware/studentAuth/STUDENT_TOKENS/RESET_TOKENS/
// STUDENT_TOKEN_EXPIRY/validateToken/generateToken，mock 必须全部补齐，
// 否则 STUDENT_TOKENS 为 undefined → checkin 401、leaves 抛 TypeError(500)
jest.mock('../middleware/auth', () => {
  const STUDENT_TOKENS = {};
  const RESET_TOKENS = {};
  return {
    authMiddleware: (req, res, next) => { req.user = { userId: 'admin', role: 'admin' }; next(); },
    requireRole: (...roles) => (req, res, next) => next(),
    studentAuth: (req, res, next) => next(),
    STUDENT_TOKENS,
    RESET_TOKENS,
    STUDENT_TOKEN_EXPIRY: 8 * 3600 * 1000,
    validateToken: (t) => (t === 'test-token' ? { userId: 'admin', role: 'admin' } : false),
    generateToken: () => 'test-token',
    setDb: () => {},
  };
});

const request = require('supertest');
const express = require('express');

function createApp(dbMock) {
  // 每次测试前清除模块缓存，确保 setInterval mock 生效
  delete require.cache[require.resolve('../routes/checkin')];
  const { init: initCheckin } = require('../routes/checkin');
  const app = express();
  app.use(express.json());
  // upload.single() 的 mock 必须调用 next()，否则请求永远挂起 → 测试超时
  const noopUploadMiddleware = () => (req, res, next) => next();
  const router = initCheckin({
    db: dbMock,
    scheduleSave: jest.fn(),
    generateToken: jest.fn(() => 'test-token'),
    upload: { single: () => noopUploadMiddleware() },
    fs: { existsSync: () => false },
    path: require('path'),
    QRCode: { toString: jest.fn().mockResolvedValue('data:image/png;base64,MOCK') },
    multer: { single: () => noopUploadMiddleware() },
    os: { networkInterfaces: () => ({}) },
    addLog: jest.fn(),
    CLASS_SIZE_LIMIT: 40,
    getClassCount: () => 30,
    beijingStamp: () => '2026-09-12T12:00:00',
    broadcast: () => {},
    validateToken: () => ({ role: 'admin' }),
  });
  app.use(router);
  return app;
}

describe('routes/checkin', () => {
  const dbExec = jest.fn().mockReturnValue([{ values: [] }]);
  const dbMock = { exec: dbExec, run: jest.fn() };

  beforeEach(() => {
    dbExec.mockClear();
    dbMock.run.mockClear();
  });

  test('POST /api/checkin 签到成功', async () => {
    dbExec.mockReturnValue([{ values: [['s001', '张三', 'hash', 'student', '', '']] }]);
    dbMock.run.mockReturnValue({ changes: 1 });

    const app = createApp(dbMock);
    const res = await request(app).post('/api/checkin')
      .set('x-auth-token', 'test-token')
      .send({ student_id: 's001', date: '2026-09-12', type: 'checkin', status: '在寝' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  test('POST /api/checkin 未知学号以学号兜底（不校验学生存在）', async () => {
    dbExec.mockReturnValue([]);
    const app = createApp(dbMock);
    const res = await request(app).post('/api/checkin')
      .set('x-auth-token', 'test-token')
      .send({ student_id: 'unknown', date: '2026-09-12', type: 'checkin', status: '在寝' });

    expect(res.status).toBe(200);
    // 路由当前设计不校验学生是否存在（姓名缺失时以学号兜底），返回 code 0
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('签到成功');
  });

  test('GET /api/records 返回记录列表', async () => {
    dbExec.mockReturnValue([{ values: [['r001', 's001', '2026-09-12', '08:00', 'checkin', '在寝']] }]);
    const app = createApp(dbMock);
    const res = await request(app).get('/api/records').query({ date: '2026-09-12' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  test('POST /api/leaves 提交请假', async () => {
    // leaves 路由从 middleware/auth 的 STUDENT_TOKENS 取学生令牌，需先种入
    const { STUDENT_TOKENS } = require('../middleware/auth');
    STUDENT_TOKENS['stu_test'] = { student_id: 's001', name: '张三', expiresAt: Date.now() + 3600 * 1000 };
    dbMock.run.mockReturnValue({ changes: 1 });
    const app = createApp(dbMock);
    const res = await request(app).post('/api/leaves')
      .set('x-student-token', 'stu_test')
      .send({ student_id: 's001', type: '病假', reason: '感冒', start_date: '2026-09-12', end_date: '2026-09-13' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  test('GET /api/leaves 返回请假列表', async () => {
    dbExec.mockReturnValue([{ values: [['l001', 's001', '病假', '感冒', '2026-09-12', '2026-09-13', null, 'pending']] }]);
    const app = createApp(dbMock);
    const res = await request(app).get('/api/leaves');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
