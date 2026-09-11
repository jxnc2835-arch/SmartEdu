const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
console.log('Total lines:', lines.length);
for (let i = 50; i < 70; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');
const lines = content.split('\n');
console.log('Total lines:', lines.length);
for (let i = 50; i < 70; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
