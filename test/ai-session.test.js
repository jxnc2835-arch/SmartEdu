// routes/ai/session.js 单元测试
const path = require('path');
const fs = require('fs');
const os = require('os');

// 临时目录用于测试
const TEST_DIR = path.join(os.tmpdir(), 'smartedu-test-' + Date.now());
const TEST_SESSIONS_FILE = path.join(TEST_DIR, 'ai_sessions.json');

// 动态加载模块并注入测试路径
const sessionModule = require('../routes/ai/session');

describe('ai/session', () => {
  let originalFile;
  
  beforeEach(() => {
    // 创建测试目录
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // 保存原始值
    originalFile = sessionModule.SESSIONS_FILE;
  });

  afterEach(() => {
    // 清理测试文件
    if (fs.existsSync(TEST_SESSIONS_FILE)) {
      fs.unlinkSync(TEST_SESSIONS_FILE);
    }
    fs.rmdirSync(TEST_DIR);
  });

  test('loadSessions 加载空会话', () => {
    const sessions = sessionModule.loadSessions();
    expect(typeof sessions).toBe('object');
  });

  test('addMessage 添加消息', () => {
    const sessions = sessionModule.loadSessions();
    sessionModule.addMessage('session1', 'user', '你好', sessions);
    expect(sessions['session1'].messages.length).toBe(1);
    expect(sessions['session1'].messages[0].role).toBe('user');
    expect(sessions['session1'].messages[0].content).toBe('你好');
  });

  test('getSessionHistory 获取会话历史', () => {
    const sessions = sessionModule.loadSessions();
    sessionModule.addMessage('session2', 'user', '测试', sessions);
    const history = sessionModule.getSessionHistory('session2', sessions);
    expect(history).not.toBeNull();
    expect(history.messages.length).toBe(1);
  });

  test('updateSessionContext 更新上下文', () => {
    const sessions = sessionModule.loadSessions();
    sessionModule.addMessage('session3', 'user', '问题', sessions);
    sessionModule.updateSessionContext('session3', { lastIntent: 'today', classFilter: '计算机1班' }, sessions);
    const history = sessionModule.getSessionHistory('session3', sessions);
    expect(history.context.lastIntent).toBe('today');
    expect(history.context.classFilter).toBe('计算机1班');
  });

  test('persistSessions 持久化到文件', () => {
    const sessions = { testSession: { messages: [], context: { key: 'value' } } };
    sessionModule.persistSessions(sessions);
    expect(fs.existsSync(TEST_SESSIONS_FILE)).toBe(true);
    
    // 重新加载验证
    const loaded = sessionModule.loadSessions();
    expect(loaded.testSession.context.key).toBe('value');
  });
});
