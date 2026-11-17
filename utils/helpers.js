const path = require('path');
const fs = require('fs');
const config = require('../config');

// ==================== 工具函数 ====================
// 模块级数据库引用（由 server.js 启动时 setAppDb(db) 注入），用于"今天"锚定
let appDatabase = null;
function setAppDb(db) {
  appDatabase = db;
}
function getAppDb() {
  return appDatabase;
}

// 北京时间日期字符串：YYYY-MM-DD（无论服务器时区，均返回北京时间）
// 关键：当系统时钟已晚于模拟数据的最新【完整】日时，回退到该日作为“今天”，
// 避免数据冻结在 2026-07-17、而时钟走到 07-18 后，所有按“今天”过滤的视图空白。
function localDateStr() {
  return clampedToday(appDatabase);
}

// 格式化日期为 YYYY-MM-DD（北京时间）
function formatDate(d) {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600 * 1000);
  return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}-${String(bj.getDate()).padStart(2, '0')}`;
}

// 当前时间戳（北京时间 YYYY-MM-DD HH:mm:ss）
function nowTimestamp() {
  const utc = Date.now() + new Date().getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`;
}

function saveBase64Photo(base64Str, prefix = 'photo') {
  if (!base64Str) return null;
  // 仅允许 image/jpeg 和 image/png
  if (!/^data:image\/(jpeg|png);base64,/.test(base64Str)) return null;
  // 移除 data:image/xxx;base64, 前缀
  const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  // 校验文件类型魔数
  if (buffer.length < 8) return null;
  const magic = buffer.slice(0, 8).toString('hex');
  const isJpeg = magic.startsWith('ffd8ff');
  const isPng = magic.startsWith('89504e47');
  if (!isJpeg && !isPng) return null;
  const fileName = prefix + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + (isJpeg ? '.jpg' : '.png');
  const destPath = path.join(config.UPLOAD_DIR, fileName);
  // 确保uploads目录存在
  if (!fs.existsSync(config.UPLOAD_DIR)) {
    fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  }
  fs.writeFileSync(destPath, buffer);
  return '/uploads/' + fileName;
}

// 北京时间时间戳（用于备份文件命名）
function beijingStamp() {
  const d = new Date();
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// 图片压缩工具函数
function compressImage(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const { quality = 0.7, maxWidth = 1200 } = options;
    
    // 读取图片
    const data = fs.readFileSync(inputPath);
    
    // 对于生产环境，建议安装 sharp: npm install sharp
    try {
      // 这里我们只是复制文件，实际项目中应该使用sharp或imagemagick
      fs.copyFileSync(inputPath, outputPath);
      resolve(outputPath);
    } catch (err) {
      reject(err);
    }
  });
}

// 北京时间日期字符串：YYYY-MM-DD
// 可选参数 d：Date 对象（缺省=当前时间）。传参时返回该时刻对应的北京日期，
// 修复旧版忽略参数导致"传 30 天前也返回今天"的窗口计算 bug。
function beijingDateStr(d) {
  const src = (d instanceof Date && !isNaN(d.getTime())) ? d : new Date();
  const utc = src.getTime() + src.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600 * 1000);
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const day = String(bj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 北京时间完整时间字符串：YYYY-MM-DD HH:mm:ss
function beijingTimestamp() {
  const utc = new Date().getTime() + new Date().getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600 * 1000);
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  const h = String(bj.getHours()).padStart(2, '0');
  const mi = String(bj.getMinutes()).padStart(2, '0');
  const s = String(bj.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${mi}:${s}`;
}

// 真实北京时间“今天”（不受数据影响）
function realBeijingToday() {
  const utc = Date.now() + new Date().getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())}`;
}

// “今天”锚定：若真实时钟已超过数据的最新【完整】日（如模拟数据冻结在 2026-07-17，
// 而系统时钟已走到 07-18），则回退到最新“数据完整”的一天作为“今天”，
// 避免所有按“今天”过滤的视图（宿舍异常/大屏/重点关注窗口）因时钟越界而空白。
// 数据完整判定：当天查寝记录数 >= 学生总数的 90%。
let todayCache = { timestamp: 0, value: null };
function clampedToday(db) {
  const now = Date.now();
  if (todayCache.value && now - todayCache.timestamp < 60000) return todayCache.value;
  const real = realBeijingToday();
  let chosen = real;
  try {
    const tRes = db && db.exec("SELECT COUNT(*) FROM students");
    const total = (tRes && tRes[0] && tRes[0].values[0][0]) || 0;
    const thr = Math.max(1, Math.floor(total * 0.9));
    const r = db.exec(
      "SELECT date FROM records WHERE type='checkin' GROUP BY date HAVING COUNT(*) >= ? ORDER BY date DESC LIMIT 1",
      [thr]
    );
    const mv = r && r[0] && r[0].values[0] && r[0].values[0][0];
    if (mv) chosen = mv;
  } catch (e) {}
  todayCache = { timestamp: now, value: chosen };
  return chosen;
}

module.exports = { localDateStr, formatDate, nowTimestamp, saveBase64Photo, beijingStamp, beijingDateStr, beijingTimestamp, compressImage, clampedToday, realBeijingToday, setAppDb, getAppDb };
