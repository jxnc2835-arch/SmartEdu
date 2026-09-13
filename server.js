// 最终修复：在模块顶层、数据库初始化之前注册静态文件和404
// 路由（在 mountRoutes 里注册到 app 中）
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const os = require('os');
const path = require('path');

const initSqlJs = require('sql.js');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const express = require('express');
require('dotenv').config();

// 导入 Express 应用配置
const { createApp } = require('./app');
const config = require('./config');
const logger = require('./utils/logger');

// 验证配置
const configErrors = config.validateConfig();
if (configErrors.length > 0) {
  logger.error('配置验证失败:', configErrors.join(', '));
  process.exit(1);
}

// 确保目录存在
config.ensureDirectories();

// 当父进程（如 IDE/终端）关闭 stdout/stderr 管道后，继续写日志会触发 EPIPE，
// 若 uncaughtException 里再次 console.error 将产生无限循环，几秒写爆磁盘。
// 这里先给 stdout/stderr 注册 EPIPE 忽略，防止其变成 uncaughtException。
[process.stdout, process.stderr].forEach(s => {
  s.on('error', (err) => {
    if (err && err.code === 'EPIPE') return; // 父进程管道已关闭，静默忽略
    // 其他错误仍按默认处理
    throw err;
  });
});

// 捕获未处理的 Promise 拒绝（防止进程崩溃，便于定位根因）
process.on('unhandledRejection', (reason, promise) => {
  logger.error('[unhandledRejection]', {
    type: typeof reason,
    hasMessage: !!reason?.message,
    message: reason?.message || String(reason),
    stack: reason?.stack,
    reasonKeys: reason && typeof reason === 'object' ? Object.keys(reason) : null
  });
  // 不退出进程，继续运行
});

process.on('uncaughtException', (err) => {
  // EPIPE 已在上层 stdout/stderr 拦截，此处若再遇到 EPIPE（例如直接 write()），不再重试 console.error，避免无限循环
  const isEpipe = err && (err.code === 'EPIPE' || String(err.message || err).includes('EPIPE'));
  if (!isEpipe) {
    try { console.error('⚠️ [uncaughtException]', err?.message || err, err?.stack ? '\n' + err.stack.slice(0,1000) : ''); } catch (e) { /* stdout 可能已关闭，忽略 */ }
  }
  logger.error('[uncaughtException]', err);
    try {
      const logDir = config.LOG_DIR;
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'server-error.log');
      const line = `[${new Date().toISOString()}] ${err?.message || String(err)}${isEpipe ? ' (EPIPE ignored)' : ''}\n${err?.stack || ''}\n\n`;
      fs.appendFileSync(logFile, line);
    } catch (e) { /* 日志落盘失败时忽略 */ }
  // 不退出进程，继续运行（开发/测试环境）；生产环境建议改用 pm2 等进程守护
});

const {
  setDb, authMiddleware, requireRole, studentAuth,
  STUDENT_TOKENS, RESET_TOKENS, STUDENT_TOKEN_EXPIRY,
  LOGIN_ATTEMPTS, checkLoginRateLimit, generateToken, validateToken
} = require('./middleware/auth');
const { localDateStr, formatDate, nowTimestamp, saveBase64Photo, beijingStamp, compressImage, setAppDb } = require('./utils/helpers');
const { createIndexes, optimizeDbConfig, paginate, batchInsert, healthCheck, vacuum } = require('./utils/database');
const { runMigrations, validateDatabase } = require('./utils/migrations');
const { rateLimit, loginRateLimit } = require('./middleware/rate-limit');
const { csrfProtection, csrfGetToken } = require('./middleware/csrf');
const { initAutoBackup } = require('./utils/auto-backup');

// 路由模块导入
const { init: initAuthRoutes } = require('./routes/auth');
const { init: initStudentsRoutes } = require('./routes/students');
const { init: initCheckinRoutes } = require('./routes/checkin');
const { init: initStatisticsRoutes } = require('./routes/statistics');
const { init: initAdvancedStatsRoutes } = require('./routes/advanced-stats');
const { init: initDashboardRoutes } = require('./routes/dashboard');
const { init: initAIRoutes } = require('./routes/ai');
const { init: initExportRoutes } = require('./routes/export');
const { init: initMonitorRoutes } = require('./routes/monitor');
const { init: initLivenessRoutes } = require('./routes/liveness');
const { init: initNotifyRoutes } = require('./routes/notify');
const { init: initAlertsRoutes } = require('./routes/alerts');
const { init: initSystemRoutes, createBackup: systemCreateBackup } = require('./routes/system');
const { init: initWebhookRoutes } = require('./routes/webhook');
const { init: initMobileRoutes } = require('./routes/mobile');
const { init: initMetricsRoutes } = require('./routes/metrics');

