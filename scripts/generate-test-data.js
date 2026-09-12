/**
 * 数据生成脚本 - 生成全面模拟数据
 * 使用方法: node scripts/generate-test-data.js
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
  // 2个专业，每个专业2个班，每班40人
  majors: [
    { name: '测绘工程', classes: ['测绘2301', '测绘2302'] },
    { name: '地理信息科学', classes: ['GIS2301', 'GIS2302'] }
  ],
  studentsPerClass: 40,
  days: 60, // 两个月
  startDate: '2025-07-01',
  
  // 宿舍配置
  dorms: ['1号楼', '2号楼', '3号楼', '4号楼'],
  dormRooms: Array.from({ length: 50 }, (_, i) => `Room${String(i + 1).padStart(3, '0')}`),
  
  // 课程列表
  courses: [
    { name: '高等数学', code: 'MATH101' },
    { name: '线性代数', code: 'MATH102' },
    { name: '大学物理', code: 'PHYS101' },
    { name: '程序设计基础', code: 'CS101' },
    { name: '数据结构', code: 'CS201' },
    { name: '数据库原理', code: 'CS301' },
    { name: 'GIS原理', code: 'GIS101' },
    { name: '遥感原理', code: 'RS101' },
    { name: '摄影测量', code: 'PM101' },
    { name: '地图制图', code: 'MAP101' },
    { name: '测量学', code: 'SUR101' },
    { name: '大地测量', code: 'GEO101' }
  ],
  
  // 请假类型
  leaveTypes: ['病假', '事假', '公假', '丧假'],
  leaveReasons: {
    '病假': ['感冒发烧', '肠胃炎', '头痛', '受伤', '体检', '牙科就诊', '流感', '肺炎'],
    '事假': ['家庭事务', '办事', '搬家', '亲戚来访', '个人事务'],
    '公假': ['参加竞赛', '学术会议', '实习', '志愿者活动', '学校活动'],
    '丧假': ['亲属去世']
  },
  
  // 查寝状态分布概率
  checkinStats: {
    '在寝': 0.75,
    '未归': 0.05,
    '不在寝': 0.10,
    '请假': 0.10
  },
  
  // 上课签到状态分布概率
  attendanceStats: {
    '出勤': 0.80,
    '迟到': 0.10,
    '早退': 0.05,
    '缺勤': 0.05
  }
};

// 工具函数
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function formatTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getWeightedRandom(stats) {
  const entries = Object.entries(stats);
  const rand = Math.random();
  let cumulative = 0;
  for (const [value, weight] of entries) {
    cumulative += weight;
    if (rand <= cumulative) return value;
  }
  return entries[entries.length - 1][0];
}

function generateName() {
  const surnames = ['张', '王', '李', '刘', '陈', '杨', '黄', '赵', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗'];
  const names = ['伟', '芳', '娜', '秀英', '敏', '静', '丽', '强', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀兰', '霞', '平', '刚', '桂英'];
  return randomChoice(surnames) + randomChoice(names);
}

function generatePhone() {
  const prefixes = ['138', '139', '137', '136', '135', '134', '150', '151', '152', '153', '155', '156', '158', '159', '188', '189'];
  const prefix = randomChoice(prefixes);
  const suffix = String(randomInt(10000000, 99999999));
  return prefix + suffix;
}

// 生成学生数据
function generateStudents() {
  const students = [];
  let id = 1;
  
  for (const major of CONFIG.majors) {
    for (const className of major.classes) {
      for (let i = 0; i < CONFIG.studentsPerClass; i++) {
        const gender = i % 2 === 0 ? '男' : '女';
        const dormRoom = randomChoice(CONFIG.dormRooms);
        const dorm = `${randomChoice(CONFIG.dorms)}${dormRoom}`;
        
        students.push({
          id: id++,
          student_id: `${className.slice(0, 2)}${String(id).padStart(4, '0')}`,
          name: generateName(),
          gender: gender,
          class_name: className,
          dorm: dorm,
          phone: generatePhone(),
          password_hash: '$2a$12$LJ3m4ys9Lj3m4ys9Lj3m4u', // bcrypt hash of '123456'
          must_change_pwd: 0,
          face_hash: null
        });
      }
    }
  }
  return students;
}

// 生成查寝记录
function generateCheckinRecords(students, startDate, days) {
  const records = [];
  const start = new Date(startDate);
  
  for (let day = 0; day < days; day++) {
    const currentDate = new Date(start);
    currentDate.setDate(start.getDate() + day);
    const dateStr = formatDate(currentDate);
    
    // 周末减少查寝
    const weekday = currentDate.getDay();
    if (weekday === 0 || weekday === 6) continue; // 周末不查寝
    
    // 每天查寝时间：晚上21:00-22:00
    for (const student of students) {
      // 90%的学生有查寝记录
      if (Math.random() > 0.9) continue;
      
      const hour = randomInt(21, 22);
      const minute = randomInt(0, 59);
      const timeStr = formatTime(hour, minute);
      
      // 检查当天是否有请假
      const hasLeave = Math.random() < 0.1; // 10%概率有请假
      const status = hasLeave ? '请假' : getWeightedRandom(CONFIG.checkinStats);
      
      // 活体检测（仅对拍照签到的情况）
      const livenessPassed = Math.random() > 0.1 ? 1 : 0;
      const livenessScore = livenessPassed ? randomFloat(0.85, 0.99).toFixed(4) : randomFloat(0.3, 0.7).toFixed(4);
      
      records.push({
        id: `c_${dateStr}_${student.student_id}_${Date.now()}_${randomInt(1000, 9999)}`,
        student_id: student.student_id,
        date: dateStr,
        time: timeStr,
        type: 'checkin',
        status: status,
        note: '',
        latitude: null,
        longitude: null,
        address: null,
        photo_path: status === '在寝' && Math.random() > 0.5 ? `/uploads/${dateStr}_${student.student_id}.jpg` : null,
        course_id: null,
        course_name: null,
        offline: 0,
        class_name: student.class_name,
        liveness_passed: livenessPassed,
        liveness_score: livenessScore
      });
    }
  }
  return records;
}

// 生成请假记录
function generateLeaves(students, startDate, days) {
  const leaves = [];
  const start = new Date(startDate);
  
  for (let i = 0; i < 80; i++) { // 生成80条请假记录
    const student = randomChoice(students);
    const leaveType = randomChoice(CONFIG.leaveTypes);
    const reason = randomChoice(CONFIG.leaveReasons[leaveType]);
    
    // 请假天数1-7天
    const duration = randomInt(1, 7);
    const startDateLocal = new Date(start);
    startDateLocal.setDate(start.getDate() + randomInt(0, days - duration));
    const endDate = new Date(startDateLocal);
    endDate.setDate(startDateLocal.getDate() + duration - 1);
    
    const status = Math.random() > 0.2 ? 'approved' : 'pending'; // 80%已审批
    
    leaves.push({
      id: `l_${Date.now()}_${randomInt(1000, 9999)}`,
      student_id: student.student_id,
      type: leaveType,
      reason: reason,
      start_date: formatDate(startDateLocal),
      end_date: formatDate(endDate),
      attachment_path: null,
      status: status,
      created_at: `${formatDate(startDateLocal)} ${formatTime(randomInt(8, 20), randomInt(0, 59))}`,
      processed_at: status === 'approved' ? `${formatDate(startDateLocal)} ${formatTime(randomInt(8, 20), randomInt(0, 59))}` : null,
      processed_by: status === 'approved' ? '辅导员' : null,
      comment: status === 'approved' ? '同意' : null
    });
  }
  return leaves;
}

// 生成课程
function generateCourses(students, startDate, days) {
  const courses = [];
  const start = new Date(startDate);
  
  // 为每个班级生成课程表
  const classes = [...new Set(students.map(s => s.class_name))];
  
  for (const className of classes) {
    // 每周5天上课
    for (let day = 0; day < days; day++) {
      const currentDate = new Date(start);
      currentDate.setDate(start.getDate() + day);
      const weekday = currentDate.getDay();
      
      // 周一到周五有课
      if (weekday >= 1 && weekday <= 5 && Math.random() > 0.3) {
        const course = randomChoice(CONFIG.courses);
        const startTime = randomChoice(['08:00', '09:00', '10:00', '14:00', '15:00', '16:00']);
        
        courses.push({
          id: `course_${formatDate(currentDate)}_${className}_${randomInt(1000, 9999)}`,
          name: course.name,
          date: formatDate(currentDate),
          start_time: startTime,
          end_time: `${parseInt(startTime.split(':')[0]) + 2}:${startTime.split(':')[1]}`,
          location: randomChoice(['教学楼A', '教学楼B', '教学楼C', '实验楼']),
          class_name: className,
          created_at: `${formatDate(currentDate)} ${startTime}`
        });
      }
    }
  }
  return courses;
}

// 生成上课签到记录
function generateAttendances(students, courses) {
  const attendances = [];
  
  for (const course of courses) {
    // 随机选择该班级的学生进行签到
    const classStudents = students.filter(s => s.class_name === course.class_name);
    const presentCount = Math.floor(classStudents.length * randomFloat(0.85, 0.98));
    const presentStudents = classStudents.sort(() => Math.random() - 0.5).slice(0, presentCount);
    
    for (const student of presentStudents) {
      const status = getWeightedRandom(CONFIG.attendanceStats);
      const timeStr = status === '出勤' ? course.start_time : 
                      status === '迟到' ? `${parseInt(course.start_time.split(':')[0]) + 1}:${course.start_time.split(':')[1]}` :
                      course.start_time;
      
      attendances.push({
        id: `a_${course.id}_${student.student_id}_${Date.now()}`,
        student_id: student.student_id,
        date: course.date,
        time: timeStr,
        type: 'class',
        status: status,
        note: '',
        latitude: null,
        longitude: null,
        address: course.location,
        photo_path: null,
        course_id: course.id,
        course_name: course.name,
        offline: 0,
        class_name: course.class_name,
        liveness_passed: 1,
        liveness_score: '0.95'
      });
    }
  }
  return attendances;
}

// 生成用户账号
function generateUsers(students) {
  const users = [
    {
      id: 1,
      username: 'admin',
      password_hash: '$2a$12$LJ3m4ys9Lj3m4ys9Lj3m4u',
      display_name: '系统管理员',
      role: 'admin',
      class_name: ''
    }
  ];
  
  // 为每个班级生成一个辅导员账号
  const classes = [...new Set(students.map(s => s.class_name))];
  classes.forEach((className, idx) => {
    users.push({
      id: idx + 2,
      username: `counselor_${idx + 1}`,
      password_hash: '$2a$12$LJ3m4ys9Lj3m4ys9Lj3m4u',
      display_name: `辅导员${idx + 1}`,
      role: 'counselor',
      class_name: className
    });
  });
  
  return users;
}

// 主函数
async function main() {
  console.log('=== 开始生成模拟数据 ===\n');
  
  // 初始化数据库
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'config', 'data.db');
  
  // 读取现有数据库
  let db;
  try {
    const data = fs.readFileSync(dbPath);
    db = new SQL.Database(data);
  } catch (e) {
    console.log('创建新数据库...');
    db = new SQL.Database();
  }
  
  // 生成数据
  console.log('生成学生数据...');
  const students = generateStudents();
  console.log(`  生成 ${students.length} 名学生`);
  
  console.log('生成查寝记录...');
  const checkinRecords = generateCheckinRecords(students, CONFIG.startDate, CONFIG.days);
  console.log(`  生成 ${checkinRecords.length} 条查寝记录`);
  
  console.log('生成请假记录...');
  const leaves = generateLeaves(students, CONFIG.startDate, CONFIG.days);
  console.log(`  生成 ${leaves.length} 条请假记录`);
  
  console.log('生成课程数据...');
  const courses = generateCourses(students, CONFIG.startDate, CONFIG.days);
  console.log(`  生成 ${courses.length} 门课程`);
  
  console.log('生成上课签到记录...');
  const attendances = generateAttendances(students, courses);
  console.log(`  生成 ${attendances.length} 条上课签到记录`);
  
  console.log('生成用户账号...');
  const users = generateUsers(students);
  console.log(`  生成 ${users.length} 个用户账号`);
  
  // 插入数据
  console.log('\n插入数据到数据库...');
  
  // 清空现有数据
  db.exec('DELETE FROM voice_records');
  db.exec('DELETE FROM visitors');
  db.exec('DELETE FROM tasks');
  db.exec('DELETE FROM logs');
  db.exec('DELETE FROM leaves');
  db.exec('DELETE FROM records');
  db.exec('DELETE FROM courses');
  db.exec('DELETE FROM students');
  db.exec('DELETE FROM users');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('students', 'users', 'courses')");
  
  // 插入学生
  const insertStudentSql = `INSERT INTO students (id, student_id, name, gender, class_name, dorm, phone, password_hash, must_change_pwd, face_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const s of students) {
    db.run(insertStudentSql, [s.id, s.student_id, s.name, s.gender, s.class_name, s.dorm, s.phone, s.password_hash, s.must_change_pwd, s.face_hash]);
  }
  
  // 插入用户
  console.log('\n插入用户账号...');
  const insertUserSql = `INSERT INTO users (id, username, password_hash, display_name, role, class_name) VALUES (?, ?, ?, ?, ?, ?)`;
  for (const u of users) {
    db.run(insertUserSql, [u.id, u.username, u.password_hash, u.display_name, u.role, u.class_name]);
  }
  
  // 插入查寝记录
  const insertRecordSql = `INSERT INTO records (id, student_id, date, time, type, status, note, latitude, longitude, address, photo_path, course_id, course_name, offline, class_name, liveness_passed, liveness_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const r of checkinRecords) {
    db.run(insertRecordSql, [r.id, r.student_id, r.date, r.time, r.type, r.status, r.note, r.latitude, r.longitude, r.address, r.photo_path, r.course_id, r.course_name, r.offline, r.class_name, r.liveness_passed, r.liveness_score]);
  }
  
  // 插入请假记录
  const insertLeaveSql = `INSERT INTO leaves (id, student_id, type, reason, start_date, end_date, attachment_path, status, created_at, processed_at, processed_by, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const l of leaves) {
    db.run(insertLeaveSql, [l.id, l.student_id, l.type, l.reason, l.start_date, l.end_date, l.attachment_path, l.status, l.created_at, l.processed_at, l.processed_by, l.comment]);
  }
  
  // 插入课程
  const insertCourseSql = `INSERT INTO courses (id, name, date, start_time, end_time, location, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const c of courses) {
    db.run(insertCourseSql, [c.id, c.name, c.date, c.start_time, c.end_time, c.location, c.class_name, c.created_at]);
  }
  
  // 插入上课签到（使用records表的type='class'）
  console.log('\n插入上课签到记录...');
  const insertAttendanceSql = `INSERT INTO records (id, student_id, date, time, type, status, note, latitude, longitude, address, photo_path, course_id, course_name, offline, class_name, liveness_passed, liveness_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const a of attendances) {
    db.run(insertAttendanceSql, [a.id, a.student_id, a.date, a.time, a.type, a.status, a.note, a.latitude, a.longitude, a.address, a.photo_path, a.course_id, a.course_name, a.offline, a.class_name, a.liveness_passed, a.liveness_score]);
  }
  
  // 保存数据库
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
  
  db.close();
  
  // 统计数据
  console.log('\n=== 数据统计 ===');
  console.log(`学生总数: ${students.length}`);
  console.log(`查寝记录: ${checkinRecords.length}`);
  console.log(`请假记录: ${leaves.length}`);
  console.log(`课程数: ${courses.length}`);
  console.log(`上课签到: ${attendances.length}`);
  console.log(`用户账号: ${users.length}`);
  
  // 统计分布
  console.log('\n=== 数据分布 ===');
  
  // 班级分布
  const classCounts = {};
  students.forEach(s => {
    classCounts[s.class_name] = (classCounts[s.class_name] || 0) + 1;
  });
  console.log('\n班级人数:');
  Object.entries(classCounts).forEach(([cls, count]) => {
    console.log(`  ${cls}: ${count}人`);
  });
  
  // 查寝状态分布
  const checkinStatus = {};
  checkinRecords.forEach(r => {
    checkinStatus[r.status] = (checkinStatus[r.status] || 0) + 1;
  });
  console.log('\n查寝状态分布:');
  Object.entries(checkinStatus).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}条 (${(count/checkinRecords.length*100).toFixed(1)}%)`);
  });
  
  // 请假类型分布
  const leaveType = {};
  leaves.forEach(l => {
    leaveType[l.type] = (leaveType[l.type] || 0) + 1;
  });
  console.log('\n请假类型分布:');
  Object.entries(leaveType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}条`);
  });
  
  // 上课签到状态分布
  const attendanceStatus = {};
  attendances.forEach(a => {
    attendanceStatus[a.status] = (attendanceStatus[a.status] || 0) + 1;
  });
  console.log('\n上课签到状态分布:');
  Object.entries(attendanceStatus).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}条 (${(count/attendances.length*100).toFixed(1)}%)`);
  });
  
  console.log('\n✅ 数据生成完成!');
}

main().catch(console.error);
