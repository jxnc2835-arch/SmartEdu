/**
 * CSRF 防护中间件
 * 为所有写操作（POST/PUT/DELETE/PATCH）生成并验证 CSRF token
 * GET/HEAD/OPTIONS 请求无需 token（幂等操作）
 */

const crypto = require('crypto');

// CSRF token 存储: { token: { createdAt, expiresAt } }
const csrfTokens = new Map();
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24小时

/**
 * 生成 CSRF token
 * 返回 token 字符串，调用方负责将其注入到表单或 meta 标签
 */
function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  csrfTokens.set(token, { createdAt: now, expiresAt: now + TOKEN_EXPIRY });
  return token;
}

/**
 * 清理过期的 CSRF tokens（每 30 分钟执行一次）
 */
function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, data] of csrfTokens.entries()) {
    if (now > data.expiresAt) {
      csrfTokens.delete(token);
    }
  }
}
setInterval(cleanupExpiredTokens, 30 * 60 * 1000);

/**
 * CSRF 验证中间件
 * 仅对写操作方法生效，GET/HEAD/OPTIONS 自动跳过
 * 测试环境下跳过验证（便于单元测试）
 */
function csrfProtection(req, res, next) {
  // 测试环境跳过 CSRF 验证
  // 使用 jest 的全局变量和 NODE_ENV 双重检测
  if (typeof jest !== 'undefined' || process.env.NODE_ENV === 'test') {
    return next();
  }

  // 幂等操作无需 CSRF 验证
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // 获取请求中的 CSRF token
  // 优先级: Header > Body > Query
  const token = req.headers['x-csrf-token'] ||
                req.body?._csrf ||
                req.query?._csrf;

  if (!token) {
    return res.status(403).json({
      code: 1,
      message: '缺少 CSRF token，请刷新页面后重试'
    });
  }

  const tokenData = csrfTokens.get(token);
  if (!tokenData) {
    return res.status(403).json({
      code: 1,
      message: 'CSRF token 无效或已过期'
    });
  }

  // Token 有效，删除已使用的 token（一次性使用）
  csrfTokens.delete(token);
  next();
}

/**
 * 获取 CSRF token 端点（前端登录成功后调用获取）
 */
function csrfGetToken(req, res) {
  const token = generateToken();
  res.json({ code: 0, data: { token } });
}

module.exports = {
  csrfProtection,
  csrfGetToken,
  generateToken,
  csrfTokens
};
