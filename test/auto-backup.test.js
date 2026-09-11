/**
 * 自动备份模块测试
 */
const fs = require('fs');
const path = require('path');
const { initAutoBackup, cleanupOldBackups } = require('../utils/auto-backup');

describe('auto-backup utility', () => {
  describe('cleanupOldBackups', () => {
    test('should remove backups older than retention days', () => {
      const backupDir = path.join(__dirname, '..', 'backups');
      
      // Create some test files
      const now = Date.now();
      const oldFile = path.join(backupDir, `data.db.bak.${new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-')}`);
      const newFile = path.join(backupDir, `data.db.bak.${new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-')}`);
      
      fs.writeFileSync(oldFile, 'test');
      fs.writeFileSync(newFile, 'test');
      
      cleanupOldBackups(backupDir, 7);
      
      // Old file should be removed
      expect(fs.existsSync(oldFile)).toBe(false);
      // New file should remain
      expect(fs.existsSync(newFile)).toBe(true);
      
      // Cleanup
      fs.unlinkSync(newFile);
    });
  });

  describe('initAutoBackup', () => {
    test('should initialize backup schedule', () => {
      const db = { run: jest.fn() };
      const dbFile = path.join(__dirname, '..', 'data.db');
      const backupDir = path.join(__dirname, '..', 'backups');
      
      // Create a dummy data.db file for testing
      if (!fs.existsSync(dbFile)) {
        fs.writeFileSync(dbFile, 'dummy');
      }
      
      initAutoBackup(db, dbFile, backupDir);
      
      // Should have scheduled a backup
      expect(setTimeout).toHaveBeenCalled();
      
      // Cleanup dummy file
      if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
      }
    });
  });
});
