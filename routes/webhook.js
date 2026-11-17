// 企业微信 / 钉钉 Webhook 通知路由模块
const express = require('express');

/**
 * 初始化 Webhook 通知模块
 * @param {Object} opts - 依赖注入对象
 * @param {object} opts.db - sql.js Database 实例
 * @param {Function} opts.scheduleSave - 延迟保存函数
 * @param {Function} opts.authMiddleware - 认证中间件
 * @returns {Express.Router} Express 路由实例
 */
function init(opts) {
  const { db, scheduleSave, authMiddleware } = opts;
  const router = express.Router();

  // ==================== 获取 Webhook 配置 ====================
  /**
   * GET /api/webhook/settings
   * 获取企业微信和钉钉 Webhook 配置
   */
  router.get('/api/webhook/settings', authMiddleware, (req, res) => {
    try {
      const wecomUrl = db.exec("SELECT value FROM settings WHERE key='wecom_webhook_url'")[0]?.values?.[0]?.[0] || '';
      const wecomEnabled = db.exec("SELECT value FROM settings WHERE key='wecom_enabled'")[0]?.values?.[0]?.[0] || '0';
      const dingUrl = db.exec("SELECT value FROM settings WHERE key='dingtalk_webhook_url'")[0]?.values?.[0]?.[0] || '';
      const dingEnabled = db.exec("SELECT value FROM settings WHERE key='dingtalk_enabled'")[0]?.values?.[0]?.[0] || '0';
      const ppToken = db.exec("SELECT value FROM settings WHERE key='pushplus_token'")[0]?.values?.[0]?.[0] || '';
      const ppEnabled = db.exec("SELECT value FROM settings WHERE key='pushplus_enabled'")[0]?.values?.[0]?.[0] || '0';

      res.json({
        code: 0,
        data: {
          wecom: { url: wecomUrl, enabled: wecomEnabled === '1' },
          dingtalk: { url: dingUrl, enabled: dingEnabled === '1' },
          pushplus: { token: ppToken, enabled: ppEnabled === '1' }
        }
      });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // ==================== 更新 Webhook 配置 ====================
  /**
   * PUT /api/webhook/settings
   * 更新企业微信和钉钉 Webhook 配置
   */
  router.put('/api/webhook/settings', authMiddleware, (req, res) => {
    try {
      const { wecom, dingtalk, pushplus } = req.body;

      if (wecom) {
        if (wecom.url !== undefined) db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('wecom_webhook_url', ?)", [wecom.url || '']);
        if (wecom.enabled !== undefined) db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('wecom_enabled', ?)", [wecom.enabled ? '1' : '0']);
      }
      if (dingtalk) {
        if (dingtalk.url !== undefined) db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('dingtalk_webhook_url', ?)", [dingtalk.url || '']);
        if (dingtalk.enabled !== undefined) db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('dingtalk_enabled', ?)", [dingtalk.enabled ? '1' : '0']);
      }
      if (pushplus) {
        if (pushplus.token !== undefined) db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('pushplus_token', ?)", [pushplus.token || '']);
        if (pushplus.enabled !== undefined) db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('pushplus_enabled', ?)", [pushplus.enabled ? '1' : '0']);
      }
      
      scheduleSave();
      res.json({ code: 0, message: 'Webhook 配置已保存' });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // ==================== 测试企业微信消息 ====================
  /**
   * POST /api/webhook/test/wecom
   * 发送测试消息到企业微信
   */
  router.post('/api/webhook/test/wecom', authMiddleware, async (req, res) => {
    try {
      const url = db.exec("SELECT value FROM settings WHERE key='wecom_webhook_url'")[0]?.values?.[0]?.[0];
      if (!url) return res.json({ code: 1, message: '未配置企业微信 Webhook URL' });
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: req.body.content || '🔔 [测试消息] 企业微信通知集成正常！' } })
      });
      const result = await response.json();
      if (result.errcode === 0) {
        res.json({ code: 0, message: '测试消息发送成功' });
      } else {
        res.json({ code: 1, message: '发送失败：' + result.errmsg });
      }
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // ==================== 测试钉钉消息 ====================
  /**
   * POST /api/webhook/test/dingtalk
   * 发送测试消息到钉钉
   */
  router.post('/api/webhook/test/dingtalk', authMiddleware, async (req, res) => {
    try {
      const url = db.exec("SELECT value FROM settings WHERE key='dingtalk_webhook_url'")[0]?.values?.[0]?.[0];
      if (!url) return res.json({ code: 1, message: '未配置钉钉 Webhook URL' });
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: req.body.content || '🔔 [测试消息] 钉钉通知集成正常！' } })
      });
      const result = await response.json();
      if (result.errcode === 0) {
        res.json({ code: 0, message: '测试消息发送成功' });
      } else {
        res.json({ code: 1, message: '发送失败：' + result.errmsg });
      }
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // ==================== 测试微信推送服务（PushPlus）消息 ====================
  /**
   * POST /api/webhook/test/pushplus
   * 发送测试消息到个人微信（PushPlus）
   */
  router.post('/api/webhook/test/pushplus', authMiddleware, async (req, res) => {
    try {
      const token = db.exec("SELECT value FROM settings WHERE key='pushplus_token'")[0]?.values?.[0]?.[0];
      if (!token) return res.json({ code: 1, message: '未配置 PushPlus Token' });

      const response = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          title: '学管SmartEdu通知',
          content: (req.body.content || '🔔 [测试消息] 微信推送服务(PushPlus)集成正常！').replace(/\n/g, '<br/>'),
          content_type: 'html'
        })
      });
      const result = await response.json();
      if (result.code === 200) {
        res.json({ code: 0, message: '测试消息已发送至微信（PushPlus）' });
      } else {
        res.json({ code: 1, message: '发送失败：' + (result.msg || JSON.stringify(result)) });
      }
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  return router;
}

module.exports = { init };
