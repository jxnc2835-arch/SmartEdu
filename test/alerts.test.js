// ==================== 异常闭环告警路由测试 ====================
jest.mock('../utils/alert-generator', () => ({
  generateAlerts: jest.fn(),
  listAlerts: jest.fn(),
  alertStats: jest.fn(),
  closeAlertById: jest.fn(),
  CLOSE_REASONS: ['已返校', '请假批准', '转班', '其他']
}));

const request = require('supertest');
const express = require('express');
const { init: initAlertsRoutes, CLOSE_REASONS } = require('../routes/alerts');
const { generateAlerts, listAlerts, alertStats, closeAlertById } = require('../utils/alert-generator');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initAlertsRoutes({
    db: dbMock,
    authMiddleware: (req, res, next) => {
      req.user = { userId: 'admin', role: 'admin', allowed_classes: [] };
      next();
    },
    scheduleSave: jest.fn(),
    addLog: jest.fn()
  });
  app.use(router);
  return app;
}

describe('Alerts API', () => {
  let app;
  const mockDb = { exec: jest.fn(), run: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.exec.mockReturnValue([]);
    mockDb.run.mockReturnValue({ lastID: 1, changes: 1 });
    app = createApp(mockDb);
  });

  describe('GET /api/alerts/reasons', () => {
    test('返回销号原因列表', async () => {
      const res = await request(app).get('/api/alerts/reasons');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.reasons).toEqual(CLOSE_REASONS);
      expect(res.body.data.reasons).toContain('已返校');
      expect(res.body.data.reasons).toContain('请假批准');
    });
  });

  describe('POST /api/alerts/generate', () => {
    test('成功生成告警', async () => {
      generateAlerts.mockResolvedValue({
        created: 3, total: 5, pushed: true,
        pushDetail: { wecom: true, dingtalk: false },
        list: [{ id: 1, name: '张三' }, { id: 2, name: '李四' }]
      });

      const res = await request(app)
        .post('/api/alerts/generate')
        .send({ date: '2026-09-10' });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.created).toBe(3);
      expect(res.body.message).toContain('3');
      expect(res.body.message).toContain('已推送');
      expect(generateAlerts).toHaveBeenCalledWith(mockDb, '2026-09-10', expect.objectContaining({ scheduleSave: expect.any(Function) }));
    });

    test('生成失败时返回错误', async () => {
      generateAlerts.mockRejectedValue(new Error('DB 连接超时'));

      const res = await request(app)
        .post('/api/alerts/generate')
        .send({});

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('DB 连接超时');
    });
  });

  describe('GET /api/alerts', () => {
    test('查询开放告警列表', async () => {
      listAlerts.mockReturnValue([
        { id: 1, name: '张三', class_name: '计算机1班', status: 'open' },
        { id: 2, name: '李四', class_name: '测绘2班', status: 'open' }
      ]);

      const res = await request(app)
        .get('/api/alerts')
        .query({ status: 'open' });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toHaveLength(2);
      expect(listAlerts).toHaveBeenCalledWith(mockDb, { status: 'open', date: '', allowed: [] });
    });

    test('按日期过滤告警', async () => {
      listAlerts.mockReturnValue([]);

      const res = await request(app)
        .get('/api/alerts')
        .query({ status: 'closed', date: '2026-09-01' });

      expect(res.body.code).toBe(0);
      expect(res.body.data).toEqual([]);
      expect(listAlerts).toHaveBeenCalledWith(mockDb, { status: 'closed', date: '2026-09-01', allowed: [] });
    });
  });

  describe('GET /api/alerts/stats', () => {
    test('返回告警统计数据', async () => {
      alertStats.mockReturnValue({
        open_count: 5, closed_today: 2, total_all: 42, by_class: [{ class_name: '计算机1班', count: 3 }]
      });

      const res = await request(app).get('/api/alerts/stats');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.open_count).toBe(5);
      expect(alertStats).toHaveBeenCalledWith(mockDb, []);
    });
  });

  describe('POST /api/alerts/:id/close', () => {
    test('成功销号告警', async () => {
      closeAlertById.mockReturnValue({ code: 0, message: '已销号' });

      const res = await request(app)
        .post('/api/alerts/1/close')
        .send({ reason: '已返校', note: '本人已返回宿舍' });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('已销号');
      expect(closeAlertById).toHaveBeenCalledWith(
        mockDb, '1',
        expect.objectContaining({
          reason: '已返校',
          note: '本人已返回宿舍',
          userId: 'admin',
          role: 'admin',
          allowed: []
        })
      );
    });

    test('销号失败时返回错误码', async () => {
      closeAlertById.mockReturnValue({ code: 1, message: '无权限操作' });

      const res = await request(app)
        .post('/api/alerts/99/close')
        .send({ reason: '已返校' });

      expect(res.body.code).toBe(1);
      expect(res.body.message).toBe('无权限操作');
    });
  });
});
