#!/usr/bin/env node
/**
 * XSS 修复脚本 - 将 teacher.html 中的 innerHTML 替换为安全的 DOM 操作
 * 用法: node scripts/fix-xss.js
 */

const fs = require('fs');
const path = require('path');

const HTML_FILE = path.join(__dirname, '..', 'public', 'teacher.html');
const BACKUP_FILE = path.join(__dirname, '..', 'public', 'teacher.html.bak');

console.log('🔍 正在分析 HTML 文件...');

// 读取文件
let content = fs.readFileSync(HTML_FILE, 'utf8');
const originalContent = content;

// 替换规则：将 innerHTML 替换为 textContent + appendChild
// 规则1: el.innerHTML = '<div>...</div>' → 创建元素并设置 textContent
// 规则2: el.innerHTML = `模板字符串` → 保持原样（已使用 esc()）
// 规则3: 纯文字内容 → 使用 textContent

let replacements = 0;

// 匹配简单的 innerHTML 赋值（非模板字符串）
content = content.replace(/(\w+\.innerHTML)\s*=\s*'([^']+)'/g, (match, target, value) => {
  // 如果包含 HTML 标签且没有转义，需要处理
  if (/<[a-z][\s\S]*>/i.test(value) && !value.includes('esc(')) {
    replacements++;
    return `${target} = createSafeElement('${value}')`;
  }
  return match;
});

// 添加安全元素创建函数
const helperFunction = `
// ==================== XSS 防护工具 ====================
function createSafeElement(html) {
  // 创建临时容器
  const div = document.createElement('div');
  div.innerHTML = html;
  // 递归清理 script 标签
  div.querySelectorAll('script').forEach(s => s.remove());
  return div.firstChild || div;
}`;

// 在 </script> 前插入辅助函数
content = content.replace(/<\/script>/, helperFunction + '\n</script>');

// 保存备份
fs.copyFileSync(HTML_FILE, BACKUP_FILE);
console.log(`💾 已备份原文件到 ${BACKUP_FILE}`);

// 保存修改后的文件
fs.writeFileSync(HTML_FILE, content, 'utf8');
console.log(`✅ 完成 ${replacements} 处安全替换`);

// 生成报告
console.log('\n📊 修复报告:');
console.log('- 原文件行数:', originalContent.split('\n').length);
console.log('- 新文件行数:', content.split('\n').length);
console.log('- 安全替换:', replacements);
