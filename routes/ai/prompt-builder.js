/**
 * AI 意图路由 + 提示词构建模块
 */
const { resolveDateRef, dateRefDate, dateRefEnd, dateRefDays, dateRefRange } = require('./date-utils');

/**
 * 路由意图
 */
function routeIntent(question, sessionCtx) {
  const q = (question || '').toLowerCase().trim();
  const lastIntent = sessionCtx?.lastIntent || null;
  const lastClassFilter = sessionCtx?.lastClassFilter || '';
  const dateRef = resolveDateRef(q);
  
  // 自我介绍
  if (/^(你是|你是谁|你叫什么|你是什么|你是ai吗|你是机器人吗|介绍一下|自我介绍一下|你能做什么|你能帮我|你能查|你有什么功能|功能|帮助|help|你是谁)$/.test(q) ||
      /你好|您好|hello|hi|嗨|哈啰|hallo|在吗|在么|早上好|中午好|晚上好/.test(q)) {
    return { intent: 'self_intro', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 创作类任务
  const isWritingTask = /(写|起草|代写|拟|帮我|来一|给我|弄一|整一)/.test(q) &&
                        /(短信|通知|邮件|信|文案|话术|发言稿|检讨|道歉|慰问|表扬|寄语|温馨提示|一段|一条|一份|几句)/.test(q) &&
                        !/(名单|统计|趋势|签到率|出勤率|谁没|哪些人|预测|查询|记录)/.test(q);
  if (isWritingTask) {
    return { intent: 'general', classFilter: lastClassFilter, dateRef, param: 'writing' };
  }
  
  // 今日签到
  if (/(今天|今日|现在|当前|目前|签到|查寝|在寝|未归|缺席|缺勤)/.test(q) && !/(名单|谁|哪些|学生|档案)/.test(q)) {
    return { intent: 'today', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 未归名单
  if (/(谁没|哪些人|名单|未归|没回来|没归|缺席)/.test(q)) {
    return { intent: 'absent_list', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 高风险学生
  if (/(风险|高危|缺勤多|经常不|老是缺|总缺勤|重点关注|问题学生|需关注)/.test(q)) {
    return { intent: 'high_risk', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 趋势预测
  if (/(趋势|走向|未来|预测|曲线|变化|历史)/.test(q)) {
    return { intent: 'trend', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 班级对比
  if (/(班级|各班|对比|排名)/.test(q)) {
    return { intent: 'class_compare', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 请假
  if (/(请假|休假|销假)/.test(q)) {
    return { intent: 'leave', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 宿舍
  if (/(宿舍|寝室|住宿|熄灯|晚归)/.test(q)) {
    return { intent: 'dorm', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 课堂
  if (/(课堂|上课|到课|考勤|课程)/.test(q)) {
    return { intent: 'course', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 学生搜索
  if (/(查|找|搜索|查询|档案|学生信息)/.test(q) && /(张三|李四|王五|学生|名字|姓名)/.test(q)) {
    return { intent: 'search', classFilter: lastClassFilter, dateRef, param: q.replace(/[查找搜索查询]/g, '').trim() };
  }
  
  // 告警
  if (/(告警|预警|异常|提醒)/.test(q)) {
    return { intent: 'alerts', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 建议
  if (/(建议|怎么办|如何处理|怎么改进)/.test(q)) {
    return { intent: 'advice', classFilter: lastClassFilter, dateRef, param: null };
  }
  
  // 默认：通用问题
  return { intent: 'general', classFilter: lastClassFilter, dateRef, param: null };
}

/**
 * 格式化本地答案
 */
function formatLocalAnswer(intentResult, data, _rawQuestion) {
  const intent = intentResult.intent;
  const timeDesc = `【${new Date().toLocaleString('zh-CN')}】`;
  
  switch (intent) {
    case 'self_intro':
      return `老师你好！我是学工小智 🙋\n\n我可以帮你做这些事：\n\n` +
        `📋 **数据查询** — 今日签到率、未归名单、请假情况、课堂签到\n` +
        `🔍 **学生档案** — 搜索任意学生的详细信息和出勤记录\n` +
        `⚠️ **风险预警** — 高风险学生、缺勤趋势、宿舍异常\n` +
        `📊 **对比分析** — 各班级签到率对比、历史趋势\n` +
        `💡 **智能建议** — 基于数据给出管理建议\n\n` +
        `直接用自然语言问我就行，比如：\n` +
        `• "今天签到率怎么样？"\n` +
        `• "哪些学生没归？"\n` +
        `• "查一下张三的情况"\n` +
        `• "最近缺勤趋势如何？"`;
    
    case 'today':
      const t = data?.today || {};
      return `【今日签到总览】${timeDesc}\n\n` +
        `📊 签到率 **${t.attendance_rate || 0}%**\n` +
        `✅ 在寝 ${t.present || 0} 人 | ⚠️ 未归 ${t.absent || 0} 人 | 📝 请假 ${t.leave || 0} 人\n` +
        `👥 应到 ${t.total_students || 0} 人`;
    
    case 'absent_list':
      const absent = data?.absent || {};
      return `【未归学生】${timeDesc}\n\n共 ${absent.count || 0} 人未归：\n` +
        (absent.students?.length ? absent.students.map(s => `• ${s.name}（${s.class_name}）`).join('\n') : '暂无未归学生');
    
    case 'high_risk':
      const risk = data?.risk || {};
      return `【高风险学生】${timeDesc}\n\n共 ${risk.count || 0} 人：\n` +
        (risk.students?.length ? risk.students.map(s => `• ${s.name}（缺勤${s.absent}天）`).join('\n') : '暂无高风险学生');
    
    case 'general':
      return `💬 我是学工AI助手，可以帮你查询签到数据、分析风险学生、生成管理建议。\n\n` +
        `试试问我：\n• "今天签到率怎么样？"\n• "哪些学生是高风险？"\n• "帮我写一条提醒短信"`;
    
    default:
      return `【${intent}】${timeDesc}\n\n暂无数据支持该问题的精确回答。`;
  }
}

/**
 * 构建澄清问题
 */
function buildClarify(question, timeDesc) {
  const q = (question || '').trim();
  if (/(这门课|那门课|该课程)/.test(q)) {
    return `💬 你提到的"这门课"没有上下文，请告诉我具体课程名，例如："摄影测量学上课情况"`;
  }
  if (/(那个学生|这个学生|该学生)/.test(q)) {
    return `💬 你提到的"那个学生"没有上下文，请告诉我具体姓名，例如："查一下张三的情况"`;
  }
  return `💬 请明确您的问题，例如：\n• "今天签到率怎么样？"\n• "哪些学生是高风险？"\n• "帮我写一条提醒短信"`;
}

/**
 * 获取推荐追问
 */
function getSuggestions(intent) {
  const map = {
    today: ['今天未归学生是谁？', '高风险学生有哪些？', '各班级签到率如何？'],
    absent_list: ['这些学生该怎么处理？', '昨天也是这些吗？', '缺勤趋势怎么样？'],
    high_risk: ['缺勤趋势分析', '班级对比排名', '给我处理建议'],
    trend: ['高风险学生', '班级对比', '未来预测'],
    class_compare: ['未归学生详情', '高风险学生', '如何改进'],
    general: ['今天签到率怎么样？', '高风险学生有哪些？', '给我一些管理建议']
  };
  return map[intent] || map.general;
}

module.exports = {
  routeIntent,
  formatLocalAnswer,
  buildClarify,
  getSuggestions
};
