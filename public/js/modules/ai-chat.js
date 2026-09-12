/**
 * AI 智能助手模块
 * 封装聊天对话、气泡渲染、配置面板等功能
 */

// ==================== AI 常量与状态 ====================
const AI_SESSION_KEY = 'ai_session_id';
const AI_HISTORY_KEY = 'ai_chat_history';
const AI_HISTORY_MAX = 100;
const AI_WELCOME = '你好！我是学工AI智能助手 🤖\n\n我可以帮你：\n• 📊 查询今日签到率和未归名单\n• 🔍 搜索学生档案、分析高风险学生\n• 📈 缺勤趋势、班级对比、宿舍异常\n• 💡 基于数据给出管理建议\n\n直接用自然语言提问就行，试试看吧~';

window.aiReady = false;
window.aiSessionId = localStorage.getItem(AI_SESSION_KEY) || ('ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
localStorage.setItem(AI_SESSION_KEY, window.aiSessionId);
window.aiHistory = [];
window.aiBusy = false;

// ==================== 历史记录管理 ====================
window.loadAIHistory = function () {
  try {
    const s = localStorage.getItem(AI_HISTORY_KEY);
    if (s) {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) { }
  return [];
};
window.saveAIHistory = function () {
  localStorage.setItem(AI_HISTORY_KEY, JSON.stringify((window.aiHistory || []).slice(-AI_HISTORY_MAX)));
};

// ==================== 气泡渲染（支持 Markdown） ====================
window.bubble = function (role, text, source, modelInfo) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (role === 'user' ? 'b-user' : 'b-ai');
  let html = esc(text)
    .replace(/&amp;/g, '&')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  let srcTag = '';
  if (source === 'ai') {
    const ml = (modelInfo && modelInfo.model) ? modelInfo.model : 'AI';
    const pl = (modelInfo && modelInfo.provider === 'zhipu') ? '智谱大模型' : '大模型';
    srcTag = ' <span class="ai-src-tag ai-src-ai" title="' + pl + ' (' + ml + ') 生成">🤖 ' + pl + '</span>';
    // 强模型不可用时自动降级到快速模型：明确告知用户，避免误以为在用配置的强模型
    if (modelInfo && modelInfo.degraded) {
      srcTag += ' <span class="ai-src-tag ai-src-degraded" title="配置的大模型超时/不可用，本次已自动降级到快速模型作答">⚡ 快速模型</span>';
    }
  } else if (source === 'local_engine') {
    srcTag = ' <span class="ai-src-tag ai-src-local" title="本地数据分析引擎">⚙️ 分析</span>';
  }
  d.innerHTML = '<div class="bubble-inner">' + html + srcTag + '</div>';
  return d;
};

// ==================== 初始化 AI 聊天 ====================
window.initAI = function () {
  const chat = document.getElementById('aiChat');
  if (!chat || window.aiReady) return;
  window.aiReady = true;
  window.aiHistory = window.loadAIHistory();
  chat.innerHTML = '';
  if (window.aiHistory.length) {
    window.aiHistory.forEach(m => chat.appendChild(window.bubble(m.role, m.text, m.source, m.modelInfo)));
  } else {
    chat.appendChild(window.bubble('ai', AI_WELCOME, null));
  }
  chat.scrollTop = chat.scrollHeight;
};

// ==================== 清空聊天记录 ====================
window.clearAIChat = function () {
  if (!confirm('确定清空当前 AI 对话记录吗？清空后不可恢复。')) return;
  window.aiHistory = [];
  localStorage.removeItem(AI_HISTORY_KEY);
  window.aiSessionId = 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  localStorage.setItem(AI_SESSION_KEY, window.aiSessionId);
  const chat = document.getElementById('aiChat');
  if (chat) { chat.innerHTML = ''; chat.appendChild(window.bubble('ai', AI_WELCOME, null)); }
  const sug = document.getElementById('aiSuggestions');
  if (sug) sug.innerHTML = '';
};

// ==================== 发送消息 ====================
window.sendAI = async function (question) {
  const inp = document.getElementById('aiInput');
  const q = (question || inp?.value || '').trim();
  if (!q || window.aiBusy) return;
  window.aiBusy = true;
  if (inp) inp.value = '';
  const sendBtn = document.getElementById('aiSendBtn');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '思考中...'; }
  const chat = document.getElementById('aiChat');
  chat.appendChild(window.bubble('user', q, null));
  window.aiHistory.push({ role: 'user', text: q, time: Date.now() });
  window.saveAIHistory();
  // 等待体验：先插入一个"思考中"占位气泡并随时间更新文案
  // （强模型首字常需 20-30s，干等转圈体验差；回复到达后移除占位）
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'bubble b-ai ai-thinking';
  thinkingEl.innerHTML = '<div class="bubble-inner"><span class="ai-thinking-dots"><span></span><span></span><span></span></span> <span class="ai-thinking-text">正在深度思考…</span></div>';
  chat.appendChild(thinkingEl);
  chat.scrollTop = chat.scrollHeight;
  let thinkSec = 0;
  const thinkTimer = setInterval(() => {
    const txt = thinkingEl.querySelector('.ai-thinking-text');
    if (!txt) { clearInterval(thinkTimer); return; }
    thinkSec += 1;
    // 30s 后模型在走 60s 长窗口（强模型推理），提示用户别干等
    txt.textContent = thinkSec >= 30 ? '深度推理中（可能需要 30-60 秒），请稍候…'
      : thinkSec >= 15 ? '正在组织回答，请稍候…' : '正在深度思考…';
  }, 1000);
  try {
    const j = await apiAuth('/ai/smart?question=' + encodeURIComponent(q) + '&session_id=' + encodeURIComponent(window.aiSessionId));
    const d = j.data || {};
    const ans = d.answer || j.message || '暂无回答';
    const src = d.source || 'local_engine';
    const mi = d.modelInfo || null;
    const bubbleEl = window.bubble('ai', ans, src, mi);
    thinkingEl.replaceWith(bubbleEl);
    window.aiHistory.push({ role: 'ai', text: ans, source: src, modelInfo: mi, time: Date.now() });
    window.saveAIHistory();
    const sug = document.getElementById('aiSuggestions');
    if (sug && d.suggestions && d.suggestions.length) {
      sug.innerHTML = '<span style="font-size:12px;color:#64748b;margin-right:4px">💡 继续问：</span>' +
        d.suggestions.map(s => `<button class="btn btn-sm btn-o" style="font-size:12px" onclick="sendAI('${s.replace(/'/g, "\\'")}')">${esc(s)}</button>`).join('');
    }
  } catch (e) {
    const err = '请求失败：' + e.message;
    thinkingEl.replaceWith(window.bubble('ai', err, null));
    window.aiHistory.push({ role: 'ai', text: err, source: 'local_engine', time: Date.now() });
    window.saveAIHistory();
  }
  clearInterval(thinkTimer);
  chat.scrollTop = chat.scrollHeight;
  window.aiBusy = false;
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '发送'; }
};

