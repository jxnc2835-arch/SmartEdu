// ==================== JWT 认证 ====================
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// JWT 密钥（必须通过环境变量 JWT_SECRET 注入，避免硬编码泄露）
// 若未设置则在服务启动时抛出明确错误，防止在生产环境使用默认密钥。
// 在非测试环境下强制要求配置 JWT_SECRET，避免在单元测试时因缺失而报错
if (process.env.NODE_ENV !== 'test' && !process.env.JWT_SECRET) {
  throw new Error('环境变量 JWT_SECRET 未设置，请在 .env 中配置安全的密钥');
}

// JWT_SECRET 强弱校验：至少 32 位，包含大小写字母和数字
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '2h';

function validateJwtSecret(secret) {
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET 长度不足 32 位，请生成强密钥: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  // 检查是否包含至少三种字符类型（大写字母、小写字母、数字/特殊字符）
  const hasUpper = /[A-Z]/.test(secret);
  const hasLower = /[a-z]/.test(secret);
  const hasDigitOrSpecial = /[\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(secret);
  const typeCount = [hasUpper, hasLower, hasDigitOrSpecial].filter(Boolean).length;
  if (typeCount < 2) {
    throw new Error('JWT_SECRET 复杂度过低，建议使用包含大小写字母和数字的强密钥');
  }
}

// 仅在非测试环境下验证密钥强度
if (process.env.NODE_ENV !== 'test') {
  try {
    validateJwtSecret(JWT_SECRET);
  } catch (e) {
    console.error(`⚠️  ${e.message}`);
    process.exit(1);
  }
}

function toScope(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function generateToken(userId, role, classScope) {
  return jwt.sign(
    { userId, role, classScope: toScope(classScope) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function validateToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { userId: decoded.userId, role: decoded.role, classScope: toScope(decoded.classScope) };
  } catch (e) {
    return null;
  }
}

// db 实例将在 server.js 中通过闭包注入
let databaseInstance = null;
function setDb(dbInstance) { 
  databaseInstance = dbInstance; 
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const entry = validateToken(token);
  if (entry) {
    req.user = entry;
    req.user.allowed_classes = entry.classScope || [];
    return next();
  }
  res.status(401).json({ code: 1, message: '登录已过期，请重新登录' });
}
// 角色校验中间件（支持 dean 只读权限）
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 1, message: '未登录' });
    // admin 永远是超级管理员
    if (req.user.userId === 'admin' || String(req.user.userId) === '1') return next();
    const userRow = databaseInstance.exec("SELECT role, class_name FROM users WHERE id=?", [req.user.userId])[0]?.values?.[0];
    if (!userRow) return res.status(403).json({ code: 1, message: '无权限' });
    
    const userRole = userRow[0];
    const userClasses = userRow[1] || '';
    
    // dean 角色特殊处理：允许 dean 访问只读操作，拦截写操作
    if (roles.includes('dean') && userRole === 'dean') {
      // dean 只能读，不能写（GET 请求放行）
      if (req.method !== 'GET') {
        return res.status(403).json({ code: 1, message: '院系领导仅可查看数据，无权执行此操作' });
      }
      req.user.role = userRole;
      req.user.class_name = userClasses;
      return next();
    }
    
    if (!roles.includes(userRole)) {
      return res.status(403).json({ code: 1, message: '无权限' });
    }
    
    req.user.role = userRole;
    req.user.class_name = userClasses;
    next();
  };
}

// 数据过滤中间件：为 counselor 标记允许访问的班级（基于 JWT 中的 classScope）
function filterByUserClass(req, res, next) {
  if (!req.user || !req.user.role) return next();
  const role = req.user.role;
  // admin / super_admin / dean 不受班级限制
  if (role === 'super_admin' || role === 'admin' || role === 'dean') return next();
  if (req.user.classScope && req.user.classScope.length) {
    req.user.allowed_classes = req.user.classScope;
  }
  next();
}

// ==================== 登录限流 ====================
const LOGIN_ATTEMPTS = {};
const LOGIN_LOCK_TIME = 15 * 60 * 1000; // 15分钟
const LOGIN_MAX_ATTEMPTS = 5; // 最多5次

function checkLoginRateLimit(ip, username) {
  const key = `${ip}_${username}`;
  const now = Date.now();
  const entry = LOGIN_ATTEMPTS[key];
  
  if (!entry || now - entry.lastAttempt > LOGIN_LOCK_TIME) {
    LOGIN_ATTEMPTS[key] = { count: 1, lastAttempt: now, locked: false };
    return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS - 1 };
  }
  
  if (entry.locked) {
    const unlockIn = Math.ceil((LOGIN_LOCK_TIME - (now - entry.lastAttempt)) / 1000 / 60);
    return { allowed: false, message: `登录已锁定，请在 ${unlockIn} 分钟后重试` };
  }
  
  entry.count++;
  entry.lastAttempt = now;
  
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.locked = true;
    return { allowed: false, message: `密码错误次数过多，已锁定 15 分钟` };
  }
  
  return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS - entry.count };
}

// Student token management
const STUDENT_TOKENS = {};
const RESET_TOKENS = {}; // 学生重置密码临时令牌
const STUDENT_TOKEN_EXPIRY = 24 * 3600 * 1000; // 24小时

function studentAuth(req, res, next) {
  const token = req.headers['x-student-token'];
  const entry = STUDENT_TOKENS[token];
  if (!entry || Date.now() > entry.expiresAt) {
    delete STUDENT_TOKENS[token];
    return res.status(401).json({ code: 1, message: '身份验证已过期，请重新登录' });
  }
  req.student = entry;
  next();
}
setInterval(() => {
  const now = Date.now();
  Object.keys(STUDENT_TOKENS).forEach(t => {
    if (now > STUDENT_TOKENS[t].expiresAt) delete STUDENT_TOKENS[t];
  });
  Object.keys(RESET_TOKENS).forEach(t => {
    if (now > RESET_TOKENS[t].expiresAt) delete RESET_TOKENS[t];
  });
}, 30 * 60 * 1000);

module.exports = { 
  generateToken, 
  validateToken, 
  authMiddleware, 
  requireRole, 
  filterByUserClass, 
  checkLoginRateLimit, 
  studentAuth, 
  STUDENT_TOKENS, 
  RESET_TOKENS, 
  STUDENT_TOKEN_EXPIRY, 
  LOGIN_ATTEMPTS, 
  LOGIN_LOCK_TIME, 
  LOGIN_MAX_ATTEMPTS,
  setDb 
};
