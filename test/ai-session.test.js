// routes/ai/session.js 单元测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const sessionModule = require('../routes/ai/session');

describe('ai/session', () => {
  test('loadSessions 加载空会话', () => {
    const sessions = sessionModule.loadSessions();
    expect(typeof sessions).toBe('object');
  });

  test('addMessage 添加消息并获取历史', () => {
    const sessionId = 'test-session-' + Date.now();
    const sessions = sessionModule.loadSessions();
    
    sessionModule.addMessage(sessionId, 'user', '你好', sessions);
    expect(sessions[sessionId].messages.length).toBe(1);
    expect(sessions[sessionId].messages[0].role).toBe('user');
    expect(sessions[sessionId].messages[0].content).toBe('你好');
    
    // 获取历史验证
    const history = sessionModule.getSessionHistory(sessionId, sessions);
    expect(history).not.toBeNull();
    expect(history.messages.length).toBe(1);
    
    // 更新上下文
    sessionModule.updateSessionContext(sessionId, { lastIntent: 'today' }, sessions);
    expect(history.context.lastIntent).toBe('today');
  });
});
