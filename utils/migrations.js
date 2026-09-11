/**
 * 数据库迁移工具
 * 支持 schema 版本管理、增量更新、数据迁移
 */

const fs = require('fs');
const path = require('path');

// 当前 schema 版本
const CURRENT_SCHEMA_VERSION = 15;

/**
 * 执行数据库迁移
 * @param {object} db - sql.js Database 实例
 * @param {string} dbFile - 数据库文件路径
 */
function runMigrations(db, dbFile) {
  console.log('🔄 开始数据库迁移检查...');
  
  // 获取当前 schema 版本
  const versionRow = db.exec("SELECT value FROM settings WHERE key='schema_version'")[0]?.values?.[0];
  const currentVersion = versionRow ? parseInt(versionRow[0]) : 0;
  
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    console.log(`✅ 数据库已是最新版本 (v${CURRENT_SCHEMA_VERSION})`);
    return;
  }
  
  console.log(`📊 当前版本: v${currentVersion} → 目标版本: v${CURRENT_SCHEMA_VERSION}`);
  
  // 执行增量迁移
  const migrations = [
    // v1: 初始表结构（已由 server.js 处理）
    // v2-v14: 各种功能扩展
    // v15: 添加更多索引优化
    {
      version: 15,
      name: '添加性能索引',
      apply: (db) => {
        const indexes = [
          'CREATE INDEX IF NOT EXISTS idx_students_class_dorm ON students(class_name, dorm)',
          'CREATE INDEX IF NOT EXISTS idx_records_date_status ON records(date, status)',
          'CREATE INDEX IF NOT EXISTS idx_leaves_status_date ON leaves(status, start_date)',
          'CREATE INDEX IF NOT EXISTS idx_visitors_date_status ON visitors(visit_date, checked_in)'
        ];
        indexes.forEach(sql => {
          try { db.run(sql); } catch (e) { console.warn('索引创建失败:', e.message); }
        });
      }
    }
  ];
  
  // 按版本顺序执行迁移
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      console.log(`📦 执行迁移 v${migration.version}: ${migration.name}`);
      try {
        migration.apply(db);
        // 更新版本号
        db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('schema_version', ?)", [migration.version]);
        console.log(`✅ v${migration.version} 迁移完成`);
      } catch (e) {
        console.error(`❌ v${migration.version} 迁移失败:`, e.message);
        throw e;
      }
    }
  }
  
  console.log(`🎉 所有迁移完成，数据库已升级到 v${CURRENT_SCHEMA_VERSION}`);
}

/**
 * 导出数据库 schema（用于文档和版本控制）
 * @param {object} db - sql.js Database 实例
 * @returns {string} SQL schema 文本
 */
function exportSchema(db) {
  const tables = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name");
  let schema = '-- SmartEdu Database Schema\n';
  schema += `-- 版本: ${CURRENT_SCHEMA_VERSION}\n`;
  schema += `-- 生成时间: ${new Date().toISOString()}\n\n`;
  
  if (tables[0]) {
    tables[0].values.forEach(([name, sql]) => {
      schema += `${sql};\n\n`;
    });
  }
  
  // 导出索引
  const indexes = db.exec("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name");
  if (indexes[0]) {
    schema += '-- Indexes\n\n';
    indexes[0].values.forEach(([name, sql]) => {
      schema += `${sql};\n`;
    });
  }
  
  return schema;
}

/**
 * 验证数据库完整性
 * @param {object} db - sql.js Database 实例
 * @returns {object} 验证结果
 */
function validateDatabase(db) {
  const result = {
    valid: true,
    errors: [],
    warnings: []
  };
  
  // 检查必要表是否存在
  const requiredTables = ['users', 'students', 'records', 'leaves', 'courses', 'dorms'];
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = tables[0]?.values?.map(r => r[0]) || [];
  
  for (const table of requiredTables) {
    if (!tableNames.includes(table)) {
      result.errors.push(`缺少必要表: ${table}`);
      result.valid = false;
    }
  }
  
  // 检查索引
  const indexes = db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='index'");
  const indexCount = indexes[0]?.values?.[0]?.[0] || 0;
  if (indexCount < 10) {
    result.warnings.push(`索引数量较少 (${indexCount})，可能影响查询性能`);
  }
  
  return result;
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  runMigrations,
  exportSchema,
  validateDatabase
};
