/**
 * 生成模拟数据脚本
 * 用法: node utils/seed-demo.js
 * 
 * 生成内容：
 * - 2个专业，每个专业2个班，每班40人，共160名学生
 * - 2个月的查寝记录（2026-07-01 到 2026-08-31）
 * - 随机请假记录
 * - 课堂签到记录
 * - 宿舍数据
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// 中文姓名库
const NAMES = ['张', '李', '王', '赵', '刘', '陈', '杨', '黄', '周', '吴',
               '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗',
               '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹',
               '彭', '曾', '萧', '田', '董', '袁', '潘', '于', '蒋', '蔡'];
const FIRST_NAMES = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '洋', '勇',
                     '艳', '杰', '涛', '明', '超', '秀英', '华', '慧', '建国', '志强'];

// 专业班级配置
const MAJORS = [
  { name: '测绘工程', classes: ['测绘2301', '测绘2302'] },
  { name: '地理信息科学', classes: ['GIS2301', 'GIS2302'] }
];

// 宿舍楼配置
const DORMS = ['A栋', 'B栋', 'C栋', 'D栋'];
const ROOM_PREFIXES = {
  '测绘': ['101', '102', '103', '201', '202', '203', '301', '302'],
  'GIS': ['401', '402', '403', '501', '502', '503', '601', '602']
};

// 课程名称
const COURSES = ['测量学基础', 'GIS原理', '遥感技术', '导航原理', '地形测量',
                 '地图制图', '空间数据库', '摄影测量', '大地测量', '工程测量'];
// 教室位置
const CLASSROOMS = ['南训楼A101', '南训楼A202', '南训楼B301', '北训楼C101',
                    '北训楼C202', '实训楼D101', '实训楼D202', '图书馆301',
                    '图书馆302', '机房E101', '机房E202'];
// 宿舍楼位置（江西飞行学院）
const DORM_LOCATIONS = ['男生公寓A栋', '男生公寓B栋', '女生公寓C栋', '女生公寓D栋'];

// 请假类型
const LEAVE_TYPES = ['病假', '事假', '公假', '丧假'];
const REASONS = ['感冒发烧', '身体不适', '家里有事', '参加考试', '办理证件', '家庭事务',
                 '就医检查', '牙齿治疗', '办理护照', '参加婚礼', '家庭聚会', '其他事宜'];

async function generateData() {
  const SQL = await initSqlJs();
  const dbFile = path.join(__dirname, '..', 'config', 'data.db');
  
  // 加载现有数据库
  const data = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
  const db = new SQL.Database(data || []);
  
  // 清空现有数据（保留表结构）
  db.run("DELETE FROM records");
  db.run("DELETE FROM leaves");
  db.run("DELETE FROM students");
  db.run("DELETE FROM courses");
  db.run("DELETE FROM dorms");
  
  console.log('开始生成模拟数据...\n');
  
  // ========== 1. 生成学生数据 ==========
  console.log('生成学生数据...');
  const students = [];
  let studentId = 1;
  
  for (const major of MAJORS) {
    for (const className of major.classes) {
      const prefix = className.startsWith('测绘') ? '测绘' : 'GIS';
      const roomList = ROOM_PREFIXES[prefix] || ROOM_PREFIXES['测绘'];
      
      for (let i = 1; i <= 40; i++) {
        const surname = NAMES[Math.floor(Math.random() * NAMES.length)];
        const givenName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
        const name = surname + givenName;
        const gender = Math.random() > 0.5 ? '男' : '女';
        const dorm = `${DORMS[Math.floor(Math.random() * DORMS.length)]}${roomList[i % roomList.length]}`;
        const phone = `138${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
        const sid = `2024${String(studentId).padStart(4, '0')}`;
        
        students.push({
          id: sid,
          name,
          gender,
          className,
          dorm,
          phone,
          major: major.name
        });
        studentId++;
      }
    }
  }
  
  // 插入学生
  const stmt = db.prepare(`
    INSERT INTO students 
    (student_id, name, gender, class_name, dorm, phone, password_hash, must_change_pwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const s of students) {
    stmt.run([s.id, s.name, s.gender, s.className, s.dorm, s.phone, '', 0]);
  }
  stmt.free();
  
  console.log(`  ✅ 已生成 ${students.length} 名学生`);
  
  // ========== 2. 生成宿舍数据 ==========
  console.log('\n生成宿舍数据...');
  const dormSet = new Set();
  students.forEach(s => dormSet.add(s.dorm));
  
  const dormStmt = db.prepare(`
    INSERT OR REPLACE INTO dorms (id, building, room, capacity, gender, floor, occupied)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  dormSet.forEach(dorm => {
    const parts = dorm.match(/([A-D]栋)(\d+)/);
    if (parts) {
      const [_, building, room] = parts;
      const gender = Math.random() > 0.5 ? '男' : '女';
      const floor = Math.floor(parseInt(room) / 100);
      const count = students.filter(s => s.dorm === dorm).length;
      
      dormStmt.run([
        `d_${building}${room}`,
        building,
        room,
        6,
        gender,
        floor,
        count
      ]);
    }
  });
  dormStmt.free();
  
  console.log(`  ✅ 已生成 ${dormSet.size} 个宿舍房间`);
  
  // ========== 3. 生成查寝记录（2个月） ==========
  console.log('\n生成查寝记录（2026-07-01 至 2026-08-31）...');
  
  const startDate = new Date('2026-07-01');
  const endDate = new Date('2026-08-31');
  const recordStmt = db.prepare(`
    INSERT OR REPLACE INTO records 
    (id, student_id, date, time, type, status, class_name, note, offline, liveness_passed)
    VALUES (?, ?, ?, ?, 'checkin', ?, ?, ?, ?, ?)
  `);
  
  let recordCount = 0;
  const currentDate = new Date(startDate);
  
  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    
    for (const student of students) {
      // 随机状态分布：
      // 85% 在寝, 8% 未归, 5% 病假, 2% 事假
      const rand = Math.random();
      let status = '在寝';
      let note = '';
      let offline = 0;
      let liveness = 1;
      
      if (rand > 0.95) {
        status = '事假';
        note = REASONS[Math.floor(Math.random() * REASONS.length)];
      } else if (rand > 0.90) {
        status = '病假';
        note = REASONS[Math.floor(Math.random() * REASONS.length)];
      } else if (rand > 0.82) {
        status = '未归';
        note = '未在宿舍';
      }
      
      // 生成签到时间（晚上8-11点）
      const hour = 20 + Math.floor(Math.random() * 3);
      const minute = Math.floor(Math.random() * 60);
      const timeStr = `${dateStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
      const id = `${student.id}_${dateStr}`;

      // 随机位置（江西飞行学院）
      const locations = ['男生公寓A栋', '男生公寓B栋', '女生公寓C栋', '女生公寓D栋'];
      const dormBuilding = student.dorm.match(/([A-D]栋)/)?.[1] || locations[Math.floor(Math.random() * locations.length)];
      const latitude = 28.68 + (Math.random() - 0.5) * 0.01; // 南昌纬度约28.68
      const longitude = 115.85 + (Math.random() - 0.5) * 0.01; // 南昌经度约115.85
      const address = `江西飞行学院 ${dormBuilding} ${student.dorm}`;

      recordStmt.run([id, student.id, dateStr, timeStr, status, note, offline, liveness,
        latitude, longitude, address]);
      recordCount++;
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  recordStmt.free();
  console.log(`  ✅ 已生成 ${recordCount} 条查寝记录`);
  
  // ========== 4. 生成请假记录 ==========
  console.log('\n生成请假记录...');
  
  const leaveStmt = db.prepare(`
    INSERT INTO leaves 
    (id, student_id, type, reason, start_date, end_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  let leaveCount = 0;
  const leaveTypes = LEAVE_TYPES;
  const leaveStatuses = ['approved', 'pending', 'rejected'];
  
  // 每个学生随机生成0-3次请假
  for (const student of students) {
    const leaveCount_per_student = Math.floor(Math.random() * 4);
    
    for (let i = 0; i < leaveCount_per_student; i++) {
      const startDay = Math.floor(Math.random() * 60) + 1; // 7月1日到8月30日
      const startDate = new Date('2026-07-01');
      startDate.setDate(startDate.getDate() + startDay);
      
      const duration = Math.floor(Math.random() * 5) + 1;
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + duration);
      
      const type = leaveTypes[Math.floor(Math.random() * leaveTypes.length)];
      const reason = REASONS[Math.floor(Math.random() * REASONS.length)];
      const status = leaveStatuses[Math.floor(Math.random() * leaveStatuses.length)];
      
      const id = `lv_${student.id}_${Date.now()}_${i}`;
      const createdAt = startDate.toISOString().split('T')[0];
      
      leaveStmt.run([id, student.id, type, reason, 
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0],
        status,
        createdAt
      ]);
      leaveCount++;
    }
  }
  
  leaveStmt.free();
  console.log(`  ✅ 已生成 ${leaveCount} 条请假记录`);
  
  // ========== 5. 生成课堂签到记录 ==========
  console.log('\n生成课堂签到记录...');
  
  const courseStmt = db.prepare(`
    INSERT INTO courses 
    (id, name, date, start_time, end_time, location, class_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const courseRecordStmt = db.prepare(`
    INSERT OR REPLACE INTO records 
    (id, student_id, date, time, type, status, course_id, course_name, class_name)
    VALUES (?, ?, ?, ?, 'class', ?, ?, ?, ?)
  `);
  
  let courseCount = 0;
  const locations = ['教学楼A101', '教学楼A202', '教学楼B301', '实验楼C101', '图书馆会议室'];
  
  // 每周生成课程（7月和8月）
  const current = new Date(startDate);
  while (current <= endDate) {
    // 周一到周五生成课程
    const dayOfWeek = current.getDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      const dateStr = current.toISOString().split('T')[0];
      
      // 每个班级每天1-2节课
      for (const student of students) {
        if (Math.random() > 0.6) continue; // 60%概率有课

        const course = COURSES[Math.floor(Math.random() * COURSES.length)];
        const location = CLASSROOMS[Math.floor(Math.random() * CLASSROOMS.length)];
        const startHour = 8 + Math.floor(Math.random() * 8);
        const endHour = startHour + 1;

        const courseId = `course_${dateStr}_${student.id}`;

        courseStmt.run([
          courseId,
          course,
          dateStr,
          `${String(startHour).padStart(2, '0')}:00`,
          `${String(endHour).padStart(2, '0')}:50`,
          location,
          student.className,
          dateStr
        ]);

        // 课堂签到状态
        const attendanceRand = Math.random();
        let attendanceStatus = '出勤';
        if (attendanceRand > 0.95) attendanceStatus = '迟到';
        else if (attendanceRand > 0.90) attendanceStatus = '请假';
        else if (attendanceRand > 0.88) attendanceStatus = '缺勤';

        const checkInTime = `${dateStr} ${String(startHour).padStart(2, '0')}:${String(Math.floor(Math.random() * 10)).padStart(2, '0')}:00`;
        const recordId = `${student.id}_${dateStr}_class`;

        courseRecordStmt.run([
          recordId,
          student.id,
          dateStr,
          checkInTime,
          attendanceStatus,
          courseId,
          course,
          student.className
        ]);
        courseCount++;
      }
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  courseStmt.free();
  courseRecordStmt.free();
  console.log(`  ✅ 已生成 ${courseCount} 条课堂签到记录`);
  
  // ========== 6. 保存数据库 ==========
  const buf = db.export();
  fs.writeFileSync(dbFile, Buffer.from(buf));
  db.close();
  
  console.log('\n========================================');
  console.log('✅ 模拟数据生成完成！');
  console.log('========================================');
  console.log(`📊 数据统计：`);
  console.log(`   - 学生人数：${students.length}人`);
  console.log(`   - 专业数：${MAJORS.length}个`);
  console.log(`   - 班级数：${MAJORS.length * 2}个`);
  console.log(`   - 宿舍房间：${dormSet.size}间`);
  console.log(`   - 查寝记录：${recordCount}条（2个月）`);
  console.log(`   - 请假记录：${leaveCount}条`);
  console.log(`   - 课堂签到：${courseCount}条`);
  console.log(`\n📁 数据库路径: ${dbFile}`);
  console.log('\n💡 提示：重启服务器后刷新页面查看数据');
}

generateData().catch(err => {
  console.error('❌ 数据生成失败:', err.message);
  process.exit(1);
});
