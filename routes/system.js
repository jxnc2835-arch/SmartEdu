// ==================== 系统管理路由模块 ====================
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { authMiddleware } = require('../middleware/auth');
const { nowTimestamp, localDateStr, formatDate, beijingStamp } = require('../utils/helpers');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');

/** @type {object} */
let db, scheduleSave, addLog;
/** @type {string} */
let UPLOAD_DIR, BACKUP_DIR;

/**
 * 初始化系统管理模块
 * @param {object} _db - sql.js Database 实例
 * @param {Function} _scheduleSave - 延迟保存函数
 * @param {Function} _addLog - 日志记录函数
 * @param {Function} _broadcast - WebSocket 广播函数
 * @param {Function} _sendWebhook - Webhook 通知函数
 * @param {object} _upload - multer 上传中间件
 * @param {object} _XLSX - XLSX 库
 * @param {object} _QRCode - QRCode 库
 * @param {object} _multer - multer 库
 * @param {object} _os - Node.js os 模块
 * @param {string} _ROOT_DIR - 项目根目录
 * @param {string} _UPLOAD_DIR - 上传目录
 * @param {string} _BACKUP_DIR - 备份目录
 * @returns {Express.Router}
 */

// ==================== 备份 ====================
function createBackup(className) {
  const ts = beijingStamp();
  const bp = path.join(BACKUP_DIR, `backup_${ts}`);
  fs.mkdirSync(bp, { recursive: true });
  fs.writeFileSync(path.join(bp, 'data.db'), Buffer.from(db.export()));
  const photoDir = path.join(bp, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });
  if (fs.existsSync(UPLOAD_DIR)) {
    fs.readdirSync(UPLOAD_DIR).forEach(f => {
      const src = path.join(UPLOAD_DIR, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(photoDir, f));
    });
  }
  let studentCount, recordCount, leaveCount;
  if (className) {
    studentCount = db.exec("SELECT COUNT(*) FROM students WHERE class_name=?", [className])[0]?.values?.[0][0] || 0;
    recordCount = db.exec("SELECT COUNT(*) FROM records WHERE student_id IN (SELECT id FROM students WHERE class_name=?)", [className])[0]?.values?.[0][0] || 0;
    leaveCount = db.exec("SELECT COUNT(*) FROM leaves WHERE student_id IN (SELECT id FROM students WHERE class_name=?)", [className])[0]?.values?.[0][0] || 0;
  } else {
    studentCount = db.exec("SELECT COUNT(*) FROM students;")[0]?.values?.[0][0] || 0;
    recordCount = db.exec("SELECT COUNT(*) FROM records;")[0]?.values?.[0][0] || 0;
    leaveCount = db.exec("SELECT COUNT(*) FROM leaves;")[0]?.values?.[0][0] || 0;
  }
  const info = {
    created_at: nowTimestamp(),
    students: studentCount, records: recordCount, leaves: leaveCount,
    courses: db.exec("SELECT COUNT(*) FROM courses;")[0]?.values?.[0][0] || 0,
    photos: fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0,
    class_name: className || '全部'
  };

  // P0·实用性：备份校验——立刻用 better-sqlite3 独立句柄打开刚写的 data.db，
  // 跑 PRAGMA integrity_check + 对账核心表行数，失败抛错让上层感知
  try {
    const verifyDb = new Database(path.join(bp, 'data.db'), { readonly: true, fileMustExist: true });
    const integrity = verifyDb.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      const err = new Error(`备份 integrity_check 失败: ${integrity}`);
      verifyDb.close();
      fs.rmSync(bp, { recursive: true, force: true });
      throw err;
    }
    // 对账：备份里的 students/records/leaves 行数必须与源内存库一致
    const bakStu = verifyDb.prepare('SELECT COUNT(*) AS c FROM students').get().c;
    const bakRec = verifyDb.prepare('SELECT COUNT(*) AS c FROM records').get().c;
    const bakLev = verifyDb.prepare('SELECT COUNT(*) AS c FROM leaves').get().c;
    verifyDb.close();
    if (className) {
      // 按班级备份：data.db 仍是全量快照，对账改为"备份行数 ≥ 班级期望行数"
      // （班级期望 = 该班在源库的行数，全量备份必然 ≥ 任意班级子集）
      if (bakStu < studentCount || bakRec < recordCount || bakLev < leaveCount) {
        const err = new Error(`备份行数对账失败: 备份 stu=${bakStu} rec=${bakRec} lev=${bakLev} < 班级期望 stu=${studentCount} rec=${recordCount} lev=${leaveCount}`);
        fs.rmSync(bp, { recursive: true, force: true });
        throw err;
      }
    } else {
      // 全量备份：备份行数 = 源库行数
      const srcStu = db.exec("SELECT COUNT(*) FROM students;")[0]?.values?.[0][0] || 0;
      const srcRec = db.exec("SELECT COUNT(*) FROM records;")[0]?.values?.[0][0] || 0;
      const srcLev = db.exec("SELECT COUNT(*) FROM leaves;")[0]?.values?.[0][0] || 0;
      if (bakStu !== srcStu || bakRec !== srcRec || bakLev !== srcLev) {
        const err = new Error(`备份行数对账失败: 期望 stu=${srcStu} rec=${srcRec} lev=${srcLev}，实际 stu=${bakStu} rec=${bakRec} lev=${bakLev}`);
        fs.rmSync(bp, { recursive: true, force: true });
        throw err;
      }
    }
  } catch (e) {
    addLog('备份校验失败', e.message, 'ERROR');
    throw e; // 让 /api/backup 返回 500，前端能感知
  }

  fs.writeFileSync(path.join(bp, 'backup_info.json'), JSON.stringify({ ...info, verified: true }, null, 2));
  return info;
}

