/**
 * 全量连续数据再生脚本（模拟数据「全面完善」专用）
 * ------------------------------------------------------------
 * 目标：
 *   1. 无断点：查寝 records(type=checkin) 覆盖 2026-07-01 → 今天(2026-10-14) 的
 *      每一个自然日（含周末/国庆），杜绝「数据中断」。
 *   2. 门类齐全且合理：students / dorms / records(checkin每日+class工作日) /
 *      voice_records(每日连续) / courses / leaves / visitors / absence_alerts /
 *      tasks / announcements / logs 全部填充，分布按「暑期 / 学期 / 国庆」三阶段
 *      区分，符合高校运行规律。
 *   3. 可复现：固定随机种子（mulberry32），多次运行得到同一份数据。
 *
 * 安全策略：
 *   1. 默认 dry-run：只打印计划与预计数量，不写库、不备份。
 *   2. --force 执行前自动备份 config/data.db → data.db.bak.<timestamp>。
 *   3. 清空「模拟数据」相关表后整体重建；保留 users / settings / geofence_rules。
 *   4. 全部插入包在 BEGIN/COMMIT 事务内，保证原子性。
 *
 * 用法：
 *   node scripts/regenerate_dataset.js                 # 预览
 *   node scripts/regenerate_dataset.js --force        # 备份并重建
 *   node scripts/regenerate_dataset.js --force --end 2026-10-14
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'config', 'data.db');
const FORCE = process.argv.includes('--force');
const args = process.argv.slice(2);
const endIdx = args.indexOf('--end');
const TODAY = (endIdx >= 0 && args[endIdx + 1]) ? args[endIdx + 1] : '2026-10-14';
const START = '2026-07-01';

// 国庆假期（不排课、在寝率走低）
const NATIONAL_HOLIDAY = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
// 暑期（放假，不排课，在寝率走低）
const SUMMER_END = '2026-08-31';

// ---------- 固定种子 RNG（mulberry32），保证可复现 ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261014);
const rand = () => rng();
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const choice = (arr) => arr[Math.floor(rand() * arr.length)];
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weighted(stats) {
  const r = rand(); let acc = 0;
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
function periodOf(d) {
  if (d <= SUMMER_END) return 'summer';
  if (NATIONAL_HOLIDAY.includes(d)) return 'holiday';
  return 'semester';
}

// ---------- 各阶段查寝状态分布 ----------
// 在寝 / 未归 / 病假 / 事假
const CHECKIN_STATS = {
  summer:   { '在寝': 0.68, '未归': 0.16, '病假': 0.08, '事假': 0.08 },
  semester: { '在寝': 0.88, '未归': 0.06, '病假': 0.03, '事假': 0.03 },
  holiday:  { '在寝': 0.50, '未归': 0.28, '病假': 0.11, '事假': 0.11 }
};
// 课堂签到状态：出勤 / 迟到 / 请假 / 缺勤
const CLASS_STATS = { '出勤': 0.90, '迟到': 0.05, '请假': 0.025, '缺勤': 0.025 };

// ---------- 基础配置 ----------
const NAMES = ['张','李','王','赵','刘','陈','杨','黄','周','吴','徐','孙','马','朱','胡','郭','何','高','林','罗','郑','梁','谢','宋','唐','许','韩','冯','邓','曹','彭','曾','萧','田','董','袁','潘','于','蒋','蔡'];
const FIRST_NAMES = ['伟','芳','娜','敏','静','丽','强','磊','洋','勇','艳','杰','涛','明','超','秀英','华','慧','建国','志强','宇航','梓涵','一鸣','思源','雨欣','嘉怡','子轩','俊杰','欣怡','博文'];
const MAJORS = [
  { name: '测绘工程', classes: ['测绘2301', '测绘2302'] },
  { name: '地理信息科学', classes: ['GIS2301', 'GIS2302'] }
];
const DORMS_M = ['A栋', 'B栋'];
const DORMS_F = ['C栋', 'D栋'];
const ROOMS = { '测绘': ['101', '102', '103', '201', '202', '203', '301', '302'], 'GIS': ['401', '402', '403', '501', '502', '503', '601', '602'] };
const COURSES = ['测量学基础', 'GIS原理', '遥感技术', '导航原理', '地形测量', '地图制图', '空间数据库', '摄影测量', '大地测量', '工程测量', '误差理论与平差', 'GNSS定位技术'];
const CLASSROOMS = ['南训楼A101', '南训楼A202', '南训楼B301', '北训楼C101', '北训楼C202', '实训楼D101', '实训楼D202', '机房E101', '机房E202'];
const LEAVE_TYPES = ['病假', '事假', '公假', '丧假'];
const LEAVE_REASONS = {
  '病假': ['感冒发烧', '肠胃炎', '头痛', '运动受伤', '体检就医', '牙科就诊', '流感', '肺炎住院'],
  '事假': ['家庭事务', '回老家办事', '搬家', '亲戚来访', '证件办理', '个人事务'],
  '公假': ['参加测绘竞赛', '学术会议', '企业实习', '志愿者活动', '学校文艺活动', '运动会'],
  '丧假': ['亲属去世料理后事']
};
const LEAVE_STATUS = ['approved', 'approved', 'approved', 'pending', 'rejected'];
const VISIT_PURPOSES = ['家长探访', '快递/外卖配送', '宿舍维修', '校外面试', '同学串访', '辅导员走访', '安全检查'];
const VISIT_NAMES = ['王建国', '李秀英', '张师傅', '刘明', '陈晓', '赵阿姨', '周强', '孙丽', '黄伟', '吴敏'];
const VOICE_TEXTS = ['我在寝室', '今天已回宿舍', '晚安打卡', '我已签到', '在宿舍休息', '刚回到寝室', '签到成功'];
const ANNOUNCEMENTS = [
  ['开学第一次全体班会通知', '各位同学：本周日晚19:00在阶梯教室召开新学期第一次班会，请准时参加，班长负责签到。', '2026-09-06'],
  ['夜间查寝管理规定', '为规范宿舍管理，每晚22:00前完成查寝打卡。未归同学须提前在系统提交请假，逾期未归将触发缺勤预警。', '2026-09-08'],
  ['防电信网络诈骗提醒', '近期校园周边电信诈骗高发，请勿轻信陌生来电与刷单兼职，涉及转账一律当面核实，遇可疑情况及时联系辅导员。', '2026-09-15'],
  ['体测与体检通知', '本月将组织全体学生体质健康测试与年度体检，具体时间地点另行通知，请保持手机畅通。', '2026-09-22'],
  ['国家助学金申请启动', '家庭经济困难学生助学金申请通道已开启，请符合条件的同学在规定时间内提交材料，逾期不予受理。', '2026-09-28'],
  ['国庆节放假安排', '根据校历，10月1日至10月7日国庆节放假调休，10月8日（周四）起正常上课。假期离校请提前报备。', '2026-09-30'],
  ['宿舍安全卫生大检查', '本周五下午开展宿舍安全卫生大检查，重点排查大功率电器与私拉电线，请各宿舍提前整理。', '2026-10-09'],
  ['运动会报名通知', '校运动会将于下月举办，设有田径、趣味项目等，欢迎同学们积极报名，为班级争光。', '2026-10-11'],
  ['期中复习与诚信考试教育', '临近期中，请同学们制定复习计划。学校将持续开展诚信考试教育，严肃考风考纪。', '2026-10-13'],
  ['寒潮降温预警', '气象台发布寒潮蓝色预警，气温将大幅下降，请同学们及时添衣保暖，注意宿舍通风与用电安全。', '2026-10-14']
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

async function main() {
  const SQL = await initSqlJs();
  const data = fs.readFileSync(DB_FILE);
  const db = new SQL.Database(data);

  // 读取现有学生（dry-run 预览用，force 会重建）
  const stuRes = db.exec("SELECT student_id, name, gender, class_name, dorm FROM students");
  const existingStudents = stuRes[0] ? stuRes[0].values.map(r => ({ id: r[0], name: r[1], gender: r[2], class_name: r[3], dorm: r[4] })) : [];
  const classes = [...new Set(existingStudents.map(s => s.class_name))];
  const geoCount = db.exec("SELECT COUNT(*) FROM geofence_rules")[0]?.values?.[0]?.[0] || 0;

  if (!FORCE) {
    console.log('🛡️  DRY-RUN（未加 --force）：仅预览，不写库。\n');
    console.log('目标库:', DB_FILE, `(${(data.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log('周期:', START, '→', TODAY);
    console.log('现有学生:', existingStudents.length, '班级:', classes.join(', ') || '(空)');
    console.log('地理围栏现有:', geoCount, '（保留不重建）\n');
    // 估算
    let ck = 0, cs = 0, cr = 0, lv = 0, vs = 0, an = ANNOUNCEMENTS.length, tk = 0, al = 0, lg = 0, vr = 0;
    const clsList = classes.length ? classes : MAJORS.flatMap(m => m.classes);
    eachDate(START, TODAY, (d) => {
      ck += 160; // 每日查寝（含周末/假期）
      vr += randInt(2, 4);
      vs += randInt(2, 5);
      lg += 4;
      const p = periodOf(d);
      const wd = new Date(d + 'T00:00:00').getDay();
      if (p === 'semester' && wd >= 1 && wd <= 5) { clsList.forEach(() => { cr += 1; cs += 40; }); }
      lv += Math.round(160 * 0.04); // 请假全程每日生成
    });
    TASK_TEMPLATES.forEach(() => { let d = START; while (d <= TODAY) { tk++; d = addDays(d, randInt(3, 7)); } });
    console.log('=== 预计生成数量（估算，学生按160计）===');
    console.log(`  查寝记录   : ~${ck} 条（每日无断点）`);
    console.log(`  课程       : ~${cr} 门`);
    console.log(`  课堂签到   : ~${cs} 条`);
    console.log(`  请假记录   : ~${lv} 条`);
    console.log(`  访客记录   : ~${vs} 条`);
    console.log(`  语音记录   : ~${vr} 条（每日连续）`);
    console.log(`  公告       : ${an} 条`);
    console.log(`  任务       : ~${tk} 条`);
    console.log(`  日志       : ~${lg} 条`);
    console.log('\n确认无误后运行: node scripts/regenerate_dataset.js --force');
    db.close();
    return;
  }

  // ---------- 真正执行 ----------
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bakFile = DB_FILE.replace(/\.db$/, `.bak.${ts}`);
  fs.copyFileSync(DB_FILE, bakFile);
  console.log(`💾 已备份 → ${path.relative(path.join(__dirname, '..'), bakFile)}\n`);

  db.run('BEGIN');

  // 清空模拟数据相关表（保留 users / settings / geofence_rules）
  console.log('清空模拟数据表...');
  ['records', 'courses', 'leaves', 'visitors', 'announcements', 'tasks', 'absence_alerts', 'logs', 'voice_records', 'students', 'dorms'].forEach((t) => {
    db.run(`DELETE FROM ${t}`);
  });

  const stats = { student: 0, dorm: 0, checkin: 0, course: 0, class: 0, leave: 0, visitor: 0, announcement: 0, task: 0, geofence: 0, alert: 0, log: 0, voice: 0 };

  // ---------- 1. 学生 + 宿舍 ----------
  console.log('生成学生与宿舍...');
  const students = [];
  let sidNum = 1;
  for (const major of MAJORS) {
    for (const className of major.classes) {
      const prefix = className.startsWith('测绘') ? '测绘' : 'GIS';
      const roomList = ROOMS[prefix];
      for (let i = 1; i <= 40; i++) {
        const name = choice(NAMES) + choice(FIRST_NAMES);
        const gender = rand() > 0.5 ? '男' : '女';
        const building = gender === '男' ? choice(DORMS_M) : choice(DORMS_F);
        const room = roomList[(sidNum - 1) % roomList.length];
        const dorm = `${building}${room}`;
        const phone = `138${String(randInt(0, 99999999)).padStart(8, '0')}`;
        const student_id = `2024${String(sidNum).padStart(4, '0')}`;
        students.push({ id: student_id, name, gender, class_name: className, dorm, phone, major: major.name });
        sidNum++;
      }
    }
  }
  const insStudent = db.prepare(`INSERT INTO students (student_id, name, gender, class_name, dorm, phone, password_hash, must_change_pwd) VALUES (?,?,?,?,?,?,?,?)`);
  for (const s of students) {
    insStudent.run([s.id, s.name, s.gender, s.class_name, s.dorm, s.phone, '', 0]);
    stats.student++;
  }
  insStudent.free();

  // 宿舍：从学生去重得到，性别按房间内学生、楼层按房号、容量6
  const dormMap = new Map();
  students.forEach(s => {
    if (!dormMap.has(s.dorm)) dormMap.set(s.dorm, { building: s.dorm.match(/([A-D]栋)/)?.[1] || 'A栋', room: s.dorm.replace(/[A-D]栋/, ''), gender: s.gender, occupied: 0 });
    dormMap.get(s.dorm).occupied++;
  });
  const insDorm = db.prepare(`INSERT INTO dorms (id, building, room, capacity, gender, floor, occupied) VALUES (?,?,?,?,?,?,?)`);
  for (const [dorm, info] of dormMap.entries()) {
    insDorm.run([`d_${dorm}`, info.building, info.room, 6, info.gender, Math.floor(parseInt(info.room, 10) / 100), info.occupied]);
    stats.dorm++;
  }
  insDorm.free();
  const classList = [...new Set(students.map(s => s.class_name))];

  // ---------- 准备语句 ----------
  const insCheckin = db.prepare(`INSERT INTO records (id, student_id, date, time, type, status, note, latitude, longitude, address, photo_path, course_id, course_name, offline, class_name, liveness_passed, liveness_score)
    VALUES (?,?,?,?, 'checkin', ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)`);
  const insCourse = db.prepare(`INSERT INTO courses (id, name, date, start_time, end_time, location, class_name, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insClass = db.prepare(`INSERT INTO records (id, student_id, date, time, type, status, note, latitude, longitude, address, photo_path, course_id, course_name, offline, class_name, liveness_passed, liveness_score)
    VALUES (?,?,?,?, 'class', ?, ?, NULL, NULL, ?, NULL, ?, ?, 0, ?, 1, 0.95)`);
  const insLeave = db.prepare(`INSERT INTO leaves (id, student_id, type, reason, start_date, end_date, attachment_path, status, created_at, processed_at, processed_by, comment) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)`);
  const insVisitor = db.prepare(`INSERT INTO visitors (id, visitor_name, visitor_id_card, visitor_phone, target_student_id, target_dorm, visit_purpose, visit_date, visit_time, visitor_photo_path, checked_in, checked_out, checked_out_time, note, created_at, face_hash) VALUES (?,?,?,?,?,?,?,?,?,NULL,1,?,?,?,?, '')`);
  const insAnn = db.prepare(`INSERT INTO announcements (id, title, content, created_at) VALUES (?,?,?,?)`);
  const insTask = db.prepare(`INSERT INTO tasks (id, date, class_name, remark, status, created_at, created_by) VALUES (?,?,?,?,?,?,?)`);
  const insAlert = db.prepare(`INSERT INTO absence_alerts (id, student_id, student_name, class_name, date, status, reason, note, created_at, closed_at, closed_by) VALUES (?,?,?,?,?,'open',?,'',?,?,'')`);
  const insLog = db.prepare(`INSERT INTO logs (id, time, action, detail, level, operator) VALUES (?,?,?,?,?,?)`);
  const insVoice = db.prepare(`INSERT INTO voice_records (id, student_id, audio_path, text, timestamp, date, status, note) VALUES (?,?,?,?,?,?,'success','')`);

  const missingStudents = {}; // date -> [student]

  // ---------- 2. 查寝（每日无断点）----------
  console.log('生成查寝记录（每日无断点）...');
  eachDate(START, TODAY, (d) => {
    const dist = CHECKIN_STATS[periodOf(d)];
    const wd = new Date(d + 'T00:00:00').getDay();
    const isWeekend = (wd === 0 || wd === 6);
    students.forEach((s) => {
      const status = weighted(dist);
      const h = randInt(21, 22);
      const m = randInt(0, 59);
      const time = `${d} ${pad(h)}:${pad(m)}:00`;
      let note = '';
      if (status === '病假' || status === '事假') note = choice(LEAVE_REASONS[status]);
      else if (status === '未归') note = '未在宿舍';
      else if (rand() > 0.55) note = '扫码签到';
      // 周末/假期未归更多已体现在分布；活体核验
      const livenessPassed = status === '在寝' ? (rand() > 0.18 ? 1 : 0) : (rand() > 0.8 ? 1 : 0);
      const livenessScore = livenessPassed ? (0.82 + rand() * 0.17).toFixed(4) : (0.30 + rand() * 0.45).toFixed(4);
      const lat = 28.68 + (rand() - 0.5) * 0.012;
      const lng = 115.85 + (rand() - 0.5) * 0.012;
      const addr = `江西飞行学院 ${s.dorm}`;
      insCheckin.run([`rg_c_${s.id}_${d}`, s.id, d, time, status, note, lat.toFixed(6), lng.toFixed(6), addr, s.class_name, livenessPassed, livenessScore]);
      stats.checkin++;
      if (status === '未归') (missingStudents[d] = missingStudents[d] || []).push(s);
    });
  });

  // ---------- 3. 课程 + 课堂签到（学期工作日）----------
  console.log('生成课程与课堂签到（学期工作日）...');
  eachDate(START, TODAY, (d, wd) => {
    if (periodOf(d) !== 'semester' || wd < 1 || wd > 5) return; // 仅学期内工作日
    classList.forEach((cls) => {
      const course = choice(COURSES);
      const location = choice(CLASSROOMS);
      const startH = choice([8, 10, 14, 16]);
      const courseId = `rg_course_${d}_${cls}`;
      insCourse.run([courseId, course, d, `${pad(startH)}:00`, `${pad(startH + 2)}:00`, location, cls, `${d} ${pad(startH)}:00`]);
      stats.course++;
      const classStudents = students.filter(s => s.class_name === cls);
      classStudents.forEach((s) => {
        const cstatus = weighted(CLASS_STATS);
        const cm = cstatus === '迟到' ? randInt(10, 55) : randInt(0, 9);
        const ctime = `${d} ${pad(startH)}:${pad(cm)}:00`;
        insClass.run([`rg_a_${s.id}_${d}`, s.id, d, ctime, cstatus, '', location, courseId, course, cls]);
        stats.class++;
      });
    });
  });

  // ---------- 4. 请假（覆盖全程，含暑期）----------
  console.log('生成请假记录...');
  eachDate(START, TODAY, (d) => {
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
      insLeave.run([`rg_lv_${s.id}_${d}_${i}`, s.id, type, reason, d, end, status, created, processed, status === 'approved' ? '辅导员' : null, status === 'approved' ? '同意' : null]);
      stats.leave++;
    }
  });

  // ---------- 5. 访客（每日 2-5 条）----------
  console.log('生成访客记录...');
  eachDate(START, TODAY, (d) => {
    const n = randInt(2, 5);
    for (let i = 0; i < n; i++) {
      const s = choice(students);
      const vname = choice(VISIT_NAMES);
      const purpose = choice(VISIT_PURPOSES);
      const vh = randInt(8, 21);
      const vm = randInt(0, 59);
      const outH = Math.min(vh + randInt(1, 3), 23);
      insVisitor.run([`rg_v_${d}_${i}_${i}`, vname, `3601${randInt(10000000, 99999999)}`, `1${randInt(3800000000, 3999999999)}`, s.id, s.dorm, purpose, d, `${pad(vh)}:${pad(vm)}:00`, 1, `${pad(outH)}:${pad(vm)}:00`, `探访${s.name}`, `${d} ${pad(vh)}:${pad(vm)}:00`]);
      stats.visitor++;
    }
  });

  // ---------- 6. 公告（按既定日期）----------
  console.log('生成公告...');
  ANNOUNCEMENTS.forEach(([title, content, date], i) => {
    insAnn.run([`rg_an_${pad(i)}`, title, content, `${date} ${pad(randInt(8, 18))}:${pad(randInt(0, 59))}:00`]);
    stats.announcement++;
  });

  // ---------- 7. 任务（每模板在期间滚动分布）----------
  console.log('生成任务...');
  TASK_TEMPLATES.forEach(([remark, status, by], i) => {
    let d = START;
    while (d <= TODAY) {
      insTask.run([`rg_tk_${d}_${i}`, d, classList[i % classList.length], remark, status, `${d} ${pad(randInt(8, 20))}:${pad(randInt(0, 59))}:00`, by]);
      stats.task++;
      d = addDays(d, randInt(3, 7));
    }
  });

  // ---------- 8. 缺勤预警（基于未归，每日限量）----------
  console.log('生成缺勤预警...');
  Object.entries(missingStudents).forEach(([d, list]) => {
    list.slice(0, 8).forEach((s) => {
      insAlert.run([`rg_aa_${s.id}_${d}`, s.id, s.name, s.class_name, d, '未在宿舍就寝', `${d} 22:30:00`, d > '2026-10-10' ? '' : `${addDays(d, 1)} 09:00:00`]);
      stats.alert++;
    });
  });

  // ---------- 9. 日志（每日 4 条）----------
  console.log('生成日志...');
  eachDate(START, TODAY, (d) => {
    const logs = [
      ['系统启动', `服务正常启动，监听端口完成`, 'info', 'system'],
      ['数据备份', `自动备份任务执行成功，备份文件已生成`, 'info', 'system'],
      ['AI问答调用', `智能助手处理 ${randInt(3, 20)} 条查询请求`, 'info', 'ai'],
      ['查寝统计', `当日查寝数据统计完成，异常 ${randInt(0, 5)} 人次`, 'info', 'scheduler']
    ];
    logs.forEach(([action, detail, level, op], i) => {
      insLog.run([`rg_log_${d}_${i}`, `${d} ${pad(randInt(0, 23))}:${pad(randInt(0, 59))}:${pad(randInt(0, 59))}`, action, detail, level, op]);
      stats.log++;
    });
  });

  // ---------- 10. 语音记录（每日连续 2-4 条）----------
  console.log('生成语音签到记录...');
  eachDate(START, TODAY, (d) => {
    const n = randInt(2, 4);
    for (let i = 0; i < n; i++) {
      const s = choice(students);
      const h = randInt(21, 22);
      insVoice.run([`rg_vr_${s.id}_${d}_${i}`, s.id, `/uploads/voice/${d}_${s.id}.webm`, choice(VOICE_TEXTS), `${d} ${pad(h)}:${pad(randInt(0, 59))}:00`, d]);
      stats.voice++;
    }
  });

  db.run('COMMIT');
  [insCheckin, insCourse, insClass, insLeave, insVisitor, insAnn, insTask, insAlert, insLog, insVoice].forEach(st => st.free());

  const buf = Buffer.from(db.export());
  fs.writeFileSync(DB_FILE, buf);
  db.close();

  console.log('\n========================================');
  console.log('✅ 全量连续数据再生完成！各类别数量：');
  console.log('========================================');
  for (const [k, v] of Object.entries(stats)) console.log(`   ${k.padEnd(10)}: ${v}`);
  console.log(`\n📁 数据库已写入: ${DB_FILE}`);
  console.log('💡 重启服务器后刷新页面即可看到无断点、门类齐全的模拟数据。');
}

main().catch(err => { console.error('❌ 失败:', err.message); process.exit(1); });