// 创建 Express 应用（包含中间件、静态文件、错误处理）
const app = createApp();

// Trust proxy for reverse proxy deployments (nginx, cloud load balancers)
app.set('trust proxy', 1);

// ==================== HTTPS 强制重定向中间件 ====================
// 默认关闭。仅在显式设置 FORCE_HTTPS=true 且证书存在时，将 HTTP 301 重定向到 HTTPS。
// 说明：本项目证书默认为自签名，浏览器会提示"不安全"，因此本地/内网部署保持 HTTP 直连。
// 生产环境使用正式证书后，可设置 FORCE_HTTPS=true 开启强制加密。
if (process.env.NODE_ENV !== 'test' && process.env.FORCE_HTTPS === 'true') {
  app.use((req, res, next) => {
    // 如果已有 HTTPS 证书且请求是 HTTP，则重定向
    if (req.protocol === 'http' && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
      const httpsUrl = `https://${req.headers.host.replace(':3000', ':3443')}${req.originalUrl}`;
      logger.info(`HTTP → HTTPS 重定向: ${req.originalUrl}`);
      return res.redirect(301, httpsUrl);
    }
    next();
  });
}

// 挂载 Swagger 文档（在路由注册之前）
const initSwagger = require('./swagger');
initSwagger(app);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, verifyClient: wsVerifyClient });

const { PORT, HTTPS_PORT, SSL_DIR, SSL_KEY, SSL_CERT, UPLOAD_DIR, BACKUP_DIR, DB_FILE: dbFile } = config;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// ==================== WebSocket 认证 ====================
// 浏览器 WebSocket 无法携带自定义 header，token 通过 URL 查询参数传递：
//   ws://host/?token=<JWT 或学生token>
// 通道划分（verifyClient 按 URL 路径 + 子协议判定）：
// - 公开大屏:  ws://host/ws-public（须带 'public' 子协议，仅大屏页使用）
// - 教师端:    ?token=<JWT>（/api/login 签发）
// - 学生端:    ?token=<学生token>（/api/student/login 签发）
// - WS 一次性票据: ?ticket=<short-lived jwt>（/api/ws-ticket 签发，2 分钟有效）
// 说明：曾考虑把 token 放子协议，但 JWT（含 '.' 的 base64url）不是合法子协议
// 名，浏览器 new WebSocket 会直接失败，故统一改用查询参数。
// 校验失败返回 401，前端按既有重连逻辑定期重试。
// P2 改进：新增 /api/ws-ticket 端点，签发 2 分钟有效期的一次性 JWT，
// 避免主 token（8h）长期暴露在 WebSocket URL 中（会进 nginx/代理日志）。
function wsVerifyClient(info, done) {
  try {
    const req = info.req; // ws 8.x 回调参数为 { origin, secure, req }
    const u = new URL(req.url, 'http://localhost');
    const protocols = String(req.headers['sec-websocket-protocol'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    // 公开大屏通道：仅 /ws-public 且携带 'public' 子协议放行（认证端点不得借用）
    if (u.pathname === '/ws-public') {
      return protocols.includes('public') ? done(true) : done(false);
    }
    // 认证通道：?token= 校验（JWT 或学生 token）
    const candidate = u.searchParams.get('token') || '';
    if (!candidate) return done(false);
    if (validateToken(candidate)) return done(true);
    const studentEntry = STUDENT_TOKENS[candidate];
    if (studentEntry && Date.now() <= studentEntry.expiresAt) return done(true);
    // WS 一次性票据校验
    if (candidate.startsWith('ws_ticket_')) {
      try {
        const decoded = jwt.verify(candidate, JWT_SECRET);
        if (decoded.type === 'ws-ticket' && decoded.userId && Date.now() < decoded.exp * 1000) {
          return done(true);
        }
      } catch (_) {}
    }
    return done(false);
  } catch (e) {
    logger.warn('[WS] verifyClient 异常:', e.message);
    return done(false);
  }
}

// 数据库初始化（在 mountRoutes 之后）

// ==================== SQLite ====================
let db = null;
let _saveTimer = null;
let _saveLock = false;

function forceSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  try {
    fs.writeFileSync(dbFile, Buffer.from(db.export()));
    logger.info('💾 数据库已保存');
  } catch (e) {
    logger.error('数据库保存失败:', e.message);
  }
}

async function flushDb() {
  if (_saveLock) return;
  _saveLock = true;
  try {
    fs.writeFileSync(dbFile, Buffer.from(db.export()));
  } catch (e) {
    logger.error('数据库写入失败:', e.message);
  } finally {
    _saveLock = false;
  }
}

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushDb();
  }, 200);
}

