/**
 * AI 会话管理模块
 * 处理会话历史、消息存储、上下文更新
 */
const path = require('path');
const fs = require('fs');

const SESSIONS_FILE = path.join(__dirname, '..', '..', 'config', 'data', 'ai_sessions.json');
const MAX_HISTORY = 100;

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[AI Session] 加载失败:', e.message);
  }
  return {};
}

function persistSessions(sessions) {
  try {
    const dir = path.dirname(SESSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (e) {
    console.error('[AI Session] 持久化失败:', e.message);
  }
}

function getSessionHistory(sessionId, sessions) {
  return sessions[sessionId] || null;
}

function addMessage(sessionId, role, content, sessions) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], context: {} };
  }
  sessions[sessionId].messages.push({ role, content, time: Date.now() });
  // 保留最近 MAX_HISTORY 条
  if (sessions[sessionId].messages.length > MAX_HISTORY) {
    sessions[sessionId].messages = sessions[sessionId].messages.slice(-MAX_HISTORY);
  }
  persistSessions(sessions);
}

function updateSessionContext(sessionId, updates, sessions) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], context: {} };
  }
  sessions[sessionId].context = { ...sessions[sessionId].context, ...updates };
  persistSessions(sessions);
}

module.exports = {
  loadSessions,
  persistSessions,
  getSessionHistory,
  addMessage,
  updateSessionContext
};
