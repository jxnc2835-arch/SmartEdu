const fs = require('fs');
const code = fs.readFileSync('routes/checkin.js', 'utf8');
const lines = code.split('\n');

let initStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim().startsWith('function init(')) { initStart = i; break; }
}
console.log('init starts at line', initStart + 1);

let depth = 0;
let inStr = false, strC = '', esc = false;

for (let i = initStart; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === strC) inStr = false; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = true; strC = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
}

console.log('Final depth:', depth);

// Show lines around where depth goes back to 0
depth = 0; inStr = false; strC = ''; esc = false;
let depthAtLine = {};
for (let i = initStart; i < lines.length; i++) {
  for (let j = 0; j < lines[i].length; j++) {
    const c = lines[i][j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === strC) inStr = false; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = true; strC = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if(depth>0)depth--; }
  }
  const ln = i + 1;
  if (!depthAtLine[depth]) depthAtLine[depth] = [];
  depthAtLine[depth].push(ln);
}

console.log('Lines where depth returns to 0:', depthAtLine[0] ? depthAtLine[0].join(', ') : 'NONE');
console.log('Lines where depth=1:', (depthAtLine[1] || []).slice(-5).join(', '));
