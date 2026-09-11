const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, errors, json } = format;

/**
 * 自定义日志格式
 * @type {format.Format}
 */
const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}] ${stack || message}`;
});

/**
 * Winston 日志记录器实例
 * - 控制台输出（彩色）
 * - 文件输出（每日轮转，最大 5MB，保留 5 个文件）
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
    new transports.Console({
      format: combine(format.colorize(), logFormat),
    }),
    /**
     * 文件输出（每日轮转）
     */
    new transports.File({
      filename: 'logs/app.log',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;
