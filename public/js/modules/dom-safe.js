/**
 * DOM 安全操作工具
 * 替代 innerHTML，防止 XSS 攻击
 */

/**
 * 安全地设置元素内容
 * @param {HTMLElement} el - 目标元素
 * @param {string} html - HTML 内容（会自动转义危险字符）
 */
function safeSetInnerHTML(el, html) {
  if (!el || !html) return;
  
  // 创建临时容器
  const div = document.createElement('div');
  div.innerHTML = html;
  
  // 移除所有 script 标签
  div.querySelectorAll('script').forEach(s => s.remove());
  
  // 移除所有 onclick/onerror 等事件处理器
  const allElements = div.querySelectorAll('*');
  allElements.forEach(elem => {
    const attrs = elem.attributes;
    for (let i = attrs.length - 1; i >= 0; i--) {
      if (attrs[i].name.startsWith('on')) {
        elem.removeAttribute(attrs[i].name);
      }
    }
  });
  
  // 清空并替换内容
  el.innerHTML = '';
  el.appendChild(div.firstChild || div);
}

/**
 * 创建安全元素（用于 innerHTML = '...' 场景）
 * @param {string} html - HTML 字符串
 * @returns {HTMLElement} 安全的 DOM 元素
 */
window.createSafeElement = function(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  div.querySelectorAll('script').forEach(s => s.remove());
  return div.firstChild || div;
};

/**
 * 安全地渲染列表（替代 innerHTML 拼接）
 * @param {HTMLElement} container - 容器元素
 * @param {Array} data - 数据数组
 * @param {Function} renderItem - 渲染单个项目的函数
 */
window.renderSafeList = function(container, data, renderItem) {
  if (!container || !Array.isArray(data)) return;
  
  container.innerHTML = '';
  
  if (data.length === 0) {
    container.textContent = '暂无数据';
    return;
  }
  
  const fragment = document.createDocumentFragment();
  data.forEach((item, index) => {
    const el = renderItem(item, index);
    if (el instanceof HTMLElement) {
      fragment.appendChild(el);
    }
  });
  
  container.appendChild(fragment);
};

/**
 * 安全地渲染表格
 * @param {HTMLElement} el - 表格容器
 * @param {Array} rows - 数据行
 * @param {Function} renderRow - 渲染单行的函数
 */
window.renderSafeTable = function(el, rows, renderRow) {
  if (!el || !Array.isArray(rows)) return;
  
  el.innerHTML = '';
  
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  
  // 表头由 renderRow 的第一个参数提供（可选）
  if (renderRow.header) {
    const headerRow = document.createElement('tr');
    renderRow.header.forEach(text => {
      const th = document.createElement('th');
      th.textContent = text;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
  }
  
  // 数据行
  rows.forEach((row, idx) => {
    const tr = renderRow(row, idx);
    if (tr instanceof HTMLElement) {
      tbody.appendChild(tr);
    }
  });
  
  table.appendChild(thead);
  table.appendChild(tbody);
  el.appendChild(table);
};
