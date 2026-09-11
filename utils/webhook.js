/**
 * 企业微信 / 钉钉 Webhook 通知工具函数
 * 封装 markdwown/card 格式推送逻辑
 * @param {Object} sqlJsDb - SQLite 数据库实例（注入）
 */
function init(sqlJsDb) {
  const db = sqlJsDb;

  /**
   * 发送企业微信群消息
   * @param {string} content - 纯文本内容
   * @returns {Promise<boolean>} 是否成功
   */
  async function sendWecomText(content) {
    try {
      const wecomEnabled = db.exec("SELECT value FROM settings WHERE key='wecom_enabled'")[0]?.values?.[0]?.[0] || '0';
      if (wecomEnabled !== '1') return false;
      
      const wecomUrl = db.exec("SELECT value FROM settings WHERE key='wecom_webhook_url'")[0]?.values?.[0]?.[0];
      if (!wecomUrl) return false;

      const response = await fetch(wecomUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content }
        })
      });
      
      const result = await response.json();
      console.log('[Webhook] 企业微信发送结果:', result);
      return result.errcode === 0;
    } catch (e) {
      console.error('[Webhook] 企业微信发送失败:', e.message);
      return false;
    }
  }

  /**
   * 发送钉钉群消息
   * @param {string} content - 纯文本内容
   * @returns {Promise<boolean>} 是否成功
   */
  async function sendDingtalkText(content) {
    try {
      const dingEnabled = db.exec("SELECT value FROM settings WHERE key='dingtalk_enabled'")[0]?.values?.[0]?.[0] || '0';
      if (dingEnabled !== '1') return false;
      
      const dingUrl = db.exec("SELECT value FROM settings WHERE key='dingtalk_webhook_url'")[0]?.values?.[0]?.[0];
      if (!dingUrl) return false;

      const response = await fetch(dingUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content }
        })
      });
      
      const result = await response.json();
      console.log('[Webhook] 钉钉发送结果:', result);
      return result.errcode === 0;
    } catch (e) {
      console.error('[Webhook] 钉钉发送失败:', e.message);
      return false;
    }
  }

  /**
   * 智能发送：根据配置自动选择平台
   * @param {string} content
   */
  async function sendNotification(content) {
    const [wecomResult, dingResult] = await Promise.all([
      sendWecomText(content),
      sendDingtalkText(content)
    ]);
    
    if (wecomResult || dingResult) {
      return true;
    }
    return false;
  }

  return { sendWecomText, sendDingtalkText, sendNotification };
}

module.exports = { init };
