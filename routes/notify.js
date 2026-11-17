// 通知推送路由模块
// 将未归/异常学生实时推送到企业微信或钉钉群机器人 Webhook
const express = require('express');

/**
 * 获取配置项值
 * @param {object} db - sql.js Database 实例
 * @param {string} key - 配置键
 * @returns {string} 配置值
 */
function getSetting(db, key) {
  const r = db.exec("SELECT value FROM settings WHERE key=?", [key])[0];
  return r ? r.values[0][0] : '';
}

/**
 * 设置或更新配置项
 * @param {object} db - sql.js Database 实例
 * @param {string} key - 配置键
 * @param {string} value - 配置值
 */
function setSetting(db, key, value) {
  db.run("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", [key, value]);
}

/**
 * 获取今日日期字符串 (YYYY-MM-DD)
 * @returns {string} 今日日期
 */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 发送 Webhook 通知（企业微信/钉钉通用格式）
 * @param {string} url - Webhook URL
 * @param {string} content - 消息内容
 * @returns {Promise<{ok: boolean, status: number, body?: string, error?: string}>}
 */
async function sendToWebhook(url, content) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } })
    });
    const txt = await resp.text();
    return { ok: resp.ok, status: resp.status, body: txt };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/**
 * 微信推送服务（PushPlus）：将消息推送到个人微信
 * 与群机器人 Webhook 并行，未归名单等也可推到个人微信
 * @param {object} database - sql.js Database 实例
 * @param {string} content - 消息内容（纯文本，含 \n）
 * @returns {Promise<{sent: boolean}>}
 */
async function pushPlus(database, content) {
  try {
    if (!database) return { sent: false };
    const en = database.exec('SELECT value FROM settings WHERE key=\'pushplus_enabled\'')[0]?.values?.[0]?.[0];
    const tk = database.exec('SELECT value FROM settings WHERE key=\'pushplus_token\'')[0]?.values?.[0]?.[0];
    if (en === '1' && tk) {
      await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: tk,
          title: '学管SmartEdu通知',
          content: String(content).replace(/\n/g, '<br/>'),
          content_type: 'html'
        })
      }).catch(() => {});
      return { sent: true };
    }
  } catch (e) {}
  return { sent: false };
}

/**
 * 脱敏处理 Webhook URL
 * @param {string} u - 原始 URL
 * @returns {string} 脱敏后的 URL
 */
function maskUrl(u) {
  if (!u) return '';
  if (u.length <= 20) return '****';
  return u.slice(0, 20) + '****';
}

function init(opts) {
  const { db, authMiddleware } = opts || {};
  const router = express.Router();

  // 获取当前推送配置
  router.get('/api/notify/config', authMiddleware, (req, res) => {
    try {
      const url = getSetting(db, 'notify_webhook');
      const enabled = getSetting(db, 'notify_enabled') === '1';
      res.json({ code: 0, data: { enabled, webhook_set: !!url, webhook_mask: maskUrl(url) } });
    } catch (e) {
      res.json({ code: 1, message: '读取配置失败' });
    }
  });

  // 保存推送配置
  router.post('/api/notify/config', authMiddleware, (req, res) => {
    try {
      const { webhook_url, enabled } = req.body || {};
      if (webhook_url && !/^https?:\/\//.test(webhook_url)) {
        return res.json({ code: 1, message: 'Webhook 地址格式不正确' });
      }
      if (webhook_url) setSetting(db, 'notify_webhook', webhook_url);
      setSetting(db, 'notify_enabled', enabled ? '1' : '0');
      res.json({ code: 0, message: '配置已保存' });
    } catch (e) {
      res.json({ code: 1, message: '保存配置失败' });
    }
  });

  // 测试推送
  router.post('/api/notify/test', authMiddleware, async (req, res) => {
    try {
      const url = getSetting(db, 'notify_webhook');
      if (!url) return res.json({ code: 1, message: '尚未配置 Webhook 地址' });
      const content = `【查寝系统】推送测试\n时间：${todayStr()}\n若您收到此消息，说明通知推送已正确接入。`;
      const result = await sendToWebhook(url, content);
      if (result.ok) res.json({ code: 0, message: '测试推送成功', detail: result.body });
      else res.json({ code: 1, message: '推送失败', detail: result });
    } catch (e) {
      res.json({ code: 1, message: '推送异常', detail: e.message });
    }
  });

  // 推送今日未归名单（群机器人 + 个人微信 PushPlus 双通道）
  router.post('/api/notify/absent-today', authMiddleware, async (req, res) => {
    try {
      const today = todayStr();
      const url = getSetting(db, 'notify_webhook');
      const ppEnabled = getSetting(db, 'pushplus_enabled') === '1';
      const ppToken = getSetting(db, 'pushplus_token');
      // 未配置任何推送渠道则提前提示（保持与原行为一致）
      if (!url && !(ppEnabled && ppToken)) {
        return res.json({ code: 1, message: '尚未配置任何推送渠道（群机器人或 PushPlus）', sent: false });
      }
      const rows = db.exec(
        `SELECT s.name, s.class_name, s.dorm FROM records r
         LEFT JOIN students s ON s.student_id = r.student_id
         WHERE (r.date = ? OR SUBSTR(r.time,1,10) = ?) AND r.type='checkin' AND r.status='未归'`,
        [today, today]
      )[0]?.values || [];

      if (!rows.length) {
        return res.json({ code: 0, message: '今日暂无未归学生', sent: false });
      }
      const list = rows.map((r, i) => `${i + 1}. ${r[0] || '未知'}（${r[1] || '-'}班 / ${r[2] || '宿舍未知'}）`).join('\n');
      const content = `【查寝系统】今日未归名单（${today}）\n共 ${rows.length} 人：\n${list}`;
      let sent = false;
      let detail = '';
      if (url) {
        const result = await sendToWebhook(url, content);
        sent = !!result.ok;
        if (!sent) detail = '群机器人推送失败；';
      } else {
        detail = '未配置群机器人 Webhook；';
      }
      const pp = await pushPlus(db, content);
      if (pp.sent) { sent = true; detail = ''; }
      else { detail += '未配置 PushPlus'; }
      if (!sent) return res.json({ code: 1, message: '尚未配置任何推送渠道（群机器人或 PushPlus）', sent: false });
      res.json({ code: 0, message: `已推送 ${rows.length} 名未归学生`, sent: true, detail: detail || undefined });
    } catch (e) {
      res.json({ code: 1, message: '推送异常', detail: e.message });
    }
  });

  return router;
}

module.exports = { init, sendToWebhook, getSetting, setSetting, pushPlus };
