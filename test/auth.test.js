// auth 路由集成测试
jest.mock('../utils/helpers', () => ({
  nowTimestamp: jest.fn(() => '2026-09-12 12:00:00'),
  localDateStr: jest.fn(() => '2026-09-12'),
  formatDate: jest.fn((d) => String(d)),
  beijingStamp: jest.fn(() => '2026-09-12T12-00-00'),
  saveBase64Photo: jest.fn(),
  clampedToday: jest.fn(() => '2026-09-12'),
  beijingDateStr: jest.fn(() => '2026-09-12'),
}));

const request = require('supertest');
const express = require('express');
const { init: initAuth } = require('../routes/auth');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initAuth({
    db: dbMock, scheduleSave: jest.fn(), authMiddleware: (r, res, n) => { r.user = { userId: 'admin', role: 'admin' }; n(); },
    requireRole: (...roles) => (r, res, n) => n(),
    generateToken: jest.fn(() => 'test-jwt-token'),
    STUDENT_TOKENS: new Map(), RESET_TOKENS: new Map(), STUDENT_TOKEN_EXPIRY: 8 * 3600 * 1000,
    addLog: jest.fn(), localDateStr: () => '2026-09-12', formatDate: () => '2026-09-12',
    nowTimestamp: () => '2026-09-12T12:00:00', saveBase64Photo: jest.fn(),
    beijingStamp: () => '2026-09-12T12-00-00', compressImage: jest.fn(),
    checkLoginRateLimit: () => ({ allowed: true, remaining: 5 }),
    LOGIN_ATTEMPTS: {},
  });
  app.use(router);
  return app;
}

describe('routes/auth', () => {
  const bcrypt = require('bcryptjs');
  const hashedPwd = bcrypt.hashSync('admin123', 12);
  const dbExec = jest.fn();
  const dbMock = { exec: dbExec, run: jest.fn() };

  beforeEach(() => {
    dbExec.mockClear();
  });

  test('POST /api/login 成功登录', async () => {
    dbExec.mockReturnValue([{ values: [['admin', 'admin', hashedPwd, 'admin', '管理员', '']] }]);
    const app = createApp(dbMock);
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'admin123' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.token).toBeDefined();
  });

  test('POST /api/login 密码错误', async () => {
    dbExec.mockReturnValue([{ values: [['admin', 'admin', hashedPwd, 'admin', '管理员', '']] }]);
    const app = createApp(dbMock);
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(1);
  });

  test('GET /api/me 返回当前用户信息', async () => {
    dbExec.mockReturnValue([{ values: [['管理员', '']] }]);
    const app = createApp(dbMock);
    const res = await request(app).get('/api/me').set('x-auth-token', 'test-jwt-token');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