// ==================== 加载 AI 能力列表 ====================
window.loadAICapabilities = async function () {
  try {
    const j = await api('/ai/capabilities');
    const el = document.getElementById('aiCapabilities');
    if (!el || !j.data) return;
    el.innerHTML = j.data.capabilities.map(c =>
      `<button class="btn btn-sm btn-o" style="font-size:10.5px;padding:3px 6px;white-space:nowrap;line-height:1.1;border-radius:12px" onclick="sendAI('${(c.example || '').replace(/'/g, "\\'")}')" title="${esc(c.label)}">${c.icon} ${esc(c.label)}</button>`
    ).join('');
  } catch (e) { }
};

// ==================== AI 大模型配置面板 ====================
const AI_CONFIG_KEY = 'ai_llm_config';

window.toggleAiConfig = function () {
  const p = document.getElementById('aiConfigPanel');
  const b = document.getElementById('aiConfigBtn');
  if (p.style.display === 'none') { p.style.display = ''; b.classList.add('btn-p'); b.classList.remove('btn-o'); window.loadAiConfig(); }
  else { p.style.display = 'none'; b.classList.remove('btn-p'); b.classList.add('btn-o'); }
};

window.loadAiConfig = function () {
  try {
    const c = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || '{}');
    document.getElementById('aiBaseUrl').value = c.baseUrl || '';
    document.getElementById('aiModelName').value = c.modelName || '';
    document.getElementById('aiApiKey').value = c.apiKey || '';
  } catch (e) { }
};

