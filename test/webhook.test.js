// ==================== Webhook 通知路由测试 ====================
const request = require('supertest');
const express = require('express');
const { init: initWebhookRoutes } = require('../routes/webhook');

// Mock global fetch for webhook test endpoints
const mockFetch = jest.fn();
global.fetch = mockFetch;

function createApp(dbMock) {
  const app = express();
  app.use(express.json());
  const router = initWebhookRoutes({
    db: dbMock,
    scheduleSave: jest.fn(),
    authMiddleware: (req, res, next) => { req.user = { userId: 'admin', role: 'admin', allowed_classes: [] }; next(); },
    addLog: jest.fn()
  });
  app.use(router);
  return app;
}

/**
 * 构建 settings 查询 mock — 按 key 返回不同值
 */
function makeSettingsExec(settingsMap) {
  return jest.fn().mockImplementation((sql) => {
    if (sql.includes('SELECT value FROM settings')) {
      const keyMatch = sql.match(/key='([^']+)'/);
      if (keyMatch && settingsMap[keyMatch[1]] !== undefined) {
        return [{ values: [[settingsMap[keyMatch[1]]]] }];
      }
      return [{ values: [] }];
    }
    return [{ values: [] }];
  });
}

describe('Webhook API - Settings & Test', () => {
  let app;
  let dbMock;

  beforeEach(() => {
    dbMock = {
      exec: jest.fn(),
      run: jest.fn().mockReturnValue({ lastID: 1, changes: 1 })
    };
    mockFetch.mockReset();
    app = createApp(dbMock);
  });

  describe('GET /api/webhook/settings', () => {
    test('返回已配置的企业微信和钉钉 Webhook 设置', () => {
      const settings = makeSettingsExec({
        wecom_webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
        wecom_enabled: '1',
        dingtalk_webhook_url: '',
        dingtalk_enabled: '0'
      });
      dbMock.exec = settings;

      const res = { statusCode: 0, body: {} };
      // Use direct router invocation since supertest doesn't work with mocked exec easily
      // Actually supertest does work - let's just use it properly
    });

    test('GET 端点返回配置数据', async () => {
      dbMock.exec.mockImplementation((sql) => {
        const keyMatch = sql.match(/key='([^']+)'/);
        const map = {
          wecom_webhook_url: 'https://qyapi.weixin.qq.com/test',
          wecom_enabled: '1',
          dingtalk_webhook_url: '',
          dingtalk_enabled: '0'
        };
        if (keyMatch && map[keyMatch[1]] !== undefined) {
          return [{ values: [[map[keyMatch[1]]]] }];
        }
        return [{ values: [] }];
      });

      const res = await request(app)
        .get('/api/webhook/settings');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.wecom.url).toBe('https://qyapi.weixin.qq.com/test');
      expect(res.body.data.wecom.enabled).toBe(true);
      expect(res.body.data.dingtalk.enabled).toBe(false);
    });

    test('无配置时返回空 URL 和 disabled 状态', async () => {
      dbMock.exec.mockReturnValue([{ values: [] }]);

      const res = await request(app)
        .get('/api/webhook/settings');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.wecom.url).toBe('');
      expect(res.body.data.wecom.enabled).toBe(false);
    });
  });

  describe('PUT /api/webhook/settings', () => {
    test('保存企业微信配置', async () => {
      const res = await request(app)
        .put('/api/webhook/settings')
        .send({ wecom: { url: 'https://qyapi.weixin.qq.com/new', enabled: true } });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toContain('已保存');
      // 验证 db.run 被调用（INSERT OR REPLACE for url + enabled = 2 calls）
      expect(dbMock.run).toHaveBeenCalledTimes(2);
    });

    test('保存钉钉配置', async () => {
      const res = await request(app)
        .put('/api/webhook/settings')
        .send({ dingtalk: { url: 'https://oapi.dingtalk.com/robot/send', enabled: false } });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
    });

    test('db.run 抛异常时返回错误', async () => {
      dbMock.run.mockImplementation(() => { throw new Error('DB locked'); });

      const res = await request(app)
        .put('/api/webhook/settings')
        .send({ wecom: { url: 'https://test.com' } });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('DB locked');
    });
  });

  describe('POST /api/webhook/test/wecom', () => {
    test('未配置 URL 时返回提示', async () => {
      dbMock.exec.mockImplementation((sql) => {
        return [{ values: [] }];
      });

      const res = await request(app)
        .post('/api/webhook/test/wecom');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('未配置');
    });

    test('发送成功时返回成功消息', async () => {
      dbMock.exec.mockImplementation((sql) => {
        if (sql.includes('wecom_webhook_url')) {
          return [{ values: [['https://qyapi.weixin.qq.com/test']] }];
        }
        return [{ values: [] }];
      });
      mockFetch.mockResolvedValue({
        json: async () => ({ errcode: 0, errmsg: 'ok' })
      });

      const res = await request(app)
        .post('/api/webhook/test/wecom')
        .send({ content: '测试内容' });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toContain('成功');
      expect(mockFetch).toHaveBeenCalled();
    });

    test('发送失败时返回错误信息', async () => {
      dbMock.exec.mockImplementation((sql) => {
        if (sql.includes('wecom_webhook_url')) {
          return [{ values: [['https://qyapi.weixin.qq.com/test']] }];
        }
        return [{ values: [] }];
      });
      mockFetch.mockResolvedValue({
        json: async () => ({ errcode: 40001, errmsg: 'invalid credential' })
      });

      const res = await request(app)
        .post('/api/webhook/test/wecom')
        .send({});

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('invalid credential');
    });
  });

  describe('POST /api/webhook/test/dingtalk', () => {
    test('未配置 URL 时返回提示', async () => {
      dbMock.exec.mockImplementation((sql) => {
        // Only dingtalk_webhook_url should be empty
        if (sql.includes('dingtalk_webhook_url')) {
          return [{ values: [] }];
        }
        return [{ values: [] }];
      });

      const res = await request(app)
        .post('/api/webhook/test/dingtalk');

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('未配置');
    });

    test('发送成功时返回成功消息', async () => {
      dbMock.exec.mockImplementation((sql) => {
        if (sql.includes('dingtalk_webhook_url')) {
          return [{ values: [['https://oapi.dingtalk.com/test']] }];
        }
        return [{ values: [] }];
      });
      mockFetch.mockResolvedValue({
        json: async () => ({ errcode: 0, errmsg: 'ok' })
      });

      const res = await request(app)
        .post('/api/webhook/test/dingtalk')
        .send({});

      expect(res.body.code).toBe(0);
      expect(res.body.message).toContain('成功');
    });
  });
});
