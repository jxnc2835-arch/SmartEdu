// ==================== 监控仪表盘路由测试 ====================
const request = require('supertest');
const express = require('express');
const { init: initMetricsRoutes } = require('../routes/metrics');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initMetricsRoutes({
    db: dbMock,
    authMiddleware: (req, res, next) => { req.user = { userId: 'admin', role: 'admin', allowed_classes: [] }; next(); }
  });
  app.use(router);
  return app;
}

describe('Metrics API - System Monitoring', () => {
  let app;
  const mockDb = {
    exec: jest.fn().mockReturnValue([{ values: [] }]),
    run: jest.fn().mockReturnValue({ lastID: 1, changes: 1 })
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    app = createApp(mockDb);
  });

  test('GET /api/metrics/status 返回系统指标', async () => {
    const res = await request(app)
      .get('/api/metrics/status');

    expect(res.statusCode).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveProperty('memory');
    expect(res.body.data.memory).toHaveProperty('rss');
    expect(res.body.data.memory).toHaveProperty('heapUsed');
    expect(res.body.data).toHaveProperty('cpu');
    expect(res.body.data.cpu.count).toBeGreaterThan(0);
    expect(res.body.data).toHaveProperty('loadAvg');
    expect(res.body.data).toHaveProperty('uptimeSeconds');
    expect(res.body.data.timestamp).toBeGreaterThan(0);
  });

  test('GET /api/metrics/status 数据格式一致性', async () => {
    const res = await request(app)
      .get('/api/metrics/status');

    const d = res.body.data;
    // 内存值应为正整数 (MB)
    expect(d.memory.rss).toBeGreaterThanOrEqual(0);
    expect(d.memory.heapTotal).toBeGreaterThanOrEqual(0);
    expect(d.memory.heapUsed).toBeLessThanOrEqual(d.memory.heapTotal);
    // 负载值应为字符串 (toFixed 2)
    expect(d.loadAvg['1min']).toMatch(/^\d+\.\d{2}$/);
    expect(d.loadAvg['5min']).toMatch(/^\d+\.\d{2}$/);
    expect(d.loadAvg['15min']).toMatch(/^\d+\.\d{2}$/);
  });
});
