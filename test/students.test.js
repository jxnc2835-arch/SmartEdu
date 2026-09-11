// Mock 依赖
jest.mock('bcryptjs', () => ({
  compare: jest.fn().mockResolvedValue(true),
  compareSync: jest.fn().mockReturnValue(true),
}));

const request = require('supertest');
const express = require('express');
const { init: initStudentsRoutes } = require('../routes/students');

// 创建最小化应用
function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initStudentsRoutes({
    db: dbMock,
    scheduleSave: () => {},
    authMiddleware: (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
    bcrypt: require('bcryptjs'),
    upload: { single: () => (req, res, next) => next() },
    addLog: () => {},
    CLASS_SIZE_LIMIT: 500,
    getClassCount: () => 0,
    limitPerClass: () => 500,
    beijingStamp: () => new Date().toISOString()
  });
  app.use(router);
  return app;
}

describe('Students API', () => {
  let app;
  const mockDb = {
    exec: jest.fn(),
    close: jest.fn()
  };

  beforeEach(() => {
    mockDb.exec.mockClear();
    app = createApp(mockDb);
  });

  test('GET /api/students 返回学生列表', async () => {
    mockDb.exec.mockReturnValue([{ values: [] }]);
    
    const res = await request(app)
      .get('/api/students')
      .query({ page: 1, pageSize: 10 });
    
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('data');
  });

  test('POST /api/students 创建学生', async () => {
    mockDb.exec.mockReturnValue([{ values: [[1]] }]);
    mockDb.run = jest.fn().mockReturnValue(undefined);
    
    const res = await request(app)
      .post('/api/students')
      .send({
        name: '测试学生',
        gender: '男生',
        class_name: '计算机科学与技术1班',
        phone: '13800138000',
        dorm: 'A栋101'
      });
    
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('code');
  });

  test('PUT /api/students/:id 更新学生', async () => {
    mockDb.run = jest.fn().mockReturnValue(undefined);
    
    const res = await request(app)
      .put('/api/students/1')
      .send({
        name: '更新姓名',
        phone: '13900139000'
      });
    
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('code');
  });

  test('DELETE /api/students/:id 删除学生', async () => {
    mockDb.run = jest.fn().mockReturnValue(undefined);
    
    const res = await request(app)
      .delete('/api/students/1');
    
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('code');
  });
});
