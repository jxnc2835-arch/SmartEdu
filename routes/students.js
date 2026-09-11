// ==================== 学生管理路由模块 ====================
const express = require('express');

/**
 * 初始化学生路由模块
 * @param {Object} opts - 依赖注入对象
 * @param {object} opts.db - sql.js Database 实例
 * @param {Function} opts.scheduleSave - 延迟保存函数
 * @param {Function} opts.authMiddleware - 认证中间件
 * @param {Function} opts.requireRole - 角色验证中间件
 * @param {object} opts.bcrypt - bcryptjs 库
 * @param {object} opts.upload - multer 上传中间件
 * @param {object} opts.XLSX - XLSX 库
 * @param {Function} opts.addLog - 日志记录函数
 * @param {number} opts.CLASS_SIZE_LIMIT - 班级人数限制
 * @param {Function} opts.getClassCount - 获取班级人数函数
 * @param {Function} opts.limitPerClass - 每班级限制返回函数
 * @param {Function} opts.beijingStamp - 北京时间时间戳函数
 * @returns {Express.Router}
 */
function init(opts) {
  const { db, scheduleSave, authMiddleware, requireRole, bcrypt, upload, addLog, CLASS_SIZE_LIMIT, getClassCount, limitPerClass, beijingStamp } = opts;
  const ExcelJS = require('exceljs');
  const router = express.Router();

  // 异常闭环自动同步：records 被删除后同步今日未归告警
  const { syncAlertsForToday } = require('../utils/alerts-sync');

  /**
   * 获取用户可查询的班级范围
   * @param {object} req - Express 请求对象
   * @returns {{clause: string, params: string[]}} SQL WHERE 子句和参数
   */
  function scopeOf(req) {
    const s = req.user && req.user.classScope;
    return (s && s.length) ? { clause: `class_name IN (${s.map(() => '?').join(',')})`, params: s } : { clause: '', params: [] };
  }

  // ==================== 学生管理 ====================
  // 公开的学生列表（供学生端使用）- 每班最多显示前40人
  router.get('/api/students/public', (req, res) => {
    const rows = db.exec("SELECT student_id as id, name, gender, dorm, class_name FROM students ORDER BY class_name, name")[0]?.values || [];
    const allStudents = rows.map(r => ({ id: r[0], name: r[1], gender: r[2]||'', dorm: r[3], class_name: r[4] }));
    res.json({ code: 0, data: limitPerClass(allStudents) });
  });

  // 获取所有唯一宿舍列表（供批量操作快速选择）
  router.get('/api/dorms/list', authMiddleware, (req, res) => {
    try {
      const rows = db.exec("SELECT DISTINCT dorm FROM students WHERE dorm IS NOT NULL AND dorm != '' ORDER BY dorm")[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => r[0]) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // 获取所有唯一班级列表（优化版）
  router.get('/api/students/classes', authMiddleware, (req, res) => {
    try {
      const sc = scopeOf(req);
      const rows = db.exec(
        `SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name != ''${sc.clause ? ' AND ' + sc.clause : ''} ORDER BY class_name`,
        sc.params
      )[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => r[0]) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // 获取所有年级列表
  router.get('/api/students/grades', authMiddleware, (req, res) => {
    try {
      const rows = db.exec("SELECT DISTINCT grade FROM students WHERE grade IS NOT NULL AND grade != '' ORDER BY grade")[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => r[0]) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // 分页查询学生列表（新增高性能接口）
  router.get('/api/students/paged', authMiddleware, (req, res) => {
    try {
      const { page = 1, limit = 50, class_name, grade, dorm, search, sort = 'class_name,name', order = 'ASC' } = req.query;
      const pageNum = parseInt(page) || 1;
      const limitNum = Math.min(parseInt(limit) || 50, 200); // 最大200条
      const offset = (pageNum - 1) * limitNum;

      let whereClauses = ['1=1'];
      let params = [];

      if (class_name) {
        whereClauses.push('class_name=?');
        params.push(class_name);
      }
      if (grade) {
        whereClauses.push('grade=?');
        params.push(grade);
      }
      if (dorm) {
        whereClauses.push('dorm LIKE ?');
        params.push(`%${dorm}%`);
      }
      if (search) {
        whereClauses.push('(name LIKE ? OR student_id LIKE ? OR phone LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      const sc = scopeOf(req);
      if (sc.clause) { whereClauses.push(sc.clause); params.push(...sc.params); }

      const whereSql = whereClauses.join(' AND ');
      const orderBy = sort.split(',').map(s => {
        const [field, dir] = s.trim().split(' ');
        return `s.${field || 'name'} ${dir ? dir.toUpperCase() : 'ASC'}`;
      }).join(', ');

      const query = `SELECT s.id, s.name, s.student_id, s.gender, s.dorm, s.class_name, s.phone, s.grade, s.major 
                     FROM students s 
                     WHERE ${whereSql} 
                     ORDER BY ${orderBy || 's.class_name, s.name'} 
                     LIMIT ? OFFSET ?`;

      const finalParams = [...params, limitNum, offset];
      let rows = [];
      let columns = [];
      
      try {
        const result = db.exec(query, finalParams);
        rows = result[0]?.values || [];
        columns = result[0]?.columns || [];
      } catch (e) {
        // 如果查询失败，尝试不使用 grade 和 major 列
        const fallbackQuery = `SELECT s.id, s.name, s.student_id, s.gender, s.dorm, s.class_name, s.phone 
                     FROM students s 
                     WHERE ${whereSql} 
                     ORDER BY ${orderBy || 's.class_name, s.name'} 
                     LIMIT ? OFFSET ?`;
        const result = db.exec(fallbackQuery, [...params, limitNum, offset]);
        rows = result[0]?.values || [];
        columns = result[0]?.columns || [];
      }

      // 获取总数
      const countQuery = `SELECT COUNT(*) FROM students s WHERE ${whereSql}`;
      const countResult = db.exec(countQuery, params);
      const total = countResult[0]?.values?.[0]?.[0] || 0;

      const data = rows.map(row => {
        const obj = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj;
      });

      res.json({
        code: 0,
        data: data.map(r => ({
          id: r.id,
          name: r.name,
          student_id: r.student_id || '',
          gender: r.gender || '',
          dorm: r.dorm || '',
          class_name: r.class_name || '',
          phone: r.phone || '',
          grade: r.grade || '',
          major: r.major || ''
        })),
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
          hasNext: pageNum < Math.ceil(total / limitNum),
          hasPrev: pageNum > 1,
        }
      });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // 获取学生统计概览
  router.get('/api/students/overview', authMiddleware, (req, res) => {
    try {
      const sc = scopeOf(req);
      const cond = sc.clause ? ` AND ${sc.clause}` : '';
      const totalStudents = db.exec(`SELECT COUNT(*) FROM students WHERE 1=1${cond}`, sc.params)[0]?.values?.[0]?.[0] || 0;
      const maleCount = db.exec(`SELECT COUNT(*) FROM students WHERE 1=1${cond} AND gender='男'`, sc.params)[0]?.values?.[0]?.[0] || 0;
      const femaleCount = db.exec(`SELECT COUNT(*) FROM students WHERE 1=1${cond} AND gender='女'`, sc.params)[0]?.values?.[0]?.[0] || 0;
      const classCount = db.exec(`SELECT COUNT(DISTINCT class_name) FROM students WHERE 1=1${cond} AND class_name IS NOT NULL AND class_name != ''`, sc.params)[0]?.values?.[0]?.[0] || 0;
      const dormCount = db.exec(`SELECT COUNT(DISTINCT dorm) FROM students WHERE 1=1${cond} AND dorm IS NOT NULL AND dorm != ''`, sc.params)[0]?.values?.[0]?.[0] || 0;
      
      // 各年级分布（如果 grade 列存在）
      let gradeDist = [];
      try {
        gradeDist = db.exec(`SELECT grade, COUNT(*) as count FROM students WHERE 1=1${cond} AND grade IS NOT NULL GROUP BY grade ORDER BY grade`, sc.params)[0]?.values || [];
      } catch (e) {
        // grade 列不存在
      }
      
      // 各专业分布（如果 major 列存在）
      let majorDist = [];
      try {
        majorDist = db.exec(`SELECT major, COUNT(*) as count FROM students WHERE 1=1${cond} AND major IS NOT NULL AND major != '' GROUP BY major ORDER BY count DESC LIMIT 10`, sc.params)[0]?.values || [];
      } catch (e) {
        // major 列不存在
      }

      res.json({
        code: 0,
        data: {
          totalStudents,
          maleCount,
          femaleCount,
          classCount,
          dormCount,
          gradeDistribution: gradeDist.map(r => ({ grade: r[0], count: r[1] })),
          majorDistribution: majorDist.map(r => ({ major: r[0], count: r[1] })),
        }
      });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.get('/api/students', authMiddleware, (req, res) => {
    const { class_name, grade } = req.query;
    let sqlStr = "SELECT student_id, name, student_id, gender, dorm, class_name, phone FROM students";
    const params = [];
    const conditions = [];
    if (class_name) { conditions.push("class_name=?"); params.push(class_name); }
    const sc = scopeOf(req);
    if (sc.clause) { conditions.push(sc.clause); params.push(...sc.params); }
    if (conditions.length) sqlStr += " WHERE " + conditions.join(" AND ");
    sqlStr += " ORDER BY class_name, dorm, name";
    const rows = db.exec(sqlStr, params)[0]?.values || [];
    const allStudents = rows.map(r => ({ id: r[0], name: r[1], student_id: r[2]||'', gender: r[3]||'', dorm: r[4], class_name: r[5], phone: r[6]||'' }));
    res.json({ code: 0, data: limitPerClass(allStudents) });
  });

  router.post('/api/students', authMiddleware, (req, res) => {
    const { name, student_id, gender, dorm, class_name, phone } = req.body;
    if (!name || !class_name) return res.json({ code: 1, message: '姓名和班级不能为空' });
    if (class_name) {
      const currentCount = getClassCount(db, class_name);
      if (currentCount >= CLASS_SIZE_LIMIT) {
        return res.json({ code: 1, message: `${class_name} 当前已有 ${currentCount} 人，已达上限 ${CLASS_SIZE_LIMIT} 人，无法继续添加` });
      }
    }
    let finalStudentId = student_id && student_id.trim() ? student_id.trim() : '';
    if(!finalStudentId){
      // 自动生成学号：S+ 时间戳后6位
      finalStudentId='S'+Date.now().toString().slice(-7);
    }
    try{
      db.run("INSERT INTO students(student_id, name, gender, dorm, class_name, phone) VALUES(?,?,?,?,?,?)", [finalStudentId, name, gender||'', dorm||'', class_name||'', phone||'']);
      scheduleSave();
      // 查询返回的id
      const r=db.exec("SELECT id FROM students WHERE student_id=?", [finalStudentId])[0]?.values?.[0];
      res.json({ code: 0, message: '添加成功', id: r?.[0] });
    }catch(e){
      if(String(e.message).includes('UNIQUE')){
        // 学号重复，自动重新生成
        finalStudentId='S'+Date.now().toString().slice(-7)+Math.floor(Math.random()*100);
        try{
          db.run("INSERT INTO students(student_id, name, gender, dorm, class_name, phone) VALUES(?,?,?,?,?,?)", [finalStudentId, name, gender||'', dorm||'', class_name||'', phone||'']);
          scheduleSave();
          const r=db.exec("SELECT id FROM students WHERE student_id=?", [finalStudentId])[0]?.values?.[0];
          res.json({ code: 0, message: '添加成功（学号自动生成）', id: r?.[0] });
        }catch(e2){
          res.json({ code: 1, message: '添加失败: '+e2.message });
        }
      } else {
        res.json({ code: 1, message: '添加失败: '+e.message });
      }
    }
  });

  router.put('/api/students/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    const { name, student_id, gender, dorm, class_name, phone } = req.body;
    // console.log(`[PUT /api/students/${id}] body:`, req.body); // DEBUG: disabled in production
    const fields = [];
    const params = [];
    if (name !== undefined) { fields.push('name=?'); params.push(name); }
    if (student_id !== undefined && student_id!=='') { fields.push('student_id=?'); params.push(student_id); }
    if (gender !== undefined) { fields.push('gender=?'); params.push(gender); }
    if (dorm !== undefined) { fields.push('dorm=?'); params.push(dorm); }
    if (class_name !== undefined) { fields.push('class_name=?'); params.push(class_name); }
    if (phone !== undefined) { fields.push('phone=?'); params.push(phone); }
    if (!fields.length) return res.json({ code: 1, message: '无更新字段' });
    // 优先用 id 匹配（数据库真实 id）
    const numericId = parseInt(id);
    if(!isNaN(numericId) && numericId>0){
      try{
        db.run(`UPDATE students SET ${fields.join(', ')} WHERE id=?`, [...params, numericId]);
        scheduleSave();
        console.log(`[PUT] Updated by id=${numericId}`);
        return res.json({ code: 0, message: '更新成功' });
      }catch(e){
        console.error('[PUT] Update by id failed:',e.message);
        return res.json({ code: 1, message: '更新失败: '+e.message });
      }
    }
    // 否则用学号匹配
    try{
      db.run(`UPDATE students SET ${fields.join(', ')} WHERE student_id=?`, [...params, id]);
      scheduleSave();
      console.log(`[PUT] Updated by student_id=${id}`);
      return res.json({ code: 0, message: '更新成功' });
    }catch(e){
      console.error('[PUT] Update by student_id failed:',e.message);
      return res.json({ code: 1, message: '更新失败: '+e.message });
    }
  });

  router.delete('/api/students/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    const numericId = parseInt(id);
    const isNumeric = !isNaN(numericId) && String(numericId) === String(id);
    if(isNumeric){
      db.run("DELETE FROM students WHERE id=?", [numericId]);
    } else {
      db.run("DELETE FROM students WHERE student_id=? OR id=?", [id, id]);
    }
    scheduleSave();
    res.json({ code: 0, message: '删除成功' });
  });

  // 宿舍管理 CRUD
router.get('/api/dorms/all', authMiddleware, (req, res) => {
  try {
    const rows = db.exec("SELECT * FROM dorms ORDER BY building, room")[0]?.values || [];
    res.json({ code: 0, data: rows.map(r => ({
      id: r[0], building: r[1]||'', room: r[2]||'', capacity: r[3]||6, gender: r[4]||'', floor: r[5]||0, occupied: r[6]||0
    })) });
  } catch (e) {
    res.json({ code: 1, message: e.message });
  }
});

router.post('/api/dorms', authMiddleware, (req, res) => {
  try {
    const { id, building, room, capacity, gender, floor, occupied } = req.body;
    if (!building || !room) return res.json({ code: 1, message: '楼栋和房号不能为空' });
    const dormId = id || ('dorm_'+Date.now());
    try {
      db.run("INSERT INTO dorms(id, building, room, capacity, gender, floor, occupied) VALUES(?,?,?,?,?,?,?)", [dormId, building, room, capacity||6, gender||'男', floor||0, occupied||0]);
      scheduleSave();
      res.json({ code: 0, message: '创建成功', id: dormId });
    } catch(e) {
      res.json({ code: 1, message: '创建失败: '+e.message });
    }
  } catch (e) {
    res.json({ code: 1, message: e.message });
  }
});

router.put('/api/dorms/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { building, room, capacity, gender, floor, occupied } = req.body;
    const fields = [];
    const params = [];
    if (building !== undefined) { fields.push('building=?'); params.push(building); }
    if (room !== undefined) { fields.push('room=?'); params.push(room); }
    if (capacity !== undefined) { fields.push('capacity=?'); params.push(capacity); }
    if (gender !== undefined) { fields.push('gender=?'); params.push(gender); }
    if (floor !== undefined) { fields.push('floor=?'); params.push(floor); }
    if (occupied !== undefined) { fields.push('occupied=?'); params.push(occupied); }
    if (!fields.length) return res.json({ code: 1, message: '无更新字段' });
    params.push(id);
    db.run(`UPDATE dorms SET ${fields.join(', ')} WHERE id=?`, params);
    scheduleSave();
    res.json({ code: 0, message: '更新成功' });
  } catch (e) {
    res.json({ code: 1, message: e.message });
  }
});

router.delete('/api/dorms/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    db.run("DELETE FROM dorms WHERE id=?", [id]);
    scheduleSave();
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.json({ code: 1, message: e.message });
  }
});

// 重置密码：按班级或宿舍
  router.post('/api/students/reset-password', authMiddleware, async (req, res) => {
    try {
      const { class_name, dorm, new_password, student_id, d } = req.body;
      const pwd = new_password || '123456';
      const cond = [];
      const params = [];
      if(class_name){ cond.push('class_name=?'); params.push(class_name); }
      if(dorm){ cond.push('dorm=?'); params.push(dorm); }
      if(d){ cond.push('dorm=?'); params.push(d); }
      if(student_id){ cond.push('(student_id=? OR id=?)'); params.push(String(student_id)); params.push(parseInt(student_id)||0); }
      if(!cond.length){
        return res.json({ code: 1, message: '请指定班级、宿舍或学生' });
      }
      // 使用 bcrypt 哈希存储密码
      const newHash = await bcrypt.hash(pwd, 10);
      const sql = `UPDATE students SET password_hash=?, must_change_pwd=1 WHERE ${cond.join(' AND ')}`;
      db.run(sql, [newHash, ...params]);
      scheduleSave();
      const cnt = db.exec(`SELECT COUNT(*) FROM students WHERE ${cond.join(' AND ')}`, params)[0]?.values?.[0]?.[0] || 0;
      res.json({ code: 0, message: `重置成功，影响 ${cnt} 条`, data: { count: cnt } });
    } catch(e) {
      res.json({ code: 1, message: '重置失败: '+e.message });
    }
  });

  // 宿舍维度重置密码
  router.post('/api/dorms/reset-password', authMiddleware, async (req, res) => {
    try {
      const { dorm, new_password } = req.body;
      const pwd = new_password || '123456';
      if(!dorm) return res.json({ code: 1, message: '请指定宿舍' });
      const pwdHash = await bcrypt.hash(pwd, 10);
      db.run("UPDATE students SET password_hash=?, must_change_pwd=1 WHERE dorm=?", [pwdHash, dorm]);
      scheduleSave();
      const cnt = db.exec("SELECT COUNT(*) FROM students WHERE dorm=?", [dorm])[0]?.values?.[0]?.[0] || 0;
      res.json({ code: 0, message: `重置成功，影响 ${cnt} 条`, data: { count: cnt } });
    } catch(e) {
      res.json({ code: 1, message: '重置失败: '+e.message });
    }
  });

// ==================== Excel 导入导出 ====================
router.get('/api/export/students', authMiddleware, async (req, res) => {
  try {
    const rows = db.exec("SELECT student_id, name, gender, dorm, class_name, phone FROM students ORDER BY class_name, dorm, name")[0]?.values || [];
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('学生信息');
    worksheet.addRow(['学号','姓名','性别','宿舍','班级','电话']);
    rows.forEach(r => {
      worksheet.addRow([
        r[0]||'',
        r[1]||'',
        r[2]||'',
        r[3]||'',
        r[4]||'',
        r[5]||''
      ]);
    });
    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="students.xlsx"');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (e) {
    console.error('学生导出失败:', e);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 1, message: '导出失败: ' + e.message }));
    }
  }
});

router.get('/api/template/students', authMiddleware, (req, res) => {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('学生名单');
      
      // 添加表头
      worksheet.addRow(['姓名', '学号', '性别', '宿舍', '班级', '年级', '专业', '电话']);
      
      // 添加示例数据
      worksheet.addRow(['张三', '2024001', '男', '12栋301', '241测绘', '2024', '测绘工程', '13800138000']);
      worksheet.addRow(['李四', '2024002', '女', '12栋3012', '242测绘', '2024', '测绘工程', '13800138001']);
      
      // 设置列宽
      worksheet.columns = [
        { key: 'A', width: 10 },
        { key: 'B', width: 12 },
        { key: 'C', width: 6 },
        { key: 'D', width: 15 },
        { key: 'E', width: 15 },
        { key: 'F', width: 10 },
        { key: 'G', width: 15 },
        { key: 'H', width: 15 }
      ];
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="students_template.xlsx"');
      workbook.xlsx.write(res).then(() => res.end());
    } catch (e) {
      console.error('Template error:', e);
      res.json({ code: 1, message: '生成模板失败: ' + e.message });
    }
  });

  router.post('/api/students/import-excel', upload.single('file'), authMiddleware, async (req, res) => {
    if (!req.file) return res.json({ code: 1, message: '请上传文件' });
    
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(req.file.path);
      const worksheet = workbook.getWorksheet(1);
      
      const rows = [];
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber <= worksheet.rowCount) {
          rows.push(row.values);
        }
      });
      
      if (rows.length < 2) return res.json({ code: 1, message: '文件为空或格式不正确' });
      
      const headers = Array.from(rows[0]).map(h => String(h || '').trim());
      const nameIdx = headers.findIndex(h => h.includes('姓名') || h.includes('name'));
      const studentIdIdx = headers.findIndex(h => h.includes('学号') || h.includes('student'));
      const genderIdx = headers.findIndex(h => h.includes('性别') || h.includes('gender'));
      const dormIdx = headers.findIndex(h => h.includes('宿舍') || h.includes('dorm'));
      const clsIdx = headers.findIndex(h => h.includes('班级') || h.includes('class'));
      const gradeIdx = headers.findIndex(h => h.includes('年级') || h.includes('grade'));
      const majorIdx = headers.findIndex(h => h.includes('专业') || h.includes('major'));
      const phoneIdx = headers.findIndex(h => h.includes('电话') || h.includes('phone'));
      
      if (nameIdx === -1 || dormIdx === -1) return res.json({ code: 1, message: 'Excel缺少姓名和宿舍列' });

      const classAddCount = {};
      for (let i = 1; i < rows.length; i++) {
        const row = Array.from(rows[i] || []);
        if (!row[nameIdx]) continue;
        const clsName = clsIdx >= 0 && row[clsIdx] ? String(row[clsIdx]).trim() : '';
        if (clsName) classAddCount[clsName] = (classAddCount[clsName] || 0) + 1;
      }
      const overLimitClasses = [];
      for (const [clsName, addCount] of Object.entries(classAddCount)) {
        const currentCount = getClassCount(db, clsName);
        if (currentCount + addCount > CLASS_SIZE_LIMIT) {
          overLimitClasses.push(`${clsName}（当前${currentCount}人，新增${addCount}人，上限${CLASS_SIZE_LIMIT}人）`);
        }
      }
      if (overLimitClasses.length > 0) {
        return res.json({ code: 1, message: `以下班级人数超限，无法导入：\n${overLimitClasses.join('\n')}` });
      }

      let count = 0;
      for (let i = 1; i < rows.length; i++) {
        const row = Array.from(rows[i] || []);
        if (!row[nameIdx]) continue;
        const id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        db.run("INSERT INTO students(id, name, student_id, gender, dorm, class_name, phone, grade, major) VALUES(?,?,?,?,?,?,?,?,?)", [
          id, String(row[nameIdx] || '').trim(),
          studentIdIdx >= 0 && row[studentIdIdx] ? String(row[studentIdIdx]).trim() : '',
          genderIdx >= 0 && row[genderIdx] ? String(row[genderIdx]).trim() : '',
          row[dormIdx] ? String(row[dormIdx]).trim() : '',
          clsIdx >= 0 && row[clsIdx] ? String(row[clsIdx]).trim() : '',
          phoneIdx >= 0 && row[phoneIdx] ? String(row[phoneIdx]).trim() : '',
          gradeIdx >= 0 && row[gradeIdx] ? String(row[gradeIdx]).trim() : '',
          majorIdx >= 0 && row[majorIdx] ? String(row[majorIdx]).trim() : ''
        ]);
        count++;
      }
      scheduleSave();
      addLog('Excel导入学生', `成功导入 ${count} 位学生`);
      res.json({ code: 0, message: `成功导入 ${count} 位学生` });
    } catch (e) {
      console.error('Import error:', e);
      res.json({ code: 1, message: '导入失败: ' + e.message });
    }
  });

  // 删除单个查寝记录
  router.delete('/api/records/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    try {
      db.run("DELETE FROM records WHERE id=?", [id]);
      scheduleSave();
      syncAlertsForToday();
      res.json({ code: 0, message: '记录已删除' });
    } catch (e) {
      res.json({ code: 1, message: '删除失败: ' + e.message });
    }
  });

  return router;
}

module.exports = { init };
