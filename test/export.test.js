// export 路由集成测试
jest.mock('exceljs', () => {
  const makeRow = (values = []) => ({
    values,
    eachCell: (fn) => {
      values.forEach((val, i) => fn({ value: val, column: i + 1 }, i + 1));
    },
    getCell: (n) => ({ value: values[n - 1] || null }),
  });
  const mockWS = {
    addRow: function(v) {
      const r = makeRow(v || []);
      this.rows.push(r);
      return this;
    },
    getRows: function(start, count) {
      return this.rows.slice(start - 1, start - 1 + (count || this.rows.length));
    },
    eachRow: function(fn) { this.rows.forEach(fn); },
    eachCell: function(fn) {},
    columns: [],
    row: function(n) { return makeRow(); },
    commit: function() {},
  };
  return {
    Workbook: class {
      constructor() {
        this.sheets = [];
        this.xlsx = { writeBuffer: async () => Buffer.from('mock-xlsx-content') };
      }
      addWorksheet(name) {
        const ws = Object.create(mockWS);
        ws.name = typeof name === 'string' ? name : 'Sheet1';
        ws.rows = [];
        this.sheets.push(ws);
        return ws;
      }
    },
  };
});
jest.mock('../utils/helpers', () => ({
  formatDate: jest.fn((d) => String(d)),
  localDateStr: jest.fn(() => '2026-09-12'),
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => { req.user = { userId: 'admin', role: 'admin' }; next(); },
}));

const request = require('supertest');
const express = require('express');
const { init: initExport } = require('../routes/export');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  // PDFKit 链式调用完整 mock：所有方法返回自身
  const pdfChain = new Proxy(() => pdfChain, {
    apply() {},
    get(_, prop) {
      if (prop === 'end') return () => {};
      if (prop === 'pipe') return () => pdfChain;
      if (prop === 'constructor') return PDFDocument;
      return pdfChain;
    },
  });
  function PDFDocument() { return pdfChain; }
  PDFDocument.prototype = pdfChain;

  const router = initExport({
    db: dbMock,
    scheduleSave: jest.fn(),
    authMiddleware: (r, res, n) => { r.user = { userId: 'admin' }; n(); },
    PDFDocument,
    addLog: jest.fn(),
  });
  app.use(router);
  return app;
}

describe('routes/export', () => {
  const dbExec = jest.fn().mockReturnValue([{ values: [] }]);
  const dbMock = { exec: dbExec, run: jest.fn() };

  beforeEach(() => { dbExec.mockClear(); });

  test('GET /api/export/students 返回 Excel', async () => {
    dbExec.mockReturnValue([{
      values: [['s001', '张三', '男', '101', '计算机1班', '13800138000']],
      columns: ['学号', '姓名', '性别', '宿舍', '班级', '电话'],
    }]);
    const app = createApp(dbMock);
    const res = await request(app).get('/api/export/students');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });

  test('GET /api/export/class-report 返回班级分表 Excel', async () => {
    dbExec.mockReturnValue([]);
    const app = createApp(dbMock);
    const res = await request(app).get('/api/export/class-report').query({ type: 'month' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });

  test('GET /api/export/report 返回 PDF', async () => {
    const app = createApp(dbMock);
    const res = await request(app).get('/api/export/report').query({ type: 'month' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('pdf');
  });
});
