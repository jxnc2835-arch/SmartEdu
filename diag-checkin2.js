const fs = require('fs');
const code = fs.readFileSync('routes/checkin.js', 'utf8');
const lines = code.split('\n');

console.log('Total lines:', lines.length);
console.log('BOM:', Buffer.from(code.slice(0, 3)).toString('hex'));

// Track brace depth line by line
let depth = 0;
let inStr = false;
let strC = '';
let esc = false;
let lastCloseDepth = 0;
let lastCloseLine = 0;

for (let i = 0; i < code.length; i++) {
  const c = code[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (inStr) {
    if (c === strC) inStr = false;
    continue;
  }
  if (c === "'" || c === '"' || c === '`') { inStr = true; strC = c; continue; }
  if (c === '{') {
    depth++;
  } else if (c === '}') {
    if (depth === 1) {
      // This is closing the init function
      const lineNum = code.slice(0, i).split('\n').length;
      console.log('Closing init() at line ' + lineNum + ', depth was ' + depth);
    }
    depth--;
    lastCloseDepth = depth;
    lastCloseLine = code.slice(0, i).split('\n').length;
  }
}

console.log('Final depth:', depth);
console.log('Last close at line:', lastCloseLine, 'depth:', lastCloseDepth);

// Find the line around 774 and show context
console.log('\n--- Lines 770-778 ---');
for (let i = 769; i < Math.min(778, lines.length); i++) {
  console.log((i+1) + ': ' + JSON.stringify(lines[i]));
}