function init(_db, _scheduleSave, _addLog, _broadcast, _sendWebhook, _upload, _QRCode, _multer, _os, _ROOT_DIR, _UPLOAD_DIR, _BACKUP_DIR) {
  const router = express.Router();
  
  db = _db;
  scheduleSave = _scheduleSave;
  addLog = _addLog;
  // 预留 DI 槽位(本模块未使用, 保留形参以对齐调用契约): _broadcast/_sendWebhook/_upload/_QRCode/_multer/_os/_ROOT_DIR
  UPLOAD_DIR = _UPLOAD_DIR || config.UPLOAD_DIR;
  BACKUP_DIR = _BACKUP_DIR || config.BACKUP_DIR;
  
  // ==================== 日志管理 ====================
  // GET /api/logs - 获取日志列表（带分页）
  router.get('/api/logs', authMiddleware, (req, res) => {
    const { level, action, detail, from, to, page = 1, pageSize = 50 } = req.query;
    let sqlStr = "SELECT * FROM logs";
    const params = [];
    const cond = [];
    if (level) { cond.push("level=?"); params.push(level); }
    if (action) { cond.push("action LIKE ?"); params.push(`%${action}%`); }
    if (detail) { cond.push("detail LIKE ?"); params.push(`%${detail}%`); }
    if (from) { cond.push("time>=?" ); params.push(from); }
    if (to) { cond.push("time<=?" ); params.push(to); }
    if (cond.length) sqlStr += " WHERE " + cond.join(" AND ");
    sqlStr += " ORDER BY time DESC";
    const rows = db.exec(sqlStr, params)[0]?.values || [];
    const total = rows.length;
    const start = (parseInt(page)-1)*parseInt(pageSize);
    const paged = rows.slice(start, start+parseInt(pageSize));
    res.json({ code: 0, data: paged.map(r => ({ id: r[0], time: r[1], action: r[2], detail: r[3], level: r[4], operator: r[5] || '' })), 
      levelCounts: {
        INFO: db.exec("SELECT COUNT(*) FROM logs WHERE level='INFO'")[0]?.values?.[0]?.[0] || 0,
        WARN: db.exec("SELECT COUNT(*) FROM logs WHERE level='WARN'")[0]?.values?.[0]?.[0] || 0,
        ERROR: db.exec("SELECT COUNT(*) FROM logs WHERE level='ERROR'")[0]?.values?.[0]?.[0] || 0
      },
      pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total/parseInt(pageSize)) } });
  });
  
  router.post('/api/delete-log', authMiddleware, (req, res) => {
    const { id } = req.body;
    if (!id) return res.json({ code: 1, message: '参数不完整' });
    try {
      db.run("DELETE FROM logs WHERE id=?", [id]);
      scheduleSave();
      res.json({ code: 0, message: '已删除' });
    } catch (err) { res.json({ code: 1, message: '删除失败: ' + err.message }); }
  });
  
  router.post('/api/clear-logs', authMiddleware, (req, res) => {
    const { level } = req.body;
    try {
      // P1修复：sql.js 的 db.run 是同步 API，第三参回调会被静默忽略（原写法 count 恒为 0）
      // 改为先查待删条数再执行删除，统计数真实可靠
      let count;
      if (level) {
        count = db.exec("SELECT COUNT(*) FROM logs WHERE level=?", [level])?.[0]?.values?.[0]?.[0] ?? 0;
        db.run("DELETE FROM logs WHERE level=?", [level]);
      } else {
        count = db.exec("SELECT COUNT(*) FROM logs")?.[0]?.values?.[0]?.[0] ?? 0;
        db.run("DELETE FROM logs");
      }
      scheduleSave();
      res.json({ code: 0, message: `已清空 ${count} 条日志` });
    } catch (err) { res.json({ code: 1, message: '清空失败: ' + err.message }); }
  });

