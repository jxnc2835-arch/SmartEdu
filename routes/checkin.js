// 查寝相关路由模块
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const os = require('os');
const { authMiddleware, STUDENT_TOKENS, RESET_TOKENS, STUDENT_TOKEN_EXPIRY, validateToken } = require('../middleware/auth');
const sharp = require('sharp'); // 用于图片格式校验与处理
const { nowTimestamp: localNowTimestamp, saveBase64Photo, localDateStr } = require('../utils/helpers');

/**
 * 确保用户信息（非强制解析 token）
 * 带 token 的请求会设置 req.user（用于辅导员班级隔离），不带则维持公开
 * @param {object} req - Express 请求对象
 */
function ensureUser(req) {
  if (req.user) return;
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token) { 
    const validated = validateToken(token); 
    if (validated) req.user = validated; 
  }
}

/**
 * 初始化查寝路由模块
 * @param {Object} opts - 依赖注入对象
 * @returns {Express.Router}
 */
function init(opts) {
  const { db, scheduleSave, upload, fs, path, addLog, broadcast, sendWebhook } = opts;
  const router = express.Router();

  // 异常闭环自动同步：当查寝记录变化时，异步同步今日未归告警（不阻塞响应）
  const { syncAlertsForToday } = require('../utils/alerts-sync');

  // ==================== 查寝记录查询 ====================
  /**
   * GET /api/records
   * 获取查寝记录列表（支持分页和全量查询）
   */
  router.get('/api/records', (req, res) => {
    const { date, type, student_id, class_name, date_from, date_to, page, limit } = req.query;
    
    // 如果请求分页，使用优化后的分页查询
    if (page || limit) {
      return getPaginatedRecords(req, res, date, type, student_id, class_name, date_from, date_to, page, limit);
    }
    
    // 原有查询逻辑（保持向后兼容）
    return getFullRecords(req, res, date, type, student_id, class_name, date_from, date_to);
  });

  // 分页查询查寝记录（高性能版本）
  function getPaginatedRecords(req, res, date, type, student_id, class_name, date_from, date_to, page, limit) {
    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (pageNum - 1) * limitNum;

    const whereClauses = ['1=1'];
    const params = [];

    ensureUser(req);
    const sc = req.user && req.user.classScope;
    const _role = req.user && req.user.role;
    // [修复·问题3] 辅导员/班主任未绑定班级时禁止查看任何记录，杜绝越权看全校
    if ((_role === 'counselor' || _role === 'teacher') && (!sc || !sc.length)) {
      return res.json({ code: 0, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0, hasNext: false, hasPrev: false } });
    }
    if (sc && sc.length) { whereClauses.push(`s.class_name IN (${sc.map(() => '?').join(',')})`); params.push(...sc); }

    if (date) { whereClauses.push("r.date=?"); params.push(date); }
    if (date_from) { whereClauses.push("r.date>=?"); params.push(date_from); }
    if (date_to) { whereClauses.push("r.date<=?"); params.push(date_to); }
    if (type && type.includes(',')) {
      // 支持多类型过滤，如 type=class,attendance
      const types = type.split(',').map(t => t.trim()).filter(Boolean);
      const placeholders = types.map(() => '?').join(',');
      whereClauses.push(`r.type IN (${placeholders})`);
      params.push(...types);
    } else if (type) {
      whereClauses.push("r.type=?"); params.push(type);
    }
    if (student_id) { whereClauses.push("r.student_id=?"); params.push(student_id); }
    if (class_name) { whereClauses.push("(s.class_name=? OR r.class_name=?)"); params.push(class_name); params.push(class_name); }
    if (req.query.status) { 
      if (req.query.status === '请假') {
        const leaveTypes = ['病假','事假','公假','丧假'];
        whereClauses.push(`r.status IN (${leaveTypes.map(() => '?').join(',')})`);
        params.push(...leaveTypes);
      } else {
        whereClauses.push("r.status=?"); params.push(req.query.status);
      }
    }
    if (req.query.course_id) { whereClauses.push("r.course_id=?"); params.push(req.query.course_id); }
    if (req.query.course_name) { whereClauses.push("r.course_id IN (SELECT id FROM courses WHERE name=?)"); params.push(req.query.course_name); }
    
    const whereSql = whereClauses.join(' AND ');
    
    const query = `SELECT r.*, s.name as student_name, s.dorm, s.class_name as r_class_name, s.student_id as s_student_id 
                   FROM records r 
                   LEFT JOIN students s ON r.student_id = s.student_id 
                   WHERE ${whereSql}
                   ORDER BY r.date DESC, r.time DESC 
                   LIMIT ? OFFSET ?`;

    const finalParams = [...params, limitNum, offset];
    const result = db.exec(query, finalParams);
    const rows = result[0]?.values || [];
    const columns = result[0]?.columns || [];

    // 获取总数
    const countQuery = `SELECT COUNT(*) FROM records r LEFT JOIN students s ON r.student_id = s.student_id WHERE ${whereSql}`;
    const countResult = db.exec(countQuery, params);
    const total = countResult[0]?.values?.[0]?.[0] || 0;

    const data = rows.map(r => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = r[i]; });
      // 班级列优先取学生表真实班级(r_class_name)，避免记录表 class_name 去规范化副本
      // （可能为空，或历史/演示数据里混入的未归理由文本）覆盖到"班级"列
      if (obj.r_class_name) obj.class_name = obj.r_class_name;
      return obj;
    });

    res.json({
      code: 0,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        hasNext: pageNum < Math.ceil(total / limitNum),
        hasPrev: pageNum > 1,
      }
    });
  }

  // 全量查询查寝记录（向后兼容）
  function getFullRecords(req, res, date, type, student_id, class_name, date_from, date_to) {
    let sqlStr = `SELECT r.*, s.name as student_name, s.dorm, s.class_name, s.student_id FROM records r LEFT JOIN students s ON r.student_id = s.student_id WHERE 1=1`;
    const params = [];
    ensureUser(req);
    const sc = req.user && req.user.classScope;
    const _role = req.user && req.user.role;
    // [修复·问题3] 辅导员/班主任未绑定班级时禁止查看任何记录，杜绝越权看全校
    if ((_role === 'counselor' || _role === 'teacher') && (!sc || !sc.length)) {
      return res.json({ code: 0, data: [] });
    }
    if (sc && sc.length) { sqlStr += ` AND s.class_name IN (${sc.map(() => '?').join(',')})`; params.push(...sc); }
    if (date) { sqlStr += " AND r.date=?"; params.push(date); }
    if (date_from) { sqlStr += " AND r.date>=?"; params.push(date_from); }
    if (date_to) { sqlStr += " AND r.date<=?"; params.push(date_to); }
    if (type && type.includes(',')) {
      const types = type.split(',').map(t => t.trim()).filter(Boolean);
      const placeholders = types.map(() => '?').join(',');
      sqlStr += ` AND r.type IN (${placeholders})`;
      params.push(...types);
    } else if (type) {
      sqlStr += " AND r.type=?"; params.push(type);
    }
    if (student_id) { sqlStr += " AND r.student_id=?"; params.push(student_id); }
    if (class_name) { sqlStr += " AND s.class_name=?"; params.push(class_name); }
    if (req.query.status) {
      if (req.query.status === '请假') {
        const leaveTypes = ['病假','事假','公假','丧假'];
        sqlStr += ` AND r.status IN (${leaveTypes.map(() => '?').join(',')})`;
        params.push(...leaveTypes);
      } else {
        sqlStr += " AND r.status=?"; params.push(req.query.status);
      }
    }
    sqlStr += " ORDER BY r.date DESC, r.time DESC";
    const execResult = db.exec(sqlStr, params);
    const rows = execResult[0]?.values || [];
    const columns = execResult[0]?.columns || [];
    res.json({ code: 0, data: rows.map(r => { const obj = {}; columns.forEach((col, i) => { obj[col] = r[i]; }); return obj; }) });
  }

  // ==================== 访客管理查询 ====================
  router.get('/api/visitors', authMiddleware, (req, res) => {
    try {
      const { class_name, dorm } = req.query;
      const scope = req.user?.classScope;
      const role = req.user?.role;
      if ((role === 'counselor' || role === 'teacher') && (!scope || !scope.length)) {
        return res.json({ code: 0, data: [] });
      }

      let sql = `SELECT v.*, s.name as target_student_name FROM visitors v LEFT JOIN students s ON v.target_student_id = s.student_id OR v.target_student_id = s.id WHERE 1=1`;
      const params = [];
      if (scope && scope.length) {
        sql += ` AND s.class_name IN (${scope.map(() => '?').join(',')})`;
        params.push(...scope);
      }
      if (class_name) { sql += " AND s.class_name=?"; params.push(class_name); }
      if (dorm) { sql += " AND v.target_dorm=?"; params.push(dorm); }
      sql += " ORDER BY v.visit_date DESC, v.visit_time DESC";
      const execResult = db.exec(sql, params);
      const rows = execResult[0]?.values || [];
      const columns = execResult[0]?.columns || [];
      res.json({ code: 0, data: rows.map(r => { const obj = {}; columns.forEach((col, i) => { obj[col] = r[i]; }); return obj; }) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // P1·实用性：访客登记 POST/PUT/DELETE
  router.post('/api/visitors', authMiddleware, (req, res) => {
    try {
      const { visitor_name, visitor_id_card, visitor_phone, target_student_id, target_dorm, visit_purpose, visit_date, visit_time, note } = req.body || {};
      if (!visitor_name || !target_dorm) return res.json({ code: 1, message: '姓名与所访宿舍为必填' });
      const id = 'vis_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      db.run("INSERT INTO visitors(id, visitor_name, visitor_id_card, visitor_phone, target_student_id, target_dorm, visit_purpose, visit_date, visit_time, note, created_at, checked_in) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)",
        [id, visitor_name, visitor_id_card || '', visitor_phone || '', target_student_id || '', target_dorm, visit_purpose || '', visit_date || localDateStr(), visit_time || '', note || '', localNowTimestamp()]);
      scheduleSave();
      addLog('登记访客', `${visitor_name} → ${target_dorm}`);
      res.json({ code: 0, message: '登记成功', data: { id } });
    } catch (e) { res.json({ code: 1, message: e.message }); }
  });

  router.put('/api/visitors/:id', authMiddleware, (req, res) => {
    try {
      const { visitor_name, visitor_id_card, visitor_phone, target_student_id, target_dorm, visit_purpose, visit_date, visit_time, note, checked_in } = req.body || {};
      const fields = []; const params = [];
      if (visitor_name !== undefined) { fields.push('visitor_name=?'); params.push(visitor_name); }
      if (visitor_id_card !== undefined) { fields.push('visitor_id_card=?'); params.push(visitor_id_card); }
      if (visitor_phone !== undefined) { fields.push('visitor_phone=?'); params.push(visitor_phone); }
      if (target_student_id !== undefined) { fields.push('target_student_id=?'); params.push(target_student_id); }
      if (target_dorm !== undefined) { fields.push('target_dorm=?'); params.push(target_dorm); }
      if (visit_purpose !== undefined) { fields.push('visit_purpose=?'); params.push(visit_purpose); }
      if (visit_date !== undefined) { fields.push('visit_date=?'); params.push(visit_date); }
      if (visit_time !== undefined) { fields.push('visit_time=?'); params.push(visit_time); }
      if (note !== undefined) { fields.push('note=?'); params.push(note); }
      if (checked_in !== undefined) { fields.push('checked_in=?'); params.push(checked_in); }
      if (fields.length === 0) return res.json({ code: 1, message: '无字段可更新' });
      params.push(req.params.id);
      db.run(`UPDATE visitors SET ${fields.join(', ')} WHERE id=?`, params);
      if (db.getRowsModified() === 0) return res.json({ code: 1, message: '未找到该访客' });
      scheduleSave();
      addLog('更新访客', `ID：${req.params.id}`);
      res.json({ code: 0, message: '更新成功' });
    } catch (e) { res.json({ code: 1, message: e.message }); }
  });

  router.delete('/api/visitors/:id', authMiddleware, (req, res) => {
    try {
      db.run("DELETE FROM visitors WHERE id=?", [req.params.id]);
      if (db.getRowsModified() === 0) return res.json({ code: 1, message: '未找到该访客' });
      scheduleSave();
      addLog('删除访客', `ID：${req.params.id}`, 'WARN');
      res.json({ code: 0, message: '删除成功' });
    } catch (e) { res.json({ code: 1, message: e.message }); }
  });

  // ==================== 查寝签到 ====================
  // 上传图片后进行安全校验，确保是真正的图片文件，防止恶意文件上传
  router.post('/api/checkin', upload.single('photo'), async (req, res) => {
    try {
      await handleCheckin(req, res);
    } catch (e) {
      // P1修复：路由体整体兜底，任何同步/异步异常都保证响应送达（Express 5 async 未捕获 rejection 会挂起）
      console.error('[checkin] 未捕获异常:', e);
      addLog('查寝签到异常', `${req.body?.student_id || '未知'} ${e.message}`, 'ERROR');
      if (!res.headersSent) res.status(500).json({ code: 1, message: '签到处理异常：' + e.message });
    }
  });

  // /api/checkin 路由体（P1修复拆出以便 try/catch 兜底）
  async function handleCheckin(req, res) {
    const { student_id, date, time, status, latitude, longitude, address, note, photo, offline, liveness_passed, liveness_score } = req.body;
    if (!student_id || !date) return res.json({ code: 1, message: '参数不完整' });

    const adminToken = req.headers['x-auth-token'];
    const studentToken = req.headers['x-student-token'];
    const adminAuth = adminToken && validateToken(adminToken);
    const studentAuthEntry = studentToken && STUDENT_TOKENS[studentToken];

    if (!adminAuth && !studentAuthEntry) return res.status(401).json({ code: 1, message: '身份验证失败，请重新登录' });
    if (studentAuthEntry && student_id !== studentAuthEntry.student_id) return res.json({ code: 1, message: '身份验证失败' });
    if (studentAuthEntry && Date.now() > studentAuthEntry.expiresAt) {
      delete STUDENT_TOKENS[studentToken];
      return res.status(401).json({ code: 1, message: '身份验证已过期，请重新登录' });
    }

    // [加固] 扫码签到宿舍绑定校验：请求中携带 dorm 时，必须与学生本人宿舍一致
    // 注意：空字符串 '' 也视为有传 dorm，防止前端漏传 dorm 绕过校验
    if (req.body.dorm !== undefined && req.body.dorm !== null) {
      const qrDorm = String(req.body.dorm).trim();
      const stuRow = db.exec("SELECT dorm FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
      const studentDorm = stuRow ? String(stuRow[0]).trim() : '';
      // 学生有宿舍归属且与扫码宿舍不符则拒绝
      if (studentDorm && qrDorm !== studentDorm) {
        addLog('扫码签到拦截', `学生 ${student_id} 扫描了非本人宿舍二维码（本人：${studentDorm}，扫码：${qrDorm}）`, 'WARN');
        return res.json({ code: 3, message: `二维码宿舍（${qrDorm}）与本人宿舍（${studentDorm}）不符，签到失败` });
      }
      // 学生无宿舍归属但二维码指定了宿舍，也拒绝（防止乱扫）
      if (!studentDorm && qrDorm) {
        addLog('扫码签到拦截', `学生 ${student_id} 无宿舍归属，但扫描了宿舍二维码（${qrDorm}）`, 'WARN');
        return res.json({ code: 3, message: '学生无宿舍归属，无法扫码签到' });
      }
    }

    // [P0修复] GPS 围栏校验接入主签到流程：存在启用中的围栏规则且请求带坐标时，
    // 位置在所有围栏之外 → 拦截签到 + 记审计日志 + Webhook 告警（原先围栏只在独立的
    // /api/checkin-with-geofence 接口生效，而学生端从未调用该接口，围栏形同虚设）
    if ((latitude || longitude)) {
      const fenceRules = db.exec("SELECT latitude, longitude, radius_meters FROM geofence_rules WHERE active=1")[0]?.values || [];
      if (fenceRules.length) {
        const lat = parseFloat(latitude), lon = parseFloat(longitude);
        if (!isNaN(lat) && !isNaN(lon)) {
          // 距离近似：纬度差 × 111km，经度差 × 111km × cos(纬度)（校园尺度误差可忽略）
          const cosLat = Math.cos(lat * Math.PI / 180);
          let isInside = false;
          for (const rule of fenceRules) {
            const dLat = (lat - parseFloat(rule[0])) * 111000;
            const dLon = (lon - parseFloat(rule[1])) * 111000 * cosLat;
            if (Math.sqrt(dLat * dLat + dLon * dLon) <= (parseFloat(rule[2]) || 200)) { isInside = true; break; }
          }
          if (!isInside) {
            addLog('围栏拦截', `学生 ${student_id} 签到位置超出所有围栏: (${lat}, ${lon})`, 'WARN');
            if (typeof sendWebhook === 'function') {
              sendWebhook(`⚠️ 围栏告警\n学生：${student_id}\n时间：${localNowTimestamp().slice(0,19).replace('T',' ')}\n当前坐标：${lat}, ${lon}\n签到已被拦截，请核实位置`);
            }
            return res.json({ code: 2, message: '当前位置超出允许的签到范围（电子围栏），签到被拦截。请到宿舍/教学楼指定区域内重试。', outside: true });
          }
        }
      }
    }

    // 若有上传文件，使用 sharp 读取元数据进行校验
    let photoPath = null;
    if (req.file) {
      try {
        await sharp(req.file.path).metadata(); // 若不是图片会抛错
        photoPath = '/uploads/' + req.file.filename;
      } catch (e) {
        // 删除非法文件并返回错误
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ code: 1, message: '上传的文件不是有效图片' });
      }
    }
    if (photo && !req.file) {
      const base64Data = photo.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2,8)}.jpg`;
      const filePath = path.join(__dirname, '..', 'public', 'uploads', filename);
      fs.writeFileSync(filePath, buf);
      photoPath = '/uploads/' + filename;
    }

    const now = date + ' ' + (time || localNowTimestamp().slice(11, 19));
    const id = 'c_' + Date.now();
    const isOffline = offline === true || offline === '1';
    const livenessInt = Number(liveness_passed) === 1 ? 1 : 0;          // 活体检测是否通过
    const livenessScoreVal = parseFloat(liveness_score) || 0;            // 活体置信度

    // 姓名查询前移（P0修复：低活体分数分支的告警文案依赖 studentName，原声明在后导致 TDZ ReferenceError）
    const studentRow = db.exec("SELECT name FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
    const studentName = studentRow ? studentRow[0] : student_id;

    // [P0修复] 服务端活体分数校验：低置信度需告警
    const LIVENESS_SCORE_THRESHOLD = 0.5;
    if (livenessScoreVal > 0 && livenessScoreVal < LIVENESS_SCORE_THRESHOLD) {
      addLog('活体分数异常', `学生 ${studentName}(${student_id}) 活体分数过低(${livenessScoreVal.toFixed(4)})，可能伪造检测`, 'WARN');
      if (typeof sendWebhook === 'function') {
        sendWebhook(`⚠️ 活体分数过低\n姓名：${studentName}\n学号：${student_id}\n时间：${now}\n分数：${livenessScoreVal.toFixed(4)}\n阈值：${LIVENESS_SCORE_THRESHOLD}\n请核实是否伪造活体检测`);
      }
    }

    // 同一学生同一天只保留一条查寝记录，避免重复签到导致统计异常
    db.run("DELETE FROM records WHERE student_id=? AND type='checkin' AND date=?", [student_id, date]);

    db.run("INSERT INTO records(id, student_id, class_name, status, time, type, note, latitude, longitude, address, photo_path, offline, date, liveness_passed, liveness_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, student_id, req.body.class_name||'', status||'在寝', now, 'checkin', note||'', latitude?parseFloat(latitude):null, longitude?parseFloat(longitude):null, address||'', photoPath, isOffline ? 1 : 0, date, livenessInt, livenessScoreVal]);
    scheduleSave();
    syncAlertsForToday();

    if (typeof broadcast === 'function') {
      broadcast({ type: 'new_checkin', data: { id, student_id, student_name: studentName, date, time: now, status: status||'在寝', address, photo_path: photoPath, offline: isOffline } });
    }
    if ((status === '未归' || status === '不在寝') && studentName) {
      if (typeof sendWebhook === 'function') {
        sendWebhook(`⚠️ 学生未归\n姓名：${studentName}\n宿舍：${req.body.dorm || '未知'}\n时间：${now}\n状态：${status}`);
      }
    }
    // 活体检测风险告警：提交照片但活体未通过 → 疑似照片代签
    if (photoPath && livenessInt === 0) {
      addLog('活体检测风险', `学生 ${studentName}(${student_id}) 签到照片未通过活体检测，疑似照片代签`, 'WARN');
      if (typeof sendWebhook === 'function') {
        sendWebhook(`⚠️ 活体检测未通过\n姓名：${studentName}\n学号：${student_id}\n时间：${now}\n可能使用照片代签，请核实`);
      }
    }
    
    // [P0修复] 服务端人脸比对验证：若有face_hash则与注册人脸比对
    let faceMatchResult = null;
    const faceHash = req.body.face_hash;
    if (faceHash && photoPath) {
      try {
        const studentData = db.exec("SELECT student_id, name, class_name, face_hash FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
        if (studentData && studentData[3]) {
          let registeredArr, submittedArr;
          try {
            registeredArr = JSON.parse(studentData[3]);
            submittedArr = JSON.parse(faceHash);
          } catch (e) {
            addLog('人脸比对错误', `学生 ${student_id} 人脸特征数据格式错误`, 'WARN');
            faceMatchResult = { matched: false, reason: '格式错误' };
          }
          
          if (!faceMatchResult && registeredArr && submittedArr && registeredArr.length === submittedArr.length) {
            let dotProduct = 0, magA = 0, magB = 0;
            for (let i = 0; i < registeredArr.length; i++) {
              dotProduct += registeredArr[i] * submittedArr[i];
              magA += registeredArr[i] * registeredArr[i];
              magB += submittedArr[i] * submittedArr[i];
            }
            magA = Math.sqrt(magA);
            magB = Math.sqrt(magB);
            if (magA > 0 && magB > 0) {
              const similarity = dotProduct / (magA * magB);
              const FACE_THRESHOLD = 0.65;
              faceMatchResult = { matched: similarity >= FACE_THRESHOLD, similarity: parseFloat(similarity.toFixed(4)) };
              
              if (!faceMatchResult.matched) {
                addLog('人脸比对失败', `学生 ${studentName}(${student_id}) 签到人脸与注册人脸不匹配（相似度:${similarity.toFixed(4)}）`, 'WARN');
                if (typeof sendWebhook === 'function') {
                  sendWebhook(`⚠️ 人脸比对失败\n姓名：${studentName}\n学号：${student_id}\n时间：${now}\n相似度：${similarity.toFixed(4)}\n阈值：${FACE_THRESHOLD}`);
                }
              }
            }
          }
        }
      } catch (e) {
        addLog('人脸比对异常', `${student_id} ${e.message}`, 'ERROR');
      }
    }
    
    addLog('查寝签到', `${studentName}(${student_id}) - ${status||'在寝'}${livenessInt ? ' [活体✓]' : ''}${faceMatchResult ? (faceMatchResult.matched ? ' [人脸✓]' : ' [人脸✗]') : ''}`, offline ? 'WARN' : 'INFO');
    res.json({ code: 0, message: '签到成功', id, liveness_passed: livenessInt, face_match: faceMatchResult });
  }

  // ==================== 请假 ====================
  router.post('/api/leaves', upload.single('attachment'), (req, res) => {
    const token = req.headers['x-student-token'];
    const entry = STUDENT_TOKENS[token];
    if (!entry || Date.now() > entry.expiresAt) { delete STUDENT_TOKENS[token]; return res.status(401).json({ code: 1, message: '身份验证已过期，请重新登录' }); }

    const { student_id, type, reason, start_date, end_date } = req.body;
    if (!student_id || !type || !reason || !start_date) return res.json({ code: 1, message: '请填写完整信息' });
    if (student_id !== entry.student_id) return res.json({ code: 1, message: '身份验证失败' });

    let attachPath = null;
    if (req.file) { attachPath = '/uploads/' + req.file.filename; }
    else if (req.body.attachment) { attachPath = saveBase64Photo(req.body.attachment, 'lv'); }

    const now = localNowTimestamp();
    const id = 'l_' + Date.now();
    db.run("INSERT INTO leaves(id, student_id, type, reason, start_date, end_date, attachment_path, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)", [id, student_id, type, reason, start_date, end_date||start_date, attachPath, '待审批', now]);
    scheduleSave();

    const studentRow = db.exec("SELECT name FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
    const studentName = studentRow ? studentRow[0] : student_id;

    if (typeof broadcast === 'function') {
      broadcast({ type: 'new_leave', data: { id, student_id, student_name: studentName, type, reason, start_date, end_date: end_date||start_date, status: '待审批', created_at: now } });
    }
    addLog('提交请假', `${studentName} - ${type}: ${reason.slice(0, 30)}`);
    res.json({ code: 0, message: '请假申请已提交，等待审批', id });
  });

  // ==================== 请假记录查询 ====================
  router.get('/api/leaves', (req, res) => {
    ensureUser(req);
    const { status, student_id, from, to, class_name, type } = req.query;
    let sqlStr = "SELECT l.*, s.name as student_name, s.dorm, s.class_name FROM leaves l LEFT JOIN students s ON l.student_id = s.student_id";
    const params = [];
    const cond = [];
    // 辅导员/班主任班级隔离：空 scope 看空；选择具体班级时必须在 scope 内并精确过滤
    const sc = req.user && req.user.classScope;
    if (sc && sc.length) {
      if (class_name && !sc.includes(class_name)) {
        return res.json({ code: 1, message: '无权查看该班级数据' });
      }
      if (class_name) {
        cond.push("s.class_name=?");
        params.push(class_name);
      } else {
        cond.push(`s.class_name IN (${sc.map(() => '?').join(',')})`);
        params.push(...sc);
      }
    } else if (req.user && (req.user.role === 'counselor' || req.user.role === 'teacher')) {
      // 辅导员/班主任未绑定班级：按最小权限返回空数据
      cond.push('1=0');
    } else if (class_name) {
      cond.push("s.class_name=?");
      params.push(class_name);
    }
    if (status) {
      // 库中 status 中英混杂（历史英文 approved/pending/rejected + 新中文 已批准/待审批/已驳回），
      // 传任意一种都同时匹配两种写法，避免筛选/导出漏数据
      const stMap = { approved: '已批准', pending: '待审批', rejected: '已驳回', '已批准': 'approved', '待审批': 'pending', '已驳回': 'rejected' };
      const variants = stMap[status] ? [status, stMap[status]] : [status];
      cond.push(`l.status IN (${variants.map(() => '?').join(',')})`);
      params.push(...variants);
    }
    if (student_id) { cond.push("l.student_id=?"); params.push(student_id); }
    if (from) { cond.push("l.start_date>=?"); params.push(from); }
    if (to) { cond.push("l.start_date<=?"); params.push(to); }
    if (type) {
      // 学生端"其他"兼容旧数据"丧假"
      if (type === '其他') {
        cond.push("(l.type=? OR l.type='丧假')");
        params.push(type);
      } else {
        cond.push("l.type=?");
        params.push(type);
      }
    }
    if (cond.length) sqlStr += " WHERE " + cond.join(" AND ");
    sqlStr += " ORDER BY l.created_at DESC";
    const execResult = db.exec(sqlStr, params);
    const rows = execResult[0]?.values || [];
    const columns = execResult[0]?.columns || [];
    res.json({ code: 0, data: rows.map(r => { const obj = {}; columns.forEach((col, i) => { obj[col] = r[i]; }); return obj; }) });
  });

  router.put('/api/leaves/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    const { status, comment } = req.body;
    if (!['已批准', '已驳回'].includes(status)) return res.json({ code: 1, message: '状态无效' });
    const now = localNowTimestamp();
    // 检查 id 是数字还是字符串
    const numericId = parseInt(id);
    const isNumeric = !isNaN(numericId) && numericId>0;
    if(isNumeric){
      db.run("UPDATE leaves SET status=?, comment=?, processed_at=?, processed_by=? WHERE id=?", [status, comment||'', now, '辅导员', numericId]);
    } else {
      db.run("UPDATE leaves SET status=?, comment=?, processed_at=?, processed_by=? WHERE id=?", [status, comment||'', now, '辅导员', id]);
    }
    // P1修复：0 行匹配为假成功，须如实返回未找到
    if (db.getRowsModified() === 0) {
      const exists = db.exec("SELECT 1 FROM leaves WHERE id=?", [isNumeric?numericId:id])[0]?.values?.[0];
      if (!exists) return res.json({ code: 1, message: '未找到该请假记录，可能已被删除' });
    }
    const leave = db.exec("SELECT l.*, s.name as student_name, s.class_name as stu_class FROM leaves l LEFT JOIN students s ON l.student_id=s.student_id WHERE l.id=?", [isNumeric?numericId:id])[0]?.values?.[0] || [];
    if (typeof broadcast === 'function') {
      broadcast({ type: 'leave_updated', data: { id, student_id: leave.student_id, student_name: leave.student_name, status, comment, updated_at: now } });
    }
    // 同步请假状态到当日查寝记录：已批准 → records 状态改为请假；已驳回 → 恢复为在寝
    if (leave.length >= 6) {
      try {
        const leaveStart = leave[4];
        const leaveEnd = leave[5];
        const leaveType = leave[2] || '事假';
        const sid = leave[1];
        const stuClass = leave[13] || '';
        // 枚举 [leaveStart, leaveEnd] 闭区间每一天，请假全量日期同步（不再只同步“今天”）
        const days = [];
        if (leaveStart && leaveEnd) {
          const cur = new Date(leaveStart + 'T00:00:00');
          const last = new Date(leaveEnd + 'T00:00:00');
          if (!isNaN(cur.getTime()) && !isNaN(last.getTime()) && cur <= last) {
            while (cur <= last) {
              const y = cur.getFullYear();
              const m = String(cur.getMonth() + 1).padStart(2, '0');
              const d = String(cur.getDate()).padStart(2, '0');
              days.push(`${y}-${m}-${d}`);
              cur.setDate(cur.getDate() + 1);
            }
          }
        }
        for (const d of days) {
          if (status === '已批准') {
            db.run("DELETE FROM records WHERE student_id=? AND type='checkin' AND date=?", [sid, d]);
            db.run("INSERT INTO records(id, student_id, class_name, status, time, type, note, date) VALUES(?,?,?,?,?,?,?)",
              ['lv_' + Date.now() + '_' + d.replace(/-/g, ''), sid, stuClass, leaveType, d + ' 08:00', 'checkin', '请假同步', d]);
          } else if (status === '已驳回') {
            db.run("DELETE FROM records WHERE student_id=? AND type='checkin' AND date=? AND status IN ('病假','事假','公假','丧假')", [sid, d]);
            db.run("INSERT INTO records(id, student_id, class_name, status, time, type, note, date) VALUES(?,?,?,?,?,?,?)",
              ['ck_' + Date.now() + '_' + d.replace(/-/g, ''), sid, stuClass, '在寝', d + ' 22:00', 'checkin', '驳回后恢复', d]);
          }
        }
      } catch (syncErr) {
        console.error('请假同步 records 失败:', syncErr);
      }
      syncAlertsForToday();
    }
    addLog('审批请假', `${leave.student_name} -> ${status}${comment?'：'+comment:''}`);
    res.json({ code: 0, message: status === '已批准' ? '✅ 已批准该请假' : '❌ 已驳回该请假' });
  });

  // P1·实用性：批量审批（一次处理多条待审批请假，复用单条逻辑）
  router.post('/api/leaves/batch-approve', authMiddleware, (req, res) => {
    const { ids, status, comment } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.json({ code: 1, message: '未选择请假记录' });
    if (!['已批准', '已驳回'].includes(status)) return res.json({ code: 1, message: '状态无效' });
    let ok = 0, fail = 0;
    for (const id of ids) {
      try {
        const now = localNowTimestamp();
        db.run("UPDATE leaves SET status=?, comment=?, processed_at=?, processed_by=? WHERE id=? AND status='待审批'", [status, comment || '', now, req.user?.username || '辅导员', id]);
        if (db.getRowsModified() > 0) ok++; else fail++;
        // 同步 records（复用单条逻辑的简化版：只更新 records 状态，不逐日展开）
        if (db.getRowsModified() > 0) {
          const leave = db.exec("SELECT * FROM leaves WHERE id=?", [id])[0]?.values?.[0] || [];
          if (leave.length >= 6 && status === '已批准') {
            const sid = leave[1];
            db.run("UPDATE records SET status=? WHERE student_id=? AND type='checkin' AND status='未归'", ['请假', sid]);
          } else if (leave.length >= 6 && status === '已驳回') {
            const sid = leave[1];
            db.run("UPDATE records SET status='在寝' WHERE student_id=? AND type='checkin' AND status='未归'", [sid]);
          }
        }
      } catch (e) { fail++; }
    }
    scheduleSave();
    addLog('批量审批请假', `${status} ${ok} 条${fail ? '，失败 ' + fail + ' 条' : ''}`, fail ? 'WARN' : 'INFO');
    res.json({ code: 0, message: `已${status === '已批准' ? '批准' : '驳回'} ${ok} 条${fail ? '，失败 ' + fail + ' 条' : ''}` });
  });

  // ==================== 课堂签到 ====================
  router.post('/api/class-checkin', (req, res) => {
    const token = req.headers['x-student-token'];
    const entry = STUDENT_TOKENS[token];
    if (!entry || Date.now() > entry.expiresAt) { delete STUDENT_TOKENS[token]; return res.status(401).json({ code: 1, message: '身份验证已过期，请重新登录' }); }

    const { student_id, course_id, date, time, latitude, longitude, address, class_name, note, photo } = req.body;
    if (!student_id || !course_id || !date) return res.json({ code: 1, message: '参数不完整' });
    if (student_id !== entry.student_id) return res.json({ code: 1, message: '身份验证失败' });

    const now = time || localNowTimestamp().slice(11, 19);
    const id = 'cc_' + Date.now();
    // 拍照签到通道：base64 照片落盘 public/uploads，photo_path 记入 records
    let photoPath = null;
    if (photo) {
      try { photoPath = saveBase64Photo(photo, 'cl'); } catch (e) { console.error('课堂签到照片保存失败:', e); }
    }
    // 同一学生同一课程同一天只保留一条签到记录
    db.run("DELETE FROM records WHERE student_id=? AND type='class' AND course_id=? AND date=?", [student_id, course_id, date]);
    db.run("INSERT INTO records(id, student_id, class_name, status, time, type, course_id, note, latitude, longitude, address, photo_path, date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, student_id, class_name, '出勤', date + ' ' + now, 'class', course_id, note || course_id || '', latitude?parseFloat(latitude):null, longitude?parseFloat(longitude):null, address||'', photoPath, date]);
    scheduleSave();

    if (typeof broadcast === 'function') {
      broadcast({ type: 'new_class_checkin', data: { id, student_id, course_id, date, time: now, status: '出勤', address, photo_path: photoPath } });
    }
    addLog('课堂签到', `学生${student_id} - 课程${course_id}${photoPath ? ' - 拍照签到' : ''}`);
    res.json({ code: 0, message: '签到成功', id });
  });

  router.get('/api/class-records', authMiddleware, (req, res) => {
    const { course_id, date, class_name } = req.query;
    let sqlStr = "SELECT r.*, s.name as student_name, s.class_name as stu_class FROM records r LEFT JOIN students s ON r.student_id=s.student_id WHERE r.type='class'";
    const params = [];
    const cond = [];
    if (course_id) { cond.push("r.course_id=?"); params.push(course_id); }
    if (date) { cond.push("r.date=?"); params.push(date); }
    if (class_name) { cond.push("(s.class_name=? OR stu_class=?)"); params.push(class_name); params.push(class_name); }
    if (cond.length) sqlStr += " AND " + cond.join(" AND ");
    sqlStr += " ORDER BY r.date DESC, r.time DESC";
    const rows = db.exec(sqlStr, params)[0]?.values || [];
    res.json({ code: 0, data: rows });
  });

  // ==================== 学生认证 ====================
  router.post('/api/student/change-password', async (req, res) => {
    const { student_id, oldPassword, newPassword } = req.body;
    // P0修复：加学生 token 鉴权（原接口裸奔，知道学号即可改他人密码）
    const token = req.headers['x-student-token'];
    const entry = STUDENT_TOKENS[token];
    if (!entry || Date.now() > entry.expiresAt) { delete STUDENT_TOKENS[token]; return res.status(401).json({ code: 1, message: '身份验证已过期，请重新登录' }); }
    if (student_id !== entry.student_id) return res.json({ code: 1, message: '身份验证失败，仅可修改本人密码' });
    if (!newPassword || newPassword.length < 6) return res.json({ code: 1, message: '新密码至少6位' });

    const row = db.exec("SELECT password_hash, must_change_pwd FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
    if (!row) return res.json({ code: 1, message: '学生不存在' });
    const hash = row[0] || '';
    if (hash) {
      if (!oldPassword) return res.json({ code: 1, message: '请输入当前密码' });
      const valid = await bcrypt.compare(oldPassword, hash);
      if (!valid) return res.json({ code: 1, message: '当前密码错误' });
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    db.run("UPDATE students SET password_hash=?, must_change_pwd=0 WHERE student_id=? OR id=?", [newHash, student_id, student_id]);
    scheduleSave();
    res.json({ code: 0, message: '密码修改成功' });
  });

  router.post('/api/student-login', (req, res) => {
    const { student_id } = req.body;
    if (!student_id) return res.json({ code: 1, message: '缺少学生ID' });
    const exists = db.exec("SELECT 1 FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.length;
    if (!exists) return res.json({ code: 1, message: '学生不存在' });
    const token = 'st_' + Date.now() + '_' + crypto.randomBytes(12).toString('hex');
    STUDENT_TOKENS[token] = { student_id, expiresAt: Date.now() + 8 * 3600 * 1000 };
    res.json({ code: 0, token, expiresIn: 8 });
  });

  router.post('/api/student/forgot-password', async (req, res) => {
    const { student_id, phone, dorm } = req.body;
    let row;
    if (student_id) {
      row = db.exec("SELECT student_id as id, name, phone, dorm, password_hash FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
      if (!row) return res.json({ code: 1, message: '学号不存在' });
      const s = { id: row[0], name: row[1], phone: row[2]||'', dorm: row[3]||'', password_hash: row[4]||'' };
      let verified = false;
      if (phone && s.phone && phone.trim() === s.phone.trim()) verified = true;
      if (dorm && s.dorm && dorm.trim() === s.dorm.trim()) verified = true;
      if (!verified) return res.json({ code: 1, message: '验证信息不匹配' });
    } else if (phone || dorm) {
      let sql = "SELECT student_id as id, name, phone, dorm, password_hash FROM students WHERE 1=1";
      const params = [];
      if (phone) { sql += " AND phone=?"; params.push(phone.trim()); }
      if (dorm) { sql += " AND dorm=?"; params.push(dorm.trim()); }
      const result = db.exec(sql, params);
      const rows = result?.[0]?.values || [];
      if (!rows.length) return res.json({ code: 1, message: '未找到匹配的记录' });
      if (rows.length > 1) return res.json({ code: 1, message: '匹配到多条记录，请使用学号验证' });
      row = rows[0];
    } else {
      return res.json({ code: 1, message: '请输入学号，或手机号/宿舍号' });
    }

    const s = { id: row[0], name: row[1], phone: row[2]||'', dorm: row[3]||'', password_hash: row[4]||'' };
    const resetToken = 'rst_' + Date.now() + '_' + crypto.randomBytes(12).toString('hex');
    // P0修复：字段名统一为 student_id（原写 studentId、reset-password 读 entry.student_id → undefined → UPDATE 0 行假成功）
    RESET_TOKENS[resetToken] = { student_id: s.id, expiresAt: Date.now() + 10 * 60 * 1000 };
    res.json({ code: 0, resetToken, studentName: s.name, message: '身份验证通过，可以重置密码' });
  });

  router.post('/api/student/reset-password', async (req, res) => {
    const { resetToken, newPassword } = req.body;
    if (!resetToken) return res.json({ code: 1, message: '缺少重置令牌' });
    if (!newPassword || newPassword.length < 6) return res.json({ code: 1, message: '新密码至少6位' });

    const entry = RESET_TOKENS[resetToken];
    if (!entry || Date.now() > entry.expiresAt) { delete RESET_TOKENS[resetToken]; return res.json({ code: 1, message: '验证已过期，请重新验证身份' }); }

    const hash = await bcrypt.hash(newPassword, 10);
    db.run("UPDATE students SET password_hash=?, must_change_pwd=0 WHERE student_id=? OR id=?", [hash, entry.student_id, entry.student_id]);
    // P1修复：0 行匹配为假成功，须如实返回失败
    if (db.getRowsModified() === 0) { delete RESET_TOKENS[resetToken]; return res.json({ code: 1, message: '重置失败：学生不存在或已被删除' }); }
    scheduleSave();
    delete RESET_TOKENS[resetToken];
    res.json({ code: 0, message: '密码重置成功，请用新密码登录' });
  });

  router.post('/api/student/login', async (req, res) => {
    const { student_id, password } = req.body;
    if (!student_id) return res.json({ code: 1, message: '请输入学号' });
    const row = db.exec("SELECT * FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
    if (!row) return res.json({ code: 1, message: '学号不存在' });

    const fields = ['id','student_id','name','gender','class_name','dorm','phone','password_hash','must_change_pwd','face_hash'];
    const s = {};
    fields.forEach((f, i) => s[f] = row[i] !== undefined && row[i] !== null ? row[i] : '');

    // 密码验证：检测无效哈希（非 $2$ 开头的 bcrypt）并自动修复
    if (s.password_hash && !s.password_hash.startsWith('$2')) {
      // 无效哈希 → 视为未设置密码，自动用当前输入作为新密码
      if (!password) return res.json({ code: 1, message: '请设置登录密码' });
      const hash = await bcrypt.hash(password, 10);
      db.run("UPDATE students SET password_hash=?, must_change_pwd=0 WHERE student_id=? OR id=?", [hash, s.id, s.id]);
      scheduleSave();
      s.password_hash = hash;
    }

    if (s.password_hash) {
      if (!password) return res.json({ code: 1, message: '请输入密码' });
      const valid = await bcrypt.compare(password, s.password_hash);
      if (!valid) return res.json({ code: 1, message: '密码错误' });
    } else if (password) {
      const hash = await bcrypt.hash(password, 10);
      db.run("UPDATE students SET password_hash=?, must_change_pwd=0 WHERE student_id=? OR id=?", [hash, s.id, s.id]);
      scheduleSave();
    }

    const mustChangePwd = s.must_change_pwd == 1;
    const token = 'stu_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
    STUDENT_TOKENS[token] = { student_id: s.student_id, name: s.name, dorm: s.dorm, class_name: s.class_name, mustChangePwd: mustChangePwd, expiresAt: Date.now() + STUDENT_TOKEN_EXPIRY };

    if (mustChangePwd) {
      return res.json({ code: 0, token, mustChangePwd: true, hasPassword: true, student: { id: s.id, name: s.name, dorm: s.dorm, class_name: s.class_name, phone: s.phone }, message: '首次登录，请修改密码' });
    }
    res.json({ code: 0, token, mustChangePwd: false, hasPassword: !!s.password_hash, student: { id: s.id, name: s.name, dorm: s.dorm, class_name: s.class_name, phone: s.phone }, message: '登录成功' });
  });

  // 定期清理过期 Token
  setInterval(() => {
    const now = Date.now();
    Object.keys(STUDENT_TOKENS).forEach(t => { if (now > STUDENT_TOKENS[t].expiresAt) delete STUDENT_TOKENS[t]; });
    Object.keys(RESET_TOKENS).forEach(t => { if (now > RESET_TOKENS[t].expiresAt) delete RESET_TOKENS[t]; });
  }, 30 * 60 * 1000);

  // ==================== 语音签到（应急场景） ====================
  router.post('/api/voice-checkin', (req, res) => {
    // 注意：此接口接收 JSON body（含 audioBase64 字段），不使用 multer 文件上传
    // 前端通过 blobToBase64 把录音转 base64 随 JSON 一起发送，避免 multipart 兼容性问题
    const { student_id, text, date, note } = req.body || {};
    if (!student_id || !date) return res.json({ code: 1, message: '参数不完整' });

    const token = req.headers['x-student-token'];
    const entry = token && STUDENT_TOKENS[token];
    if (!entry || Date.now() > entry.expiresAt) {
      return res.status(401).json({ code: 1, message: '身份验证已过期' });
    }
    if (student_id !== entry.student_id) return res.json({ code: 1, message: '身份验证失败' });

    let audioPath = null;
    if (req.file) {
      audioPath = '/uploads/' + req.file.filename;
    } else if (req.body.audioBase64) {
      const buf = Buffer.from(req.body.audioBase64.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
      const filename = `voice_${Date.now()}.wav`;
      fs.writeFileSync(path.join(__dirname, '..', 'public', 'uploads', filename), buf);
      audioPath = '/uploads/' + filename;
    }

    const id = 'vc_' + Date.now();
    const now = localNowTimestamp();
    db.run("INSERT INTO voice_records(id, student_id, audio_path, text, timestamp, date, status, note) VALUES(?,?,?,?,?,?,?,?)",
      [id, student_id, audioPath || '', text || '', now, date, 'success', note || '']);

    // 同步写入 records 表
    db.run("INSERT INTO records(id, student_id, class_name, status, time, type, note, date) VALUES(?,?,?,?,?,?,?,?)",
      [`rc_voice_${id}`, student_id, entry.class_name || '', '在寝', now, 'voice', '语音签到', date]);

    scheduleSave();
    syncAlertsForToday();

    const studentRow = db.exec("SELECT name FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0]?.values?.[0];
    const studentName = studentRow ? studentRow[0] : student_id;

    if (typeof broadcast === 'function') {
      broadcast({ type: 'new_voice_checkin', data: { id, student_id, student_name: studentName, date, text } });
    }
    addLog('语音签到', `${studentName}(${student_id}) - ${text}`);

    res.json({ code: 0, message: '语音签到成功', id });
  });

  // ==================== GPS 围栏规则管理 ====================
  router.get('/api/geofence/rules', authMiddleware, (req, res) => {
    try {
      const rows = db.exec("SELECT id, name, latitude, longitude, radius_meters, type, active, created_at FROM geofence_rules ORDER BY id DESC")[0]?.values || [];
      const data = rows.map(r => ({
        id: r[0], name: r[1], latitude: r[2], longitude: r[3],
        radius_meters: r[4], type: r[5], active: r[6], created_at: r[7]
      }));
      res.json({ code: 0, data });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.post('/api/geofence/rules', authMiddleware, (req, res) => {
    try {
      const { name, latitude, longitude, radius_meters, type } = req.body;
      if (!name || !latitude || !longitude) return res.json({ code: 1, message: '缺少必要参数' });

      db.run("INSERT INTO geofence_rules(name, latitude, longitude, radius_meters, type, active, created_at) VALUES(?,?,?,?,?,?,?)",
        [String(name), parseFloat(latitude), parseFloat(longitude), parseFloat(radius_meters) || 200, type || 'dorm', 1, localDateStr()]);
      scheduleSave();
      res.json({ code: 0, message: '围栏规则已创建' });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.delete('/api/geofence/rules/:id', authMiddleware, (req, res) => {
    try {
      const numericId = parseInt(req.params.id);
      if (isNaN(numericId)) return res.json({ code: 1, message: 'ID 无效' });
      db.run("DELETE FROM geofence_rules WHERE id=?", [numericId]);
      scheduleSave();
      res.json({ code: 0, message: '已删除' });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // ==================== 新增：带 GPS 围栏校验的签到接口 ====================
  router.post('/api/checkin-with-geofence', upload.single('photo'), (req, res) => {
    const { student_id, date, time, status, latitude, longitude, address, note, offline, liveness_passed, liveness_score } = req.body;
    if (!student_id || !date) return res.json({ code: 1, message: '参数不完整' });

    const rules = db.exec("SELECT * FROM geofence_rules WHERE active=1")[0]?.values || [];
    if (rules.length > 0 && (latitude || longitude)) {
      const lat = parseFloat(latitude);
      const lon = parseFloat(longitude);
      
      let isInside = false;
      for (const rule of rules) {
        const rLat = parseFloat(rule[2]);
        const rLon = parseFloat(rule[3]);
        const radius = parseFloat(rule[4]) || 200;
        
        const dist = Math.sqrt(Math.pow(lat - rLat, 2) + Math.pow(lon - rLon, 2)) * 111000;
        if (dist <= radius) {
          isInside = true;
          break;
        }
      }
      
      if (!isInside) {
        addLog('围栏拦截', `学生 ${student_id} 位置异常: (${lat}, ${lon})`, 'WARN');
        if (typeof sendWebhook === 'function') {
          sendWebhook(`⚠️ 围栏告警\n学生：${student_id}\n时间：${localNowTimestamp().slice(0,19).replace('T',' ')}\n当前坐标：${lat}, ${lon}\n请核实位置信息`);
        }
        return res.json({ code: 2, message: '当前位置超出允许的围栏范围，签到被拦截', outside: true });
      }
    }

    const token = req.headers['x-student-token'];
    const entry = token && STUDENT_TOKENS[token];
    if (!entry) return res.status(401).json({ code: 1, message: '身份验证失败' });
    if (student_id !== entry.student_id) return res.json({ code: 1, message: '身份验证失败' });

    const now = date + ' ' + (time || localNowTimestamp().slice(11, 19));
    const id = 'c_gf_' + Date.now();
    const isOffline = offline === true || offline === '1';
    const livenessInt = Number(liveness_passed) === 1 ? 1 : 0;
    const livenessScoreVal = parseFloat(liveness_score) || 0;

    // [P0修复] 服务端活体分数校验
    const LIVENESS_SCORE_THRESHOLD = 0.5;
    if (livenessScoreVal > 0 && livenessScoreVal < LIVENESS_SCORE_THRESHOLD) {
      addLog('活体分数异常', `围栏签到学生 ${student_id} 活体分数过低(${livenessScoreVal.toFixed(4)})`, 'WARN');
    }

    db.run("INSERT INTO records(id, student_id, class_name, status, time, type, note, latitude, longitude, address, photo_path, offline, date, liveness_passed, liveness_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, student_id, req.body.class_name||'', status||'在寝', now, 'geofence', note||'', latitude?parseFloat(latitude):null, longitude?parseFloat(longitude):null, address||'', req.file?'/uploads/'+req.file.filename:null, isOffline ? 1 : 0, date, livenessInt, livenessScoreVal]);
    scheduleSave();
    syncAlertsForToday();

    if (typeof broadcast === 'function') {
      broadcast({ type: 'new_geofence_checkin', data: { id, student_id, date, time: now, status, latitude, longitude } });
    }
    // 围栏告警：超出允许范围时发送通知
    if (address && (status === '超出范围' || status === '越界')) {
      addLog('围栏告警', `学生 ${student_id} 位置异常: ${address}`, 'WARN');
      if (typeof sendWebhook === 'function') {
        sendWebhook(`⚠️ 围栏告警\n学生：${student_id}\n时间：${now}\n当前坐标：${latitude}, ${longitude}\n请核实位置信息`);
      }
    }
    res.json({ code: 0, message: '签到成功', id });
  });

  // P0修复：离线同步接口加双 token 鉴权（教师 JWT 或学生 token），并校验学号存在性与批次上限
  router.post('/api/offline/sync', (req, res) => {
    try {
      const adminAuth = validateToken(req.headers['x-auth-token']);
      const studentAuthEntry = STUDENT_TOKENS[req.headers['x-student-token']];
      const isStudentAuth = studentAuthEntry && Date.now() <= (studentAuthEntry.expiresAt || 0);
      if (!adminAuth && !isStudentAuth) return res.status(401).json({ code: 1, message: '身份验证失败' });

      const { actions } = req.body;
      if (!actions || !Array.isArray(actions)) return res.json({ code: 1, message: '无效的同步数据' });
      if (actions.length > 200) return res.json({ code: 1, message: '单次同步数据量过大（上限200条）' });
      // 学号必须真实存在（学生 token 场景下只能同步本人）
      const validIds = {};
      for (const a of actions) {
        if (a?.type === 'checkin' && a.data?.student_id) {
          if (isStudentAuth && a.data.student_id !== studentAuthEntry.student_id) {
            return res.json({ code: 1, message: '学生账号仅可同步本人离线记录' });
          }
          const row = db.exec("SELECT 1 FROM students WHERE student_id=? OR id=?", [a.data.student_id, a.data.student_id])[0]?.values?.[0];
          if (!row) return res.json({ code: 1, message: '学号不存在：' + a.data.student_id });
          validIds[a.data.student_id] = true;
        }
      }
      
      let synced = 0;
      for (const action of actions) {
        const { type, data } = action;
        if (type === 'checkin' && data && validIds[data.student_id]) {
          const id = 'off_' + Date.now() + '_' + synced;
          const now = localNowTimestamp();
          const date = data.date || localDateStr();
          const livenessInt = Number(data.liveness_passed) === 1 ? 1 : 0;
          const livenessScoreVal = parseFloat(data.liveness_score) || 0;
          db.run("INSERT INTO records(id, student_id, class_name, status, time, type, note, latitude, longitude, address, date, offline, liveness_passed, liveness_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [id, data.student_id||'', data.class_name||'', '在寝', now, 'checkin', data.note||'', 
             data.latitude?parseFloat(data.latitude):null, data.longitude?parseFloat(data.longitude):null, data.address||'', date, 1, livenessInt, livenessScoreVal]);
          synced++;
        }
      }
      
      if (synced > 0) {
        scheduleSave();
        syncAlertsForToday();
        addLog('离线同步', `同步了 ${synced} 条离线签到`, 'INFO');
      }
      
      res.json({ code: 0, message: '同步完成', synced });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // ==================== 课程管理 ====================
  router.post('/api/courses', authMiddleware, (req, res) => {
    const { name, date, start_time, end_time, location, class_name } = req.body;
    if (!name || !date) return res.json({ code: 1, message: '课程名和日期不能为空' });
    // 查重：同名同日期同时间同地点同班级视为重复（防止批量导入反复执行造成重复数据）
    const dup = db.exec("SELECT id FROM courses WHERE name=? AND date=? AND ifnull(start_time,'')=? AND ifnull(end_time,'')=? AND ifnull(location,'')=? AND ifnull(class_name,'')=? LIMIT 1",
      [name, date, start_time||'', end_time||'', location||'', class_name||''])[0]?.values?.[0]?.[0];
    if (dup) {
      return res.json({ code: 0, message: '已存在相同课程，已自动跳过', id: dup, duplicate: true });
    }
    const id = 'co_' + Date.now();
    db.run("INSERT INTO courses(id, name, date, start_time, end_time, location, class_name, created_at) VALUES(?,?,?,?,?,?,?,?)", [id, name, date, start_time||'', end_time||'', location||'', class_name||'', localDateStr()]);
    scheduleSave();
    // 实时通知在线学生端刷新课表（批量导入时每条都会触发，学生端有防抖）
    if (typeof global.broadcast === 'function') {
      global.broadcast({ type: 'course_updated', data: { action: 'created', id, date, class_name: class_name || '' } });
    }
    res.json({ code: 0, message: '课程签到已创建', id });
  });

  router.get('/api/courses', (req, res) => {
    ensureUser(req);
    const { date, class_name } = req.query;
    let sqlStr = "SELECT * FROM courses";
    const params = [];
    const conditions = [];
    // 辅导员/班主任班级隔离
    const sc = req.user && req.user.classScope;
    if (sc && sc.length) {
      if (class_name && !sc.includes(class_name)) {
        return res.json({ code: 1, message: '无权查看该班级数据' });
      }
      if (!class_name) {
        conditions.push(`(class_name IN (${sc.map(() => '?').join(',')}) OR class_name='')`);
        params.push(...sc);
      }
    } else if (class_name) {
      conditions.push("(class_name=? OR class_name='')");
      params.push(class_name);
    }
    if (date) { conditions.push("date=?"); params.push(date); }
    if (conditions.length) sqlStr += " WHERE " + conditions.join(" AND ");
    sqlStr += " ORDER BY date DESC, start_time ASC";
    const rows = db.exec(sqlStr, params)[0]?.values || [];
    res.json({ code: 0, data: rows.map(r => ({ id: r[0], name: r[1], date: r[2], start_time: r[3], end_time: r[4], location: r[5], class_name: r[6]||'', created_at: r[7] })) });
  });

  router.get('/api/courses/with-checkin', (req, res) => {
    ensureUser(req);
    try {
      const { date, class_name } = req.query;
      // date=all 表示查询全部日期的课程（教师端"显示全部"勾选），否则按指定日期（默认今天）
      const isAll = date === 'all';
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const bj = new Date(utc + 8 * 3600 * 1000);
      const targetDate = isAll ? null : (date || `${bj.getFullYear()}-${String(bj.getMonth()+1).padStart(2,'0')}-${String(bj.getDate()).padStart(2,'0')}`);

      // 辅导员/班主任班级隔离
      const sc = req.user && req.user.classScope;
      const conds = [];
      const params = [];
      if (!isAll) { conds.push("date=?"); params.push(targetDate); }
      if (sc && sc.length) {
        if (class_name && !sc.includes(class_name)) {
          return res.json({ code: 1, message: '无权查看该班级数据' });
        }
        if (!class_name) {
          conds.push("(class_name IN (" + sc.map(() => '?').join(',') + ") OR class_name='')");
          params.push(...sc);
        }
      } else if (class_name) {
        conds.push("(class_name=? OR class_name='')");
        params.push(class_name);
      }
      let sql = "SELECT * FROM courses" + (conds.length ? " WHERE " + conds.join(" AND ") : "");
      sql += isAll ? " ORDER BY date DESC, start_time ASC" : " ORDER BY start_time ASC";
      const courses = db.exec(sql, params)[0]?.values || [];

      // 统计每个课程的签到数（使用 date 列，避免 time 格式不一致导致漏算；all 模式聚合全部日期）
      const data = courses.map(c => {
        const cntSql = isAll
          ? "SELECT COUNT(DISTINCT student_id) FROM records WHERE course_id=? AND type='class'"
          : "SELECT COUNT(DISTINCT student_id) FROM records WHERE course_id=? AND type='class' AND date=?";
        const cntParams = isAll ? [c[0]] : [c[0], targetDate];
        const checked = db.exec(cntSql, cntParams)[0]?.values?.[0]?.[0] || 0;
        return {
          id: c[0], name: c[1], date: c[2], start_time: c[3], end_time: c[4],
          location: c[5], class_name: c[6]||'',
          checked_in: checked, present: checked
        };
      });
      res.json({ code: 0, data });
    } catch (e) { res.json({ code: 1, message: e.message }); }
  });

  // 解析课表/学生导入文件为 CSV 文本（彻底替代"完整Excel解析功能开发中"的假提示）
  // 支持 .csv / .txt / .xlsx / .xls：csv/txt 直接读文本；Excel 用 exceljs 取第一个工作表
  // 逐行转成"逗号分隔"文本返回。该文本即前端既有 parseCourseText / parseStudentText
  // 能直接消化的格式，零改动复用现有导入链路。挂 upload.single('file') 走 multer 存临时盘。
  // 专用 multer 实例：注入的 upload 的 fileFilter 只放行图片（jpeg/png/webp），
  // 表格文件会被它拒掉并抛错返回 HTML 错误页，故这里单独定义，接受 csv/txt/xlsx/xls。
  // 文件存系统临时目录（req.file.path），解析完即删，不进上传目录。
  const fileUpload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (/\.(csv|txt|xlsx|xls)$/i.test(file.originalname || '')) return cb(null, true);
      cb(new Error('仅支持 CSV/TXT/XLSX/XLS 文件'));
    }
  });
  router.post('/api/import/parse-file', authMiddleware, fileUpload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ code: 1, message: '未收到上传文件' });
      const fname = String(req.file.originalname || '');
      const lower = fname.toLowerCase();
      const cleanup = () => { try { if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {}); } catch (_) {} };
      if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
        fs.readFile(req.file.path, 'utf-8', (err, raw) => {
          if (err) return cleanup() || res.json({ code: 1, message: '读取文件失败：' + err.message });
          const lines = raw.replace(/^\ufeff/, '').split(/\r?\n/).map(s => s.trim()).filter(s => s);
          cleanup();
          res.json({ code: 0, text: lines.join('\n'), count: lines.length, filename: fname });
        });
        return;
      }
      // .xlsx / .xls：exceljs 解析第一个 sheet
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      workbook.xlsx.readFile(req.file.path).then(() => {
        const ws = workbook.getWorksheet(1) || workbook.worksheets[0];
        if (!ws) { cleanup(); return res.json({ code: 1, message: 'Excel 中没有可用的工作表' }); }
        const out = [];
        ws.eachRow((row) => {
          let line = '';
          row.eachCell({ includeEmpty: true }, (cell) => {
            let v = cell.value;
            if (v && typeof v === 'object') {
              if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join('');
              else if (v.text != null) v = v.text;
              else if (v.result != null) v = v.result;
              else v = String(v);
            }
            line += (line ? ',' : '') + (v == null ? '' : String(v));
          });
          if (line.trim()) out.push(line.replace(/\s+$/g, ''));
        });
        cleanup();
        res.json({ code: 0, text: out.join('\n'), count: out.length, filename: fname });
      }).catch(e => { cleanup(); res.json({ code: 1, message: 'Excel 解析失败：' + e.message }); });
    } catch (e) {
      res.json({ code: 1, message: '文件解析失败：' + e.message });
    }
  });

  router.delete('/api/courses/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM courses WHERE id=?", [id]);
    // P1修复：0 行匹配为假成功，须如实返回未找到
    if (db.getRowsModified() === 0) return res.json({ code: 1, message: '未找到该课程，可能已被删除' });
    scheduleSave();
    // 实时通知在线学生端刷新课表（删除课程后无需手动刷新页面）
    if (typeof global.broadcast === 'function') {
      global.broadcast({ type: 'course_updated', data: { action: 'deleted', id } });
    }
    res.json({ code: 0, message: '已删除' });
  });

  return router;
}

module.exports = { init };
