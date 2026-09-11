// ==================== 登录与用户管理路由模块 ====================
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

/**
 * 初始化认证路由模块
 * @param {Object} opts - 依赖注入对象
 * @param {object} opts.db - sql.js Database 实例
 * @param {Function} opts.scheduleSave - 延迟保存函数
 * @param {Function} opts.authMiddleware - 认证中间件
 * @param {Function} opts.requireRole - 角色验证中间件
 * @param {Function} opts.generateToken - Token 生成函数
 * @param {Map} opts.STUDENT_TOKENS - 学生 Token 存储
 * @param {Map} opts.RESET_TOKENS - 密码重置 Token 存储
 * @param {string} opts.STUDENT_TOKEN_EXPIRY - 学生 Token 过期时间
 * @param {Function} opts.addLog - 日志记录函数
 * @param {Function} opts.localDateStr - 本地日期字符串函数
 * @param {Function} opts.formatDate - 日期格式化函数
 * @param {Function} opts.nowTimestamp - 当前时间戳函数
 * @param {Function} opts.saveBase64Photo - 保存 Base64 图片函数
 * @param {Function} opts.beijingStamp - 北京时间时间戳函数
 * @param {Function} opts.compressImage - 图片压缩函数
 * @param {Function} opts.checkLoginRateLimit - 登录频率限制函数
 * @param {Map} opts.LOGIN_ATTEMPTS - 登录尝试记录
 * @returns {Express.Router}
 */
