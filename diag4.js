const fs = require('fs');
const code = fs.readFileSync('routes/checkin.js', 'utf8');
const lines = code.split('\n');
const out = [];

// Find unmatched brace - track depth and which line opened each level
const opens = []; // stack of { line numbers
const closes = []; // stack of } line numbers

for (let i = 0; i < code.length; i++) {
  const c = code[i];
  // Simple string detection
  let inStr = false, strC = '';
  // We need to track per-character, not per-line
}

// Better approach: line-by-line with string state
let depth = 0;
let inStr = false, strC = '', esc = false;
const openStack = []; // [{ line, depth }]

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
    const lineNum = code.slice(0, i).split('\n').length;
    openStack.push({ line: lineNum, depth: depth, content: lines[lineNum-1].trim().slice(0,60) });
  } else if (c === '}') {
    const lineNum = code.slice(0, i).split('\n').length;
    if (openStack.length > 0) {
      const open = openStack.pop();
      if (depth === 1 && open.depth === 1) {
        out.push('CLOSING init() at line ' + lineNum + ' (opened at ' + open.line + ')');
      }
    } else {
      out.push('EXTRA close at line ' + lineNum);
    }
    depth--;
  }
}

out.push('Final depth: ' + depth);
out.push('Open stack remaining: ' + openStack.length);
openStack.forEach(o => {
  out.push('  Line ' + o.line + ' (depth=' + o.depth + '): ' + o.content);
});

// Also check for string imbalance
let strDepth = 0;
inStr = false; strC = ''; esc = false;
let unclosedLine = -1;
for (let i = 0; i < code.length; i++) {
  const c = code[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (inStr) {
    if (c === strC) { inStr = false; }
    continue;
  }
  if (c === "'" || c === '"' || c === '`') {
    inStr = true; strC = c;
    unclosedLine = code.slice(0, i).split('\n').length;
  }
}
if (inStr) {
  out.push('UNCLOSED STRING starting at line ' + unclosedLine + ' char ' + JSON.stringify(strC));
}

fs.writeFileSync('diag-output.txt', out.join('\n'));
console.log('done');
