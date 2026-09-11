/**
 * 数据库优化模块
 * 提供高性能的数据库操作封装
 */

/**
 * 创建数据库索引
 */
function createIndexes(db) {
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_students_class_name ON students(class_name)',
    'CREATE INDEX IF NOT EXISTS idx_students_dorm ON students(dorm)',
    'CREATE INDEX IF NOT EXISTS idx_records_time ON records(time)',
    'CREATE INDEX IF NOT EXISTS idx_records_student_id ON records(student_id)',
    'CREATE INDEX IF NOT EXISTS idx_records_type ON records(type)',
    'CREATE INDEX IF NOT EXISTS idx_records_status ON records(status)',
    'CREATE INDEX IF NOT EXISTS idx_records_class_name ON records(class_name)',
    'CREATE INDEX IF NOT EXISTS idx_leaves_student_id ON leaves(student_id)',
    'CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(status)',
    'CREATE INDEX IF NOT EXISTS idx_courses_date ON courses(date)',
    'CREATE INDEX IF NOT EXISTS idx_courses_class_name ON courses(class_name)',
    'CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(time)',
    'CREATE INDEX IF NOT EXISTS idx_visitors_date ON visitors(visit_date)',
    'CREATE INDEX IF NOT EXISTS idx_visitors_target_student_id ON visitors(target_student_id)',
  ];

  // 尝试创建基础索引
  let created = 0;
  indexes.forEach(sql => {
    try {
      db.run(sql);
      created++;
    } catch (e) {
      // 静默忽略，可能是列不存在
    }
  });

  // 尝试创建扩展索引（可能需要特定列存在）
  const extendedIndexes = [
    'CREATE INDEX IF NOT EXISTS idx_students_grade ON students(grade)',
    'CREATE INDEX IF NOT EXISTS idx_students_major ON students(major)',
    'CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)',
    'CREATE INDEX IF NOT EXISTS idx_records_course_id ON records(course_id)',
    'CREATE INDEX IF NOT EXISTS idx_leaves_date ON leaves(start_date)',
  ];

  extendedIndexes.forEach(sql => {
    try {
      db.run(sql);
      created++;
    } catch (e) {
      // 静默忽略
    }
  });

  console.log(`✅ 已创建 ${created} 个数据库索引`);
}

/**
 * 优化数据库性能参数
 */
function optimizeDbConfig(db) {
  const pragmas = [
    ['journal_mode', 'WAL'],           // 写前日志，提高并发性能
    ['synchronous', 'NORMAL'],          // 正常同步模式
    ['cache_size', -64000],             // 64MB 缓存
    ['temp_store', 'MEMORY'],           // 临时数据存储到内存
    ['mmap_size', 134217728],           // 128MB 内存映射
    ['page_size', 4096],                // 标准页大小
    ['foreign_keys', 'TRUE'],           // 启用外键检查
    ['busy_timeout', 10000],            // 10秒忙等待
    ['wal_autocheckpoint', 1000],       // WAL 自动检查点
  ];

  pragmas.forEach(([key, value]) => {
    try {
      db.run(`PRAGMA ${key}=${value}`);
    } catch (e) {
      console.warn(`PRAGMA ${key} 设置失败:`, e.message);
    }
  });

  console.log('✅ 数据库性能参数已优化');
}

/**
 * 分页查询封装
 * @param {Object} db - 数据库实例
 * @param {string} query - SQL 查询语句
 * @param {Array} params - 查询参数
 * @param {Object} options - 分页选项
 * @returns {Object} 分页结果
 */
function paginate(db, query, params = [], options = {}) {
  const { page = 1, limit = 50, totalCount = null } = options;
  const offset = (page - 1) * limit;

  // 执行主查询
  const result = db.exec(query, params);
  const rows = result?.[0]?.values || [];
  const columns = result?.[0]?.columns || [];

  // 转换为对象数组
  const data = rows.map(row => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });

  // 应用分页
  const paginatedData = data.slice(offset, offset + limit);

  // 获取总数（如果没有提供）
  let total = totalCount;
  if (!total) {
    try {
      const countQuery = query.replace(/SELECT.*?FROM/i, 'SELECT COUNT(*) as count FROM');
      const countResult = db.exec(countQuery, params);
      total = countResult?.[0]?.values?.[0]?.[0] || 0;
    } catch (e) {
      total = data.length;
    }
  }

  const totalPages = Math.ceil(total / limit);

  return {
    code: 0,
    data: paginatedData,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    }
  };
}

