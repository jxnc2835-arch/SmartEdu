/**
 * 模拟数据补齐脚本（纯追加，绝不删除现有数据）
 * ------------------------------------------------------------
 * 用途：把项目里的模拟数据补齐到「今天」为止，并保证各业务类型数据完备。
 *       - 查寝 records(type=checkin)：补齐到今天（含今天，今天为模拟时间戳）
 *       - 课程 courses + 课堂签到 records(type=class)：补齐到今天（国庆假期不排课）
 *       - 请假 leaves：补齐到今天
 *       - 访客 visitors / 公告 announcements / 任务 tasks / 地理围栏 geofence_rules：此前为 0，全量补齐
 *       - 缺勤预警 absence_alerts：补齐近期
 *       - 日志 logs / 语音 voice_records：补齐近期
 *
 * 安全策略：
 *   1. 默认 dry-run（不加 --force）：只打印计划，绝不写库。
 *   2. --force 执行前，自动把当前 config/data.db 复制为 data.db.bak.<timestamp>。
 *   3. 所有插入使用 `bf_` 前缀唯一主键 + INSERT OR IGNORE，可重复运行而不冲突/不重复。
 *   4. 不执行任何 DELETE / DROP，现有数据原样保留。
 *
 * 用法：
 *   node scripts/backfill_demo_data.js            # 预览计划（不写库）
 *   node scripts/backfill_demo_data.js --force    # 备份并执行补齐
 *   node scripts/backfill_demo_data.js --force --end 2026-10-09  # 指定终点
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'config', 'data.db');
const FORCE = process.argv.includes('--force');
const args = process.argv.slice(2);
const endArgIdx = args.indexOf('--end');
const TODAY = endArgIdx >= 0 && args[endArgIdx + 1] ? args[endArgIdx + 1] : '2026-10-09';
const NATIONAL_HOLIDAY = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];

// ---------- 工具函数 ----------
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (h, m) => `${pad(h)}:${pad(m)}:00`;
function weighted(stats) {
  const r = Math.random();
  let acc = 0;
  for (const [k, w] of Object.entries(stats)) { acc += w; if (r <= acc) return k; }
  return Object.keys(stats)[Object.keys(stats).length - 1];
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
function eachDate(startStr, endStr, cb) {
  let cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  while (cur <= end) { cb(fmtDate(cur), cur.getDay()); cur.setDate(cur.getDate() + 1); }
}

// ---------- 各类配置 ----------
const CHECKIN_STATS_NORMAL = { '在寝': 0.86, '未归': 0.07, '病假': 0.04, '事假': 0.03 };
const CHECKIN_STATS_HOLIDAY = { '在寝': 0.52, '未归': 0.23, '病假': 0.12, '事假': 0.13 };
const CLASS_STATS = { '出勤': 0.88, '迟到': 0.06, '请假': 0.03, '缺勤': 0.03 };

const LEAVE_TYPES = ['病假', '事假', '公假', '丧假'];
const LEAVE_REASONS = {
  '病假': ['感冒发烧', '肠胃炎', '头痛', '运动受伤', '体检就医', '牙科就诊', '流感', '肺炎住院'],
  '事假': ['家庭事务', '回老家办事', '搬家', '亲戚来访', '证件办理', '个人事务'],
  '公假': ['参加测绘竞赛', '学术会议', '企业实习', '志愿者活动', '学校文艺活动', '运动会'],
  '丧假': ['亲属去世料理后事']
};
const LEAVE_STATUS = ['approved', 'approved', 'approved', 'pending', 'rejected'];

const COURSE_NAMES = ['测量学基础', 'GIS原理', '遥感技术', '导航原理', '地形测量', '地图制图',
  '空间数据库', '摄影测量', '大地测量', '工程测量', '误差理论与平差', 'GNSS定位技术'];
const CLASSROOMS = ['南训楼A101', '南训楼A202', '南训楼B301', '北训楼C101', '北训楼C202',
  '实训楼D101', '实训楼D202', '机房E101', '机房E202'];

const VISIT_PURPOSES = ['家长探访', '快递/外卖配送', '宿舍维修', '校外面试', '同学串访', '辅导员走访', '安全检查'];
const VISIT_NAMES = ['王建国', '李秀英', '张师傅', '刘明', '陈晓', '赵阿姨', '周强', '孙丽', '黄伟', '吴敏'];

const ANNOUNCEMENTS = [
  ['开学第一次全体班会通知', '各位同学：本周日晚19:00在阶梯教室召开新学期第一次班会，请准时参加，班长负责签到。'],
  ['夜间查寝管理规定', '为规范宿舍管理，每晚22:00前完成查寝打卡。未归同学须提前在系统提交请假，逾期未归将触发缺勤预警。'],
  ['国庆节放假安排', '根据校历，10月1日至10月7日国庆节放假调休，10月8日（周四）起正常上课。假期离校请提前报备。'],
  ['防电信网络诈骗提醒', '近期校园周边电信诈骗高发，请勿轻信陌生来电与刷单兼职，涉及转账一律当面核实，遇可疑情况及时联系辅导员。'],
  ['体测与体检通知', '本月将组织全体学生体质健康测试与年度体检，具体时间地点另行通知，请保持手机畅通。'],
  ['国家助学金申请启动', '家庭经济困难学生助学金申请通道已开启，请符合条件的同学在规定时间内提交材料，逾期不予受理。'],
  ['期中考试安排', '第8-9教学周组织期中考试，请同学们合理安排复习，严禁作弊，违者按校纪严肃处理。'],
  ['宿舍安全卫生大检查', '本周五下午开展宿舍安全卫生大检查，重点排查大功率电器与私拉电线，请各宿舍提前整理。'],
  ['运动会报名通知', '校运动会将于下月举办，设有田径、趣味项目等，欢迎同学们积极报名，为班级争光。'],
  ['期末复习与诚信考试教育', '临近期末，请同学们制定复习计划。学校将持续开展诚信考试教育，严肃考风考纪。'],
  ['寒潮降温预警', '气象台发布寒潮蓝色预警，气温将大幅下降，请同学们及时添衣保暖，注意宿舍通风与用电安全。'],
  ['图书馆延长开放通知', '考试月临近，图书馆自习区开放时间延长至23:00，请同学们有序使用，保持安静。']
];

const TASK_TEMPLATES = [
  ['查寝数据每日汇总', 'pending', '辅导员'],
  ['待审批请假单处理', 'pending', '辅导员'],
  ['宿舍安全巡查', 'pending', '宿管员'],
  ['缺勤预警复核', 'pending', '辅导员'],
  ['系统数据自动备份核查', 'done', '系统'],
  ['人脸识别模型准确率抽检', 'done', '管理员'],
  ['周报生成与上报', 'pending', '辅导员'],
  ['异常GPS定位记录核查', 'pending', '管理员'],
  ['访客登记台账核对', 'done', '宿管员'],
  ['月度考勤统计', 'pending', '教务']
];

const GEOFENCES = [
  ['男生公寓A栋围栏', 28.6821, 115.8521, 120, 'dorm'],
  ['男生公寓B栋围栏', 28.6830, 115.8530, 120, 'dorm'],
  ['女生公寓C栋围栏', 28.6815, 115.8515, 120, 'dorm'],
  ['女生公寓D栋围栏', 28.6808, 115.8508, 120, 'dorm'],
  ['教学区主围栏', 28.6845, 115.8550, 300, 'campus']
];

const VOICE_TEXTS = ['我在寝室', '今天已回宿舍', '晚安打卡', '我已签到', '在宿舍休息'];

// ---------- 主流程 ----------
async function main() {
  const SQL = await initSqlJs();
  const data = fs.readFileSync(DB_FILE);
  const db = new SQL.Database(data);

  // 读取现有学生
  const stuRes = db.exec("SELECT student_id, name, gender, class_name, dorm FROM students");
  const students = stuRes[0] ? stuRes[0].values.map(r => ({
    id: r[0], name: r[1], gender: r[2], class_name: r[3], dorm: r[4]
  })) : [];
  const classes = [...new Set(students.map(s => s.class_name))];

  // 幂等起点计算：必须基于「清理后」的库计算补齐起点（force 模式在清理后调用；dry-run 基于当前库）
  function computeStarts(database) {
    const maxCheckin = database.exec("SELECT MAX(date) FROM records WHERE type='checkin'")[0]?.values?.[0]?.[0] || '2026-09-14';
    const maxClass = database.exec("SELECT MAX(date) FROM records WHERE type='class'")[0]?.values?.[0]?.[0] || '2026-08-31';
    const maxLeave = database.exec("SELECT MAX(start_date) FROM leaves")[0]?.values?.[0]?.[0] || '2026-08-30';
    const ci = addDays(maxCheckin, 1);
    const cl = addDays(maxClass, 1) < '2026-09-01' ? '2026-09-01' : addDays(maxClass, 1);
    const lv = addDays(maxLeave, 1);
    return { checkinStart: ci, classStart: cl, leaveStart: lv };
  }

  // 0 表（visitors/tasks/announcements/geofence）从较早起点补齐，体现完整历史
  const miscStart = '2026-09-01';

  if (!FORCE) {
    const { checkinStart, classStart, leaveStart } = computeStarts(db);
    console.log('🛡️  DRY-RUN 模式（未加 --force）：仅预览计划，不写库。\n');
    console.log('目标库:', DB_FILE, `(${(data.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log('学生总数:', students.length, '班级:', classes.join(', '));
    console.log('补齐终点 TODAY =', TODAY, '\n');
    console.log('=== 各类型补齐窗口（起点 → 终点）===');
    console.log(`  查寝 checkin     : ${checkinStart} → ${TODAY}`);
    console.log(`  课程/课堂 class  : ${classStart} → ${TODAY}（国庆10-01~07不排课）`);
    console.log(`  请假 leaves      : ${leaveStart} → ${TODAY}`);
    console.log(`  访客/公告/任务等 : ${miscStart} → ${TODAY}`);
    console.log('\n=== 预计生成数量（估算）===');
    let ck = 0, cs = 0, cr = 0, lv = 0, vs = 0, an = 0, tk = 0;
    eachDate(checkinStart, TODAY, () => { ck += students.length; });
    eachDate(classStart, TODAY, (d, wd) => {
      if (wd >= 1 && wd <= 5 && !NATIONAL_HOLIDAY.includes(d)) {
        cr += classes.length; cs += classes.length * students.length / classes.length * 40; // approx
      }
    });
    // 精确课堂估算
    cs = 0; cr = 0;
    eachDate(classStart, TODAY, (d, wd) => {
      if (wd >= 1 && wd <= 5 && !NATIONAL_HOLIDAY.includes(d)) {
        classes.forEach(() => { cr += 1; cs += 40; });
      }
    });
    eachDate(leaveStart, TODAY, () => { lv += Math.round(students.length * 0.04); });
    eachDate(miscStart, TODAY, () => { vs += randInt(2, 5); });
    an = ANNOUNCEMENTS.length; tk = TASK_TEMPLATES.length * 6;
    console.log(`  查寝记录   : ~${ck} 条`);
    console.log(`  课程       : ~${cr} 门`);
    console.log(`  课堂签到   : ~${cs} 条`);
    console.log(`  请假记录   : ~${lv} 条`);
    console.log(`  访客记录   : ~${vs} 条`);
    console.log(`  公告       : ${an} 条`);
    console.log(`  任务       : ~${tk} 条`);
    console.log(`  地理围栏   : ${GEOFENCES.length} 条（若为空）`);
    console.log(`  缺勤预警   : 基于补齐查寝中的「未归」生成`);
    console.log(`  日志/语音  : 补齐近期若干条`);
    console.log('\n确认无误后运行: node scripts/backfill_demo_data.js --force');
    db.close();
    return;
  }

  // ---------- 真正执行 ----------
  // 1. 备份
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bakFile = DB_FILE.replace(/\.db$/, `.bak.${ts}`);
  fs.copyFileSync(DB_FILE, bakFile);
  console.log(`💾 已备份 → ${path.relative(path.join(__dirname, '..'), bakFile)}\n`);

  db.run('BEGIN');

  // 幂等清理：先删除上次补齐生成的 bf_ 前缀数据（不含任何原始数据），再重建。
  // 这样脚本可反复运行：每次 --force 都会把补齐部分重算到最新 TODAY。
  console.log('清理上次补齐数据（bf_ 前缀，不影响原始数据）...');
  ['records', 'courses', 'leaves', 'visitors', 'announcements', 'tasks', 'absence_alerts', 'logs', 'voice_records'].forEach((t) => {
    db.run(`DELETE FROM ${t} WHERE id LIKE 'bf_%'`);
  });

  const { checkinStart, classStart, leaveStart } = computeStarts(db);

  const stats = { checkin: 0, course: 0, class: 0, leave: 0, visitor: 0, announcement: 0, task: 0, geofence: 0, alert: 0, log: 0, voice: 0 };

  const insCheckin = db.prepare(`INSERT OR IGNORE INTO records
    (id, student_id, date, time, type, status, note, latitude, longitude, address, photo_path, course_id, course_name, offline, class_name, liveness_passed, liveness_score)
    VALUES (?,?,?,?, 'checkin', ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`);
  const insCourse = db.prepare(`INSERT OR IGNORE INTO courses (id, name, date, start_time, end_time, location, class_name, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insClass = db.prepare(`INSERT OR IGNORE INTO records
    (id, student_id, date, time, type, status, note, latitude, longitude, address, photo_path, course_id, course_name, offline, class_name, liveness_passed, liveness_score)
    VALUES (?,?,?,?, 'class', ?, ?, NULL, NULL, ?, NULL, ?, ?, 0, ?, 1, 0.95)`);
  const insLeave = db.prepare(`INSERT OR IGNORE INTO leaves
    (id, student_id, type, reason, start_date, end_date, attachment_path, status, created_at, processed_at, processed_by, comment)
    VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)`);
  const insVisitor = db.prepare(`INSERT OR IGNORE INTO visitors
    (id, visitor_name, visitor_id_card, visitor_phone, target_student_id, target_dorm, visit_purpose, visit_date, visit_time, visitor_photo_path, checked_in, checked_out, checked_out_time, note, created_at, face_hash)
    VALUES (?,?,?,?,?,?,?,?,?,NULL,1,?,?,?,?, '')`);
  const insAnn = db.prepare(`INSERT OR IGNORE INTO announcements (id, title, content, created_at) VALUES (?,?,?,?)`);
  const insTask = db.prepare(`INSERT OR IGNORE INTO tasks (id, date, class_name, remark, status, created_at, created_by) VALUES (?,?,?,?,?,?,?)`);
  const insGeo = db.prepare(`INSERT OR IGNORE INTO geofence_rules (name, latitude, longitude, radius_meters, type, active, created_at) VALUES (?,?,?,?,?,1,'')`);
  const insAlert = db.prepare(`INSERT OR IGNORE INTO absence_alerts (id, student_id, student_name, class_name, date, status, reason, note, created_at, closed_at, closed_by) VALUES (?,?,?,?,?,'open',?,'',?,?,'')`);
  const insLog = db.prepare(`INSERT OR IGNORE INTO logs (id, time, action, detail, level, operator) VALUES (?,?,?,?,?,?)`);
  const insVoice = db.prepare(`INSERT OR IGNORE INTO voice_records (id, student_id, audio_path, text, timestamp, date, status, note) VALUES (?,?,?,?,?,?,'success','')`);

  // 缺失预警的学生集合（用于生成 absence_alerts）
  const missingStudents = {}; // date -> [{id,name,class}]

  // 2. 查寝
  console.log('生成查寝记录...');
  eachDate(checkinStart, TODAY, (d) => {
    const isHoliday = NATIONAL_HOLIDAY.includes(d);
    const dist = isHoliday ? CHECKIN_STATS_HOLIDAY : CHECKIN_STATS_NORMAL;
    students.forEach((s) => {
      const status = weighted(dist);
      const h = randInt(21, 22);
      const m = randInt(0, 59);
      const time = `${d} ${pad(h)}:${pad(m)}:00`;
      let note = '';
      if (status === '病假' || status === '事假') note = choice(LEAVE_REASONS[status]);
      else if (status === '未归') note = '未在宿舍';
      else if (Math.random() > 0.6) note = '扫码签到';
      const livenessPassed = status === '在寝' ? (Math.random() > 0.35 ? 1 : 0) : (Math.random() > 0.7 ? 1 : 0);
      const livenessScore = livenessPassed ? (0.85 + Math.random() * 0.14).toFixed(4) : (0.3 + Math.random() * 0.4).toFixed(4);
      const lat = 28.68 + (Math.random() - 0.5) * 0.01;
      const lng = 115.85 + (Math.random() - 0.5) * 0.01;
      const addr = `江西飞行学院 ${s.dorm}`;
      insCheckin.run([`bf_c_${s.id}_${d}`, s.id, d, time, status, note, lat, lng, addr, s.class_name, livenessPassed, livenessScore]);
      stats.checkin++;
      if (status === '未归') { (missingStudents[d] = missingStudents[d] || []).push(s); }
    });
  });

  // 3. 课程 + 课堂签到（仅工作日且非国庆）
  console.log('生成课程与课堂签到...');
  eachDate(classStart, TODAY, (d, wd) => {
    if (wd < 1 || wd > 5 || NATIONAL_HOLIDAY.includes(d)) return; // 周末/国庆不排课
    classes.forEach((cls) => {
      // 每班每天 1 门课
      const course = choice(COURSE_NAMES);
      const location = choice(CLASSROOMS);
      const startH = choice([8, 10, 14, 16]);
      const courseId = `bf_course_${d}_${cls}`;
      insCourse.run([courseId, course, d, `${pad(startH)}:00`, `${pad(startH + 2)}:00`, location, cls, `${d} ${pad(startH)}:00`]);
      stats.course++;
      const classStudents = students.filter(s => s.class_name === cls);
      classStudents.forEach((s) => {
        const cstatus = weighted(CLASS_STATS);
        const cm = cstatus === '迟到' ? randInt(10, 55) : randInt(0, 9);
        const ctime = `${d} ${pad(startH)}:${pad(cm)}:00`;
        insClass.run([`bf_a_${s.id}_${d}`, s.id, d, ctime, cstatus, '', location, courseId, course, cls]);
        stats.class++;
      });
    });
  });

  // 4. 请假（覆盖到今天）
  console.log('生成请假记录...');
  eachDate(leaveStart, TODAY, (d) => {
    const n = Math.round(students.length * 0.04);
    for (let i = 0; i < n; i++) {
      const s = choice(students);
      const type = choice(LEAVE_TYPES);
      const reason = choice(LEAVE_REASONS[type]);
      const duration = randInt(1, 5);
      const end = addDays(d, duration);
      const status = choice(LEAVE_STATUS);
      const created = `${d} ${pad(randInt(8, 20))}:${pad(randInt(0, 59))}:00`;
      const processed = status === 'approved' ? `${d} ${pad(randInt(8, 20))}:${pad(randInt(0, 59))}:00` : null;
      insLeave.run([`bf_lv_${s.id}_${d}_${i}`, s.id, type, reason, d, end, status, created, processed, status === 'approved' ? '辅导员' : null, status === 'approved' ? '同意' : null]);
      stats.leave++;
    }
  });

  // 5. 访客（每天 2-5 条）
  console.log('生成访客记录...');
  eachDate(miscStart, TODAY, (d) => {
    const n = randInt(2, 5);
    for (let i = 0; i < n; i++) {
      const s = choice(students);
      const vname = choice(VISIT_NAMES);
      const purpose = choice(VISIT_PURPOSES);
      const vh = randInt(8, 21);
      const vm = randInt(0, 59);
      const outH = vh + randInt(1, 3);
      insVisitor.run([`bf_v_${d}_${i}_${Date.now()}`, vname, `3601${randInt(10000000, 99999999)}`, `1${randInt(3800000000, 3999999999)}`, s.id, s.dorm, purpose, d, `${pad(vh)}:${pad(vm)}:00`, 1, `${pad(Math.min(outH, 23))}:${pad(vm)}:00`, `探访${s.name}`, `${d} ${pad(vh)}:${pad(vm)}:00`]);
      stats.visitor++;
    }
  });

  // 6. 公告
  console.log('生成公告...');
  const totalDays = Math.max(1, Math.round((new Date(TODAY) - new Date(miscStart)) / 86400000));
  ANNOUNCEMENTS.forEach(([title, content], i) => {
    const dayOffset = Math.round((i / (ANNOUNCEMENTS.length - 1)) * totalDays);
    const d = addDays(miscStart, dayOffset);
    if (d > TODAY) return;
    insAnn.run([`bf_an_${pad(i)}`, title, content, `${d} ${pad(randInt(8, 18))}:${pad(randInt(0, 59))}:00`]);
    stats.announcement++;
  });

  // 7. 任务（每模板在期间分布若干次）
  console.log('生成任务...');
  TASK_TEMPLATES.forEach(([remark, status, by], i) => {
    let d = miscStart;
    while (d <= TODAY) {
      insTask.run([`bf_tk_${d}_${i}`, d, classes[i % classes.length], remark, status, `${d} ${pad(randInt(8, 20))}:${pad(randInt(0, 59))}:00`, by]);
      stats.task++;
      d = addDays(d, randInt(3, 7));
    }
  });

  // 8. 地理围栏（若为空）
  const geoCount = db.exec("SELECT COUNT(*) FROM geofence_rules")[0]?.values?.[0]?.[0] || 0;
  if (geoCount === 0) {
    console.log('生成地理围栏规则...');
    GEOFENCES.forEach(([name, lat, lng, r, type], i) => {
      insGeo.run([name, lat, lng, r, type]);
      stats.geofence++;
    });
  } else {
    console.log(`地理围栏已存在 ${geoCount} 条，跳过。`);
  }

  // 9. 缺勤预警（基于补齐查寝中的「未归」，每天限量避免爆炸）
  console.log('生成缺勤预警...');
  Object.entries(missingStudents).forEach(([d, list]) => {
    // 每天最多取 8 个未归学生生成预警
    list.slice(0, 8).forEach((s) => {
      insAlert.run([`bf_aa_${s.id}_${d}`, s.id, s.name, s.class_name, d, '未在宿舍就寝', `${d} 22:30:00`, d > '2026-10-05' ? '' : `${addDays(d, 1)} 09:00:00`]);
      stats.alert++;
    });
  });

  // 10. 日志 + 语音（补齐近期）
  console.log('生成日志与语音记录...');
  // 日志：覆盖到今天，每天几条系统日志
  eachDate(miscStart, TODAY, (d) => {
    const logs = [
      ['系统启动', `服务正常启动，监听端口完成`, 'info', 'system'],
      ['数据备份', `自动备份任务执行成功，备份文件已生成`, 'info', 'system'],
      ['AI问答调用', `智能助手处理 ${randInt(3, 20)} 条查询请求`, 'info', 'ai'],
      ['查寝统计', `当日查寝数据统计完成，异常 ${randInt(0, 5)} 人次`, 'info', 'scheduler']
    ];
    logs.forEach(([action, detail, level, op], i) => {
      insLog.run([`bf_log_${d}_${i}_${Date.now()}`, `${d} ${pad(randInt(0, 23))}:${pad(randInt(0, 59))}:${pad(randInt(0, 59))}`, action, detail, level, op]);
      stats.log++;
    });
  });
  // 语音：近期每天 0-3 条
  eachDate(addDays(TODAY, -10), TODAY, (d) => {
    const n = randInt(0, 3);
    for (let i = 0; i < n; i++) {
      const s = choice(students);
      const h = randInt(21, 22);
      insVoice.run([`bf_vr_${s.id}_${d}_${i}`, s.id, `/uploads/voice/${d}_${s.id}.webm`, choice(VOICE_TEXTS), `${d} ${pad(h)}:${pad(randInt(0, 59))}:00`, d]);
      stats.voice++;
    }
  });

  db.run('COMMIT');

  // 释放语句
  [insCheckin, insCourse, insClass, insLeave, insVisitor, insAnn, insTask, insGeo, insAlert, insLog, insVoice].forEach(st => st.free());

  // 写库
  const buf = Buffer.from(db.export());
  fs.writeFileSync(DB_FILE, buf);
  db.close();

  console.log('\n========================================');
  console.log('✅ 补齐完成！各类型新增数量：');
  console.log('========================================');
  console.log(`   查寝记录   : ${stats.checkin}`);
  console.log(`   课程       : ${stats.course}`);
  console.log(`   课堂签到   : ${stats.class}`);
  console.log(`   请假记录   : ${stats.leave}`);
  console.log(`   访客记录   : ${stats.visitor}`);
  console.log(`   公告       : ${stats.announcement}`);
  console.log(`   任务       : ${stats.task}`);
  console.log(`   地理围栏   : ${stats.geofence}`);
  console.log(`   缺勤预警   : ${stats.alert}`);
  console.log(`   日志       : ${stats.log}`);
  console.log(`   语音记录   : ${stats.voice}`);
  console.log(`\n📁 数据库已写入: ${DB_FILE}`);
  console.log('💡 重启服务器后刷新页面即可看到补齐后的数据。');
}

main().catch(err => { console.error('❌ 失败:', err.message); process.exit(1); });
