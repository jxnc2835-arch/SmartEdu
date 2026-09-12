// ==================== 高级统计路由测试 ====================
jest.mock('../utils/helpers', () => ({
  localDateStr: jest.fn(() => '2026-09-12'),
  formatDate: jest.fn(),
  nowTimestamp: jest.fn(() => '2026-09-12 12:00:00'),
  beijingDateStr: jest.fn((d) => d ? '2026-08-13' : '2026-09-12')
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    req.user = { userId: 'admin', role: 'admin', allowed_classes: [] };
    next();
  },
  requireRole: (...roles) => (req, res, next) => next()
}));

const request = require('supertest');
const express = require('express');
const { init: initAdvancedStats } = require('../routes/advanced-stats');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initAdvancedStats(
    dbMock,
    jest.fn(),   // scheduleSave
    jest.fn(),   // addLog
    (req, res, next) => { req.user = { userId: 'admin', role: 'admin' }; next(); },  // authMiddleware
    (req, res, next) => next(),  // requireRole
    jest.fn(() => '2026-09-12'),  // localDateStr
    jest.fn((d) => String(d)),     // formatDate
    jest.fn(() => '2026-09-12 12:00:00')  // nowTimestamp
  );
  app.use(router);
  return app;
}

describe('Advanced Stats API', () => {
  let dbMock;

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock = { exec: jest.fn(), run: jest.fn() };
    dbMock.exec.mockReturnValue([]);
  });

  describe('GET /api/stats/conduct', () => {
    test('返回操行量化评分列表（含分数计算）', async () => {
      dbMock.exec.mockImplementation((sql, params) => {
        if (sql.includes('COUNT(*)')) return [{ values: [[0]] }];
        // 返回两行学生数据
        return [{
          columns: ['id', 'name', 'dorm', 'class_name', 'normal_days', 'absent_days', 'leave_days', 'checkin_days'],
          values: [
            [1, '张三', '301', '计算机1班', 20, 2, 3, 25],
            [2, '李四', '302', '计算机1班', 10, 10, 5, 25]
          ]
        }];
      });

      const app = createApp(dbMock);
      const res = await request(app)
        .get('/api/stats/conduct')
        .query({ days: 30 });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data).toHaveLength(2);

      // 张三: 20/25 = 80%
      expect(data[0].name).toBe('张三');
      expect(data[0].score).toBe(80);
      expect(data[0].normal_days).toBe(20);
      expect(data[0].absent_days).toBe(2);

      // 李四: 10/25 = 40%
      expect(data[1].name).toBe('李四');
      expect(data[1].score).toBe(40);
    });

    test('无数据时返回空数组', async () => {
      dbMock.exec.mockReturnValue([{ values: [] }]);

      const app = createApp(dbMock);
      const res = await request(app).get('/api/stats/conduct');

      expect(res.body.code).toBe(0);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /api/stats/dorm-rank/public', () => {
    test('返回宿舍排名（公开接口，无需认证）', async () => {
      dbMock.exec.mockImplementation((sql) => {
        if (sql.includes('COUNT(*)')) return [{ values: [[0]] }];
        // 宿舍排名数据（按 attendance_rate ASC 排序后的结果，模拟数据库返回）
        return [{
          values: [
            ['302', '计算机1班', 20, 15, 3, 2, 75.0],
            ['301', '计算机1班', 20, 18, 1, 1, 90.0]
          ]
        }];
      });

      const app = createApp(dbMock);
      const res = await request(app)
        .get('/api/stats/dorm-rank/public')
        .query({ days: 30 });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data).toHaveLength(2);

      // 按 attendance_rate ASC 排序，302（75%）在前
      expect(data[0].dorm).toBe('302');
      expect(data[0].attendance_rate).toBe(75.0);
      expect(data[1].dorm).toBe('301');
      expect(data[1].attendance_rate).toBe(90.0);
    });

    test('无数据时返回空数组', async () => {
      dbMock.exec.mockReturnValue([{ values: [] }]);

      const app = createApp(dbMock);
      const res = await request(app).get('/api/stats/dorm-rank/public');

      expect(res.body.code).toBe(0);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /api/stats/attention', () => {
    test('返回重点关注学生列表', async () => {
      dbMock.exec.mockImplementation((sql) => {
        if (sql.includes('COUNT(*)')) return [{ values: [[0]] }];
        // 重点关注学生
        return [{
          values: [
            [1, '王五', '301', '计算机1班', 8, 2],
            [2, '赵六', '302', '计算机1班', 5, 0]
          ]
        }];
      });

      const app = createApp(dbMock);
      const res = await request(app)
        .get('/api/stats/attention')
        .query({ days: 30 });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data).toHaveLength(2);
      expect(data[0].absent_count).toBe(8);
      expect(data[0].leave_count).toBe(2);
      expect(data[1].absent_count).toBe(5);
    });
  });

  describe('GET /api/stats/dorm-anomaly/public', () => {
    test('返回宿舍异常检测数据', async () => {
      dbMock.exec.mockImplementation((sql) => {
        if (sql.includes('COUNT(*)')) return [{ values: [[0]] }];
        return [{
          values: [
            ['301', 3, '张三,李四,王五'],
            ['302', 1, '赵六']
          ]
        }];
      });

      const app = createApp(dbMock);
      const res = await request(app)
        .get('/api/stats/dorm-anomaly/public')
        .query({});

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data).toHaveLength(2);
      expect(data[0].dorm).toBe('301');
      expect(data[0].count).toBe(3);
      expect(data[0].names).toBe('张三,李四,王五');
    });

    test('无异常时返回空数组', async () => {
      dbMock.exec.mockReturnValue([{ values: [] }]);

      const app = createApp(dbMock);
      const res = await request(app).get('/api/stats/dorm-anomaly/public');

      expect(res.body.code).toBe(0);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /api/stats/leave-trend', () => {
    test('返回请假趋势数据', async () => {
      dbMock.exec.mockImplementation((sql) => {
        // leave-trend 的 SQL 包含 COUNT(*) as total，需要直接返回月度数据
        if (sql.includes('strftime')) {
          return [{
            values: [
              ['2026-09', 5, 3, 1, 2, 11],
              ['2026-08', 8, 5, 2, 3, 18]
            ]
          }];
        }
        return [{ values: [[0]] }];
      });

      const app = createApp(dbMock);
      const res = await request(app)
        .get('/api/stats/leave-trend')
        .query({});

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      const data = res.body.data;
      expect(data).toHaveLength(2);
      expect(data[0].month).toBe('2026-09');
      expect(data[0]['事假']).toBe(5);
      expect(data[0]['病假']).toBe(3);
      expect(data[0].total).toBe(11);
      expect(data[1].month).toBe('2026-08');
    });
  });
});
