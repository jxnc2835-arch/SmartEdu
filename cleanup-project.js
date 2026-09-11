const fs = require('fs');
const path = require('path');

const projectPath = 'd:\\my pj\\WorkBuddy\\Claw\\学管 SmartEdu';

// Files to delete
const filesToDelete = [
  'add_missing_student.py',
  'andrej-skills.zip',
  'API_KEY_使用说明.md',
  'API_Key配置完成报告.md',
  'check-config.js',
  'cleanup-backups.js',
  'cleanup-logs.js',
  'config.json',
  'create-pwa-icons.js',
  'create_full_mock_data.js',
  'debug_login.js',
  'diagnose_zero.js',
  'edu-data-sync.zip',
  'fill_missing_class.py',
  'fix_dorm_anomaly.py',
  'fix_passwords.js',
  'fix_passwords_v2.js',
  'gen_anomaly_sim.py',
  'gen_dorm_anomaly.py',
  'gen_timeseries.py',
  'import_data.js',
  'import_students.js',
  'reassign_dorms.py',
  'rebuild_class_records.py',
  'server.log',
  'simulate_crash.js',
  'simulate_full_cycle.js',
  'simulate_load.js',
  'simulate_server.js',
  'synchronize-dorms.js',
  'sync_dorms_leaves.py',
  'sync_leaves.py',
  'v2.json',
  'v3.json',
  'v4.json',
  'verify_result.txt',
  '使用说明.md',
  '学生导入模板.xlsx',
  '挑战杯参赛优劣势分析.md',
  '操作手册.md',
  '短期优化报告.md',
  '课表导入模板.csv',
  '项目优化完成报告.md'
];

// Directories to delete
const dirsToDelete = [
  'backups',
  'coverage',
  '.github',
  '.workbuddy',
  'andrej-karpathy-skills'
];

// Backup db files to delete (pattern)
const backupPatterns = [
  'data_backup_*.db',
  'data_final_*.db',
  'data_pre_*.db'
];

console.log('Starting cleanup...');

let deletedFiles = 0;
let deletedDirs = 0;
let errors = 0;

// Delete files
filesToDelete.forEach(file => {
  const filePath = path.join(projectPath, file);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`✓ Deleted: ${file}`);
      deletedFiles++;
    }
  } catch (err) {
    console.error(`✗ Error deleting ${file}: ${err.message}`);
    errors++;
  }
});

// Delete directories
dirsToDelete.forEach(dir => {
  const dirPath = path.join(projectPath, dir);
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      console.log(`✓ Deleted directory: ${dir}`);
      deletedDirs++;
    }
  } catch (err) {
    console.error(`✗ Error deleting directory ${dir}: ${err.message}`);
    errors++;
  }
});

// Delete backup files matching patterns
backupPatterns.forEach(pattern => {
  const regex = new RegExp('^' + pattern.replace('*', '').replace(/\*/g, '.*') + '$');
  try {
    const files = fs.readdirSync(projectPath);
    files.forEach(file => {
      if (regex.test(file)) {
        fs.unlinkSync(path.join(projectPath, file));
        console.log(`✓ Deleted: ${file}`);
        deletedFiles++;
      }
    });
  } catch (err) {
    console.error(`✗ Error scanning for ${pattern}: ${err.message}`);
    errors++;
  }
});

console.log(`\nCleanup completed:`);
console.log(`  Files deleted: ${deletedFiles}`);
console.log(`  Directories deleted: ${deletedDirs}`);
console.log(`  Errors: ${errors}`);

// List remaining files
console.log('\nRemaining files:');
try {
  const items = fs.readdirSync(projectPath, { withFileTypes: true });
  items.forEach(item => {
    if (!item.name.startsWith('.')) {
      console.log(`  ${item.isDirectory() ? 'DIR' : 'FILE'}: ${item.name}`);
    }
  });
} catch (err) {
  console.error(`Error reading directory: ${err.message}`);
}
