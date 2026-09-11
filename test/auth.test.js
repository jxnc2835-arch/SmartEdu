// Mock bcryptjs 的 compare 方法，使其始终返回 true，避免真实哈希校验
jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  compareSync: jest.fn().mockReturnValue(true),
}));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
// Ensure bcrypt.compare always resolves true for login tests
bcrypt.compare = jest.fn().mockResolvedValue(true);
const { init: initAuthRoutes } = require('../routes/auth');

// 创建一个最小化的 Express 应用用于测试
function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initAuthRoutes({
    db: dbMock,
    scheduleSave: () => {},
    authMiddleware: (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
    generateToken: () => 'test-token',
    STUDENT_TOKENS: {},
    RESET_TOKENS: {},
    STUDENT_TOKEN_EXPIRY: 0,
    addLog: () => {},
    localDateStr: () => '2026-01-01',
    formatDate: () => '2026-01-01',
    nowTimestamp: () => Date.now(),
    saveBase64Photo: () => {},
    beijingStamp: () => new Date().toISOString(),
    compressImage: () => {},
    checkLoginRateLimit: () => ({ allowed: true, remaining: 5 }),
    LOGIN_ATTEMPTS: {}
  });
  app.use(router);
  return app;
}

describe('Auth API', () => {
  let app;
  const mockDb = {
    exec: jest.fn().mockReturnValue([
      {
        values: [[
          1,
          'admin',
          // A bcrypt‑compatible hash placeholder that satisfies the regex /^\$[234]\d?\$/
          '$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'admin',
          'Admin',
          ''
        ]]
      }
    ]),
  };

  beforeAll(() => {
    app = createApp(mockDb);
  });

  test('POST /api/login 成功返回 token', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'any' });
    console.log('TEST RESPONSE:', res.body);
    expect(res.statusCode).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body).toHaveProperty('token');
  });
});
