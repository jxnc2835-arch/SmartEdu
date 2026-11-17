/**
 * AI 意图路由 + 提示词构建模块
 */
const { resolveDateRef } = require('./date-utils');
const dataAnalyzer = require('./data-analyzer');

// ===== 班级名 / 楼栋 辅助（由 ai-chat.js 注入真实班级列表）=====
let CLASS_NAMES = [];
function setClassNames(arr) { CLASS_NAMES = Array.isArray(arr) ? arr.slice() : []; }

// 中文数字 / 阿拉伯 -> 楼栋字母（库内为 A/B/C/D 栋）
const BUILDING_MAP = { '一': 'A', '二': 'B', '三': 'C', '四': 'D', '五': 'E', '六': 'F', '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E', '6': 'F' };
function resolveBuilding(q) {
  // 学四 / 学3 / D栋 / a栋（大小写不敏感）
  const m = q.match(/学\s*([一二三四五六123456])|([a-d])\s*栋/i);
  if (!m) return null;
  if (m[1]) return (BUILDING_MAP[m[1]] || m[1].toUpperCase()) + '栋';
  if (m[2]) return m[2].toUpperCase() + '栋';
  return null;
}

// 从问题中识别具体班级（如 "测绘2301" / "gis2301班"）
function detectClassName(q) {
  for (const c of CLASS_NAMES) {
    const lc = c.toLowerCase();
    if (q.includes(lc) || q.includes(lc + '班')) return c;
  }
  return '';
}

/**
 * 路由意图
 */
