const fs = require('fs');
const code = fs.readFileSync('routes/checkin.js', 'utf8');
const lines = code.split('\n');

let depth = 0;
let inStr = false, strC = '', esc = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === strC) inStr = false; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = true; strC = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if(depth>0)depth--; }
  }
  const ln = i + 1;
  if (depth <= 2 && depth >= -1) {
    console.log('L' + ln + ' depth=' + depth + ' : ' + JSON.stringify(line.slice(0, 80)));
  }
}
