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
const { init: initStatisticsRoutes } = require('../routes/statistics');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initStatisticsRoutes(
    dbMock,
    () => {},
    () => {},
    () => {},
    () => {}
  );
  app.use(router);
  return app;
}

describe('Statistics API', () => {
  let app;
  const mockDb = {
    exec: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    mockDb.exec.mockReturnValue([{ values: [] }]);
    app = createApp(mockDb);
  });

  test('GET /api/stats 返回统计概览', async () => {
    mockDb.exec.mockReturnValue([{ values: [[0, 0, 0, 0]] }]);
    const res = await request(app).get('/api/stats').query({ days: 7 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  test('GET /api/stats/overview 返回今日概览', async () => {
    mockDb.exec.mockReturnValue([{ values: [[0]] }]);
    const res = await request(app).get('/api/stats/overview');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('code');
  });
});