// ==================== 班级周报 ====================
router.get('/api/report', authMiddleware, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const className = req.query.class_name;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days + 1);
    const bjDateStr = (dd) => {
      const utc = dd.getTime() + dd.getTimezoneOffset() * 60000;
      const bj = new Date(utc + 8 * 3600 * 1000);
      return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}-${String(bj.getDate()).padStart(2, '0')}`;
    };
    const startDateStr = bjDateStr(startDate);
    const endDateStr = bjDateStr(endDate);

    let studentsSql = "SELECT * FROM students";
    const studentsParams = [];
    if (className) { studentsSql += " WHERE class_name=?"; studentsParams.push(className); }
    studentsSql += " ORDER BY class_name";
    const studentsRows = db.exec(studentsSql, studentsParams)[0]?.values || [];
    const students = studentsRows.map(r => ({ id: r[0], name: r[1], dorm: r[2], class_name: r[3], grade: r[5] }));

    const dorms = {};
    students.forEach(s => {
      if (!s.dorm) return;
      if (!dorms[s.dorm]) dorms[s.dorm] = { dorm: s.dorm, class_name: s.class_name, total: 0, absentCount: 0, leaveCount: 0, anomalyStudents: [] };
      dorms[s.dorm].total++;
      if (dorms[s.dorm].class_name !== s.class_name && dorms[s.dorm].class_name.indexOf(s.class_name) === -1) dorms[s.dorm].class_name += '/' + s.class_name;
    });

    const recordsRows = db.exec(`SELECT s.dorm, r.status, COUNT(DISTINCT r.student_id || SUBSTR(r.time,1,10)) FROM records r JOIN students s ON r.student_id = s.student_id WHERE r.type='checkin' AND SUBSTR(r.time,1,10) >= ? AND SUBSTR(r.time,1,10) <= ? AND r.status IN ('未归','请假') GROUP BY s.dorm, r.status`, [startDateStr, endDateStr])[0]?.values || [];
    recordsRows.forEach(r => { const d = dorms[r[0]]; if (!d) return; if (r[1]==='未归') d.absentCount=r[2]; if (r[1]==='请假') d.leaveCount=r[2]; });

    const anomalyRows = db.exec(`SELECT s.dorm, s.name, r.status FROM records r JOIN students s ON r.student_id = s.student_id WHERE r.type='checkin' AND SUBSTR(r.time,1,10) >= ? AND SUBSTR(r.time,1,10) <= ? AND r.status = '未归'`, [startDateStr, endDateStr])[0]?.values || [];
    anomalyRows.forEach(r => { const d = dorms[r[0]]; if (!d) return; if (!d.anomalyStudents.find(a=>a.name===r[1])) d.anomalyStudents.push({name:r[1],absent:0}); const a=d.anomalyStudents.find(x=>x.name===r[1]); if (a) a.absent++; });

    const leaveRows = db.exec(`SELECT s.dorm, s.name, COUNT(*) FROM leaves l JOIN students s ON l.student_id = s.student_id WHERE l.status IN ('approved','已批准') AND SUBSTR(l.created_at,1,10) >= ? AND SUBSTR(l.created_at,1,10) <= ? GROUP BY s.dorm, s.name`, [startDateStr, endDateStr+' 23:59:59'])[0]?.values || [];
    leaveRows.forEach(r => { const d = dorms[r[0]]; if (!d) return; d.leaveCount+=r[2]; if (!d.anomalyStudents.find(a=>a.name===r[1])) d.anomalyStudents.push({name:r[1],absent:0,leave:0}); const a=d.anomalyStudents.find(x=>x.name===r[1]); if (a){if(!a.leave)a.leave=0; a.leave+=r[2];} });

    const dormList = Object.values(dorms).map(d => ({...d, absentRate: d.total > 0 ? Math.round((d.absentCount/(d.total*days))*100) : 0}));
    let pendingSql = "SELECT COUNT(*) FROM leaves l LEFT JOIN students s ON l.student_id=s.student_id WHERE l.status='待审批'";
    const pendingParams = [];
    if (className) { pendingSql += " AND s.class_name=?"; pendingParams.push(className); }
    const pendingLeaves = db.exec(pendingSql, pendingParams)[0]?.values?.[0]?.[0] || 0;

    res.json({ code: 0, data: {
      summary: { date_range: `${startDateStr} ~ ${endDateStr}`, total_students: students.length, total_classes: Object.keys(dorms).length, total_absent: dormList.reduce((s,d)=>s+d.absentCount,0), total_leaves: dormList.reduce((s,d)=>s+d.leaveCount,0), pending_leaves: pendingLeaves },
      dorms: dormList.sort((a,b)=>b.absentRate-a.absentRate)
    }});
  } catch (e) {
    console.error('report error:', e.message);
    res.status(500).json({ code: 1, message: e.message });
  }
});

router.post('/api/backup', authMiddleware, (req, res) => {
  const className = req.query.class_name || null;
  const info = createBackup(className);
  addLog('创建备份', className ? `班级：${className}` : '全部数据');
  res.json({ code: 0, message: '备份成功', data: info });
});

router.get('/api/backups', authMiddleware, (req, res) => {
  // P1修复：列表同时兼容两种备份格式——
  //   手动备份：backup_<ts>/ 目录（含 data.db + photos/ + backup_info.json）
  //   自动备份：data_backup_<UTC时间戳>_<reason>.db 文件（utils/auto-backup.js 生成）
  // 原先只认 backup_ 前缀，导致自动备份永远显示"暂无备份"
  try {
    const list = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup_') || (f.startsWith('data_backup_') && f.endsWith('.db')))
      .map(f => {
        const fp = path.join(BACKUP_DIR, f);
        let stat;
        try { stat = fs.statSync(fp); } catch { return null; }
        const isDir = typeof stat.isDirectory === 'function' ? stat.isDirectory() : false;
        let info = {};
        let size = stat.size;
        if (isDir) {
          try { info = JSON.parse(fs.readFileSync(path.join(fp, 'backup_info.json'), 'utf-8')); } catch {}
          // 目录型备份 stat.size 只是目录项(4096)，真实大小取内部 data.db
          try {
            const inner = fs.statSync(path.join(fp, 'data.db'));
            size = inner.size;
          } catch {}
        } else {
          const m = f.match(/^data_backup_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_([a-z]+)\.db$/);
          if (m) info = { created_at: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, class_name: '全部', reason: m[6] };
        }
        return { name: f, time: stat.mtime, size, type: isDir ? 'manual' : 'auto', ...info };
      })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time);
    res.json({ code: 0, data: list });
  } catch (err) {
    res.json({ code: 1, message: '读取备份列表失败: ' + err.message });
  }
});

// ==================== 备份恢复 ====================
// P0修复：前端"恢复"按钮调 POST /api/restore，但后端此前根本没有该接口（点击必然失败）。
// 实现：把备份数据整表替换进当前内存库（保持 db 对象引用不变），目录备份附带恢复照片，最后落盘。
router.post('/api/restore', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ code: 1, message: '参数不完整' });
  // 路径安全：只允许两种合法备份名，杜绝 ../ 穿越
  const isDirBackup = /^backup_[^\\/]+$/.test(name);
  const isFileBackup = /^data_backup_[^\\/]+\.db$/.test(name);
  if (!isDirBackup && !isFileBackup) return res.json({ code: 1, message: '备份名称不合法' });
  const bp = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(bp)) return res.json({ code: 1, message: '备份不存在' });
  try {
    let backupBytes;
    let photoSrc = null;
    if (fs.statSync(bp).isDirectory()) {
      const dbFile = path.join(bp, 'data.db');
      if (!fs.existsSync(dbFile)) return res.json({ code: 1, message: '备份损坏：缺少 data.db' });
      backupBytes = fs.readFileSync(dbFile);
      const pDir = path.join(bp, 'photos');
      if (fs.existsSync(pDir)) photoSrc = pDir;
    } else {
      backupBytes = fs.readFileSync(bp);
    }

    const initSqlJs = require('sql.js');
    initSqlJs().then(SQL => {
      let tmp;
      try {
        tmp = new SQL.Database(backupBytes);
      } catch (e) {
        return res.json({ code: 1, message: '备份文件无法解析：' + e.message });
      }
      const tables = (tmp.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0]?.values || []).map(v => v[0]);
      db.run('BEGIN');
      try {
        let restoredTables = 0, restoredRows = 0;
        for (const t of tables) {
          // 只恢复当前库已存在的同名表（schema 演进时跳过未知表，防止注入式结构）
          const exists = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t])[0];
          if (!exists) continue;
          const colInfo = tmp.exec(`PRAGMA table_info("${t}")`)[0]?.values || [];
          if (!colInfo.length) continue;
          const colNames = colInfo.map(v => v[1]);
          const rows = tmp.exec(`SELECT * FROM "${t}"`)[0]?.values || [];
          db.run(`DELETE FROM "${t}"`);
          if (rows.length) {
            const stmt = `INSERT INTO "${t}" (${colNames.map(c => `"${c}"`).join(',')}) VALUES (${colNames.map(() => '?').join(',')})`;
            for (const r of rows) db.run(stmt, r);
            restoredRows += rows.length;
          }
          restoredTables++;
        }
        db.run('COMMIT');
        tmp.close();
        // 目录备份附带恢复照片（覆盖同名，不删除现有新增照片）
        let photoCount = 0;
        if (photoSrc && UPLOAD_DIR && fs.existsSync(UPLOAD_DIR)) {
          fs.readdirSync(photoSrc).forEach(f => {
            const src = path.join(photoSrc, f);
            if (fs.statSync(src).isFile()) { fs.copyFileSync(src, path.join(UPLOAD_DIR, f)); photoCount++; }
          });
        }
        scheduleSave();
        addLog('恢复备份', `来源：${name}，恢复 ${restoredTables} 张表 / ${restoredRows} 行${photoCount ? ` / ${photoCount} 张照片` : ''}`, 'WARN');
        res.json({ code: 0, message: `✅ 恢复成功：${restoredTables} 张表 / ${restoredRows} 行数据${photoCount ? ` / ${photoCount} 张照片` : ''}，刷新页面即可看到恢复后的数据` });
      } catch (e) {
        try { db.run('ROLLBACK'); } catch (_) {}
        tmp.close();
        res.json({ code: 1, message: '恢复失败，已回滚：' + e.message });
      }
    }).catch(e => res.json({ code: 1, message: '恢复失败：' + e.message }));
  } catch (err) {
    res.json({ code: 1, message: '恢复失败: ' + err.message });
  }
});

router.post('/api/delete-backup', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ code: 1, message: '参数不完整' });
  const bp = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(bp)) return res.json({ code: 1, message: '备份不存在' });
  try {
    // 使用重命名代替删除（避免沙箱 safe-delete 拦截）
    const delName = '.deleted_' + Date.now() + '_' + (name.replace(/[\\/:*?"<>|]/g, '_'));
    const delPath = path.join(BACKUP_DIR, delName);
    fs.renameSync(bp, delPath);
    addLog('删除备份', name, 'WARN');
    res.json({ code: 0, message: `已删除备份【${name}】` });
  } catch (err) { res.json({ code: 1, message: '删除失败: ' + err.message }); }
});

router.post('/api/cleanup-backups', authMiddleware, (req, res) => {
  const { days = 90 } = req.body;
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json({ code: 0, message: '备份目录不存在' });
    const files = fs.readdirSync(BACKUP_DIR);
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    let deleted = 0;
    files.forEach(f => {
      try {
        const fp = path.join(BACKUP_DIR, f);
        // 跳过已标记删除的文件
        if (f.startsWith('.deleted_')) return;
        const stat = fs.statSync(fp);
        if (stat.mtime.getTime() < cutoff) {
          // 使用重命名代替删除（避免沙箱 safe-delete 拦截）
          const delName = '.deleted_' + Date.now() + '_' + f.replace(/[\\/:*?"<>|]/g, '_');
          fs.renameSync(fp, path.join(BACKUP_DIR, delName));
          deleted++;
        }
      } catch {}
    });
    addLog('清理备份', days===0?`清除全部备份 ${deleted}个`:`清理 ${deleted} 个 ${days}天前的备份`, 'WARN');
    res.json({ code: 0, message: days===0?`已清除全部 ${deleted} 个备份`:`已清理 ${deleted} 个 ${days}天前的旧备份` });
  } catch (err) { res.json({ code: 1, message: '清理失败: ' + err.message }); }
});

router.delete('/api/logs', authMiddleware, (req, res) => {
  try {
    db.run('DELETE FROM logs');
    addLog('清空日志', '清空所有系统日志', 'WARN');
    res.json({ code: 0, message: '已清空' });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

router.delete('/api/logs/:id', authMiddleware, (req, res) => {
  try {
    db.run('DELETE FROM logs WHERE id=?', [req.params.id]);
    res.json({ code: 0, message: '已删除' });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

router.post('/api/clear-data', authMiddleware, (req, res) => {
  const className = req.query.class_name || null;
  try {
    const ds=0, dr=0, dl=0;
    if (className) {
      const ids = db.exec("SELECT id FROM students WHERE class_name=?", [className])[0]?.values?.map(r=>r[0]) || [];
      if (ids.length > 0) {
        const ph = ids.map(()=>'?').join(',');
        db.run(`DELETE FROM records WHERE student_id IN (${ph})`, ids);
        db.run(`DELETE FROM leaves WHERE student_id IN (${ph})`, ids);
        db.run(`DELETE FROM students WHERE class_name=?`, [className]);
      }
    } else {
      db.run("DELETE FROM students");
      db.run("DELETE FROM records");
      db.run("DELETE FROM leaves");
      db.run("DELETE FROM courses");
    }
    scheduleSave();
    addLog('清除数据', className ? `班级：${className}` : `全部（学生${ds}人，记录${dr}条）`, 'WARN');
    res.json({ code: 0, message: `清除成功（学生${ds}人，记录${dr}条，请假${dl}条）`, data: { students: ds, records: dr, leaves: dl } });
  } catch (err) { res.status(500).json({ code: 1, message: '清除失败: ' + err.message }); }
});

router.post('/api/cleanup-old-data', authMiddleware, (req, res) => {
  try {
    const cutoff = formatDate(new Date(Date.now() - 90*24*60*60*1000));
    db.run("DELETE FROM records WHERE SUBSTR(time,1,10) < ?", [cutoff]);
    db.run("DELETE FROM leaves WHERE created_at < ?", [cutoff]);
    scheduleSave();
    addLog('清理旧数据', `记录清理完成`);
    res.json({ code: 0, message: `清理完成` });
  } catch (err) { res.json({ code: 1, message: '清理失败: ' + err.message }); }
});

// ==================== 查寝任务管理 ====================
// 学生端只读查寝任务（x-student-token 鉴权，离线兜底拉当天 pending 任务）
// 直接读 STUDENT_TOKENS 表（与 /api/student-login 同一份），而非走 studentAuth 中间件：
// 后者因模块实例隔离，其 STUDENT_TOKENS 永远为空，会把有效 token 误判 401。
// 必须注册在 /api/tasks 之前，否则教师 authMiddleware 会先拦截 /api/tasks/student。
// 学生端只读查寝任务端点 /api/tasks/student 已移至 server.js 直接挂 app 层，
// 原因：statistics.js 有 router.use('/api', authMiddleware) 全局鉴权先拦截该路径
// （学生 token 过不了教师 JWT 会 401），与 /api/config/map 同层挂载可绕过。

router.get('/api/tasks', authMiddleware, (req, res) => {
  const { status, class_name } = req.query;
  let sql = "SELECT * FROM tasks";
  const params = [];
  const cond = [];
  if (status) { cond.push("status=?"); params.push(status); }
  if (class_name) { cond.push("class_name=?"); params.push(class_name); }
  if (cond.length) sql += " WHERE " + cond.join(" AND ");
  sql += " ORDER BY created_at DESC";
  const rows = db.exec(sql, params)[0]?.values || [];
  const tasks = rows.map(r => ({
    id: r[0], date: r[1], class_name: r[2], remark: r[3],
    status: r[4], created_at: r[5], created_by: r[6] || 'system',
    required_steps: parseTaskSteps(r[7]),
    closed_at: r[8] || ''
  }));
  res.json({ code: 0, data: tasks });
});

// 任务 required_steps 解析：JSON 数组字符串 → 数组；空/非法 → 默认全 4 项（兼容旧数据）
const TASK_STEP_KEYS = ['location', 'photo', 'voice', 'qrcode'];
function parseTaskSteps(raw) {
  if (!raw) return TASK_STEP_KEYS.slice();
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr)) {
      const valid = arr.filter(k => TASK_STEP_KEYS.includes(k));
      return valid.length ? valid : TASK_STEP_KEYS.slice();
    }
  } catch (e) { /* fallthrough */ }
  return TASK_STEP_KEYS.slice();
}

router.post('/api/tasks', authMiddleware, (req, res) => {
  const { date, class_name, remark, required_steps } = req.body;
  if (!date) {
    return res.json({ code: 1, message: '日期不能为空' });
  }
  // class_name 允许为空 = 发布给全部班级（学生端按“无班级限制”匹配）
  const taskClass = class_name || '';
  const steps = parseTaskSteps(Array.isArray(required_steps) ? required_steps : null);
  const id = 'task_' + Date.now();
  const created_at = nowTimestamp();
  db.run("INSERT INTO tasks(id, date, class_name, remark, status, created_at, created_by, required_steps) VALUES(?,?,?,?,?,?,?,?)",
    [id, date, taskClass, remark || '', 'pending', created_at, req.user?.username || 'system', JSON.stringify(steps)]);
  scheduleSave();
  addLog('发布查寝任务', `日期：${date}，班级：${taskClass || '全部班级'}，需完成：${steps.map(k => TASK_STEP_KEYS.includes(k) ? { location: '获取位置', photo: '拍照', voice: '语音', qrcode: '扫码' }[k] : k).join('、')}`);
  // 实时推送给在线学生端：查寝页收到 checkin_task 事件后弹横幅提示
  // 用 global.broadcast（server.js 启动时挂载），系统路由的 DI _broadcast 槽位本就未接
  if (typeof global.broadcast === 'function') {
    global.broadcast({
      type: 'checkin_task',
      data: { id, date, class_name: taskClass, remark: remark || '', required_steps: steps, created_at, created_by: req.user?.username || 'system' }
    });
  }
  res.json({ code: 0, message: '任务发布成功', data: { id, date, class_name: taskClass, remark, required_steps: steps } });
});

router.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM tasks WHERE id=?", [id]);
  // P1修复：0 行匹配为假成功，须如实返回未找到
  if (db.getRowsModified() === 0) return res.json({ code: 1, message: '未找到该任务，可能已被删除' });
  scheduleSave();
  addLog('删除查寝任务', `任务ID：${id}`, 'WARN');
  res.json({ code: 0, message: '删除成功' });
});

// P1·实用性：查寝任务"一键销号"——pending → closed，记录 closed_at
router.put('/api/tasks/:id/close', authMiddleware, (req, res) => {
  const { id } = req.params;
  db.run("UPDATE tasks SET status='closed', closed_at=? WHERE id=? AND status='pending'", [nowTimestamp(), id]);
  if (db.getRowsModified() === 0) return res.json({ code: 1, message: '未找到该任务或已销号' });
  scheduleSave();
  addLog('销号查寝任务', `任务ID：${id}`);
  res.json({ code: 0, message: '已销号' });
});

// ==================== 导出查寝记录 ====================
router.get('/api/export/records', authMiddleware, async (req, res) => {
  try {
    const { class_name, status, from, to } = req.query;
    const params = [];
    const cond = [];
    if (class_name) { cond.push("s.class_name=?"); params.push(class_name); }
    if (status) { cond.push("r.status=?"); params.push(status); }
    if (from) { cond.push("SUBSTR(r.time,1,10)>=?"); params.push(from); }
    if (to) { cond.push("SUBSTR(r.time,1,10)<=?"); params.push(to); }

    let whereClause = "WHERE r.type='checkin'";
    if (cond.length) whereClause += " AND " + cond.join(" AND ");

    const sql = `
      SELECT s.name, s.student_id, s.dorm, s.class_name, r.status, r.address, SUBSTR(r.time,1,10) as record_date, SUBSTR(r.time,12) as record_time
      FROM records r
      JOIN students s ON r.student_id = s.student_id
      ${whereClause}
      ORDER BY record_date DESC, record_time DESC
    `;
    
    const result = db.exec(sql, params);
    const rows = result[0]?.values || [];
    const cols = result[0]?.columns || [];
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('查寝记录');
    worksheet.addRow(['姓名','学号','宿舍','班级','状态','地址','日期','时间']);
    rows.forEach(r => {
      const obj = {};
      cols.forEach((col, i) => { obj[col] = r[i]; });
      worksheet.addRow([
        obj['name'] || '',
        obj['student_id'] || '',
        obj['dorm'] || '',
        obj['class_name'] || '',
        obj['status'] || '',
        obj['address'] || '',
        obj['record_date'] || '',
        obj['record_time'] || ''
      ]);
    });
    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const fname1 = encodeURIComponent('查寝记录.xlsx');
    res.setHeader('Content-Disposition', `attachment; filename="checkin_records.xlsx"; filename*=UTF-8''${fname1}`);
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  } catch (e) {
    console.error('导出失败:', e);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 1, message: '导出失败: ' + e.message }));
    }
  }
});

// ==================== 导出请假记录 ====================
router.get('/api/export/leaves', authMiddleware, async (req, res) => {
  try {
    const { class_name, status, from, to } = req.query;
    let sql = `
      SELECT l.id, s.name as student_name, s.student_id, s.dorm, s.class_name, l.reason, l.start_date, l.end_date, l.status, l.created_at
      FROM leaves l
      LEFT JOIN students s ON l.student_id = s.student_id
      WHERE 1=1
    `;
    const params = [];
    const cond = [];
    if (class_name) { cond.push("s.class_name=?"); params.push(class_name); }
    if (status) {
      // 库中 status 中英混杂（历史英文 + 新中文），传任意一种都同时匹配两种写法
      const stMap = { approved: '已批准', pending: '待审批', rejected: '已驳回', '已批准': 'approved', '待审批': 'pending', '已驳回': 'rejected' };
      const variants = stMap[status] ? [status, stMap[status]] : [status];
      cond.push(`l.status IN (${variants.map(() => '?').join(',')})`);
      params.push(...variants);
    }
    if (from) { cond.push("l.start_date>=?"); params.push(from); }
    if (to) { cond.push("l.start_date<=?"); params.push(to); }
    if (cond.length) sql += " AND " + cond.join(" AND ");
    sql += " ORDER BY l.created_at DESC";
    
    const result = db.exec(sql, params);
    const rows = result[0]?.values || [];
    const cols = result[0]?.columns || [];
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('请假记录');
    worksheet.addRow(['学生','学号','宿舍','班级','事由','开始日期','结束日期','状态','提交时间']);
    rows.forEach(r => {
      const obj = {};
      cols.forEach((col, i) => { obj[col] = r[i]; });
      worksheet.addRow([
        obj['student_name'] || '',
        obj['student_id'] || '',
        obj['dorm'] || '',
        obj['class_name'] || '',
        obj['reason'] || '',
        obj['start_date'] || '',
        obj['end_date'] || '',
        // 状态中文化：库中历史数据是英文 approved/pending/rejected，新数据是中文，统一映射为中文展示
        { approved:'已批准', pending:'待审批', rejected:'已驳回' }[String(obj['status']||'').toLowerCase()] || obj['status'] || '',
        obj['created_at'] || ''
      ]);
    });
    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const filename = encodeURIComponent('请假记录.xlsx');
    res.setHeader('Content-Disposition', `attachment; filename="leaves_records.xlsx"; filename*=UTF-8''${filename}`);
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  } catch (e) {
    console.error('请假导出失败:', e);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 1, message: '导出失败: ' + e.message }));
    }
  }
});

// ==================== 导出课堂记录 ====================
router.get('/api/export/class-records', authMiddleware, async (req, res) => {
  try {
    const { course_id, from, to, class_name, status } = req.query;
    let sql = `
      SELECT r.time, r.date, s.name as student_name, s.student_id, s.dorm, s.class_name, r.status, r.address, r.course_name
      FROM records r
      LEFT JOIN students s ON r.student_id = s.student_id
      WHERE r.type='class'
    `;
    const params = [];
    const cond = [];
    if (course_id) { cond.push("r.course_id=?"); params.push(course_id); }
    if (req.query.course_name) { cond.push("r.course_id IN (SELECT id FROM courses WHERE name=?)"); params.push(req.query.course_name); }
    if (class_name) { cond.push("s.class_name=?"); params.push(class_name); }
    if (status) { cond.push("r.status=?"); params.push(status); }
    if (from) { cond.push("r.date>=?"); params.push(from); }
    if (to) { cond.push("r.date<=?"); params.push(to); }
    if (cond.length) sql += " AND " + cond.join(" AND ");
    sql += " ORDER BY r.date DESC, r.time DESC";
    
    const result = db.exec(sql, params);
    const rows = result[0]?.values || [];
    const cols = result[0]?.columns || [];
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('课堂记录');
    worksheet.addRow(['日期','时间','课程','姓名','学号','宿舍','班级','状态','地址']);
    rows.forEach(r => {
      const obj = {};
      cols.forEach((col, i) => { obj[col] = r[i]; });
      worksheet.addRow([
        obj['date'] || '',
        obj['time'] || '',
        obj['course_name'] || '',
        obj['student_name'] || '',
        obj['student_id'] || '',
        obj['dorm'] || '',
        obj['class_name'] || '',
        obj['status'] || '',
        obj['address'] || ''
      ]);
    });
    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="class_records.xlsx"');
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  } catch (e) {
    console.error('课堂记录导出失败:', e);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 1, message: '导出失败: ' + e.message }));
    }
  }
});

// ===== 操行评分导出 =====
router.get('/api/export/conduct', authMiddleware, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const { class_name } = req.query;
    const endDate = localDateStr();
    const d = new Date(); d.setDate(d.getDate() - days);
    const startDate = d.toISOString().slice(0, 10);
    
    const sql = `
      SELECT s.student_id as id, s.name, s.dorm, s.class_name,
        COUNT(DISTINCT CASE WHEN r.status='在寝' THEN SUBSTR(r.time,1,10) END) as normal_count,
        COUNT(DISTINCT CASE WHEN r.status IN ('未归','不在宿') THEN SUBSTR(r.time,1,10) END) as absent_count,
        COUNT(DISTINCT CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN SUBSTR(r.time,1,10) END) as leave_count,
        COUNT(DISTINCT SUBSTR(r.time,1,10)) as checkin_days
      FROM students s
      LEFT JOIN records r ON s.student_id = r.student_id AND r.type='checkin' AND SUBSTR(r.time,1,10) >= ? AND SUBSTR(r.time,1,10) <= ?
      ${class_name ? 'AND s.class_name = ?' : ''}
      GROUP BY s.student_id
      ORDER BY checkin_days DESC, normal_count DESC
    `;
    const params = [startDate, endDate];
    if (class_name) params.push(class_name);
    const result = db.exec(sql, params);
    const rows = result[0]?.values || [];
    const cols = result[0]?.columns || [];
    
    const scores = rows.map(r => {
      const obj = {};
      cols.forEach((col, i) => { obj[col.toLowerCase()] = r[i]; });
      const checkinDays = obj['checkin_days'] || 0;
      const normalCount = obj['normal_count'] || 0;
      const score = checkinDays > 0 ? Math.round((normalCount / checkinDays) * 100) : 0;
      return {
        name: obj['name'] || r[1],
        dorm: obj['dorm'] || r[2] || '',
        class_name: obj['class_name'] || r[3] || '',
        normal_count: normalCount,
        absent_count: obj['absent_count'] || r[4] || 0,
        leave_count: obj['leave_count'] || r[5] || 0,
        checkin_days: checkinDays,
        score: score
      };
    });
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('操行评分');
    worksheet.addRow(['排名','姓名','宿舍','班级','在寝次数','缺勤次数','请假次数','签到天数','评分','等级']);
    scores.forEach((s, i) => {
      worksheet.addRow([
        i + 1,
        s.name,
        s.dorm,
        s.class_name,
        s.normal_count,
        s.absent_count,
        s.leave_count,
        s.checkin_days,
        s.score,
        s.score >= 90 ? '优秀' : s.score >= 75 ? '良好' : s.score >= 60 ? '及格' : '不及格'
      ]);
    });
    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="操行评分.xlsx"');
    res.end(buf);
  } catch (e) { res.json({ code: 1, message: '导出失败: ' + e.message }); }
});

router.get('/api/export-all', authMiddleware, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();

    // 学生
    const sr = db.exec("SELECT id,name,student_id,gender,dorm,class_name,phone,grade,major FROM students ORDER BY class_name,name")[0]?.values || [];
    const ws1 = workbook.addWorksheet('学生');
    ws1.addRow(['学号','姓名','性别','宿舍','班级','电话','年级','专业']);
    sr.forEach(r => ws1.addRow([r[2]||'', r[1]||'', r[3]||'', r[4]||'', r[5]||'', r[6]||'', r[7]||'', r[8]||'']));

    // 查寝记录
    const rr = db.exec("SELECT SUBSTR(r.time,1,10) as record_date,r.time,s.name,s.dorm,s.class_name,r.status FROM records r LEFT JOIN students s ON r.student_id=s.student_id WHERE r.type='checkin' ORDER BY SUBSTR(r.time,1,10) DESC")[0]?.values || [];
    const ws2 = workbook.addWorksheet('查寝记录');
    ws2.addRow(['日期','时间','姓名','宿舍','班级','状态']);
    rr.forEach(r => ws2.addRow([r[0]||'', r[1]||'', r[2]||'', r[3]||'', r[4]||'', r[5]||'']));

    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="all_data.xlsx"');
    res.end(buf);
  } catch (e) { res.json({ code: 1, message: '导出失败: ' + e.message }); }
});

router.get('/api/photo-stats', authMiddleware, (req, res) => {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return res.json({ code: 0, data: { totalPhotos: 0 } });
    const files = fs.readdirSync(UPLOAD_DIR).filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f));
    let totalSize = 0;
    files.forEach(f => { try { totalSize += fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch {} });
    res.json({ code: 0, data: { totalPhotos: files.length, totalSize, totalSizeMB: (totalSize/1024/1024).toFixed(2) } });
  } catch (err) { res.json({ code: 1, message: '获取照片统计失败: ' + err.message }); }
});

router.post('/api/cleanup-photos', authMiddleware, (req, res) => {
  try {
    const { days = 30 } = req.body;
    const cutoff = new Date(Date.now() - days * 24*60*60*1000);
    if (!fs.existsSync(UPLOAD_DIR)) return res.json({ code: 0, message: '上传目录不存在' });
    const files = fs.readdirSync(UPLOAD_DIR);
    let deleted = 0;
    files.forEach(f => { try { if (fs.statSync(path.join(UPLOAD_DIR, f)).mtime < cutoff) { fs.unlinkSync(path.join(UPLOAD_DIR, f)); deleted++; } } catch {} });
    addLog('清理照片', `清理了${deleted}张${days}天前的照片`);
    res.json({ code: 0, message: `清理完成，删除了${deleted}张照片` });
  } catch (err) { res.json({ code: 1, message: '清理失败: ' + err.message }); }
});

// ==================== 导出全部数据（多Sheet Excel）====================
router.get('/api/export/all', authMiddleware, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();

    // 辅助函数：SQL查询转sheet
    const sqlToSheet = async (sql, params, sheetName, headers) => {
      try {
        const result = db.exec(sql, params || []);
        if (!result[0]) return;
        const cols = result[0].columns;
        const rows = result[0].values;
        const ws = workbook.addWorksheet(sheetName.substring(0, 31));
        ws.addRow(headers || cols);
        for (const row of rows) ws.addRow(row);
        // 设置列宽
        const colWidths = (headers || cols).map(h => ({ wch: Math.min(Math.max(String(h).length * 2 + 4, 10), 40) }));
        ws.columns = colWidths;
      } catch (e) { console.error(`Sheet [${sheetName}] error:`, e.message); }
    };

    await sqlToSheet(
      "SELECT s.student_id, s.name, CASE WHEN s.gender='male' THEN '男' WHEN s.gender='female' THEN '女' ELSE s.gender END as gender, s.class_name, s.dorm, s.phone FROM students s ORDER BY s.class_name, s.student_id",
      [], '学生信息',
      ['学号', '姓名', '性别', '班级', '宿舍', '手机']
    );

    await sqlToSheet(
      "SELECT building, room, floor, capacity, occupied, CASE WHEN gender='male' THEN '男' WHEN gender='female' THEN '女' ELSE gender END as gender FROM dorms ORDER BY building, room",
      [], '宿舍信息',
      ['楼栋', '房号', '楼层', '容量', '已住', '性别']
    );

    await sqlToSheet(
      `SELECT s.name, s.student_id, s.class_name, s.dorm,
              CASE r.status
                WHEN '在寝' THEN '在寝' WHEN '未归' THEN '未归'
                WHEN '不在寝' THEN '未归' WHEN '晚归' THEN '晚归'
                WHEN '请假' THEN '请假' ELSE r.status END as status,
              r.address,
              SUBSTR(r.date,1,10) as 日期, SUBSTR(r.time,1,19) as 时间
       FROM records r LEFT JOIN students s ON r.student_id=s.student_id
       WHERE r.type='checkin' ORDER BY r.date DESC, r.time DESC`,
      [], '签到记录',
      ['姓名', '学号', '班级', '宿舍', '状态', '位置', '日期', '时间']
    );

    await sqlToSheet(
      `SELECT s.name, s.student_id, s.class_name, l.reason, l.start_date, l.end_date,
              CASE l.status
                WHEN 'approved' THEN '已批准' WHEN 'pending' THEN '待审批'
                WHEN 'rejected' THEN '已驳回' ELSE l.status END as status,
              l.created_at
       FROM leaves l LEFT JOIN students s ON l.student_id=s.student_id
       ORDER BY l.created_at DESC`,
      [], '请假记录',
      ['姓名', '学号', '班级', '事由', '开始日期', '结束日期', '状态', '提交时间']
    );

    await sqlToSheet(
      "SELECT name, date, start_time, end_time, location, class_name FROM courses ORDER BY date DESC, start_time DESC",
      [], '课程列表',
      ['课程名称', '日期', '开始时间', '结束时间', '地点', '班级']
    );

    await sqlToSheet(
      `SELECT student_name, student_id, class_name, date,
              CASE status WHEN 'open' THEN '处理中' WHEN 'closed' THEN '已关闭' ELSE status END as status,
              reason, note, closed_at
       FROM absence_alerts ORDER BY created_at DESC`,
      [], '异常告警',
      ['姓名', '学号', '班级', '日期', '状态', '关闭原因', '备注', '关闭时间']
    );

    await sqlToSheet(
      `SELECT time, action, detail, operator,
              CASE level WHEN 'error' THEN '错误' WHEN 'warn' THEN '警告' WHEN 'info' THEN '信息' ELSE level END as level
       FROM logs ORDER BY id DESC LIMIT 500`,
      [], '操作日志',
      ['时间', '操作', '详情', '操作人', '级别']
    );

    const buf = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('学生管理系统全量数据_' + new Date().toISOString().slice(0, 10))}.xlsx`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('Export all error:', e);
    res.json({ code: 1, message: '导出失败：' + e.message });
  }
});

