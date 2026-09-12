// ==================== 系统管理路由测试 ====================
jest.mock('../utils/helpers', () => ({
  nowTimestamp: jest.fn(() => '2026-09-12 12:00:00'),
  localDateStr: jest.fn(() => '2026-09-12'),
  formatDate: jest.fn((d) => String(d)),
  beijingStamp: jest.fn(() => '2026-09-12T12-00-00'),
  saveBase64Photo: jest.fn(),
  clampedToday: jest.fn(() => '2026-09-12'),
  beijingDateStr: jest.fn(() => '2026-09-12'),
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => { req.user = { userId: 'admin', role: 'admin', allowed_classes: [] }; next(); },
  requireRole: (...roles) => (req, res, next) => next(),
  studentAuth: (req, res, next) => { req.user = { userId: 's1', role: 'student' }; next(); },
}));
jest.mock('exceljs', () => {
  const mockWorkbook = {
    addWorksheet: jest.fn().mockReturnValue({
      columns: [{ key: 'a', width: 10 }],
      addRow: jest.fn(),
      getRow: jest.fn().mockReturnValue({ addCell: jest.fn() }),
      mergeCells: jest.fn(),
      addPageBreak: jest.fn(),
    }),
    xlsx: { writeBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-xlsx')) },
  };
  return { Workbook: jest.fn().mockReturnValue(mockWorkbook) };
});

const request = require('supertest');
const express = require('express');
const { init: initSystem } = require('../routes/system');

function createApp(dbMock, overrides = {}) {
  const fsMock = {
    readdirSync: jest.fn().mockReturnValue([]),
    existsSync: jest.fn().mockReturnValue(false),
    statSync: jest.fn().mockReturnValue({ mtime: new Date(), size: 1024, isFile: () => true }),
    readFileSync: jest.fn().mockReturnValue('{}'),
    renameSync: jest.fn(),
  };
  const deps = {
    db: dbMock,
    scheduleSave: jest.fn(),
    addLog: jest.fn(),
    broadcast: jest.fn(),
    sendWebhook: jest.fn(),
    upload: { single: jest.fn().mockReturnValue((req, res, next) => next()) },
    QRCode: { toString: jest.fn().mockResolvedValue('data:image/png;base64,MOCK') },
    multer: { single: jest.fn().mockReturnValue((req, res, next) => next()) },
    os: { platform: () => 'win32', cpus: () => [{ model: 'CPU' }], totalmem: () => 8e9, freemem: () => 4e9 },
    ROOT_DIR: 'C:\\project',
    UPLOAD_DIR: 'C:\\project\\uploads',
    BACKUP_DIR: 'C:\\project\\backups',
    fs: fsMock,
  };
  const app = express();
  app.use(express.json());
  const router = initSystem(
    deps.db, deps.scheduleSave, deps.addLog, deps.broadcast, deps.sendWebhook,
    deps.upload, deps.QRCode, deps.multer, deps.os, deps.ROOT_DIR, deps.UPLOAD_DIR, deps.BACKUP_DIR
  );
  app.use(router);
  return { app, deps };
}

describe('routes/system', () => {
  describe('GET /api/logs', () => {
    test('returns paginated logs with level counts', async () => {
      const dbExec = jest.fn().mockImplementation((sql, params) => {
        if (sql.includes("COUNT(*) FROM logs WHERE level='INFO'")) return [{ values: [[3]] }];
        if (sql.includes("COUNT(*) FROM logs WHERE level='WARN'")) return [{ values: [[1]] }];
        if (sql.includes("COUNT(*) FROM logs WHERE level='ERROR'")) return [{ values: [[0]] }];
        return [{ values: [[1, '2026-09-12 10:00:00', 'test', 'detail', 'INFO', 'admin']] }];
      });
      const dbMock = { exec: dbExec, run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/logs');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.levelCounts).toEqual({ INFO: 3, WARN: 1, ERROR: 0 });
      expect(res.body.pagination.total).toBe(1);
    });

    test('returns empty array when no logs', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([{ values: [] }]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/logs');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('POST /api/delete-log', () => {
    test('requires id parameter', async () => {
      const dbMock = { exec: jest.fn(), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).post('/api/delete-log').send({});
      expect(res.body.code).toBe(1);
    });

    test('deletes log and calls scheduleSave', async () => {
      const dbMock = { exec: jest.fn(), run: jest.fn() };
      const { app, deps } = createApp(dbMock);
      await request(app).post('/api/delete-log').send({ id: 42 });
      expect(dbMock.run).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM logs WHERE id='), [42]);
      expect(deps.scheduleSave).toHaveBeenCalled();
    });
  });

  describe('POST /api/clear-logs', () => {
    test('clears all logs when no level specified', async () => {
      const dbMock = { exec: jest.fn(), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).post('/api/clear-logs').send({});
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  describe('GET /api/report', () => {
    // 辅助：创建一个能处理 /api/report 所有 SQL 的 mock
    const createReportMock = (studentsRows = []) => {
      const dbExec = jest.fn().mockImplementation((sql) => {
        if (sql.includes('FROM students') && !sql.includes('JOIN')) {
          return [{ values: studentsRows }];
        }
        if (sql.includes('FROM records') || sql.includes('JOIN students')) return [{ values: [] }];
        if (sql.includes('FROM leaves')) return [{ values: [] }];
        return [{ values: [] }];
      });
      return { exec: dbExec, run: jest.fn() };
    };

    test('returns weekly report structure', async () => {
      const dbMock = createReportMock();
      const { app } = createApp(dbMock);
      let err;
      let res;
      try {
        res = await request(app).get('/api/report');
      } catch (e) {
        err = e;
      }
      console.log('DEBUG report: res=', res ? { status: res.status, body: res.body } : 'no res', 'err=', err ? err.message : 'none');
      if (res) {
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
        expect(res.body.data).toHaveProperty('summary');
        expect(res.body.data).toHaveProperty('dorms');
      } else {
        throw err;
      }
    });

    test('processes students with dorms', async () => {
      // 学生列顺序：[id, name, dorm, class_name, phone, grade]
      const dbMock = createReportMock([[1, '张三', '101', '计算机1班', '', '2023']]);
      const { app } = createApp(dbMock);
      let err;
      let res;
      try {
        res = await request(app).get('/api/report');
      } catch (e) {
        err = e;
      }
      console.log('DEBUG students: res=', res ? { status: res.status, body: res.body } : 'no res', 'err=', err ? err.message : 'none');
      if (res) {
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
        expect(res.body.data.summary.total_students).toBe(1);
      } else {
        throw err;
      }
    });
  });

  describe('GET /api/backups', () => {
    test('lists backups from directory', async () => {
      const dbMock = { exec: jest.fn(), run: jest.fn() };
      const { app, deps } = createApp(dbMock);
      // mock fs.readdirSync to return backup directories
      const fsModule = require('fs');
      jest.spyOn(fsModule, 'readdirSync').mockReturnValue(['backup_2026-09-01', 'backup_2026-09-02']);
      jest.spyOn(fsModule, 'statSync').mockReturnValue({ mtime: new Date(), size: 1024, isFile: () => true });
      jest.spyOn(fsModule, 'readFileSync').mockReturnValue('{"students":10,"records":100,"leaves":5}');
      const res = await request(app).get('/api/backups');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.length).toBe(2);
      jest.restoreAllMocks();
    });
  });

  describe('POST /api/settings/webhook', () => {
    test('saves webhook config', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).post('/api/settings/webhook')
        .send({ enabled: true, type: 'wechat', url: 'https://example.com/webhook' });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(dbMock.run).toHaveBeenCalled();
    });
  });

  describe('GET /api/settings/webhook', () => {
    test('returns default webhook config when not set', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/settings/webhook');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  describe('GET /api/announcements', () => {
    test('returns empty array when no announcements', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/announcements');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    test('returns announcements when present', async () => {
      const dbMock = {
        exec: jest.fn().mockReturnValue([{
          columns: ['id', 'title', 'content', 'created_at'],
          values: [['ann_1', '欢迎', '这是内容', '2026-09-12T00:00:00.000Z']]
        }]),
        run: jest.fn()
      };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/announcements');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('欢迎');
    });
  });

  describe('POST /api/announcements', () => {
    test('requires title and content', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).post('/api/announcements').send({ title: '' });
      expect(res.body.code).toBe(1);
    });

    test('creates announcement', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
      const { app, deps } = createApp(dbMock);
      const res = await request(app).post('/api/announcements').send({ title: '通知', content: '内容' });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(deps.addLog).toHaveBeenCalledWith(expect.stringContaining('发布公告'), expect.any(String));
    });
  });

  describe('GET /api/settings/alert-rules', () => {
    test('returns default alert rules', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/settings/alert-rules');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toHaveProperty('enabled');
      expect(res.body.data).toHaveProperty('absent_days');
    });
  });

  describe('POST /api/settings/alert-rules', () => {
    test('saves alert rules', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).post('/api/settings/alert-rules')
        .send({ enabled: true, absent_days: 5, dorm_count: 3, consecutive_days: 2 });
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  describe('GET /api/export/leaves', () => {
    test('exports leave records as xlsx', async () => {
      const dbMock = {
        exec: jest.fn().mockReturnValue([{
          columns: ['id', 'student_name', 'student_id', 'dorm', 'class_name', 'reason', 'start_date', 'end_date', 'status', 'created_at'],
          values: [[1, '张三', 'S001', '101', '计算机1班', '病假', '2026-09-01', '2026-09-03', '已批准', '2026-09-12T00:00:00.000Z']]
        }]),
        run: jest.fn()
      };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/export/leaves');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheet');
      expect(res.headers['content-disposition']).toContain('attachment');
    });
  });

  describe('POST /api/tasks', () => {
    test('creates a check-in task', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([{ values: [[1]] }]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).post('/api/tasks').send({
        name: '夜间查寝',
        type: 'checkin',
        schedule: '2026-09-12 22:00',
        classes: ['计算机1班'],
      });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/tasks', () => {
    test('lists tasks', async () => {
      const dbMock = { exec: jest.fn().mockReturnValue([{ values: [] }]), run: jest.fn() };
      const { app } = createApp(dbMock);
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });
});
