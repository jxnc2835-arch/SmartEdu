/**
 * 集成测试 - 端到端流程验证
 */
const request = require('supertest');
const express = require('express');
const { init: initAuthRoutes } = require('../routes/auth');
const { init: initStudentsRoutes } = require('../routes/students');
const { init: initCheckinRoutes } = require('../routes/checkin');
const { init: initDashboardRoutes } = require('../routes/dashboard');
const { init: initStatisticsRoutes } = require('../routes/statistics');

// Mock bcrypt
jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  compareSync: jest.fn().mockReturnValue(true),
}));

jest.mock('../middleware/auth', () => {
  const actual = jest.requireActual('../middleware/auth');
  return {
    ...actual,
    authMiddleware: (req, res, next) => {
      req.user = { role: 'admin', userId: 1, classScope: [] };
      next();
    },
    requireRole: () => (req, res, next) => next(),
    filterByUserClass: (req, res, next) => next()
  };
});

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  
  // 挂载所有路由
  app.use(initAuthRoutes({
    db: dbMock, scheduleSave: () => {}, authMiddleware: (r, res, next) => next(),
    requireRole: () => (r, res, next) => next(), generateToken: () => 'test-token',
    STUDENT_TOKENS: {}, RESET_TOKENS: {}, STUDENT_TOKEN_EXPIRY: 0, addLog: () => {},
    localDateStr: () => '2026-09-11', formatDate: () => '2026-09-11',
    nowTimestamp: () => Date.now(), saveBase64Photo: () => {},
    beijingStamp: () => new Date().toISOString(), compressImage: () => {},
    checkLoginRateLimit: () => ({ allowed: true, remaining: 5 }), LOGIN_ATTEMPTS: {}
  }));
  app.use(initStudentsRoutes({
    db: dbMock, scheduleSave: () => {}, nowTimestamp: () => Date.now(),
    authMiddleware: (r, res, next) => next(), requireRole: () => (r, res, next) => next(),
    bcrypt: require('bcryptjs'), upload: { single: () => (r, res, next) => next() },
    addLog: () => {}, CLASS_SIZE_LIMIT: 500, getClassCount: () => 0,
    limitPerClass: () => 500, beijingStamp: () => new Date().toISOString()
  }));
  app.use(initCheckinRoutes({
    db: dbMock, scheduleSave: () => {}, authMiddleware: (r, res, next) => next(),
    requireRole: () => (r, res, next) => next(), studentAuth: (r, res, next) => next(),
    addLog: () => {}, localDateStr: () => '2026-09-11', formatDate: () => '2026-09-11',
    nowTimestamp: () => Date.now(), beijingStamp: () => new Date().toISOString(),
    broadcast: () => {}, validateToken: () => ({ role: 'admin' }),
    upload: { single: () => (r, res, next) => next() }
  }));
  app.use(initDashboardRoutes(dbMock, () => null));
  app.use(initStatisticsRoutes(dbMock, () => {}, () => {}, () => {}, () => {}));
  
  return app;
}

describe('Integration Tests - Full Workflow', () => {
  let app;
  const mockDb = {
    exec: jest.fn(),
    run: jest.fn().mockReturnValue({ lastID: 1, changes: 1 }),
    close: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    mockDb.run.mockClear();
    // 默认返回空数据
    mockDb.exec.mockReturnValue([{ values: [] }]);
    app = createApp(mockDb);
  });

  describe('登录流程', () => {
    test('POST /api/login 返回 token', async () => {
      mockDb.exec.mockReturnValue([{ values: [[1, 'admin', '$2b$10$aaaaaa', 'admin', '管理员', '']] }]);
      
      const res = await request(app)
        .post('/api/login')
        .send({ username: 'admin', password: 'test' });
      
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body).toHaveProperty('token');
    });
  });

  describe('学生管理流程', () => {
    test('GET /api/students 返回学生列表', async () => {
      mockDb.exec.mockReturnValue([{ values: [[1, '2024001', '张三', '男生', '计算机1班', 'A栋101', '13800001001', '', 0, '']] }]);
      
      const res = await request(app).get('/api/students').query({ page: 1, pageSize: 10 });
      
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('data');
    });

    test('POST /api/students 创建学生', async () => {
      mockDb.run.mockReturnValue({ lastID: 16 });
      
      const res = await request(app)
        .post('/api/students')
        .send({
          name: '测试学生',
          gender: '男生',
          class_name: '计算机1班',
          dorm: 'A栋101'
        });
      
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  describe('查寝流程', () => {
    test('GET /api/records 返回签到记录', async () => {
      mockDb.exec.mockReturnValue([{ values: [] }]);
      
      const res = await request(app)
        .get('/api/records')
        .query({ date: '2026-09-11', page: 1, limit: 10 });
      
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
    });

    test('POST /api/checkin 提交签到', async () => {
      mockDb.exec
        .mockReturnValueOnce([{ values: [[1]] }])
        .mockReturnValue([{ values: [] }]);
      
      const res = await request(app)
        .post('/api/checkin')
        .send({
          student_id: '2024001',
          type: 'checkin',
          dorm: 'A栋101',
          lat: 39.9,
          lng: 116.4
        });
      
      expect(res.statusCode).toBe(200);
    });
  });

  describe('大屏公开 API', () => {
    test('GET /api/dashboard/public 返回大屏数据', async () => {
      mockDb.exec.mockReturnValue([{ values: [[0], [0, 0, 0]] }]);
      
      const res = await request(app).get('/api/dashboard/public');
      
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('data');
    });

    test('GET /api/stats 返回统计概览', async () => {
      mockDb.exec.mockReturnValue([{ values: [[0, 0, 0, 0]] }]);
      
      const res = await request(app).get('/api/stats').query({ days: 7 });
      
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('data');
    });
  });
});
