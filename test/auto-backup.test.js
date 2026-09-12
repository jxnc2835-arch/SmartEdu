/**
 * 自动备份模块测试
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('auto-backup utility', () => {
  let cleanupOldBackups;
  let initAutoBackup;
  let originalSetTimeout;
  // 用临时目录做备份目录，避免污染项目根 backups/（历史 bug：曾写入根目录产生 200+ 个 4 字节 junk 文件）
  let backupDir;

  beforeEach(() => {
    jest.useFakeTimers();
    originalSetTimeout = global.setTimeout;
    global.setTimeout = jest.fn();
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartedu-backup-test-'));
    const backupModule = require('../utils/auto-backup');
    cleanupOldBackups = backupModule.cleanupOldBackups;
    initAutoBackup = backupModule.initAutoBackup;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.setTimeout = originalSetTimeout;
    if (backupDir && fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  });

  describe('cleanupOldBackups', () => {
    test('should remove backups older than retention days', () => {
      const db = { run: jest.fn(), export: () => Buffer.from('test') };
      const dbFile = path.join(backupDir, 'data.db');
      if (!fs.existsSync(dbFile)) {
        fs.writeFileSync(dbFile, 'dummy');
      }
      initAutoBackup(db, dbFile, backupDir);

      const now = Date.now();
      const oldFile = path.join(backupDir, `data_backup_1970-01-01T00-00-00-000Z_manual.db`);
      const newFile = path.join(backupDir, `data_backup_${new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-')}_manual.db`);

      fs.writeFileSync(oldFile, 'test');
      fs.writeFileSync(newFile, 'test');

      const oldTime = new Date(now - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, oldTime, oldTime);

      cleanupOldBackups(7);

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);

      fs.unlinkSync(newFile);
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
    });
  });

  describe('initAutoBackup', () => {
    test('should initialize backup schedule', () => {
      const db = { run: jest.fn(), export: () => Buffer.from('test') };
      const dbFile = path.join(backupDir, 'data.db');
      if (!fs.existsSync(dbFile)) {
        fs.writeFileSync(dbFile, 'dummy');
      }
      initAutoBackup(db, dbFile, backupDir);

      expect(global.setTimeout).toHaveBeenCalled();

      if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
      }
    });
  });
});
