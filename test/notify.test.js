// ==================== 通知推送路由测试 ====================
const request = require('supertest');
const express = require('express');
const { init: initNotifyRoutes, sendToWebhook, getSetting, setSetting } = require('../routes/notify');

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeSettingsExec(settingsMap) {
  return jest.fn().mockImplementation((sql, params) => {
    if (sql.includes('SELECT value FROM settings') && params && params.length > 0) {
      const key = params[0];
      if (settingsMap[key] !== undefined) {
        return [{ values: [[settingsMap[key]]] }];
      }
      return [{ values: [] }];
    }
    return [{ values: [] }];
  });
}

describe('Notify API - Push Configuration', () => {
  let app;
  let dbMock;

  function createApp() {
    const app = express();
    app.use(express.json());
    const router = initNotifyRoutes({
      db: dbMock,
      authMiddleware: (req, res, next) => { req.user = { userId: 'admin', role: 'admin', allowed_classes: [] }; next(); }
    });
    app.use(router);
    return app;
  }

  beforeEach(() => {
    dbMock = {
      exec: jest.fn(),
      run: jest.fn().mockReturnValue({ lastID: 1, changes: 1 })
    };
    mockFetch.mockReset();
    app = createApp();
  });

  // Helper: mock db.exec to simulate sql.js behavior
  // sql.js returns [] (no results) when no rows match, or [{values:[[...]]}] when rows exist
  function mockSettingsExec(map) {
    dbMock.exec.mockImplementation((sql, params) => {
      // Non-settings query: absent students (has 2+ date params)
      if (params && params.length >= 2 && sql.includes('records')) {
        return map.__absent_rows ? [{ values: map.__absent_rows }] : [];
      }
      // Settings query: single key param
      if (params && params.length === 1) {
        const key = params[0];
        if (map[key] !== undefined) {
          return [{ values: [[map[key]]] }];
        }
        return []; // no result set = key not found
      }
      // Fallback
      if (sql.includes('SELECT s.name')) {
        return map.__absent_rows ? [{ values: map.__absent_rows }] : [];
      }
      return [];
    });
  }

  describe('GET /api/notify/config', () => {
    test('返回未启用且无 Webhook 的配置', async () => {
      mockSettingsExec({ notify_enabled: '0' });

      const res = await request(app).get('/api/notify/config');

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.enabled).toBe(false);
      expect(res.body.data.webhook_set).toBe(false);
    });

    test('返回已启用且有 Webhook 的配置（URL 已脱敏）', async () => {
      const fullUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret12345';
      mockSettingsExec({ notify_enabled: '1', notify_webhook: fullUrl });

      const res = await request(app).get('/api/notify/config');

      expect(res.body.code).toBe(0);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.webhook_set).toBe(true);
      // maskUrl: first 20 chars + '****'
      expect(res.body.data.webhook_mask).toBe(fullUrl.slice(0, 20) + '****');
      expect(res.body.data.webhook_mask).toContain('****');
      expect(res.body.data.webhook_mask).not.toContain('secret12345');
    });
  });

  describe('POST /api/notify/config', () => {
    test('保存有效配置', async () => {
      dbMock.exec.mockReturnValue([{ values: [] }]);

      const res = await request(app)
        .post('/api/notify/config')
        .send({ webhook_url: 'https://qyapi.weixin.qq.com/test', enabled: true });

      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toContain('已保存');
    });

    test('拒绝非 http/https 协议的 URL', async () => {
      const res = await request(app)
        .post('/api/notify/config')
        .send({ webhook_url: 'ftp://invalid-protocol.com', enabled: true });

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('格式不正确');
    });

    test('空 body 时安全保存 enabled=false', async () => {
      const res = await request(app)
        .post('/api/notify/config')
        .send({});

      expect(res.body.code).toBe(0);
    });
  });

  describe('POST /api/notify/test', () => {
    test('未配置 Webhook 时返回提示', async () => {
      mockSettingsExec({});

      const res = await request(app).post('/api/notify/test');

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('尚未配置');
    });

    test('推送成功时返回成功消息', async () => {
      mockSettingsExec({ notify_webhook: 'https://qyapi.weixin.qq.com/test' });
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"errcode":0,"errmsg":"ok"}'
      });

      const res = await request(app).post('/api/notify/test');

      expect(res.body.code).toBe(0);
      expect(res.body.message).toContain('成功');
      expect(mockFetch).toHaveBeenCalled();
    });

    test('推送失败时返回详细错误', async () => {
      mockSettingsExec({ notify_webhook: 'https://qyapi.weixin.qq.com/test' });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Server Error'
      });

      const res = await request(app).post('/api/notify/test');

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('推送失败');
    });
  });

  describe('POST /api/notify/absent-today', () => {
    test('未配置 Webhook 时返回提示', async () => {
      mockSettingsExec({});

      const res = await request(app).post('/api/notify/absent-today');

      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('尚未配置');
    });

    test('今日无未归学生时返回安全响应', async () => {
      mockSettingsExec({
        notify_webhook: 'https://qyapi.weixin.qq.com/test',
        __absent_rows: []
      });

      const res = await request(app).post('/api/notify/absent-today');

      expect(res.body.code).toBe(0);
      expect(res.body.message).toContain('暂无未归');
      expect(res.body.sent).toBe(false);
    });

    test('有未归学生时推送名单', async () => {
      mockSettingsExec({
        notify_webhook: 'https://qyapi.weixin.qq.com/test',
        __absent_rows: [['张三', '计算机1班', '301'], ['李四', '测绘2班', '205']]
      });
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'ok'
      });

      const res = await request(app).post('/api/notify/absent-today');

      expect(res.body.code).toBe(0);
      expect(res.body.message).toContain('2');
      expect(res.body.sent).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});

describe('Notify Utility Functions', () => {
  test('sendToWebhook 成功时返回 ok=true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'ok'
    });

    const result = await sendToWebhook('https://test.com', 'hello');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  test('sendToWebhook 网络错误时返回 ok=false', async () => {
    mockFetch.mockRejectedValue(new Error('Network unreachable'));

    const result = await sendToWebhook('https://test.com', 'hello');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain('Network');
  });

  test('getSetting 读取配置值', () => {
    const dbMock = {
      exec: jest.fn().mockReturnValue([{ values: [['https://test.com']] }])
    };
    const val = getSetting(dbMock, 'notify_webhook');
    expect(val).toBe('https://test.com');
  });

  test('setSetting 写入配置值', () => {
    const dbMock = {
      run: jest.fn().mockReturnValue({ lastID: 1, changes: 1 })
    };
    setSetting(dbMock, 'notify_enabled', '1');
    expect(dbMock.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR REPLACE INTO settings'),
      ['notify_enabled', '1']
    );
  });
});