function routeIntent(question, sessionCtx) {
  const q = (question || '').toLowerCase().trim();
  const lastIntent = sessionCtx?.lastIntent || null;
  const lastClassFilter = sessionCtx?.lastClassFilter || '';
  const dateRef = resolveDateRef(q);

  // 班级过滤：优先用户问题中明确提到的班级，否则沿用会话上下文
  let classFilter = lastClassFilter || detectClassName(q);
  // 班级对比意图下展示全部班级，不锁定单一班级
  const classCompareFilter = lastClassFilter || '';

  // 楼栋（"学四"/"D栋"/"a栋" 等）
  const building = resolveBuilding(q);

  // 姓名检测（提前计算，用于下面的趋势/搜索守卫）
  // 1) 结构化候选：姓名在"查/找/搜索/查询/看看/了解(+/一下/下)/的/班"之后，或在"同学/的/近期/情况…"之前（高置信）
  // 2) 位置候选：姓名在标点/空格之前（如"吴一鸣，查下这个学生的信息"）——只参与"库中存在"校验，不做未找到回显
  // 3) 兜底：把连续中文字符切成 2~3 字窗口（处理无触发词的纯姓名，如"彭慧"），仅采纳库中真实存在的姓名
  const BAD_NAME = /^(整体|总体|班级|全校|学院|我们|大家|所有|学校|一下|最近|情况|他们|她们|近整体|近总体|这整体|那整体|学生|同学|个学|这个|那个|该生|本人|老师|怎么样|如何|怎么办|电话|手机|号码|联系方式|邮箱|地址|微信|QQ)$/;
  // 清洗：去掉开头 班/的/这/那/该/此/下/个，去掉结尾 同学/的/近期/情况… 等修饰，避免把"班彭慧""彭慧的"当姓名
  function cleanName(c) {
    return c.replace(/^[班的这那该此下个]+/, '').replace(/[的同学近期最近近况情况档案信息记录资料]+$/, '');
  }
  function validName(c) {
    const n = cleanName(c);
    if (n.length < 2 || BAD_NAME.test(n)) return null;
    // 泛称/语气词不是姓名
    if (/学生|同学|老师|这个|那个|该生|怎|吗|呢|吧|啊|谁|么/.test(n)) return null;
    return n;
  }
  // 库中"精确同名"命中（避免"吴一鸣是谁"被 LIKE 前缀"吴一"抢走）
  function exactNameHit(c) {
    const s = dataAnalyzer.searchStudent(c);
    return s.count > 0 && (s.students || []).some(x => x.name === c);
  }
  function extractName(q) {
    const namePos = [];   // 姓名位置候选（高置信，可做"未找到"回显）
    const posOther = [];  // 标点/空格位置候选（仅参与存在性校验）
    const pushTo = (arr) => (s) => { const n = validName(s); if (n && !arr.includes(n)) arr.push(n); };
    let m;
    const reA = /([一-龥]{2,3})(?:同学|的|近期|最近|近况|情况|档案|信息|资料|记录)/g;
    while ((m = reA.exec(q))) pushTo(namePos)(m[1]);
    const reB = /(?:查|找|搜索|查询|看看|看下|看一眼|了解)\s*(?:一下|下)?\s*([一-龥]{2,3})/g;
    while ((m = reB.exec(q))) pushTo(namePos)(m[1]);
    const reC = /(?:的|班)\s*([一-龥]{2,3})/g;
    while ((m = reC.exec(q))) pushTo(namePos)(m[1]);
    const reD = /([一-龥]{2,3})\s*[，,。！？!?；;、]/g;
    while ((m = reD.exec(q))) pushTo(posOther)(m[1]);
    const reE = /([一-龥]{2,3})\s+(?=帮我|麻烦|请|查|看|了解)/g;
    while ((m = reE.exec(q))) pushTo(posOther)(m[1]);
    // 存在性校验：位置候选 + 标点/空格候选 一起参与；精确同名优先，其次 LIKE 命中
    const allCands = [...namePos, ...posOther];
    for (const c of allCands) if (exactNameHit(c)) return c;
    for (const c of allCands) if (dataAnalyzer.searchStudent(c).count > 0) return c;
    if (namePos.length) return namePos[0]; // 仅用高置信候选做"未找到"回显
    // 兜底窗口扫描：仅采纳库中真实存在的姓名（避免"最近整"之类垃圾误当姓名）
    const segs = q.match(/[一-龥]+/g) || [];
    const cands = [];
    for (const seg of segs) {
      for (let i = 0; i < seg.length; i++) {
        for (let len = 2; len <= 3 && i + len <= seg.length; len++) {
          const n = validName(seg.slice(i, i + len));
          if (n) cands.push(n);
        }
      }
    }
    for (const c of cands) if (exactNameHit(c)) return c;
    for (const c of cands) if (dataAnalyzer.searchStudent(c).count > 0) return c;
    return null;
  }
  let nameHit = extractName(q);
  // 代词回指：问题里有"这个学生/他/她"等指代且有查询意图（含属性追问：他的电话/她的宿舍/手机号）时，
  // 沿用会话中最近一次确认过的学生——即使属性词被误提为姓名候选（库中不存在时），也优先回指；
  // 无上下文则给澄清引导
  if (!nameHit || dataAnalyzer.searchStudent(nameHit).count === 0) {
    const explicitLookup = /(查|找|搜索|查询|信息|档案|资料|情况|近况|近期|是谁|电话|手机|号码|联系方式|宿舍|班级)/.test(q);
    const pronoun = /(这个学生|那个学生|该学生|这位同学|那位同学|这个同学|那位同学|此人|刚才|(?<![其])他|(?<![其])她)/.test(q);
    const lastName = sessionCtx?.lastData?.student?.name;
    // 代词回指仅在"显式查找词 + 真·代词（他/她/刚才/这个学生…）"时触发，沿用上一轮查到的学生；
    // 纯趋势/时间问句（"最近缺勤趋势/到课率"）不含代词，须让位给 trend 等原路由，避免被误吞成 clarify。
    if (explicitLookup && pronoun) {
      if (lastName) nameHit = lastName;
      else return { intent: 'clarify', classFilter, dateRef, param: 'pronoun' };
    }
  }
  const hasLookup = /(查|找|搜索|查询|档案|信息|同学|近期|最近|近况)/.test(q) || !!nameHit;
  const realName = !!nameHit && !BAD_NAME.test(nameHit);

  // 自我介绍
  if (/^(你是|你是谁|你叫什么|你是什么|你是ai吗|你是机器人吗|介绍一下|自我介绍一下|你能做什么|你能帮我|你能查|你有什么功能|功能|帮助|help|你是谁)$/.test(q) ||
      /你好|您好|hello|hi|嗨|哈啰|hallo|在吗|在么|早上好|中午好|晚上好/.test(q)) {
    return { intent: 'self_intro', classFilter, dateRef, param: null };
  }

  // 创作类任务
  const isWritingTask = /(写|起草|代写|拟|帮我|来一|给我|弄一|整一)/.test(q) &&
                        /(短信|通知|邮件|信|文案|话术|发言稿|检讨|道歉|慰问|表扬|寄语|温馨提示|一段|一条|一份|几句)/.test(q) &&
                        !/(名单|统计|趋势|签到率|出勤率|谁没|哪些人|预测|查询|记录)/.test(q);
  if (isWritingTask) {
    return { intent: 'general', classFilter, dateRef, param: 'writing' };
  }

  // 外部话题（天气/日期/股票/新闻/问AI自身等）：非查寝业务，交给 LLM（general）自然回答，别纠结。
  // 必须放在所有业务分支（楼栋/today/absent_list/…）之前，否则"今天天气"的"今天"
  // 会先被 today 正则误吞成签到总览；且晚于 self_intro 与写作类，避免"写节假日通知"被吞。
  // 注意：「是/什么/哪个/模型」等太通用的词不放进外部话题触发（会误伤"是什么高风险学生/哪个班…"等概念题），
  // 它们已由下方「学生管理概念题」分支按 核心词+概念词 结构承接。
  if (/(天气|气温|温度|下雨|下雪|台风|地震|今天几点|现在几点|今天几号|今天星期|今天周几|现在几号|几点钟|股价|股票|A股|基金|比特币|汇率|新闻|热搜|彩票|开奖|球赛|比分|演唱会|gpt|deepseek|通义千问|豆包|kimi)/.test(q) &&
      !/(签到|查寝|出勤|到勤|缺勤|未归|请假|课堂|课程|到课|宿舍|楼栋|风险|出勤率|到课率|谁没|名单|对比|趋势)/.test(q)) {
    return { intent: 'general', classFilter, dateRef, param: null };
  }

  // 学生管理"概念/方法论"题（跟学生管理相关但不查具体学生数据）：
  // 如"什么是高风险学生/什么叫缺勤/查寝制度是怎样的/查寝流程是什么/怎么管理宿舍"，交给 LLM 自然讲解。
  // 放在 dorm/absent_list/today 等数据意图之前，避免被姓名扫描/查寝正则误吞成数据查询。
  // 采用「核心词 AND 概念词」结构（比单纯堆词表稳）：
  //   核心词=学生管理域名词(查寝/签到/缺勤/未归/请假/课堂/到课/宿舍/楼栋/风险/考勤/违纪/操行/高风险…)
  //   概念词=问"是什么/怎么算/制度/流程/标准"等概念性措辞(什么是/什么叫/制度/流程/标准/怎么算/是怎样的/是什么/怎么理解/评价规则…)
  // 只有两类词同时出现才算概念题；若问"查寝情况怎么样/今天谁没归"(核心词+数据疑问词)，
  // 数据疑问词(情况/多少/谁/今天/在寝/出勤率/名单/趋势)命中排除词，让位给 today/absent_list 等数据意图。
  if (
    /(高风险|查寝|签到|出勤|缺勤|未归|请假|课堂|到课|宿舍|楼栋|考勤|违纪|处分|操行|德育|评奖|评优|辅导员|管理办法|考核|评价|风险)/.test(q) &&
    /(什么是|什么叫|啥意思|定义|含义|概念|制度|规定|办法|标准|流程|规范|怎么算|如何算|算不算|怎样算|是怎样的|是什么|怎么理解|有哪些规定|怎么管理|如何管理|怎么看待|如何评价|评分规则|什么标准)/.test(q) &&
    !/(情况|多少|谁没|名单|在寝|出勤率|到课率|今天|今日|现在|最近|近况|趋势|未归率|查寝情况|今天谁|现在谁)/.test(q) &&
    !realName
  ) {
    return { intent: 'general', classFilter, dateRef, param: null };
  }

  // 宿舍（明确楼栋时优先，避免被 today/absent_list 抢走；无楼栋仅"宿舍"类词也归宿舍；
  // 但已锁定具体学生时（如"他宿舍是哪个/黄子轩的宿舍"）让位给学生档案，由档案带出宿舍信息）
  if (building && !realName) {
    return { intent: 'dorm', classFilter, dateRef, param: building };
  }
  if (/(宿舍|寝室|住宿|熄灯|晚归)/.test(q) && !realName) {
    return { intent: 'dorm', classFilter, dateRef, param: null };
  }

  // 未归名单（须在 today 之前，且其正则不含"签到/查寝"，避免误吞对比/趋势）
  if (/(谁没|哪些人|名单|未归|没回来|没归|缺席)/.test(q)) {
    return { intent: 'absent_list', classFilter, dateRef, param: null };
  }

  // 高风险学生
  if (/(风险|高危|缺勤多|经常不|老是缺|总缺勤|重点关注|问题学生|需关注)/.test(q)) {
    return { intent: 'high_risk', classFilter, dateRef, param: null };
  }

  // 课堂（须放在 trend 之前，"最近到课率" 等才不会被趋势概览抢走）
  if (/(课堂|上课|到课|考勤|课程)/.test(q)) {
    return { intent: 'course', classFilter, dateRef, param: null };
  }

  // 趋势 / 总体概览（须在 today 之前；有明确姓名时让位给学生检索）
  if (!realName && (/(趋势|走向|未来|预测|曲线|变化|历史)/.test(q) || /(近期|最近|近况|总体情况|整体情况|概况|这段时间|近30天|近30日)/.test(q))) {
    return { intent: 'trend', classFilter, dateRef, param: null };
  }

  // 班级对比（展示全部班级，不锁定单一班级）
  if (/(班级|各班|对比|排名)/.test(q)) {
    return { intent: 'class_compare', classFilter: classCompareFilter, dateRef, param: null };
  }

  // 今日签到（已移除"未归/缺勤/缺席"，改由 absent_list 承接；仅保留时间词与查寝/签到/在寝）
  if (/(今天|今日|现在|当前|目前|签到|查寝|在寝)/.test(q)) {
    return { intent: 'today', classFilter, dateRef, param: null };
  }

  // 请假（若问题中带真实姓名，如"张三请假了吗/他最近有请假吗"，带出该生请假记录）
  if (/(请假|休假|销假)/.test(q)) {
    return { intent: 'leave', classFilter, dateRef, param: realName ? nameHit : null };
  }

  // 告警
  if (/(告警|预警|异常|提醒)/.test(q)) {
    return { intent: 'alerts', classFilter, dateRef, param: null };
  }

  // 建议（"怎么管理/如何管理/给点建议" 等也归入）
  if (/(建议|怎么办|如何处理|怎么改进|怎么管理|如何管理|给点建议|有何建议|帮我分析)/.test(q)) {
    return { intent: 'advice', classFilter, dateRef, param: null };
  }

  // 学生搜索 / 个人近期情况（有明确姓名时优先，即使带"近期/情况"也视为该生近况）
  if (realName && hasLookup) {
    return { intent: 'search', classFilter, dateRef, param: nameHit };
  }

  // 上下文指代澄清（这个学生 / 那门课 等）
  if (/这个学生|那个学生|该学生|这名同学|那名同学|这个同学|这个楼栋|这个班级|这门课|那门课|这个宿舍|那个宿舍/.test(q)) {
    return { intent: 'clarify', classFilter, dateRef, param: null };
  }

  // 默认：通用问题
  return { intent: 'general', classFilter, dateRef, param: null };
}

