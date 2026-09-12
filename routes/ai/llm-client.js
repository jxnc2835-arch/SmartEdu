/**
 * AI LLM 客户端模块
 * 处理与大模型的交互：askZhipu, callLLM, 上下文构建
 */
const axios = require('axios');

async function askZhipu(question, dataContext, history, runtimeConfig) {
  const cfg = runtimeConfig;
  const apiKey = cfg.apiKey || process.env.ZHIPU_AI_API_KEY;
  const baseUrl = cfg.baseUrl || process.env.ZHIPU_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const userModel = cfg.modelName || process.env.ZHIPU_AI_MODEL || 'glm-4-flash';
  
  if (!apiKey || apiKey.trim() === '' || apiKey === '你的_api_key_here') {
    return null;
  }
  
  const isGeneral = !!(dataContext && dataContext.intent === 'general');
  let contextText = isGeneral ? '' : '';
  
  const modelsToTry = [
    { model: userModel, timeout: 60000, retries: 0 },
    { model: 'glm-4-flash', timeout: 30000, retries: 1, fallback: true }
  ];
  
  for (const { model: modelName, timeout: timeoutMs, retries, fallback } of modelsToTry) {
    if (!modelName) continue;
    try {
      const answer = await callLLM(question, contextText, history, apiKey, baseUrl, modelName, timeoutMs, isGeneral);
      if (answer) {
        return { answer, modelName: fallback ? modelName + '（降级）' : modelName, degraded: !!fallback };
      }
    } catch (err) {
      if (retries > 0) continue;
      break;
    }
  }
  return null;
}

async function callLLM(question, contextText, history, apiKey, baseUrl, modelName, timeoutMs = 30000, generalMode = false) {
  const systemPrompt = generalMode 
    ? '你是学工小智，同时是通用知识助手。请自然回答用户问题。'
    : '你是学工小智，高校辅导员AI助手。所有数据必须来自系统实时数据。';
  
  const messages = [{ role: 'system', content: systemPrompt }];
  if (history && history.length > 0) {
    messages.push(...history.slice(-4).map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })));
  }
  messages.push({ role: 'user', content: question });
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await axios.post(
      `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      { model: modelName, messages, temperature: 0.7, max_tokens: 2000 },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: controller.signal, timeout: timeoutMs }
    );
    clearTimeout(timer);
    return response.data.choices?.[0]?.message?.content || null;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function summarizeDataForLLM(data) {
  if (!data || typeof data !== 'object') return '';
  return JSON.stringify(data).slice(0, 2000);
}

function buildStructuredContext(data) {
  if (!data || typeof data !== 'object') return '';
  return JSON.stringify(data, null, 2).slice(0, 3000);
}

module.exports = {
  askZhipu,
  callLLM,
  summarizeDataForLLM,
  buildStructuredContext
};
