// Mock @vladmandic/face-api
jest.mock('@vladmandic/face-api/dist/face-api.node-wasm.js', () => ({
  tf: {
    setBackend: jest.fn().mockResolvedValue(undefined),
    ready: jest.fn().mockResolvedValue(undefined)
  },
  Image: { fromBuffer: jest.fn().mockResolvedValue({}) },
  detectSingleFace: jest.fn().mockResolvedValue({
    withFaceLandmarks: () => ({
      withFaceDescriptor: () => ({ descriptor: new Float32Array(128).fill(0.5) })
    })
  })
}));

const request = require('supertest');
const express = require('express');
const { init: initAiRoutes } = require('../routes/ai');

const mockUpload = { single: jest.fn().mockReturnValue((req, res, next) => next()) };

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initAiRoutes({
    db: dbMock,
    scheduleSave: () => {},
    upload: mockUpload,
    fs: { 
      existsSync: jest.fn().mockReturnValue(false), 
      readFileSync: jest.fn().mockReturnValue('{}'),
      writeFileSync: jest.fn(),
      mkdirSync: jest.fn()
    },
    path: require('path'),
    authMiddleware: (req, res, next) => next(),
    nowTimestamp: () => Date.now(),
    localDateStr: () => '2026-09-10',
    formatDate: () => '2026-09-10 10:00:00',
    addLog: () => {},
    broadcast: () => {},
    validateToken: () => ({ role: 'admin' }),
    STUDENT_TOKENS: new Map(),
    sendWebhook: () => Promise.resolve(),
    ROOT_DIR: 'C:/project'
  });
  app.use(router);
  return app;
}

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  jest.clearAllMocks();
});

describe('AI API - Face Recognition', () => {
  let app;
  const mockDb = {
    exec: jest.fn(),
    run: jest.fn().mockReturnValue({ lastID: 1, changes: 1 }),
    close: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    mockDb.run.mockClear();
    app = createApp(mockDb);
  });

  test('GET /api/face/students 返回人脸注册列表', async () => {
    mockDb.exec.mockReturnValue([{
      values: [
        [1, '学生A', '计算机1班', null],
        [2, '学生B', '计算机1班', JSON.stringify(new Array(128).fill(0.5))]
      ]
    }]);

    const res = await request(app).get('/api/face/students');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].has_face).toBe(false);
    expect(res.body.data[1].has_face).toBe(true);
  });

  test('POST /api/face/compare 人脸比对验证', async () => {
    const featureVector = new Array(128).fill(0.5);
    mockDb.exec.mockReturnValue([{
      values: [[1, '学生A', '计算机1班', JSON.stringify(featureVector)]]
    }]);

    const res = await request(app)
      .post('/api/face/compare')
      .send({ student_id: '1', face_hash: JSON.stringify(featureVector) });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.matched).toBe(true);
  });
});

describe('AI API - Predictions', () => {
  let app;
  const mockDb = {
    exec: jest.fn(),
    run: jest.fn(),
    close: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    app = createApp(mockDb);
  });

  test('GET /api/predict/checkin-trend 返回签到趋势预测', async () => {
    const dailyData = Array.from({ length: 30 }, (_, i) => {
      const date = `2026-08-${String(i + 1).padStart(2, '0')}`;
      return [date, 95, 100];
    });
    mockDb.exec.mockReturnValue([{ values: dailyData }]);

    const res = await request(app).get('/api/predict/checkin-trend').query({ days: 7, dim: 'checkin' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveProperty('history');
    expect(res.body.data).toHaveProperty('predictions');
    expect(res.body.data.predictions.length).toBe(7);
  });

  test('GET /api/predict/checkin-trend 数据不足时返回提示', async () => {
    mockDb.exec.mockReturnValue([{ values: [['2026-09-01', 90, 100]] }]);

    const res = await request(app).get('/api/predict/checkin-trend').query({ days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveProperty('message');
    expect(res.body.data.message).toContain('数据不足');
  });
});