window.saveAiConfig = async function () {
  const config = {
    baseUrl: document.getElementById('aiBaseUrl').value.trim(),
    modelName: document.getElementById('aiModelName').value.trim(),
    apiKey: document.getElementById('aiApiKey').value.trim()
  };
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
  try { await apiAuth('/api/ai/config', { method: 'POST', body: JSON.stringify(config) }); } catch (e) { }
  window.showAiConfigMsg('✅ 配置已保存（同时保存到本地和服务器）', '#047857');
};

window.testAiConfig = async function () {
  const s = document.getElementById('aiConfigStatus');
  s.style.display = ''; s.textContent = '🔄 正在测试连接...'; s.color = '#2563eb';
  try {
    const r = await apiAuth('/api/ai/test');
    if (r.code === 0) window.showAiConfigMsg('✅ ' + (r.message || '连接成功'), '#047857');
    else window.showAiConfigMsg('❌ ' + (r.message || '连接失败'), '#dc2626');
  } catch (e) { window.showAiConfigMsg('❌ 网络错误:' + e.message, '#dc2626'); }
};

window.resetAiConfig = function () {
  localStorage.removeItem(AI_CONFIG_KEY);
  document.getElementById('aiBaseUrl').value = '';
  document.getElementById('aiModelName').value = '';
  document.getElementById('aiApiKey').value = '';
  window.showAiConfigMsg('↩️ 已恢复默认配置（使用本地分析引擎）', '#2563eb');
};

window.showAiConfigMsg = function (msg, color) {
  const s = document.getElementById('aiConfigStatus');
  s.style.display = ''; s.textContent = msg; s.color = color;
};

// ==================== AI 样式注入（DOMContentLoaded） ====================
document.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('style');
  s.textContent = `
    .bubble{max-width:88%;word-break:break-word;line-height:1.65;margin:8px 0;padding:10px 14px;border-radius:12px;font-size:13.5px}
    .b-user{margin-left:auto;background:#3b82f6;color:#fff;border-bottom-right-radius:2px}
    .b-ai{margin-right:auto;background:#f1f5f9;color:#334155;border-bottom-left-radius:2px}
    .dark-mode .b-ai{background:#1e293b;color:#e2e8f0}
    .bubble-inner{white-space:pre-wrap}
    .ai-src-tag{font-size:10px;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;font-weight:600;white-space:nowrap;display:inline-block}
    .ai-src-ai{background:#dbeafe;color:#1d4ed8}
    .ai-src-local{background:#dcfce7;color:#16a34a}
    .ai-src-degraded{background:#fef3c7;color:#b45309}
    .dark-mode .ai-src-ai{background:#1e3a5f;color:#60a5fa}
    .dark-mode .ai-src-local{background:#14532d;color:#4ade80}
    .dark-mode .ai-src-degraded{background:#451a03;color:#fbbf24}
    #aiChat .b-ai strong{color:#0f172a}
    #aiChat .b-user strong{color:#fff}
    .dark-mode #aiChat .b-ai strong{color:#f8fafc}
    .chat-bar input{flex:1;padding:10px 14px;border:1.5px solid #e2e8f0;border-radius:10px 0 0 10px;font-size:14px;outline:none;transition:border-color .2s}
    .chat-bar input:focus{border-color:#3b82f6}
    .dark-mode .chat-bar input{background:#0f172a;border-color:#334155;color:#e2e8f0}
    .ai-thinking{opacity:.9}
    .ai-thinking-dots{display:inline-flex;gap:3px;align-items:center}
    .ai-thinking-dots span{width:6px;height:6px;border-radius:50%;background:#6366f1;animation:aiDotPulse 1.2s infinite ease-in-out}
    .ai-thinking-dots span:nth-child(2){animation-delay:.2s}
    .ai-thinking-dots span:nth-child(3){animation-delay:.4s}
    @keyframes aiDotPulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
    .dark-mode .ai-thinking-dots span{background:#818cf8}
    .ai-thinking-text{font-size:13px;color:#6366f1}
    .dark-mode .ai-thinking-text{color:#a5b4fc}
  `;
  document.head.appendChild(s);
});
