/**
 * AI 助手深度测试（离线本地引擎全链路）
 * 复刻 handleAiQuestion 的 LOCAL 路径：routeIntent -> loadDataForIntent -> formatLocalAnswer
 * 不调用 LLM（沙箱无网/无 key），专门验证"兜底确定性答案"的正确性——
 * 因为 LLM 关闭或失败时必须靠本地引擎给出准确、不编造的答案。
 *
 * 用法：node test/ai_deep_test.js            （跑全部 + 自动标记可疑）
 *       node test/ai_deep_test.js --quiet    （只打印标记的可疑项）
 *
 * 退出码：发现可疑项返回 1，否则 0（便于回归）。
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dataAnalyzer = require('../routes/ai/data-analyzer');
const { routeIntent, formatLocalAnswer, setClassNames } = require('../routes/ai/prompt-builder');

const DB_PATH = path.join(__dirname, '..', 'config', 'data.db');

// 简单中文 numeral -> 阿拉伯，便于打印
const CN = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };

// 会话上下文：模拟上一轮刚查过"黄子轩"（唯一命中），用于代词回指/属性追问用例
const sessStudent = { lastData: { student: { name: '黄子轩', sid: '20240001' } } };

const CASES = [
  // [分类, 问题, 可选会话上下文（routeIntent 的 sessionCtx）]
  ['A 自我介绍', '你好'],
  ['A 自我介绍', '你是谁'],
  ['A 自我介绍', '你能做什么'],
  ['B 今日', '今天签到率怎么样'],
  ['B 今日', '今天谁没归'],
  ['B 今日', '现在查寝情况'],
  ['C 未归名单', '哪些学生没归'],
  ['C 未归名单', '未归名单'],
  ['C 未归名单', '谁没回来'],
  ['D 高风险', '哪些学生最近缺勤多'],
  ['D 高风险', '高风险学生'],
  ['D 高风险', '重点关注学生'],
  ['E 趋势', '近30天缺勤趋势'],
  ['E 趋势', '最近整体情况'],
  ['E 趋势', '总体情况'],
  ['F 班级对比', '各班签到率对比'],
  ['F 班级对比', '班级排名'],
  ['G 宿舍', 'D栋今天谁没归'],
  ['G 宿舍', '学四的近期情况'],
  ['G 宿舍', 'A栋 未归'],
  ['G 宿舍', '查一下 B栋'],
  ['G 宿舍', '学三宿舍怎么查'],
  ['H 单匹配', '查一下 黄子轩 的情况'],
  ['H 单匹配', '黄子轩同学的近期情况'],
  ['H 单匹配', '查一下 高一鸣'],
  ['I 重名', '查一下 彭慧 的情况'],
  ['I 重名', '查 王超'],
  ['I 重名', '蔡雨欣同学近期情况'],
  ['I 重名+班级', '测绘2301的彭慧'],
  ['I 重名+班级', 'GIS2301班彭慧的情况'],
  ['J 未找到', '查一下 张三 的情况'],
  ['J 未找到', '查一下 不存在的人'],
  ['J 灵活提问', '吴一鸣，查下这个学生的信息'],
  ['J 灵活提问', '吴一鸣是谁'],
  ['J 灵活提问', '帮我看看黄子轩近况'],
  ['J 灵活提问', '吴一鸣请假了吗'],
  ['J 灵活提问', '今天签到率怎么样？'],
  ['J 灵活提问', '今天签到情况怎么样'],
  ['K 写作', '帮我写一条提醒短信'],
  ['K 写作', '帮我写一份检讨书'],
  ['K 写作', '写一封表扬信'],
  ['L 请假', '待审批的请假多吗'],
  ['L 请假', '请假情况'],
  ['L 请假', '今天谁请假了'],
  ['M 课堂', '最近到课率怎么样'],
  ['M 课堂', '课堂签到情况'],
  ['N 告警', '有哪些待处理的告警'],
  ['N 告警', '异常预警'],
  ['O 建议', '我该怎么管理缺勤学生'],
  ['O 建议', '给我一些建议'],
  ['P 边界', '查一下 一下'],
  ['P 边界', '这个学生'],
  ['P 边界', '那门课'],
  ['P 边界', '随便聊聊'],
  ['Q 日期', '昨天签到率'],
  ['Q 日期', '上周趋势'],
  ['R 班级NL', '测绘2301今天谁没归'],
  ['R 班级NL', 'GIS2301班签到率'],
  ['S 上下文追问', '他的电话?', sessStudent],
  ['S 上下文追问', '她的手机号多少', sessStudent],
  ['S 上下文追问', '他宿舍是哪个', sessStudent],
  ['S 上下文追问', '他最近有请假吗', sessStudent],
  ['S 上下文追问', '这个学生最近表现如何', sessStudent],
  ['S 上下文追问', '我要刚才那个学生的电话', sessStudent],
  ['S 上下文追问', '最近那个学生的电话是多少', sessStudent],
  ['S 上下文追问', '他的电话?', null],
  ['S 上下文追问', '其他班级签到率'],
  ['X 外部话题', '今天天气怎么样'],
  ['X 外部话题', '明天会下雨吗'],
  ['X 外部话题', '现在几点'],
  ['X 外部话题', '今天星期几'],
  ['X 外部话题', '你用的是什么模型'],
  ['X 外部话题', '你用的什么大模型'],
  ['Y 管理概念题', '什么是高风险学生'],
  ['Y 管理概念题', '什么叫缺勤'],
  ['Y 管理概念题', '查寝制度是怎样的'],
  ['Y 管理概念题', '查寝流程是什么'],
  ['Y 管理概念题', '怎么算出勤率'],
  ['Y 管理概念题', '什么是未归'],
];

// 自动标记"可疑答案"的启发式规则
function flagAnswer(intent, answer) {
  const flags = [];
  const a = (answer || '').toString();
  if (!a || a.trim().length < 4) flags.push('空答');
  if (/暂无数据支持该问题的精确回答/.test(a)) flags.push('兜底空白(default)');
  if (/报告生成功能开发中/.test(a)) flags.push('报告占位');
  // 声称模拟/示例/未接入 -> 严重幻觉（不应出现）
  if (/模拟|示例数据|未接入|假数据|编造/.test(a)) flags.push('疑似幻觉表述');
  // 出现"undefined"/"NaN"/"[object"
  if (/undefined|NaN|\[object/.test(a)) flags.push('渲染错误');
  // 含糊无引导
  if (/暂时没法精确回答|暂不支持/.test(a) && !/可以这样问我|例如/.test(a)) flags.push('无引导兜底');
  // LLM 依赖意图但本地无数据（leave/course/alerts/advice 若走 default 即标记）
  if (['leave', 'course', 'alerts', 'advice'].includes(intent) && /暂无数据/.test(a)) flags.push('依赖LLM无本地答案');
  return flags;
}

async function main() {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);
  dataAnalyzer.setDb(db);

  // 注入真实班级列表，使"测绘2301今天谁没归"等自然语文班级过滤可被测试
  const r = db.exec("SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL ORDER BY class_name");
  const classNames = r.length ? r[0].values.map(v => v[0]) : [];
  setClassNames(classNames);
  console.log('已注入班级列表:', classNames.join(', '));

  const quiet = process.argv.includes('--quiet');
  let pass = 0, suspicious = 0;
  const rows = [];

  for (const [cat, q, ctx] of CASES) {
    let intent, answer, err = null;
    try {
      const session = ctx ? JSON.parse(JSON.stringify(ctx)) : {};
      const ir = routeIntent(q, session);
      intent = ir.intent;
      const data = dataAnalyzer.loadDataForIntent(ir, session);
      answer = formatLocalAnswer(ir, data, q);
    } catch (e) {
      err = e.message;
      intent = 'ERR';
      answer = '(抛出异常) ' + e.message;
    }
    const flags = flagAnswer(intent, answer);
    if (err || flags.length) suspicious++;
    else pass++;
    rows.push({ cat, q, intent, answer, flags, err });
  }

  // 输出
  console.log('='.repeat(90));
  console.log(`AI 深度测试：共 ${CASES.length} 例 | 通过 ${pass} | 可疑/问题 ${suspicious}`);
  console.log('='.repeat(90));
  for (const r of rows) {
    if (quiet && !r.flags.length && !r.err) continue;
    const tag = r.flags.length ? '⚠ ' + r.flags.join(',') : '✓';
    console.log(`\n[${r.cat}] "${r.q}"`);
    console.log(`  intent=${r.intent}  ${tag}`);
    const preview = (r.answer || '').replace(/\n/g, ' ⏎ ');
    console.log(`  答: ${preview.slice(0, 300)}`);
  }
  console.log('\n' + '='.repeat(90));
  db.close();
  process.exit(suspicious > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