function addLog(action, detail, level = 'INFO', operator = '') {
  const id = 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const time = nowTimestamp();
  db.run("INSERT INTO logs(id, time, action, detail, level, operator) VALUES(?,?,?,?,?,?)", [id, time, action, detail, level, operator || 'system']);
  scheduleSave();
}

async function sendWebhook(message) {
  try {
    const webhookSettings = db.exec("SELECT value FROM settings WHERE key='webhook_enabled'")[0]?.values?.[0];
    const webhookUrl = db.exec("SELECT value FROM settings WHERE key='webhook_url'")[0]?.values?.[0];
    if (webhookSettings && webhookSettings[0] === '1' && webhookUrl && webhookUrl[0]) {
      await fetch(webhookUrl[0], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message })
      });
    }
  } catch (e) { logger.error('Webhook 发送失败', e.message); }
}

// ==================== 挂载路由 ====================
function mountRoutes() {
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9\u4e00-\u9fff.\-_]/g, '');
        const ext = path.extname(safeName) || '.jpg';
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
      }
    }),
    fileFilter: (req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowed.includes(file.mimetype)) return cb(new Error('仅支持 JPG/PNG/WebP 图片格式'), false);
      cb(null, true);
    },
    limits: { fileSize: 10 * 1024 * 1024 }
  });

  const authRouter = initAuthRoutes({
    db, scheduleSave, authMiddleware, requireRole, generateToken,
    STUDENT_TOKENS, RESET_TOKENS, STUDENT_TOKEN_EXPIRY, addLog,
    localDateStr, formatDate, nowTimestamp, saveBase64Photo, beijingStamp,
    compressImage, checkLoginRateLimit, LOGIN_ATTEMPTS,
    loginRateLimit: loginRateLimit() // 登录专用限流
  });
  app.use(authRouter);

  // P2: WS 一次性票据签发端点（2 分钟有效，避免主 JWT 暴露到 WebSocket URL）
  app.get('/api/ws-ticket', authMiddleware, (req, res) => {
    try {
      const wsTicket = jwt.sign(
        { type: 'ws-ticket', userId: req.user.userId, iat: Math.floor(Date.now() / 1000) },
        JWT_SECRET,
        { expiresIn: '2m' }
      );
      res.json({ code: 0, data: { ticket: wsTicket, expiresIn: 120 } });
    } catch (e) {
      res.status(500).json({ code: 1, message: e.message });
    }
  });

  const studentsRouter = initStudentsRoutes({
    db, scheduleSave, nowTimestamp, authMiddleware, requireRole, bcrypt,
    upload, addLog, CLASS_SIZE_LIMIT: 40,
    getClassCount: (db, cn) => db.exec("SELECT COUNT(*) FROM students WHERE class_name=?", [cn])[0]?.values?.[0]?.[0] || 0,
    limitPerClass: (students) => {
      const counts = {};
      return students.filter(s => {
        const cls = s.class_name || '';
        counts[cls] = (counts[cls] || 0) + 1;
        return counts[cls] <= 40;
      });
    },
    beijingStamp: () => { const d = new Date(); const bj = new Date(d.getTime() + 8 * 3600 * 1000); return bj.toISOString().replace(/[:.]/g, '-').slice(0, 19); }
  });
  app.use(studentsRouter);

  const checkinRouter = initCheckinRoutes({
    db, scheduleSave, generateToken, upload, fs, path, QRCode, multer, os,
    addLog, CLASS_SIZE_LIMIT: 40,
    getClassCount: (db, cn) => db.exec("SELECT COUNT(*) FROM students WHERE class_name=?", [cn])[0]?.values?.[0]?.[0] || 0,
    limitPerClass: (students) => {
      const c = {};
      return students.filter(s => {
        const cls = s.class_name || '';
        c[cls] = (c[cls] || 0) + 1;
        return c[cls] <= 40;
      });
    },
    beijingStamp: () => { const d = new Date(); const bj = new Date(d.getTime() + 8 * 3600 * 1000); return bj.toISOString().replace(/[:.]/g, '-').slice(0, 19); }
  });
  app.use(checkinRouter);

  const dashboardRouter = initDashboardRoutes(db, validateToken);
  app.use(dashboardRouter);

  const statisticsRouter = initStatisticsRoutes(db, scheduleSave, addLog, broadcast, sendWebhook);
  app.use(statisticsRouter);

  const advancedStatsRouter = initAdvancedStatsRoutes(db, scheduleSave, addLog, authMiddleware, requireRole, localDateStr, formatDate, nowTimestamp);
  app.use(advancedStatsRouter);

  const aiRouter = initAIRoutes({
    db, scheduleSave, upload, fs, path, authMiddleware, nowTimestamp,
    localDateStr, formatDate, addLog, broadcast, validateToken,
    ROOT_DIR: config.ROOT_DIR, STUDENT_TOKENS, sendWebhook
  });
  app.use(aiRouter);

  const systemRouter = initSystemRoutes(
    db, scheduleSave, addLog, broadcast, sendWebhook,
    upload, QRCode, multer, os, config.ROOT_DIR, config.UPLOAD_DIR, config.BACKUP_DIR
  );
  app.use(systemRouter);

  // Register export routes for Excel and PDF reports
  const exportRouter = initExportRoutes({ db, scheduleSave, authMiddleware, PDFDocument, addLog });
  app.use(exportRouter);
