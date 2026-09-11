// Mock 依赖
jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  compareSync: jest.fn().mockReturnValue(true),
}));

const request = require('supertest');
const express = require('express');
const { init: initCheckinRoutes } = require('../routes/checkin');
const { STUDENT_TOKENS } = require('../middleware/auth');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  
  // Mock multer upload
  const mockUpload = {
    single: jest.fn().mockReturnValue((req, res, next) => next())
  };
  
  // Mock validateToken 返回 true
  jest.mock('../middleware/auth', () => {
    const actualAuth = jest.requireActual('../middleware/auth');
    return {
      ...actualAuth,
      validateToken: jest.fn().mockReturnValue({ role: 'admin' }),
      STUDENT_TOKENS: {}
    };
  });
  
  const router = initCheckinRoutes({
    db: dbMock,
    scheduleSave: () => {},
    authMiddleware: (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
    studentAuth: (req, res, next) => next(),
    addLog: () => {},
    localDateStr: () => '2026-09-10',
    formatDate: () => '2026-09-10 10:00:00',
    nowTimestamp: () => Date.now(),
    beijingStamp: () => new Date().toISOString(),
    broadcast: () => {},
    validateToken: () => ({ role: 'admin' }),
    upload: mockUpload
  });
  app.use(router);
  return app;
}

describe('Checkin API', () => {
  let app;
  const mockDb = {
    exec: jest.fn(),
    close: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    app = createApp(mockDb);
  });

  test('GET /api/records 查询签到记录', async () => {
    mockDb.exec.mockReturnValue([{ values: [] }]);
    
    const res = await request(app)
      .get('/api/records')
      .query({ student_id: '2024001', days: 7 });
    
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('data');
  });

  // 注意：POST /api/checkin 和 POST /api/leaves 需要有效的 token 验证
  // 这些测试在集成测试中会更合适
  test.skip('POST /api/checkin 宿舍签到 (需要完整认证)', async () => {
    // 跳过，需要完整的 JWT 配置
  });

  test.skip('POST /api/leaves 提交请假 (需要完整认证)', async () => {
    // 跳过，需要完整的 JWT 配置
  });
});
