-- ============================================================
-- SmartEdu 演示数据初始化脚本
-- 用途：快速填充演示环境，方便产品演示和测试
-- 执行方式：node -e "const SQL=require('sql.js');const init=require('./utils/database');(async()=>{const sqlite=await SQL();const db=new sqlite.Database();init.seedDemoData(db);db.export();})()"
-- ============================================================

-- 1. 创建测试班级
INSERT OR IGNORE INTO settings(key, value) VALUES('demo_mode', '1');

-- 2. 创建测试学生（3个班级，每班5人）
-- 计算机科学与技术1班
INSERT OR IGNORE INTO students(student_id, name, gender, class_name, dorm, phone, face_hash) VALUES
('2024001', '张三', '男生', '计算机科学与技术1班', 'A栋101', '13800001001', NULL),
('2024002', '李四', '男生', '计算机科学与技术1班', 'A栋101', '13800001002', NULL),
('2024003', '王五', '女生', '计算机科学与技术1班', 'A栋102', '13800001003', NULL),
('2024004', '赵六', '男生', '计算机科学与技术1班', 'A栋102', '13800001004', NULL),
('2024005', '钱七', '女生', '计算机科学与技术1班', 'A栋103', '13800001005', NULL);

-- 软件工程2班
INSERT OR IGNORE INTO students(student_id, name, gender, class_name, dorm, phone, face_hash) VALUES
('2024006', '孙八', '男生', '软件工程2班', 'B栋201', '13800001006', NULL),
('2024007', '周九', '女生', '软件工程2班', 'B栋201', '13800001007', NULL),
('2024008', '吴十', '男生', '软件工程2班', 'B栋202', '13800001008', NULL),
('2024009', '郑十一', '女生', '软件工程2班', 'B栋202', '13800001009', NULL),
('2024010', '冯十二', '男生', '软件工程2班', 'B栋203', '13800001010', NULL);

-- 大数据技术3班
INSERT OR IGNORE INTO students(student_id, name, gender, class_name, dorm, phone, face_hash) VALUES
('2024011', '陈十三', '男生', '大数据技术3班', 'C栋301', '13800001011', NULL),
('2024012', '褚十四', '女生', '大数据技术3班', 'C栋301', '13800001012', NULL),
('2024013', '卫十五', '男生', '大数据技术3班', 'C栋302', '13800001013', NULL),
('2024014', '蒋十六', '女生', '大数据技术3班', 'C栋302', '13800001014', NULL),
('2024015', '沈十七', '男生', '大数据技术3班', 'C栋303', '13800001015', NULL);

-- 3. 创建测试课程
INSERT OR IGNORE INTO courses(id, name, date, start_time, end_time, location, class_name, created_at) VALUES
('course_001', '高等数学', '2026-09-11', '08:00', '09:40', '教学楼A101', '计算机科学与技术1班', '2026-09-01 00:00:00'),
('course_002', '数据结构', '2026-09-11', '10:00', '11:40', '教学楼B202', '软件工程2班', '2026-09-01 00:00:00'),
('course_003', '概率论', '2026-09-11', '14:00', '15:40', '教学楼C303', '大数据技术3班', '2026-09-01 00:00:00');

-- 4. 插入历史签到记录（过去7天）
-- 使用 Python 或 Node.js 生成更完整的数据更为方便
-- 此处提供示例结构，实际执行时建议使用脚本批量生成

-- ============================================================
-- 执行说明：
-- 1. 复制本文件内容为 seed_demo.sql
-- 2. 使用 sql.js 执行: 
--    const SQL = require('sql.js');
--    const init = require('./utils/database');
--    (async () => {
--      const sqlite = await SQL();
--      const db = new sqlite.Database();
--      init.seedDemoData(db);
--      const buf = db.export();
--      require('fs').writeFileSync('./config/data.db', buf);
--    })();
-- ============================================================
