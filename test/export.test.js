const request = require('supertest');
const express = require('express');
const { init: initExportRoutes } = require('../routes/export');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initExportRoutes({
    db: dbMock,
    scheduleSave: () => {},
    authMiddleware: (req, res, next) => next(),
    addLog: () => {},
    formatDate: () => '2026-09-11',
    PDFDocument: class PDFDocument {
      constructor() {}
      registerFont() {}
      font() { return this; }
      fontSize() { return this; }
      text() { return this; }
      moveDown() { return this; }
      pipe() { return this; }
      end() {}
    }
  });
  app.use(router);
  return app;
}

describe('Export API', () => {
  let app;
  const mockDb = {
    exec: jest.fn().mockReturnValue([{ values: [] }]),
    close: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    app = createApp(mockDb);
  });

  test('GET /api/export/students 返回导出请求', async () => {
    const res = await request(app).get('/api/export/students');
    expect(res.statusCode).toBe(200);
  });
});