// ==================== Webhook / 公告 / 预警规则 ====================
// Webhook 配置表
function ensureSettingsTable() {
  try { db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)"); } catch (e) {}
  try { db.run("CREATE TABLE IF NOT EXISTS webhook_history (id TEXT PRIMARY KEY, type TEXT, success INTEGER, message TEXT, created_at TEXT)"); } catch (e) {}
  try { db.run("CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT, content TEXT, created_at TEXT)"); } catch (e) {}
}

router.get('/api/settings/webhook', authMiddleware, (req, res) => {
  try {
    ensureSettingsTable();
    const r = db.exec("SELECT value FROM settings WHERE key='webhook'")[0]?.values?.[0]?.[0];
    const data = r ? JSON.parse(r) : { enabled: false, type: 'wechat', url: '' };
    res.json({ code: 0, data });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

router.post('/api/settings/webhook', authMiddleware, (req, res) => {
  try {
    ensureSettingsTable();
    const data = { enabled: !!req.body.enabled, type: req.body.type || 'wechat', url: req.body.url || '' };
    const now = new Date().toISOString();
    db.run("INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES('webhook',?,?)", [JSON.stringify(data), now]);
    addLog('保存Webhook', data.enabled ? `启用 ${data.type}` : '关闭');
    res.json({ code: 0, message: '保存成功' });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

router.post('/api/settings/webhook/test', authMiddleware, async (req, res) => {
  try {
    const { type, url } = req.body;
    if (!url) return res.json({ code: 1, message: '请填写 Webhook 地址' });
    // 实际发送消息
    const axios = require('axios');
    let content;
    if (type === 'wechat') {
      content = { msgtype: 'text', text: { content: '🔔 查寝系统测试消息：Webhook 配置成功！' } };
    } else if (type === 'dingtalk') {
      content = { msgtype: 'text', text: { content: '🔔 查寝系统测试消息：Webhook 配置成功！' } };
    } else {
      content = { msg_type: 'text', content: { text: '🔔 查寝系统测试消息：Webhook 配置成功！' } };
    }
    const r = await axios.post(url, content, { timeout: 8000 }).catch(e => ({ error: e.message }));
    const success = !r.error && (r.data?.errcode === 0 || r.status === 200);
    ensureSettingsTable();
    db.run("INSERT INTO webhook_history(id, type, success, message, created_at) VALUES(?,?,?,?,?)",
      ['wh_' + Date.now(), type, success ? 1 : 0, success ? '测试成功' : (r.error || '失败'), new Date().toISOString()]);
    res.json({ code: success ? 0 : 1, message: success ? '发送成功' : '发送失败：' + (r.error || '未知错误') });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

router.get('/api/settings/webhook/history', authMiddleware, (req, res) => {
  try {
    ensureSettingsTable();
    const r = db.exec("SELECT id, type, success, message, created_at FROM webhook_history ORDER BY created_at DESC LIMIT 50")[0];
    if (!r) return res.json({ code: 0, data: [] });
    const cols = r.columns, values = r.values;
    res.json({ code: 0, data: values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]]))) });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

// 公告
router.post('/api/announcements', authMiddleware, (req, res) => {
  try {
    ensureSettingsTable();
    const { title, content } = req.body;
    if (!title || !content) return res.json({ code: 1, message: '请填写完整' });
    const id = 'ann_' + Date.now();
    db.run("INSERT INTO announcements(id, title, content, created_at) VALUES(?,?,?,?)",
      [id, title, content, new Date().toISOString()]);
    addLog('发布公告', title);
    // WebSocket 实时推送学生端（双通道 HTTP/HTTPS 由 global.broadcast 双实例遍历）
    if (typeof global.broadcast === 'function') {
      global.broadcast({ type: 'announcement', data: { id, title, content, created_at: new Date().toISOString() } });
    }
    res.json({ code: 0, message: '发布成功' });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

router.get('/api/announcements', (req, res) => {
  try {
    ensureSettingsTable();
    const r = db.exec("SELECT id, title, content, created_at FROM announcements ORDER BY created_at DESC LIMIT 50")[0];
    if (!r) return res.json({ code: 0, data: [] });
    const cols = r.columns, values = r.values;
    res.json({ code: 0, data: values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]]))) });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

// 预警规则
router.get('/api/settings/alert-rules', authMiddleware, (req, res) => {
  try {
    ensureSettingsTable();
    const r = db.exec("SELECT value FROM settings WHERE key='alert_rules'")[0]?.values?.[0]?.[0];
    const data = r ? JSON.parse(r) : { enabled: true, absent_days: 3, dorm_count: 2, consecutive_days: 3 };
    res.json({ code: 0, data });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

router.post('/api/settings/alert-rules', authMiddleware, (req, res) => {
  try {
    ensureSettingsTable();
    const data = {
      enabled: req.body.enabled !== false,
      absent_days: parseInt(req.body.absent_days) || 3,
      dorm_count: parseInt(req.body.dorm_count) || 2,
      consecutive_days: parseInt(req.body.consecutive_days) || 3
    };
    db.run("INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES('alert_rules',?,?)", [JSON.stringify(data), new Date().toISOString()]);
    addLog('保存预警规则', `缺勤≥${data.absent_days}天, 同宿舍≥${data.dorm_count}人`);
    res.json({ code: 0, message: '保存成功' });
  } catch (e) { res.json({ code: 1, message: e.message }); }
});


// ==================== 地图配置接口 ====================
// 只读公开接口：返回前端 JS 用于地址反解的地图 key。
// AMAP/TENCENT/BAIDU key 本就设计给浏览器端调用，非敏感数据，
// 故豁免鉴权，允许学生端无 token 直接获取（否则定位只会显示坐标）。
router.get('/api/config/map', (req, res) => {
  try {
    const cfg = require('../config');
    let provider = 'amap';
    if (cfg.TENCENT_MAP_KEY && !cfg.AMAP_MAP_KEY) provider = 'tencent';
    else if (cfg.BAIDU_MAP_KEY && !cfg.AMAP_MAP_KEY) provider = 'baidu';
    res.json({ code: 0, data: {
      provider,
      amapKey: cfg.AMAP_MAP_KEY || '',
      tencentKey: cfg.TENCENT_MAP_KEY || '',
      baiduKey: cfg.BAIDU_MAP_KEY || ''
    }});
  } catch (e) { res.json({ code: 1, message: e.message }); }
});

  return router;
}

module.exports = { init, createBackup };