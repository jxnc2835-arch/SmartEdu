/**
 * 数据库种子数据脚本
 * 用法: node utils/seed-demo.js
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function seedDemoData() {
  const SQL = await initSqlJs();
  const dbFile = path.join(__dirname, '..', 'config', 'data.db');
  
  // 加载现有数据库或创建新库
  const data = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
  const db = new SQL.Database(data || []);
  
  // 创建演示数据
  const students = [
    { id: '2024001', name: '张三', gender: '男生', class: '计算机科学与技术1班', dorm: 'A栋101', phone: '13800001001' },
    { id: '2024002', name: '李四', gender: '男生', class: '计算机科学与技术1班', dorm: 'A栋101', phone: '13800001002' },
    { id: '2024003', name: '王五', gender: '女生', class: '计算机科学与技术1班', dorm: 'A栋102', phone: '13800001003' },
    { id: '2024004', name: '赵六', gender: '男生', class: '计算机科学与技术1班', dorm: 'A栋102', phone: '13800001004' },
    { id: '2024005', name: '钱七', gender: '女生', class: '计算机科学与技术1班', dorm: 'A栋103', phone: '13800001005' },
    { id: '2024006', name: '孙八', gender: '男生', class: '软件工程2班', dorm: 'B栋201', phone: '13800001006' },
    { id: '2024007', name: '周九', gender: '女生', class: '软件工程2班', dorm: 'B栋201', phone: '13800001007' },
    { id: '2024008', name: '吴十', gender: '男生', class: '软件工程2班', dorm: 'B栋202', phone: '13800001008' },
    { id: '2024009', name: '郑十一', gender: '女生', class: '软件工程2班', dorm: 'B栋202', phone: '13800001009' },
    { id: '2024010', name: '冯十二', gender: '男生', class: '软件工程2班', dorm: 'B栋203', phone: '13800001010' },
    { id: '2024011', name: '陈十三', gender: '男生', class: '大数据技术3班', dorm: 'C栋301', phone: '13800001011' },
    { id: '2024012', name: '褚十四', gender: '女生', class: '大数据技术3班', dorm: 'C栋301', phone: '13800001012' },
    { id: '2024013', name: '卫十五', gender: '男生', class: '大数据技术3班', dorm: 'C栋302', phone: '13800001013' },
    { id: '2024014', name: '蒋十六', gender: '女生', class: '大数据技术3班', dorm: 'C栋302', phone: '13800001014' },
    { id: '2024015', name: '沈十七', gender: '男生', class: '大数据技术3班', dorm: 'C栋303', phone: '13800001015' },
  ];
  
  // 插入学生数据
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO students 
    (student_id, name, gender, class_name, dorm, phone, password_hash, must_change_pwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  for (const s of students) {
    stmt.run([s.id, s.name, s.gender, s.class, s.dorm, s.phone, '', 0]);
  }
  stmt.free();
  
  // 生成过去7天的签到记录
  const today = new Date();
  for (let day = 0; day < 7; day++) {
    const date = new Date(today);
    date.setDate(date.getDate() - day);
    const dateStr = date.toISOString().split('T')[0];
    
    for (const student of students) {
      // 随机生成签到状态（90%在寝，5%请假，5%未归）
      const rand = Math.random();
      let status = '在寝';
      if (rand > 0.9) status = '未归';
      else if (rand > 0.85) status = '事假';
      
      const timeStr = `${dateStr} ${(8 + Math.floor(Math.random() * 4)).toString().padStart(2, '0')}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}:00`;
      const recordId = `${student.id}_${dateStr}`;
      
      db.run(
        `INSERT OR REPLACE INTO records (id, student_id, date, time, type, status, class_name) VALUES (?, ?, ?, ?, 'checkin', ?, ?)`,
        [recordId, student.id, dateStr, timeStr, status, student.class]
      );
    }
  }
  
  // 保存数据库
  const buf = db.export();
  fs.writeFileSync(dbFile, Buffer.from(buf));
  db.close();
  
  console.log(`✅ 演示数据已生成：${students.length}名学生，${students.length * 7}条签到记录`);
  console.log(`📁 数据库路径: ${dbFile}`);
}

seedDemoData().catch(err => {
  console.error('❌ 种子数据生成失败:', err.message);
  process.exit(1);
});
