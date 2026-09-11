// Mock auth to bypass token validation in tests
jest.mock('../middleware/auth', () => {
  const actualAuth = jest.requireActual('../middleware/auth');
  return {
    ...actualAuth,
    authMiddleware: (req, res, next) => {
      req.user = { role: 'admin', userId: 1, classScope: [] };
      next();
    },
    requireRole: () => (req, res, next) => next(),
    filterByUserClass: (req, res, next) => next()
  };
});

const request = require('supertest');
const express = require('express');
const { init: initDashboardRoutes } = require('../routes/dashboard');

function createApp(dbMock) {
  const app = express();
  const router = initDashboardRoutes(dbMock, () => null);
  app.use(router);
  return app;
}

describe('Dashboard API', () => {
  let app;
  const mockDb = {
    exec: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    mockDb.exec.mockReturnValue([{ values: [] }]);
    app = createApp(mockDb);
  });

  test('GET /api/classes/public 返回班级列表', async () => {
    const res = await request(app).get('/api/classes/public');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('code');
  });

  test('GET /api/classes/counts 返回班级人数统计', async () => {
    const res = await request(app).get('/api/classes/counts');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  test('GET /api/students/by-class 返回学生列表', async () => {
    const res = await request(app).get('/api/students/by-class').query({ class_name: '计算机1班' });
    expect(res.statusCode).toBe(200);
  });

  test('GET /api/dashboard/public 返回大屏数据', async () => {
    const res = await request(app).get('/api/dashboard/public');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  test('GET /api/course-checkin/public 返回课堂签到数据', async () => {
    const res = await request(app).get('/api/course-checkin/public');
    expect(res.statusCode).toBe(200);
  });

  test('GET /api/dorms/public 返回宿舍数据', async () => {
    const res = await request(app).get('/api/dorms/public');
    expect(res.statusCode).toBe(200);
  });

  test('GET /api/class-trend/public 返回班级趋势', async () => {
    mockDb.exec.mockReturnValue([{ values: [] }]);
    const res = await request(app).get('/api/class-trend/public').query({ days: 7 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  test('GET /api/stats/conduct/public 返回操行评分', async () => {
    mockDb.exec.mockReturnValue([{ values: [] }]);
    const res = await request(app).get('/api/stats/conduct/public');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  test('GET /api/stats/attention/public 返回重点关注学生', async () => {
    mockDb.exec.mockReturnValue([{ values: [] }]);
    const res = await request(app).get('/api/stats/attention/public');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });
});
