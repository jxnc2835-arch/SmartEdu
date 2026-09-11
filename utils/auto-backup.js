/**
 * auto-backup.js - 自动定时备份模块
 * 每天凌晨 2 点自动备份数据库
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let dbInstance = null;
let backupDir = null;
let scheduledTimer = null;

/**
 * 初始化自动备份
 * @param {object} db - SQLite 数据库实例
 * @param {string} dbFilePath - 数据库文件路径
 * @param {string} backupDirectory - 备份目录
 */
function initAutoBackup(db, dbFilePath, backupDirectory) {
  dbInstance = db;
  backupDir = backupDirectory || path.join(path.dirname(dbFilePath), 'backups');

  // 确保备份目录存在
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // 启动时立即备份一次
  performBackup('startup');

  // 每天凌晨 2 点备份
  scheduleDailyBackup(2, 0);

  logger.info('自动备份已启用，每天 02:00 执行');
}

/**
 * 执行一次备份
 * @param {string} reason - 备份原因
 */
function performBackup(reason = 'manual') {
  if (!dbInstance) {
    logger.warn('数据库实例未初始化，跳过备份');
    return false;
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `data_backup_${timestamp}_${reason}.db`;
    const backupPath = path.join(backupDir, backupName);

    const data = dbInstance.export();
    fs.writeFileSync(backupPath, Buffer.from(data));

    // 获取备份文件大小
    const stats = fs.statSync(backupPath);
    logger.info(`备份完成: ${backupName} (${(stats.size / 1024).toFixed(2)} KB)`);

    // 清理 7 天前的旧备份
    cleanupOldBackups(7);

    return true;
  } catch (err) {
    logger.error(`备份失败: ${err.message}`);
    return false;
  }
}

/**
 * 安排每日备份
 * @param {number} hour - 小时（0-23）
 * @param {number} minute - 分钟（0-59）
 */
function scheduleDailyBackup(hour = 2, minute = 0) {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
  }

  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);

  // 如果今天的时间已过，安排到明天
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  const msUntilBackup = target.getTime() - now.getTime();

  scheduledTimer = setTimeout(() => {
    performBackup('daily');
    // 递归安排下一次
    scheduleDailyBackup(hour, minute);
  }, msUntilBackup);

  logger.info(`下次自动备份时间: ${target.toISOString()}`);
}

/**
 * 清理旧备份文件
 * @param {number} daysToKeep - 保留天数
 */
function cleanupOldBackups(daysToKeep = 7) {
  try {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(backupDir);

    for (const file of files) {
      if (!file.startsWith('data_backup_') || !file.endsWith('.db')) continue;

      const filePath = path.join(backupDir, file);
      const stats = fs.statSync(filePath);

      if (stats.mtimeMs < cutoffTime) {
        fs.unlinkSync(filePath);
        logger.info(`清理旧备份: ${file}`);
      }
    }
  } catch (err) {
    logger.error(`清理备份失败: ${err.message}`);
  }
}

/**
 * 停止自动备份
 */
function stopAutoBackup() {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
}

module.exports = { initAutoBackup, performBackup, stopAutoBackup, cleanupOldBackups };