/**
 * 批量插入优化
 * @param {Object} db - 数据库实例
 * @param {string} table - 表名
 * @param {Array<Object>} items - 要插入的数据
 * @param {string[]} columns - 列名数组
 * @returns {Object} 插入结果
 */
function batchInsert(db, table, items, columns) {
  if (!items || items.length === 0) {
    return { success: 0, failed: 0, total: 0 };
  }

  const placeholders = columns.map(() => '?').join(', ');
  const columnNames = columns.join(', ');
  const sql = `INSERT INTO ${table} (${columnNames}) VALUES (${placeholders})`;

  let success = 0;
  let failed = 0;

  // 使用事务批量插入
  try {
    db.run('BEGIN TRANSACTION');
    
    items.forEach(item => {
      try {
        const values = columns.map(col => item[col]);
        db.run(sql, values);
        success++;
      } catch (e) {
        failed++;
        console.error('批量插入失败:', e.message);
      }
    });

    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (rollbackErr) {}
    console.error('事务执行失败:', e.message);
  }

  return { success, failed, total: items.length };
}

/**
 * 数据库健康检查
 * @param {Object} db - 数据库实例
 * @returns {Object} 健康状态统计
 */
function healthCheck(db) {
  const stats = {
    tables: {},
    size: 0,
    indexCount: 0,
  };

  try {
    // 获取所有表
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (tables) {
      tables[0].values.forEach(([tableName]) => {
        try {
          const count = db.exec(`SELECT COUNT(*) FROM "${tableName}"`)[0]?.values?.[0]?.[0] || 0;
          stats.tables[tableName] = count;
        } catch (e) {
          stats.tables[tableName] = 0;
        }
      });
    }

    // 获取所有索引
    const indexes = db.exec("SELECT name FROM sqlite_master WHERE type='index'");
    if (indexes) {
      stats.indexCount = indexes[0].values.length;
    }

    // 获取数据库文件大小（活跃库为 config/data.db，而非 process.cwd() 下的遗留文件）
    try {
      const config = require('../config');
      const dbPath = config.DB_FILE;
      const fs = require('fs');
      if (fs.existsSync(dbPath)) {
        stats.size = fs.statSync(dbPath).size;
      }
    } catch (e) {
      console.error('数据库文件 size 读取失败:', e.message);
    }
  } catch (e) {
    console.error('健康检查失败:', e.message);
  }

  return stats;
}

/**
 * 压缩数据库（释放空间）
 */
function vacuum(db) {
  try {
    db.run('VACUUM');
    console.log('✅ 数据库已压缩');
    return true;
  } catch (e) {
    console.error('数据库压缩失败:', e.message);
    return false;
  }
}

/**
 * 安全执行 SQL 查询（带超时保护）
 * @param {Object} db - 数据库实例
 * @param {string} sql - SQL 语句
 * @param {Array} params - 查询参数
 * @param {number} timeoutMs - 超时时间（毫秒），默认5秒
 * @returns {Object|null} 查询结果或 null
 */
function execWithTimeout(db, sql, params = [], timeoutMs = 5000) {
  const startTime = Date.now();
  try {
    const result = db.exec(sql, params);
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs * 0.8) {
      console.warn(`[DB TIMEOUT WARN] Query took ${elapsed}ms (timeout: ${timeoutMs}ms): ${sql.slice(0, 100)}...`);
    }
    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[DB ERROR] Query failed after ${elapsed}ms: ${err.message}`);
    throw err;
  }
}

module.exports = {
  createIndexes,
  optimizeDbConfig,
  paginate,
  batchInsert,
  healthCheck,
  vacuum,
  execWithTimeout,
};
