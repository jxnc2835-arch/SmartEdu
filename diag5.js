const fs = require('fs');
const code = fs.readFileSync('routes/checkin.js', 'utf8');
const lines = code.split('\n');

// Find the init function start
let initStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim().startsWith('function init(')) { initStart = i; break; }
}
console.log('init starts at line', initStart + 1);

// Count braces from initStart to end, tracking depth
let depth = 0;
let inStr = false, strC = '', esc = false;
const events = [];

for (let i = initStart; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) {
      if (c === strC) inStr = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = true; strC = c;
      continue;
    }
    if (c === '{') {
      depth++;
      events.push({ line: i+1, char: j+1, type: '{', depth: depth, preview: line.slice(0, Math.min(j+20, line.length)) });
    } else if (c === '}') {
      if (depth > 0) {
        const prevDepth = depth;
        depth--;
        if (prevDepth === 1) {
          events.push({ line: i+1, char: j+1, type: 'CLOSE_INIT', depth: depth, preview: line.slice(0, Math.min(j+20, line.length)) });
        }
      }
    }
  }
}

console.log('Final depth after init body:', depth);
console.log('\nAll depth-1 closings:');
events.filter(e => e.type === 'CLOSE_INIT').forEach(e => {
  console.log('  Line', e.line + ':', e.preview.trim());
});

// Also check for unclosed strings
let sDepth = 0, sLine = -1, sChar = '';
esc = false; inStr = false;
for (let i = 0; i < code.length; i++) {
  const c = code[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (inStr) {
    if (c === sChar) inStr = false;
    continue;
  }
  if (c === "'" || c === '"' || c === '`') {
    inStr = true; sChar = c;
    sLine = code.slice(0, i).split('\n').length;
  }
}
if (inStr) console.log('UNCLOSED STRING at line', sLine, 'char', JSON.stringify(sChar));

// Check the module.exports line
console.log('\nLast 5 lines:');
for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) {
  console.log((i+1) + ':', JSON.stringify(lines[i]));
}