const monitorRouter = initMonitorRoutes({db, dbFile, authMiddleware, addLog, sendWebhook});
app.use(monitorRouter);

  // 活体检测专用路由（可单独调用）
  const livenessRouter = initLivenessRoutes({ authMiddleware });
  app.use(livenessRouter);

  // 小程序专属路由（移动端）
  const mobileRouter = initMobileRoutes({ db, scheduleSave, authMiddleware, upload });
  app.use(mobileRouter);

  // 详细监控指标路由
  const metricsRouter = initMetricsRoutes({ db, authMiddleware });
  app.use(metricsRouter);
const notifyRouter = initNotifyRoutes({ db, authMiddleware });
app.use(notifyRouter);
const alertsRouter = initAlertsRoutes({ db, authMiddleware, scheduleSave, addLog });
app.use(alertsRouter);
const webhookRouter = initWebhookRoutes({ db, authMiddleware, addLog });
app.use(webhookRouter);

// CSRF 防护：在所有业务路由挂载后，对写操作进行 CSRF 验证
// GET/HEAD/OPTIONS 自动跳过，仅 POST/PUT/DELETE/PATCH 需要 token
app.use(csrfProtection);

logger.info('所有路由模块已挂载');

  // 导出全局共享函数（向后兼容）
  global.broadcast = broadcast;
  global.sendWebhook = sendWebhook;
}

// ==================== 全局错误处理 ====================
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 1, message: '请求参数错误' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ code: 1, message: '文件过大，最大支持 10MB' });
  }
  logger.error('❌ 未处理的错误:', err.message);
  res.status(500).json({ code: 1, message: '服务器内部错误' });
});

