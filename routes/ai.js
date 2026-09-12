/**
 * 兼容性转发：原 routes/ai.js 已拆分为 routes/ai-chat.js + routes/ai/ 模块
 * 此文件保持向后兼容，确保旧测试和引用继续工作
 */
const path = require('path');
const { initChatSubRouter } = require('./ai-chat');

/**
 * 保持原 init 函数签名兼容
 */
function init(opts) {
  // 确保 ROOT_DIR 存在
  const deps = { ROOT_DIR: opts.ROOT_DIR || path.resolve(__dirname, '..'), ...opts };
  return initChatSubRouter(deps);
}

module.exports = { init };
