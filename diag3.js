const fs = require('fs');
const out = [];
const code = fs.readFileSync('routes/checkin.js', 'utf8');
const lines = code.split('\n');

out.push('Total lines: ' + lines.length);
out.push('BOM: ' + Buffer.from(code.slice(0, 3)).toString('hex'));

let depth = 0;
let inStr = false;
let strC = '';
let esc = false;

for (let i = 0; i < code.length; i++) {
  const c = code[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (inStr) { if (c === strC) inStr = false; continue; }
  if (c === "'" || c === '"' || c === '`') { inStr = true; strC = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') depth--;
}
out.push('Final brace depth: ' + depth);

out.push('--- Lines 770-778 ---');
for (let i = 769; i < Math.min(778, lines.length); i++) {
  out.push((i+1) + ': ' + JSON.stringify(lines[i]));
}

fs.writeFileSync('diag-output.txt', out.join('\n'));
console.log('done');
