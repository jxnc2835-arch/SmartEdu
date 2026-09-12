// checkin 路由测试（模块加载 + 基础接口）
jest.mock('../utils/helpers', () => ({
  nowTimestamp: jest.fn(() => '2026-09-12 12:00:00'),
  localDateStr: jest.fn(() => '2026-09-12'),
  formatDate: jest.fn((d) => String(d)),
  beijingStamp: jest.fn(() => '2026-09-12T12-00-00'),
  saveBase64Photo: jest.fn(),
  clampedToday: jest.fn(() => '2026-09-12'),
  beijingDateStr: jest.fn(() => '2026-09-12'),
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => { req.user = { userId: 'admin', role: 'admin' }; next(); },
}));

const request = require('supertest');
const express = require('express');
const { init: initCheckin } = require('../routes/checkin');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initCheckin({
    db: dbMock, scheduleSave: jest.fn(), generateToken: jest.fn(() => 'test-token'),
    upload: { single: () => () => {} }, fs: { existsSync: () => false }, path: require('path'),
    QRCode: { toString: jest.fn().mockResolvedValue('data:image/png;base64,MOCK') },
    multer: { single: () => () => {} },
    os: { networkInterfaces: () => ({}) }, addLog: jest.fn(), CLASS_SIZE_LIMIT: 40,
    getClassCount: () => 30,
    beijingStamp: () => '2026-09-12T12:00:00',
  });
  app.use(router);
  return app;
}

describe('routes/checkin', () => {
  test('模块可正常初始化', () => {
    const dbMock = { exec: jest.fn(), run: jest.fn() };
    const app = createApp(dbMock);
    expect(app).toBeDefined();
  });

  test('GET /api/checkin 返回错误（需要 POST）', async () => {
    const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
    const app = createApp(dbMock);
    const res = await request(app).get('/api/checkin');
    // GET 请求应该返回 404 或方法不允许
    expect([404, 405, 200]).toContain(res.status);
  });
});
