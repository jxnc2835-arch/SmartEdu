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

// 回归测试：多班级辅导员场景下，公开接口 SQL 参数数量必须与占位符匹配
// 背景：/api/dorms/public 和 /api/class-trend/public 在修复前用单 `?` 处理多班级，
//       导致参数数量与 IN (?,?) 占位符不一致。
describe('Dashboard - Multi-class Counselor Regression', () => {
  let mockDb;

  function createAppWithCounselor(dbMock, allowedClasses) {
    const app = express();
    const validateToken = () => ({
      role: 'counselor',
      userId: 2,
      allowed_classes: allowedClasses,
      classScope: allowedClasses
    });
    const router = initDashboardRoutes(dbMock, validateToken);
    // 在路由前注入 counselor token 解析结果，模拟已带有效 token 的辅导员请求
    app.use((req, res, next) => {
      req.headers['x-auth-token'] = 'counselor-token';
      next();
    });
    app.use(router);
    return app;
  }

  beforeEach(() => {
    mockDb = { exec: jest.fn() };
    mockDb.exec.mockReturnValue([{ values: [] }]);
  });

  test('/api/dorms/public 多班级：SQL 占位符数量 = 参数数量（IN 模式）', async () => {
    const app = createAppWithCounselor(mockDb, ['A班', 'B班']);
    await request(app).get('/api/dorms/public');
    const dormCall = mockDb.exec.mock.calls.find(([sql]) =>
      sql.includes('FROM dorms') && sql.includes('d.building'));
    expect(dormCall).toBeDefined();
    const [sql, params] = dormCall;
    const placeholderCount = (sql.match(/\?/g) || []).length;
    // f.params = ['A班','B班']，params = [...f.params, ...f.params] = 4
    // SQL 含 2 个 IN (?,?) 子句（countCond + existsCond），共 4 个占位符
    expect(placeholderCount).toBe(params.length);
  });

  test('/api/class-trend/public 多班级：SQL 占位符数量 = 参数数量（IN 模式）', async () => {
    const app = createAppWithCounselor(mockDb, ['A班', 'B班']);
    await request(app).get('/api/class-trend/public').query({ days: 7 });
    const trendCall = mockDb.exec.mock.calls.find(([sql]) =>
      sql.includes('GROUP BY r.date') && sql.includes('r.type'));
    expect(trendCall).toBeDefined();
    const [sql, params] = trendCall;
    const placeholderCount = (sql.match(/\?/g) || []).length;
    // SQL: r.date >= ? AND r.date <= ? AND r.class_name IN (?,?)  → 4 个占位符
    // params = [startDate, endDate, 'A班', 'B班'] = 4
    expect(placeholderCount).toBe(params.length);
    expect(params).toHaveLength(4);
    expect(params[2]).toBe('A班');
    expect(params[3]).toBe('B班');
  });

  test('/api/dorms/public 单班级：SQL 占位符数量 = 参数数量（单 ? 模式）', async () => {
    const app = createAppWithCounselor(mockDb, ['A班']);
    await request(app).get('/api/dorms/public');
    const dormCall = mockDb.exec.mock.calls.find(([sql]) =>
      sql.includes('FROM dorms') && sql.includes('d.building'));
    expect(dormCall).toBeDefined();
    const [sql, params] = dormCall;
    const placeholderCount = (sql.match(/\?/g) || []).length;
    // f.params = ['A班']，params = ['A班', 'A班'] = 2
    // SQL: s2.class_name=? + EXISTS s.class_name=? → 2 个占位符
    expect(placeholderCount).toBe(params.length);
    expect(params).toEqual(['A班', 'A班']);
  });

  test('/api/class-trend/public 单班级：SQL 占位符数量 = 参数数量（单 ? 模式）', async () => {
    const app = createAppWithCounselor(mockDb, ['A班']);
    await request(app).get('/api/class-trend/public').query({ days: 7 });
    const trendCall = mockDb.exec.mock.calls.find(([sql]) =>
      sql.includes('GROUP BY r.date') && sql.includes('r.type'));
    expect(trendCall).toBeDefined();
    const [sql, params] = trendCall;
    const placeholderCount = (sql.match(/\?/g) || []).length;
    // SQL: r.date >= ? AND r.date <= ? AND r.class_name=? → 3 个占位符
    // params = [startDate, endDate, 'A班'] = 3
    expect(placeholderCount).toBe(params.length);
    expect(params).toHaveLength(3);
    expect(params[2]).toBe('A班');
  });
});
