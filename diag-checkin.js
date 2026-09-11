const fs = require('fs');
const path = require('path');

const filepath = 'routes/checkin.js';
const code = fs.readFileSync(filepath, 'utf8');
const lines = code.split('\n');

console.log('Total lines:', lines.length);
console.log('File size:', Buffer.byteLength(code));
console.log('BOM check:', Buffer.from(code.slice(0, 3)).toString('hex'));

// Find all lines near 774
for (let i = 760; i < Math.min(780, lines.length); i++) {
  const line = lines[i];
  const hasNonAscii = [...line].some(c => c.charCodeAt(0) > 127);
  const marker = hasNonAscii ? ' [NON-ASCII]' : '';
  console.log((i + 1) + ':' + marker + ' ' + JSON.stringify(line));
}

// Count braces
let depth = 0;
let inStr = false;
let strC = '';
let esc = false;
let lastOpenLine = 0;
for (let i = 0; i < code.length; i++) {
  const c = code[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (inStr) {
    if (c === strC) inStr = false;
    continue;
  }
  if (c === "'" || c === '"' || c === '`') { inStr = true; strC = c; continue; }
  if (c === '{') { depth++; lastOpenLine = code.slice(0, i).split('\n').length; }
  else if (c === '}') { depth--; }
}
console.log('\nFinal brace depth:', depth, '(should be 0)');
console.log('Last open brace at line:', lastOpenLine);