/**
 * 写作类模板（无大模型时的本地兜底）
 */
function buildWritingTemplate(text) {
  const t = (text || '');
  if (/检讨|道歉|认错/.test(t)) return `📝 检讨/道歉书建议结构：① 事情经过（时间、地点、事由）② 错误认识 ③ 整改承诺 ④ 请求谅解。把学生姓名与具体事项告诉我，我可据此起草。`;
  if (/表扬|寄语|慰问|鼓励/.test(t)) return `📝 表扬/寄语建议结构：① 具体事迹 ② 肯定与鼓励 ③ 期望嘱托。告诉我对象与事迹，我可帮您起草。`;
  if (/短信|通知|提醒|话术|群发/.test(t)) return `📝 提醒短信（模板）：\n"【学工通知】同学你好，系统显示你近期有 N 次查寝缺勤/未归，请及时向辅导员说明情况；如有疑问请联系 XXX。"\n（把 N 替换为该生真实缺勤天数，我可帮您按真实数据生成。）`;
  return `📝 我可以帮您起草短信、通知、提醒、表扬、寄语、检讨等文案。请告诉我：写给谁、什么事由，我会结合真实数据生成草稿。`;
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
        `• "查一下 彭慧 的情况"\n` +
        `• "最近缺勤趋势如何？"`;

    case 'today': {
      const t = data?.today || {};
      const rate = t.attendance_rate || 0;
      const flag = rate >= 90 ? '✅' : (rate >= 80 ? '⚠️' : '🔴');
      return `【今日签到总览】${timeDesc}\n\n${flag} 出勤率 **${rate}%**\n` +
        `✅ 到勤 ${t.present || 0} 人 | 🏖️ 请假 ${t.leave || 0} 人 | ⚠️ 缺勤/未归 ${t.absent || 0} 人\n` +
        `👥 应到 ${t.total_students || 0} 人（数据最新日：${t.date || '—'}）`;
    }

    case 'absent_list': {
      const a = data?.absent || {};
      if (!a.count) return `【未归 / 缺勤】${a.date || ''}\n\n当前（数据最新日）没有未归或缺勤记录，一切正常 👍`;
      return `【未归 / 缺勤名单】${a.date || ''}\n\n共 **${a.count}** 人：\n` +
        a.students.map(s => `• ${s.name}（${s.class_name} · ${s.dorm || '宿舍未知'}）`).join('\n');
    }

    case 'high_risk': {
      const r = data?.risk || {};
      if (!r.count) return `【高风险学生】近 ${r.days || 30} 天暂无明显缺勤 / 未归记录，继续保持 👍`;
      return `【高风险学生】近 ${r.days || 30} 天缺勤 / 未归排行（共 ${r.count} 人）：\n` +
        r.students.map(s => `• ${s.name}（${s.class_name}）— 缺勤/未归 **${s.absent}** 天`).join('\n');
    }

    case 'trend': {
      const t = data?.trend || {};
      const daily = t.daily || [];
      if (!daily.length) return `【近期趋势】暂无趋势数据。`;
      const last = daily.slice(-7);
      const avg = Math.round(last.reduce((a, b) => a + b.rate, 0) / last.length * 10) / 10;
      return `【近期出勤趋势】近 ${daily.length} 天，最近 7 天平均出勤率 **${avg}%**：\n` +
        last.map(d => `• ${d.date}：${d.rate}%`).join('\n');
    }

    case 'class_compare': {
      const c = data?.classes || [];
      if (!c.length) return `【班级对比】暂无班级数据。`;
      const sorted = [...c].sort((a, b) => b.rate - a.rate);
      return `【各班级出勤率对比】\n` +
        sorted.map(x => `• ${x.class_name}：${x.rate}%（到勤 ${x.present}/${x.total}）`).join('\n');
    }

    case 'dorm': {
      const d = data?.dorm || {};
      const b = data?.dormBuilding || '';
      if (!b) return `🏠 请告诉我具体楼栋，例如："D栋 今天谁没归？" 或 "查一下 A栋 的近期情况"。\n（库内楼栋：A / B / C / D 栋）`;
      if (!d.found) return `🏠 没找到楼栋"${b}"的宿舍数据（库内楼栋：A / B / C / D 栋）。请确认楼栋号，例如"D栋"。`;
      if (!d.count) return `🏠 【${b}】当前（数据最新日：${d.date || '—'}）没有未归 / 缺勤记录 👍`;
      return `🏠 【${b} 未归 / 缺勤】共 **${d.count}** 人：\n` +
        d.students.map(s => `• ${s.name}（${s.class_name} · ${s.dorm}）`).join('\n');
    }

    case 'search': {
      const s = data?.search;
      const name = intentResult.param || '';
      if (data?.notFound || !s || s.count === 0) {
        return `🔍 没有找到叫"${name}"的同学，请确认姓名是否正确，或试试"查一下 XXX 的情况"。`;
      }
      if (s.count > 1) {
        const lines = s.students.map(x => `• ${x.name}（${x.class_name} · ${x.dorm || '宿舍未知'}）`).join('\n');
        return `🔍 叫"${name}"的同学有 **${s.count}** 位，请告诉我您指的是哪一位：\n${lines}`;
      }
      const st = data.student, sum = data.summary || {};
      let body = `📌 **${st.name}**｜${st.class_name}｜${st.dorm || '宿舍未知'}\n`;
      body += `📞 联系电话：${st.phone || '未登记'}\n\n`;
      body += `【近 30 天查寝概况】\n`;
      body += `• 出勤率 **${sum.rate || 0}%**（到勤 ${sum.present || 0} 天 · 请假 ${sum.leave || 0} 天 · 缺勤/未归 ${sum.absent || 0} 天，共 ${sum.total || 0} 条记录）\n`;
      if (sum.absent > 0) body += `• ⚠️ 近 30 天有 **${sum.absent}** 天缺勤 / 未归，建议关注。\n`;
      if (sum.recent && sum.recent.length) {
        body += `\n【最近记录】\n` + sum.recent.slice(0, 6).map(r => `• ${r.date} ${r.status}`).join('\n');
      }
      return body;
    }

    case 'leave': {
      // 指定学生的请假查询（如"张三请假了吗/他最近有请假吗"）
      if (data?.student && data?.studentLeaves) {
        const st = data.student;
        const lv = data.studentLeaves || [];
        if (!lv.length) return `🏖️ **${st.name}**（${st.class_name} · ${st.dorm || '—'}）目前**没有请假记录**。`;
        const STMap = { approved: '已批准', rejected: '已驳回', pending: '待审批', closed: '已销假' };
        const stTxt = lv.map(x =>
          `• ${x.type || '请假'}：${x.reason || '—'}（${x.start_date} ~ ${x.end_date}）— ${STMap[x.status] || x.status || '待审批'}`
        ).join('\n');
        return `🏖️ **${st.name}**（${st.class_name} · ${st.dorm || '—'}）的请假记录（最近 ${lv.length} 条）：\n${stTxt}`;
      }
      const l = data?.leave || {};
      const pending = l.pending || 0;
      const todayOnLeave = l.today_on_leave || 0;
      const total = l.total || 0;
      const approved = l.approved || 0;
      const rejected = l.rejected || 0;
      let body = `🏖️ 【请假概况】（数据最新日：${l.date || '—'}）\n`;
      body += `• 待审批：${pending} 条\n• 今日在请假状态：${todayOnLeave} 人\n`;
      body += `• 累计请假记录：${total} 条（已批准 ${approved} / 已驳回 ${rejected}）\n`;
      const byType = l.pending_by_type || [];
      if (byType.length) body += `• 待审批类型分布：${byType.map(t => `${t.type} ${t.c} 条`).join('、')}\n`;
      const list = l.pending_list || [];
      if (list.length) {
        body += `\n📋 【待审批名单】（${list.length} / ${pending} 条，按申请时间先后）\n`;
        body += list.map((s, i) =>
          `${i + 1}. **${s.name}**（${s.class_name} · ${s.dorm || '—'}）${s.type || ''}：${s.reason || '—'}（${s.start_date} ~ ${s.end_date}）`
        ).join('\n');
        if (pending > list.length) body += `\n\n（仅显示最早申请的 ${list.length} 条，其余 ${pending - list.length} 条请在\"请假管理\"中查看）`;
      }
      if (pending > 0) body += `\n\n⚠️ 共 ${pending} 条请假待您审批，请及时在\"请假管理\"中处理。`;
      return body;
    }

    case 'course': {
      const c = data?.course || {};
      const rate = c.recent_7d_rate || 0;
      const flag = rate >= 90 ? '✅' : (rate >= 80 ? '⚠️' : '🔴');
      const cnt = c.course_count || 0;
      if (!cnt) return `📚 【课堂到课】暂无课堂签到数据。`;
      return `📚 【课堂到课概况】（近 7 天 · 数据最新日：${c.date_end || '—'}）\n\n${flag} 平均到课率 **${rate}%**\n` +
        `✅ 到课 ${c.recent_7d_present || 0} 人次 | ❌ 缺课 ${c.recent_7d_absent || 0} 人次（共 ${c.recent_7d_total || 0} 条记录）\n` +
        `📖 涉及课程 ${cnt} 门`;
    }

    case 'alerts': {
      const a = data?.alerts || {};
      const open = a.open || 0;
      const closedToday = a.closed_today || 0;
      const flag = open > 0 ? '🔴' : '✅';
      return `🔔 【异常告警】\n${flag} 当前未处理告警 **${open}** 条${closedToday ? `（今日已处理 ${closedToday} 条）` : ''}\n` +
        (open > 0 ? `\n建议优先查看"数据大屏 → 告警"中连续未归 / 高频缺勤学生的预警。` : `\n暂无未处理告警，运行状态良好 👍`);
    }

    case 'advice': {
      const t = data?.today || {};
      const r = data?.risk || {};
      const c = data?.classes || [];
      const lowest = c.length ? [...c].sort((a, b) => a.rate - b.rate)[0] : null;
      let body = `💡 【管理建议】基于当前数据：\n`;
      body += `• 最新一日出勤率 **${t.attendance_rate || 0}%**（缺勤/未归 ${t.absent || 0} 人），${ (t.attendance_rate||0) >= 90 ? '整体平稳' : '需关注' }。\n`;
      if (r && r.count) body += `• 近 30 天有 **${r.count}** 名高风险学生（缺勤/未归较多），建议逐一谈心谈话并核实原因。\n`;
      if (lowest) body += `• 出勤率最低的班级是 **${lowest.class_name}（${lowest.rate}%）**，可针对性加强该班查寝。\n`;
      body += `\n您也可以直接问我："近30天哪些学生缺勤多？" 或 "某同学的近期情况"。`;
      return body;
    }

    case 'clarify':
      if (intentResult.param === 'pronoun') {
        return `💬 你提到了"他/她"，但我还不知道指哪位同学。请先告诉我姓名，例如"查一下张三的情况"，之后就可以直接问"他的电话""她的宿舍"等。`;
      }
      return buildClarify(_rawQuestion, timeDesc);

    case 'general': {
      if (intentResult.param === 'writing') {
        return buildWritingTemplate(_rawQuestion);
      }
      // 无大模型兜底：给出当前整体概览 + 引导，而不是干巴巴的欢迎语
      let snap = {};
      try { snap = dataAnalyzer.getFullDataSnapshot('') || {}; } catch (_) { snap = {}; }
      const t = snap.today || {};
      return `💬 这个问题我暂时没法精确回答，不过先给您当前的整体情况：\n\n` +
        `📊 最新一日出勤率 **${t.attendance_rate || 0}%**（到勤 ${t.present || 0} · 请假 ${t.leave || 0} · 缺勤/未归 ${t.absent || 0}）\n\n` +
        `您可以这样问我：\n• "今天谁没归？"\n• "近30天哪些学生缺勤多？"\n• "查一下 彭慧 的情况"\n• "各班出勤率对比"`;
    }

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
    return `💬 你提到的"这个学生"没有上下文，请告诉我具体姓名，例如："查一下张三的情况"`;
  }
  if (/(这个楼栋|那个楼栋|这个宿舍|那个宿舍)/.test(q)) {
    return `💬 你提到的楼栋没有上下文，请直接告诉我楼栋号，例如："D栋今天谁没归？"`;
  }
  if (/(这个班级|那个班级)/.test(q)) {
    return `💬 你提到的班级没有上下文，请直接告诉我班级名，例如："测绘2301今天谁没归？"`;
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
  getSuggestions,
  setClassNames,
  resolveBuilding
};