// ==================== 数据库初始化 & 启动 ====================
(async () => {
  try {
    const SQL = await initSqlJs();
    const data = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
    db = new SQL.Database(data || []);
    setAppDb(db); // 注入 db 引用，供“今天”锚定（clampedToday）使用
    logger.info('SQLite 数据库加载成功');

    // 包装 db.exec/db.run 以捕获 undefined 参数绑定（调试用，定位 422/崩溃根因）
    const _origExec = db.exec.bind(db);
    const _origRun = db.run.bind(db);
    db.exec = function(sql, params) {
      if (params && Array.isArray(params)) {
        for (let i = 0; i < params.length; i++) {
          if (params[i] === undefined) {
            params[i] = ''; // 兜底：替换为空字符串防止崩溃
          }
        }
      }
      return _origExec(sql, params);
    };
    db.run = function(sql, params) {
      if (params && Array.isArray(params)) {
        for (let i = 0; i < params.length; i++) {
          if (params[i] === undefined) {
            params[i] = '';
          }
        }
      }
      return _origRun(sql, params);
    };
    
    // 优化数据库性能
    optimizeDbConfig(db);
    
    // 执行数据库迁移
    runMigrations(db, dbFile);
    
    // 验证数据库完整性
    const validation = validateDatabase(db);
    if (!validation.valid) {
      logger.error('数据库验证失败:', validation.errors);
    } else if (validation.warnings.length > 0) {
      logger.warn('数据库验证警告:', validation.warnings);
    }
    
    // 创建索引
    createIndexes(db);
  } catch (initErr) {
    logger.error('数据库初始化失败:', initErr.message);
    process.exit(1);
  }

  db.run(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, display_name TEXT DEFAULT '');`);
  db.run(`CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, gender TEXT, class_name TEXT NOT NULL, dorm TEXT, phone TEXT, password_hash TEXT DEFAULT '', must_change_pwd INTEGER DEFAULT 0, face_hash TEXT DEFAULT '');`);
  try { db.run("ALTER TABLE students ADD COLUMN gender TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE students ADD COLUMN student_id TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE students ADD COLUMN password_hash TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE students ADD COLUMN must_change_pwd INTEGER DEFAULT 0"); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, student_id TEXT, date TEXT, time TEXT, type TEXT, status TEXT, note TEXT, latitude REAL, longitude REAL, address TEXT, photo_path TEXT, course_id TEXT, course_name TEXT, offline INTEGER DEFAULT 0, class_name TEXT);`);
    try { db.run("ALTER TABLE records ADD COLUMN liveness_passed INTEGER DEFAULT 0"); } catch(e) {}   // 活体检测是否通过（防照片代签）
    try { db.run("ALTER TABLE records ADD COLUMN liveness_score REAL DEFAULT 0"); } catch(e) {}        // 活体置信度 0~1
  db.run(`CREATE TABLE IF NOT EXISTS leaves(id TEXT PRIMARY KEY, student_id TEXT, type TEXT, reason TEXT, start_date TEXT, end_date TEXT, attachment_path TEXT, status TEXT, created_at TEXT, processed_at TEXT, processed_by TEXT, comment TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS courses(id TEXT PRIMARY KEY, name TEXT, date TEXT, start_time TEXT, end_time TEXT, location TEXT, class_name TEXT, created_at TEXT);`);
  try { db.run("ALTER TABLE courses ADD COLUMN date TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE courses ADD COLUMN start_time TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE courses ADD COLUMN end_time TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE courses ADD COLUMN created_at TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE courses ADD COLUMN class_name TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE leaves ADD COLUMN comment TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE leaves ADD COLUMN processed_at TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE leaves ADD COLUMN processed_by TEXT DEFAULT ''"); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS logs(id TEXT PRIMARY KEY, time TEXT, action TEXT, detail TEXT, level TEXT, operator TEXT DEFAULT '');`);
  try { db.run("ALTER TABLE logs ADD COLUMN operator TEXT DEFAULT ''"); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS dorms(id TEXT PRIMARY KEY, building TEXT, room TEXT, capacity INTEGER DEFAULT 6, gender TEXT DEFAULT 'male', floor INTEGER, occupied INTEGER DEFAULT 0);`);
  try { db.run("ALTER TABLE dorms ADD COLUMN occupied INTEGER DEFAULT 0"); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS visitors(id TEXT PRIMARY KEY, visitor_name TEXT, visitor_id_card TEXT, visitor_phone TEXT, target_student_id TEXT, target_dorm TEXT, visit_purpose TEXT, visit_date TEXT, visit_time TEXT, visitor_photo_path TEXT, checked_in INTEGER DEFAULT 0, checked_out INTEGER DEFAULT 0, checked_out_time TEXT, note TEXT, created_at TEXT);`);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_visitors_date ON visitors(visit_date)"); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`);

  try { db.run("CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_records_student ON records(student_id)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_records_status ON records(status)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_records_composite ON records(student_id, date, type, status)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_name)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_students_dorm ON students(dorm)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_leaves_student ON leaves(student_id)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(status)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_courses_date ON courses(date)"); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, date TEXT, class_name TEXT, remark TEXT, status TEXT DEFAULT 'pending', created_at TEXT, created_by TEXT);`);

  // ==================== 新功能：异常闭环告警 ====================
  // 未归自动建单 → 推送辅导员 → 跟进登记 → 销号闭环
  db.run(`CREATE TABLE IF NOT EXISTS absence_alerts(
    id TEXT PRIMARY KEY, student_id TEXT, student_name TEXT, class_name TEXT, date TEXT,
    status TEXT DEFAULT 'open', reason TEXT DEFAULT '', note TEXT DEFAULT '',
    created_at TEXT, closed_at TEXT DEFAULT '', closed_by TEXT DEFAULT '');`);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_alerts_status ON absence_alerts(status)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_alerts_date ON absence_alerts(date)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_alerts_class ON absence_alerts(class_name)"); } catch(e) {}

  // ==================== 新功能：语音签到 / GPS 围栏 / 企业微信集成 ====================
  try { db.run("CREATE TABLE voice_records(id TEXT PRIMARY KEY, student_id TEXT, audio_path TEXT, text TEXT, timestamp TEXT, date TEXT, status TEXT DEFAULT 'success', note TEXT)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_voice_student ON voice_records(student_id)"); } catch(e) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_voice_date ON voice_records(date)"); } catch(e) {}
  
  try { db.run("CREATE TABLE geofence_rules(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters REAL DEFAULT 200, type TEXT DEFAULT 'dorm', active INTEGER DEFAULT 1, created_at TEXT DEFAULT '')"); } catch(e) {}
  
  try { db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('wecom_webhook_url', '')"); } catch(e) {}
  try { db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('wecom_enabled', '0')"); } catch(e) {}
  try { db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('dingtalk_webhook_url', '')"); } catch(e) {}
  try { db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('dingtalk_enabled', '0')"); } catch(e) {}

  try { db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('webhook_url', '')"); } catch(e) {}
  try { db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('webhook_enabled', '0')"); } catch(e) {}
  try { db.run("INSERT OR IGNORE INTO settings(key, value) VALUES('webhook_type', 'wecom')"); } catch(e) {}

  // 初始化自动备份
  initAutoBackup(db, dbFile, BACKUP_DIR);

  const adminExists = db.exec("SELECT 1 FROM users WHERE username='admin' LIMIT 1;")[0]?.values?.length;
  if (!adminExists) {
  // P0: 必须有明确的默认密码（从环境变量），绝不允许静默回退到 admin123
  // 缺失时直接报错拒绝启动，强制管理员显式配置强密码
  const defaultPwd = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!defaultPwd || defaultPwd.trim() === '') {
    throw new Error('环境变量 DEFAULT_ADMIN_PASSWORD 未设置，必须显式配置管理员默认密码才能启动');
  }
  const hash = await bcrypt.hash(defaultPwd, 12);
  db.run("INSERT INTO users(id, username, password_hash, role, display_name) VALUES('admin', 'admin', ?, 'admin', '管理员')", [hash]);
  logger.info(`🔑 默认管理员账号已创建 (用户名: admin)`);
  }
  try { db.run("ALTER TABLE users ADD COLUMN class_name TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE students ADD COLUMN face_hash TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE visitors ADD COLUMN face_hash TEXT DEFAULT ''"); } catch(e) {}

  // 添加数据库健康检测 API
  app.get('/api/db/health', authMiddleware, (req, res) => {
    try {
      const stats = healthCheck(db);
      res.json({
        code: 0,
        data: {
          ...stats,
          sizeMB: (stats.size / 1024 / 1024).toFixed(2),
        }
      });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // 添加数据库压缩 API
  app.post('/api/db/vacuum', authMiddleware, requireRole(['admin']), (req, res) => {
    try {
      const success = vacuum(db);
      scheduleSave();
      res.json({ code: 0, message: success ? '数据库压缩成功' : '数据库压缩失败' });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  process.on('exit', forceSave);
  process.on('SIGINT', () => { forceSave(); process.exit(); });
  process.on('SIGTERM', () => { forceSave(); process.exit(); });

  setDb(db);
  scheduleSave();

  // 挂载路由
  mountRoutes();

  // ==================== Prometheus 指标端点 ====================
  // 暴露 /metrics 供 Prometheus 抓取，返回 text 格式的指标数据
  const { register } = require('./utils/metrics');
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (e) {
      logger.error('Prometheus metrics error:', e);
      res.status(500).end(e.message);
    }
  });

  // P1 修复：reports / uploads 为学生数据（考勤报告、人脸照片），禁止未认证直接下载。
  // 先注册带鉴权的下载路由（登录后可访问，防目录穿越）；其后用拦截器兜底
  // 拦截裸目录 /reports/ /uploads/ 等未被下载路由匹配的路径。
  // 顺序不能颠倒：拦截器若不先让位，会把带鉴权请求也一并 403 掉。
  app.get(['/reports/:file', '/uploads/:file'], authMiddleware, (req, res) => {
    const dirName = req.path.startsWith('/uploads') ? 'uploads' : 'reports';
    const safe = path.basename(req.params.file || ''); // 去除目录穿越
    if (!safe || safe === '.' || safe === '..') {
      return res.status(400).json({ code: 1, message: '非法文件名' });
    }
    const fp = path.join(__dirname, 'public', dirName, safe);
    fs.stat(fp, (err) => {
      if (err) return res.status(404).json({ code: 1, message: '资源不存在' });
      res.download(fp, safe);
    });
  });

  app.use(['/uploads/', '/reports/'], (req, res) => {
    logger.warn('[静态拦截]', req.method, req.path, '敏感目录需经鉴权接口访问');
    res.status(403).json({ code: 1, message: '该资源需登录后通过认证接口访问' });
  });

  // 静态文件服务
  // HTML页面禁用缓存(实时获取最新), JS/CSS启用长期缓存提升性能
  app.use('/js/', express.static(path.join(__dirname, 'public', 'js'), { maxAge: '31536000' }));
  app.use('/css/', express.static(path.join(__dirname, 'public', 'css'), { maxAge: '31536000' }));
  app.use('/icons/', express.static(path.join(__dirname, 'public', 'icons'), { maxAge: '31536000' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '0' }));

  // Favicon handler
  app.get('/favicon.ico', (req, res) => {
    res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎓</text></svg>');
  });

  // 404 handler (必须放在最后)
  app.use((req, res, next) => {
    logger.warn('[404]', req.method, req.path);
    res.status(404).json({ code: 1, message: '接口不存在' });
  });

  // P2: 审计日志中间件——记录所有导出操作的访问者 IP、用户、参数，满足学工处"谁导出了什么数据"的验收要求
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/export/') && req.method === 'GET') {
      try {
        const operator = req.user ? String(req.user.userId || 'unknown') : 'anonymous';
        const ip = req.ip || (req.connection && req.connection.remoteAddress) || '-';
        addLog('DATA_EXPORT', `type=${req.path.split('/').pop()} params=${JSON.stringify(req.query)} ip=${ip} user=${operator}`, 'INFO', operator);
      } catch (e) { /* 审计失败不影响主流程 */ }
    }
    next();
  });

  // HTTP 实际监听端口：可随 EADDRINUSE 自增（PORT 本身是 const，不能改）
  let listeningPort = PORT;

  server.listen(listeningPort, '0.0.0.0', () => {
    logger.info(`\n🎓 学管 SmartEdu v3.8 (模块化 + AI预测/问答) 已启动！`);
    logger.info(`📡 服务器:      http://localhost:${listeningPort}`);
    logger.info(`📱 学生端:      http://localhost:${listeningPort}/student.html`);
    logger.info(`💻 教师端:      http://localhost:${listeningPort}/teacher.html`);
    logger.info(`📊 数据大屏:    http://localhost:${listeningPort}/dashboard.html`);
    logger.info(`🤖 AI 能力:     数据预测 + 人脸识别 + 智能问答`);
    logger.info(`📁 数据:        ${config.ROOT_DIR}`);
    logger.info(`💾 备份:        ${config.BACKUP_DIR}`);

    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach(ifname => {
      ifaces[ifname].forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal) {
          logger.info(`🔗 局域网: http://${iface.address}:${listeningPort}`);
        }
      });
    });
    // 实际端口确定后持久化，确保 server.bat 能准确定位（含 EADDRINUSE 递增后的端口）
    persistRuntimePort();
    
    setTimeout(() => {
      try {
        // HTTPS 证书策略：如果证书不存在则自动生成自签名证书
        if (!fs.existsSync(SSL_KEY) || !fs.existsSync(SSL_CERT)) {
          if (process.env.AUTO_GENERATE_SSL !== 'false') {
            logger.info('SSL 证书不存在，尝试自动生成自签名证书...');
            const crypto2 = require('crypto');
            const hasSSCert = typeof crypto2.createSelfSignedCertificate === 'function';
            if (!hasSSCert) {
              // 当前 Node 构建不提供 createSelfSignedCertificate（行为随版本变化）。
              // 降级为提示手动放置证书，HTTP 端口继续可用，HTTPS 跳过。
              logger.warn(`SSL 自动生成不可用（Node ${process.version} 缺少 createSelfSignedCertificate）。` +
                `请手动将 server.key/server.crt 放入 ${SSL_DIR} 后重启；当前仅 HTTP 可用。`);
            } else {
              try {
                const { privateKey, publicKey } = crypto2.generateKeyPairSync('rsa', {
                  modulusLength: 2048,
                  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
                  publicKeyEncoding: { type: 'spki', format: 'pem' }
                });
                const cert = crypto2.createSelfSignedCertificate({
                  publicKey,
                  validFrom: new Date(),
                  validTo: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
                  subject: { C: 'CN', ST: 'Beijing', L: 'Beijing', O: 'SmartEdu', OU: 'IT', CN: 'localhost' }
                });
                fs.mkdirSync(SSL_DIR, { recursive: true });
                fs.writeFileSync(SSL_KEY, privateKey);
                fs.writeFileSync(SSL_CERT, cert);
                logger.info('SSL 证书已自动生成到 ssl/ 目录');
              } catch (sslGenErr) {
                logger.error('SSL 证书自动生成失败，HTTPS 暂不可用:', sslGenErr.message);
              }
            }
          }
        }

        if (fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
          const https = require('https');
          const httpsServer = https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, app);
          const wssHttps = new WebSocketServer({ server: httpsServer, verifyClient: wsVerifyClient });
          wssHttps.on('connection', ws => { ws.on('error', (err) => logger.error('HTTPS WebSocket错误:', err.message)); });
          httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
            logger.info(`🔒 HTTPS: https://localhost:${HTTPS_PORT}`);
          }).on('error', (err) => logger.error(`HTTPS服务器启动失败: ${err.message}`));
        }
      } catch(e) { logger.error(`HTTPS启动异常: ${e.message}`); }
    }, 1000);
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE' && listeningPort < 3100) {
      // 端口被占用则递增重试（上限 3100），listeningPort 为可变变量，
      // 实际端口确定后由 listen 回调持久化到 .runtime-port
      listeningPort += 1;
      logger.warn(`端口 ${listeningPort - 1} 被占用，尝试端口 ${listeningPort}...`);
      await new Promise(resolve => setTimeout(resolve, 500));
      server.listen(listeningPort, '0.0.0.0');
    }
  });

  // P4 修复：把实际监听端口持久化到 config/.runtime-port，
  // 供 server.bat 在端口因 EADDRINUSE 自动递增后仍能准确定位并停止进程。
  function persistRuntimePort() {
    try {
      const runtimePortFile = path.join(config.ROOT_DIR, '.runtime-port');
      fs.writeFileSync(runtimePortFile, String(listeningPort));
    } catch (e) { /* 写失败不影响运行 */ }
  }
  process.on('exit', () => {
    try { fs.unlinkSync(path.join(config.ROOT_DIR, '.runtime-port')); } catch (e) {}
  });
})();

// ==================== /api/needs 端点 ====================
app.get('/api/needs', (req, res) => {
  try {
    // README.md 在项目根（APP_ROOT），而非 config/ROOT_DIR
    const readmePath = path.join(config.APP_ROOT, 'README.md');
    const content = fs.readFileSync(readmePath, 'utf-8');
    const startIdx = content.indexOf('## 📝 后续改进计划');
    if (startIdx === -1) return res.json({ code: 1, message: '未找到改进计划章节' });
    const after = content.slice(startIdx);
    const endIdx = after.search(/\n##\s+/);
    const section = endIdx === -1 ? after : after.slice(0, endIdx);
    res.json({ code: 0, data: { markdown: section.trim() } });
  } catch (e) {
    res.json({ code: 1, message: e.message });
  }
});

module.exports = { app, server, createBackup: systemCreateBackup };


