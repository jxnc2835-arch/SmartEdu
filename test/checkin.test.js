// Mock 依赖
jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  compareSync: jest.fn().mockReturnValue(true),
}));

jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,fake')
}));

jest.mock('multer', () => () => ({ single: () => (req, res, next) => next() }));

const request = require('supertest');
const express = require('express');
const { init: initCheckinRoutes } = require('../routes/checkin');

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initCheckinRoutes({
    db: dbMock,
    scheduleSave: () => {},
    authMiddleware: (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
    studentAuth: (req, res, next) => next(),
    addLog: () => {},
    localDateStr: () => '2026-09-10',
    formatDate: () => '2026-09-10 10:00:00',
    nowTimestamp: () => Date.now(),
    beijingStamp: () => new Date().toISOString(),
    broadcast: () => {},
    validateToken: () => ({ role: 'admin' }),
    upload: { single: () => (req, res, next) => next() },
    QRCode: require('qrcode'),
    multer: require('multer'),
    os: require('os'),
    path: require('path'),
    fs: require('fs'),
  });
  app.use(router);
  return app;
}

describe('Checkin API', () => {
  let app;
  const mockDb = {
    exec: jest.fn(),
    close: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    app = createApp(mockDb);
  });

  test('GET /api/records 返回空列表', async () => {
    mockDb.exec.mockReturnValue([{ values: [] }]);
    
    const res = await request(app)
      .get('/api/records')
      .query({ page: 1, limit: 10 });
    
    expect(res.statusCode).toBe(200);
    expect(res.body.code).toBe(0);
  });

  test('POST /api/checkin 接受签到请求', async () => {
    mockDb.exec
      .mockReturnValueOnce([{ values: [[1]] }])
      .mockReturnValue([{ values: [] }]);

    const res = await request(app)
      .post('/api/checkin')
      .send({
        student_id: 1,
        type: 'checkin',
        dorm: 'A101',
        lat: 39.9,
        lng: 116.4
      });

    expect(res.statusCode).toBe(200);
  });
});
