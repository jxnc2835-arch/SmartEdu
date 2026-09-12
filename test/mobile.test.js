// ==================== 移动端路由测试 ====================
jest.mock('../utils/helpers', () => ({
  localDateStr: jest.fn()
}));

const request = require('supertest');
const express = require('express');
const { init: initMobileRoutes } = require('../routes/mobile');
const { localDateStr } = require('../utils/helpers');

function createApp(opts) {
  const app = express();
  app.use(express.json());
  const router = initMobileRoutes({
    db: opts.db,
    scheduleSave: jest.fn(),
    authMiddleware: (req, res, next) => {
      req.user = { userId: 'mobile_user', role: 'student', allowed_classes: [] };
      next();
    },
    upload: { single: jest.fn().mockReturnValue((req, res, next) => next()) },
    faceCompare: opts.faceCompare
  });
  app.use(router);
  return app;
}

describe('Mobile API', () => {
  let dbMock;

  beforeEach(() => {
    localDateStr.mockReturnValue('2026-09-12');
    dbMock = { exec: jest.fn(), run: jest.fn() };
  });

  describe('POST /api/mobile/face-compare', () => {
    test('faceCompareHandler 未初始化时返回错误', async () => {
      const app = createApp({ db: dbMock, faceCompare: undefined });

      const res = await request(app)
        .post('/api/mobile/face-compare')
        .send({ student_id: '1', face_hash: '[0.1,0.2]' });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('未初始化');
    });

    test('faceCompareHandler 委托调用成功', async () => {
      const mockHandler = jest.fn((req, res) => {
        res.json({ code: 0, data: { matched: true, similarity: 0.95 } });
      });
      const app = createApp({ db: dbMock, faceCompare: mockHandler });

      const res = await request(app)
        .post('/api/mobile/face-compare')
        .send({ student_id: '1', face_hash: '[0.1,0.2]' });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.matched).toBe(true);
      expect(mockHandler).toHaveBeenCalled();
    });

    test('faceCompareHandler 抛异常时返回错误', async () => {
      const mockHandler = jest.fn((req, res) => {
        throw new Error('模型加载失败');
      });
      const app = createApp({ db: dbMock, faceCompare: mockHandler });

      const res = await request(app)
        .post('/api/mobile/face-compare')
        .send({ student_id: '1' });

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('模型加载失败');
    });
  });

  describe('GET /api/mobile/dashboard', () => {
    test('无班级过滤时返回全局统计', async () => {
      dbMock.exec.mockImplementation((sql, params) => {
        if (sql.includes('COUNT(*)')) {
          return [{ values: [[100]] }]; // 100 students
        }
        // status query
        return [{ values: [[80, 10, 10]] }]; // 80 present, 10 leave, 10 absent
      });

      const app = createApp({ db: dbMock, faceCompare: null });
      const res = await request(app)
        .get('/api/mobile/dashboard');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      const d = res.body.data;
      expect(d.total_students).toBe(100);
      expect(d.today_present).toBe(80);
      expect(d.today_leave).toBe(10);
      expect(d.today_absent).toBe(10);
      expect(d.checkin_rate).toBe(80); // 80/100 = 80%
      expect(d.date).toBe('2026-09-12');
      expect(d.class_name).toBe('');
    });

    test('按班级过滤时返回班级统计', async () => {
      dbMock.exec.mockImplementation((sql, params) => {
        if (sql.includes('COUNT(*)')) {
          // Should include class_name param
          expect(params).toEqual(['计算机1班']);
          return [{ values: [[30]] }];
        }
        // status query with class filter
        expect(params).toEqual(['2026-09-12', '计算机1班']);
        return [{ values: [[25, 3, 2]] }];
      });

      const app = createApp({ db: dbMock, faceCompare: null });
      const res = await request(app)
        .get('/api/mobile/dashboard')
        .query({ class_name: '计算机1班' });

      expect(res.body.code).toBe(0);
      const d = res.body.data;
      expect(d.total_students).toBe(30);
      expect(d.checkin_rate).toBe(83); // Math.round(25/30*100) = 83
      expect(d.class_name).toBe('计算机1班');
    });

    test('学生数为 0 时签到率为 0', async () => {
      dbMock.exec.mockImplementation((sql) => {
        if (sql.includes('COUNT(*)')) return [{ values: [[0]] }];
        return [{ values: [[0, 0, 0]] }];
      });

      const app = createApp({ db: dbMock, faceCompare: null });
      const res = await request(app).get('/api/mobile/dashboard');

      expect(res.body.data.checkin_rate).toBe(0);
    });

    test('db.exec 抛异常时返回错误', async () => {
      dbMock.exec.mockImplementation(() => { throw new Error('SQL error'); });

      const app = createApp({ db: dbMock, faceCompare: null });
      const res = await request(app).get('/api/mobile/dashboard');

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('SQL error');
    });
  });
});
