/**
 * 统一配置模块
 * 集中管理所有配置项，避免散落在多处
 */

const path = require('path');
const fs = require('fs');

// ==================== 基础配置 ====================
const ROOT_DIR = __dirname;            // config/ 目录（存放数据/日志/备份）
const APP_ROOT = path.join(__dirname, '..'); // 项目根目录（前端静态/SSL 证书/上传实际所在处）
const PORT = parseInt(process.env.PORT) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT) || 3443;

// ==================== 路径配置 ====================
// SSL 证书放在项目根 ssl/（真实证书所在位置；config/ssl 为空目录是历史遗留）
const SSL_DIR = path.join(APP_ROOT, 'ssl');
const SSL_KEY = path.join(SSL_DIR, 'server.key');
const SSL_CERT = path.join(SSL_DIR, 'server.crt');
// 用户上传/报告与前端静态资产均在项目根 public/ 下（config/public 是历史空目录）
const UPLOAD_DIR = path.join(APP_ROOT, 'public', 'uploads');
const BACKUP_DIR = path.join(ROOT_DIR, 'backups');
const DB_FILE = path.join(ROOT_DIR, 'data.db');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');

// ==================== 业务配置 ====================
const CLASS_SIZE_LIMIT = parseInt(process.env.CLASS_SIZE_LIMIT) || 40;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15分钟
const LOGIN_RATE_LIMIT_MAX_REQUESTS = 5; // 最多5次尝试
const STUDENT_TOKEN_EXPIRY = 8 * 60 * 60 * 1000; // 8小时
const AI_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟

// ==================== AI 配置 ====================
const ZHIPU_AI_API_KEY = process.env.ZHIPU_AI_API_KEY || '';
const ZHIPU_AI_BASE_URL = process.env.ZHIPU_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';

// ==================== 地图配置 ====================
const AMAP_MAP_KEY = process.env.AMAP_MAP_KEY || '';
const TENCENT_MAP_KEY = process.env.TENCENT_MAP_KEY || '';
const BAIDU_MAP_KEY = process.env.BAIDU_MAP_KEY || '';

// ==================== 通知配置 ====================
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED === '1';

// ==================== 目录初始化 ====================
function ensureDirectories() {
  [UPLOAD_DIR, BACKUP_DIR, LOG_DIR, SSL_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// ==================== 配置验证 ====================
function validateConfig() {
  const errors = [];
  
  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET 未设置');
  } else if (process.env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET 长度不足 32 位');
  }
  
  return errors;
}

// ==================== 导出 ====================
module.exports = {
  // 路径
  ROOT_DIR,
  APP_ROOT,
  SSL_DIR,
  SSL_KEY,
  SSL_CERT,
  UPLOAD_DIR,
  BACKUP_DIR,
  DB_FILE,
  LOG_DIR,
  PUBLIC_DIR,
  
  // 端口
  PORT,
  HTTPS_PORT,
  
  // 业务
  CLASS_SIZE_LIMIT,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  LOGIN_RATE_LIMIT_MAX_REQUESTS,
  STUDENT_TOKEN_EXPIRY,
  AI_CACHE_TTL_MS,
  
  // AI
  ZHIPU_AI_API_KEY,
  ZHIPU_AI_BASE_URL,
  
  // 地图
  AMAP_MAP_KEY,
  TENCENT_MAP_KEY,
  BAIDU_MAP_KEY,
  
  // 通知
  WEBHOOK_URL,
  WEBHOOK_ENABLED,
  
  // 方法
  ensureDirectories,
  validateConfig
};
