const fs = require('fs');
const path = require('path');

// Check all route files for syntax errors
const routesDir = path.join(__dirname, 'routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('Checking ' + files.length + ' route files...\n');

let hasError = false;
for (const file of files) {
  const filepath = path.join(routesDir, file);
  try {
    const code = fs.readFileSync(filepath, 'utf8');
    // Use vm to parse without executing
    new Function(code);
    console.log('  OK  ' + file);
  } catch (e) {
    console.log('  ERR ' + file + ': ' + e.message.split('\n')[0]);
    hasError = true;
  }
}

// Also check server.js
try {
  const code = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  new Function(code);
  console.log('  OK  server.js');
} catch (e) {
  console.log('  ERR server.js: ' + e.message.split('\n')[0]);
  hasError = true;
}

if (hasError) {
  console.log('\nSome files have syntax errors!');
  process.exit(1);
} else {
  console.log('\nAll files OK!');
  process.exit(0);
}