function init(opts) {
  const { db, scheduleSave, authMiddleware, requireRole, generateToken, STUDENT_TOKENS, RESET_TOKENS, STUDENT_TOKEN_EXPIRY, addLog, localDateStr, formatDate, nowTimestamp, saveBase64Photo, beijingStamp, compressImage, checkLoginRateLimit, LOGIN_ATTEMPTS } = opts;

  const router = express.Router();

  // 登录接口
  /**
   * @openapi
   * /api/login:
   *   post:
   *     summary: 用户登录
   *     description: 根据用户名和密码生成 JWT token。
   *     tags:
   *       - Auth
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               username:
   *                 type: string
   *               password:
   *                 type: string
   *     responses:
   *       200:
   *         description: 登录成功，返回 token
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 code:
   *                   type: integer
   *                 token:
   *                   type: string
   *                 message:
   *                   type: string
   *       401:
   *         description: 登录失败或身份验证错误
   */
  router.post('/api/login', async (req, res) => {
    const { password, username } = req.body;
    const ip = req.ip;
    const id = username || 'admin';

    const limit = checkLoginRateLimit(ip, id);
    if (!limit.allowed) {
      return res.json({ code: 1, message: limit.message });
    }

    const row = db.exec("SELECT * FROM users WHERE username=? LIMIT 1;", [username])[0]?.values?.[0];
    if (!row) return res.json({ code: 1, message: '用户不存在' });
    
    // users 表列顺序: id, username, password_hash, role, display_name, class_name
    const [userId, , hash, role, displayName, className] = row;
    
    // 验证密码：兼容 bcrypt / MD5 / SHA256 三种哈希算法
    let valid;
    // Detect bcrypt hash. Original regex was too strict (e.g., `$2b$10$...` didn't match).
    // Use a more permissive check that covers `$2a$`, `$2b$`, `$2y$` formats.
    if (hash && /^\$2[aby]\$/.test(hash)) {
      // bcrypt 哈希
      valid = await bcrypt.compare(password, hash);
    } else if (hash && /^[a-f0-9]{32}$/.test(hash)) {
      // MD5 哈希（32位十六进制）
      const md5 = crypto.createHash('md5').update(password).digest('hex');
      valid = md5 === hash;
    } else {
      // 默认使用 SHA256
      const sha = crypto.createHash('sha256').update(password).digest('hex');
      valid = sha === hash;
    }
    if (!valid) {
      if (limit.remaining !== undefined && limit.remaining > 0) {
        return res.json({ code: 1, message: `密码错误，还剩 ${limit.remaining} 次尝试机会` });
      }
      return res.json({ code: 1, message: '密码错误' });
    }
    delete LOGIN_ATTEMPTS[`${ip}_${id}`];

    const token = generateToken(userId, role, className);
    res.json({ code: 0, token, message: '登录成功', expiresIn: 8 * 3600, data: { role, display_name: displayName || userId, class_name: className || '' } });
  });

  // 当前登录用户信息（供前端按角色控制 UI）
  router.get('/api/me', authMiddleware, (req, res) => {
    try {
      const row = db.exec("SELECT display_name, class_name FROM users WHERE id=?", [req.user.userId])[0]?.values?.[0];
      res.json({
        code: 0,
        data: {
          role: req.user.role,
          class_name: (req.user.classScope || []).join(','),
          display_name: row ? row[0] : (req.user.userId)
        }
      });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // ==================== 用户管理 ====================
  router.get('/api/users', authMiddleware, requireRole('super_admin','admin'), (req, res) => {
    const rows = db.exec("SELECT id, username, role, class_name, display_name FROM users;")[0]?.values || [];
    res.json({ code: 0, data: rows.map(r => ({ id: r[0], username: r[1] || r[0], role: r[2], class_name: r[3] || '', display_name: r[4] || '' })) });
  });

  router.post('/api/users', authMiddleware, requireRole('super_admin','admin'), async (req, res) => {
    const { id, password, role, class_name, display_name } = req.body;
    if (!id || !password || !role) return res.json({ code: 1, message: '缺少字段' });
    // 禁止创建超级管理员（admin 是系统内置）
    if (role === 'super_admin' || role === 'admin') {
      return res.json({ code: 1, message: '不能创建超级管理员（admin 是系统内置）' });
    }
    // 院领导不能绑定班级
    const finalClassName = role === 'dean' ? '' : (class_name || '');
    const hash = await bcrypt.hash(password, 10);
    try {
      // 同时写 id 和 username，方便登录查询
      db.run("INSERT INTO users(id, username, password_hash, role, class_name, display_name) VALUES(?,?,?,?,?,?)", [id, id, hash, role, finalClassName, display_name||'']);
      scheduleSave();
      res.json({ code: 0, message: '用户创建成功' });
    } catch (e) {
      res.json({ code: 1, message: '创建失败: ' + e.message });
    }
  });

  router.put('/api/users/:id', authMiddleware, requireRole('super_admin','admin'), async (req, res) => {
    const { id } = req.params;
    const { password, role, class_name, display_name } = req.body;
    const updates = [];
    const params = [];
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      updates.push('password_hash=?');
      params.push(hash);
    }
    if (role) {
      updates.push('role=?');
      params.push(role);
    }
    if (class_name !== undefined) {
      updates.push('class_name=?');
      params.push(class_name);
    }
    if (display_name !== undefined) {
      updates.push('display_name=?');
      params.push(display_name);
    }
    if (!updates.length) return res.json({ code: 1, message: '无更新字段' });
    params.push(id);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE id=?`, params);
    scheduleSave();
    res.json({ code: 0, message: '更新成功' });
  });

  router.delete('/api/users/:id', authMiddleware, requireRole('super_admin','admin'), (req, res) => {
    const { id } = req.params;
    db.run("DELETE FROM users WHERE id=?", [id]);
    scheduleSave();
    res.json({ code: 0, message: '删除成功' });
  });

  // ==================== 密码管理 ====================
  router.post('/api/change-password', authMiddleware, async (req, res) => {
    const { oldPwd, newPwd } = req.body;
    const row = db.exec("SELECT * FROM users WHERE id=?", [req.user.userId])[0]?.values?.[0];
    if (!row) return res.json({ code: 1, message: '用户不存在' });
    const [id, hash] = row;
    const valid = await bcrypt.compare(oldPwd, hash);
    if (!valid) return res.json({ code: 1, message: '原密码错误' });
    const newHash = await bcrypt.hash(newPwd, 10);
    db.run("UPDATE users SET password_hash=? WHERE id=?", [newHash, id]);
    scheduleSave();
    res.json({ code: 0, message: '密码修改成功' });
  });

  router.post('/api/reset-password', authMiddleware, requireRole('super_admin','admin'), async (req, res) => {
    const { userId, newPassword } = req.body;
    if (!userId) return res.json({ code: 1, message: '请指定用户' });
    const pwd = newPassword || '123456';
    const hash = await bcrypt.hash(pwd, 10);
    db.run("UPDATE users SET password_hash=? WHERE id=?", [hash, userId]);
    scheduleSave();
    addLog('重置密码', `${userId} 密码已重置`, 'WARN', req.user.userId);
    res.json({ code: 0, message: `密码已重置为「${pwd}」` });
  });

  router.post('/api/student-reset-password', authMiddleware, requireRole('super_admin', 'counselor', 'dean'), async (req, res) => {
    const { studentId, newPassword } = req.body;
    if (!studentId) return res.json({ code: 1, message: '请指定学生' });

    const userRow = db.exec("SELECT role, class_name FROM users WHERE id=?", [req.user.userId])[0]?.values?.[0];
    if (!userRow) return res.status(403).json({ code: 1, message: '用户不存在' });
    const userRole = userRow[0] || '';
    const userClassName = userRow[1] || '';

    if (userRole === 'counselor') {
      const stu = db.exec("SELECT class_name FROM students WHERE student_id=? OR id=?", [studentId, studentId])[0]?.values?.[0];
      if (!stu) return res.json({ code: 1, message: '学生不存在' });
      const stuClass = stu[0] || '';
      const counselorClasses = userClassName.split(',').map(c => c.trim()).filter(Boolean);
      if (!counselorClasses.includes(stuClass)) {
        return res.json({ code: 1, message: '无权操作该学生' });
      }
    }

    const pwd = newPassword || '123456';
    const hash = await bcrypt.hash(pwd, 10);
    const mustChange = newPassword ? 0 : 1;
    db.run("UPDATE students SET password_hash=?, must_change_pwd=? WHERE student_id=? OR id=?", [hash, mustChange, studentId, studentId]);
    scheduleSave();
    addLog('重置学生密码', `学生 ${studentId} 密码已重置`, 'WARN', req.user.userId);
    res.json({ code: 0, message: `学生密码已重置为「${pwd}」` });
  });

  return router;
}

module.exports = { init };
