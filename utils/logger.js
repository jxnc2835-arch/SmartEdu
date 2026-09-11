const { createLogger, format: winstonFormat } = require('winston');
const { combine, timestamp, printf, errors, json } = winstonFormat;
const DailyRotateFile = require('winston-daily-rotate-file');

/**
 * 自定义日志格式
 * @type {winstonFormat.Format}
 */
const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}] ${stack || message}`;
});

/**
 * 从日志目录（默认 logs/）解析路径，避免随 process.cwd() 漂移
 */
const logDir = process.env.LOG_DIR || 'logs';

/**
 * Winston 日志记录器实例
 * - 控制台输出（彩色）
 * - 文件输出：winston-daily-rotate-file，按天轮转 + 单文件 5MB 上限，保留 14 天
 */
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }), // 捕获错误堆栈
    json(), // 结构化 JSON，便于日志系统收集
    logFormat
  ),
  transports: [
    /**
     * 控制台输出（彩色）
     */
    new (require('winston').transports.Console)({
      format: combine(winstonFormat.colorize(), logFormat),
    }),
    /**
     * 文件输出（每日轮转 + 单文件 5MB 上限 + 保留 14 天）
     * 原 winston.File 的 maxFiles 语义在滚动后不清理旧文件，日志会无限膨胀；
     * 改用 winston-daily-rotate-file 按天切分并按 maxFiles='14d' 自动清理。
     */
    new DailyRotateFile({
      dirname: logDir,
      filename: 'app.log',
      datePattern: 'YYYY-MM-DD',
      formatExtension: 'log',
      maxFiles: '14d',
      maxSize: 5 * 1024 * 1024, // 5MB
      zippedArchive: false,
    }),
  ],
});

module.exports = logger;
