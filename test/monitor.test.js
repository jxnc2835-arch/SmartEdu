// ==================== 系统监控路由测试 ====================
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const { init: initMonitorRoutes } = require('../routes/monitor');

function createApp(dbMock, dbFile) {
  const app = express();
  app.use(express.json());
  const router = initMonitorRoutes({
    db: dbMock,
    dbFile: dbFile,
    authMiddleware: (req, res, next) => {
      req.user = { userId: 'admin', role: 'admin' };
      next();
    },
    addLog: jest.fn()
  });
  app.use(router);
  return app;
}

describe('Monitor API', () => {
  let dbMock;
  let dbFile;

  beforeAll(() => {
    // 创建临时 db 文件用于测试
    dbFile = require('os').tmpdir() + '/test_monitor_data.db';
    fs.writeFileSync(dbFile, Buffer.alloc(1024 * 1024)); // 1MB 假数据
  });

  afterAll(() => {
    try { fs.unlinkSync(dbFile); } catch (_) {}
  });

  beforeEach(() => {
    dbMock = { exec: jest.fn() };
  });

  describe('GET /api/monitor/status', () => {
    test('返回系统运行状态概览（含数据库和 CPU 指标）', async () => {
      // 模拟 5 个 count 查询依次返回不同值
      const counts = [150, 4200, 8, 25, 3];
      dbMock.exec.mockImplementation((sql) => {
        const idx = counts.length - 1;
        // 按 SQL 内容匹配
        if (sql.includes('students')) return [{ values: [[counts[0]]] }];
        if (sql.includes('records')) return [{ values: [[counts[1]]] }];
        if (sql.includes('courses')) return [{ values: [[counts[2]]] }];
        if (sql.includes('leaves')) return [{ values: [[counts[3]]] }];
        if (sql.includes('visitors')) return [{ values: [[counts[4]]] }];
        return [{ values: [[0]] }];
      });

      const app = createApp(dbMock, dbFile);
      const res = await request(app).get('/api/monitor/status');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);

      const d = res.body.data;
      // 原有字段
      expect(d.students).toBe(150);
      expect(d.records).toBe(4200);
      expect(d.courses).toBe(8);
      expect(d.leaves).toBe(25);
      expect(d.visitors).toBe(3);
      expect(d.uptime).toBeGreaterThanOrEqual(0);
      expect(d.memoryMB).toBeGreaterThan(0);

      // 新增：内存详情
      expect(d.memoryDetails).toBeDefined();
      expect(d.memoryDetails.heapUsedMB).toBeGreaterThan(0);
      expect(d.memoryDetails.heapTotalMB).toBeGreaterThan(0);
      expect(d.memoryDetails.rssMB).toBeGreaterThan(0);

      // 新增：CPU 负载
      expect(d.cpu).toBeDefined();
      expect(d.cpu.load1).toBeGreaterThanOrEqual(0);
      expect(d.cpu.load5).toBeGreaterThanOrEqual(0);
      expect(d.cpu.load15).toBeGreaterThanOrEqual(0);

      // 新增：数据库信息
      expect(d.db).toBeDefined();
      expect(d.db.file).toBe(dbFile);
      expect(d.db.sizeMB).toBe(1); // 1MB file → 1 MB

      // 新增：网络占位
      expect(d.network).toBeDefined();
    });

    test('db.exec 抛异常时 count 降级为 0', async () => {
      dbMock.exec.mockImplementation(() => {
        throw new Error('DB not ready');
      });

      const app = createApp(dbMock, null);
      const res = await request(app).get('/api/monitor/status');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      // 所有 count 降级为 0
      expect(res.body.data.students).toBe(0);
      expect(res.body.data.records).toBe(0);
      expect(res.body.data.db.sizeMB).toBe(0); // 无 dbFile 时为 0
      expect(res.body.data.db.file).toBe('');
    });

    test('无 dbFile 时 db.file 为空字符串', async () => {
      dbMock.exec.mockReturnValue([{ values: [[0]] }]);

      const app = createApp(dbMock, null);
      const res = await request(app).get('/api/monitor/status');

      expect(res.body.data.db.file).toBe('');
      expect(res.body.data.db.sizeMB).toBe(0);
    });
  });
});
