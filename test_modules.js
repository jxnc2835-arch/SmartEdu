// 测试所有模块是否正常加载
const path = require('path');
const fs = require('fs');

const routesDir = path.join(__dirname, 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('Testing module loading...\n');

let success = 0;
let failed = 0;

for (const file of routeFiles) {
  const moduleName = './routes/' + file.replace('.js', '');
  try {
    const mod = require(moduleName);
    console.log(`✓ ${file}: OK`);
    if (typeof mod.init === 'function') {
      console.log(`  - init: function`);
    }
    if (typeof mod.createBackup === 'function') {
      console.log(`  - createBackup: function`);
    }
    success++;
  } catch (err) {
    console.log(`✗ ${file}: FAILED - ${err.message}`);
    failed++;
  }
}

console.log(`\nResults: ${success} passed, ${failed} failed`);// 测试所有模块是否正常加载
const path = require('path');
const fs = require('fs');

const routesDir = path.join(__dirname, 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('Testing module loading...\n');

let success = 0;
let failed = 0;

for (const file of routeFiles) {
  const moduleName = './routes/' + file.replace('.js', '');
  try {
    const mod = require(moduleName);
    console.log(`✓ ${file}: OK`);
    if (typeof mod.init === 'function') {
      console.log(`  - init: function`);
    }
    if (typeof mod.createBackup === 'function') {
      console.log(`  - createBackup: function`);
    }
    success++;
  } catch (err) {
    console.log(`✗ ${file}: FAILED - ${err.message}`);
    failed++;
  }
}

console.log(`\nResults: ${success} passed, ${failed} failed`);
