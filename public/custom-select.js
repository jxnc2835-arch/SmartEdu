/**
 * 自定义下拉框组件
 * 用于替换原生 select，解决深色主题下拉选项背景无法控制的问题
 */

(function() {
  'use strict';

  // 存储所有自定义下拉实例
  const instances = new Map();

  /**
   * 创建自定义下拉框
   * @param {string} selectId - 原始 select 元素的 ID
   * @param {Object} options - 配置选项
   */
  function createCustomSelect(selectId, options = {}) {
    const select = document.getElementById(selectId);
    if (!select) {
      console.warn(`CustomSelect: 未找到元素 #${selectId}`);
      return null;
    }

    // 隐藏原始 select
    select.style.display = 'none';

    // 创建自定义下拉结构
    const container = document.createElement('div');
    container.className = 'custom-select';
    container.dataset.selectId = selectId;

    // 触发按钮
    const trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    trigger.innerHTML = select.options[0]?.textContent || '请选择';

    // 下拉列表
    const dropdown = document.createElement('div');
    dropdown.className = 'custom-select-dropdown';

    // 填充选项
    populateOptions(dropdown, select);

    container.appendChild(trigger);
    container.appendChild(dropdown);
    select.parentNode.replaceChild(container, select);

    // 存储实例
    const instance = {
      selectId,
      select,
      container,
      trigger,
      dropdown,
      selectedValue: select.value,
      onChange: options.onChange || null
    };
    instances.set(selectId, instance);

    // 绑定事件
    bindEvents(instance);

    return instance;
  }

  /**
   * 填充下拉选项
   */
  function populateOptions(dropdown, select) {
    dropdown.innerHTML = '';
    
    for (const option of select.options) {
      const el = document.createElement('div');
      el.className = 'custom-select-option';
      if (option.value === '') {
        el.classList.add('disabled');
      }
      if (option.value === select.value) {
        el.classList.add('selected');
      }
      el.textContent = option.textContent;
      el.dataset.value = option.value;
      dropdown.appendChild(el);
    }

    // 如果没有选项，显示空状态
    if (dropdown.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'custom-select-empty';
      empty.textContent = '暂无选项';
      dropdown.appendChild(empty);
    }
  }

  /**
   * 绑定事件
   */
  function bindEvents(instance) {
    const { trigger, dropdown, selectId } = instance;

    // 点击触发按钮
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('show');
      
      // 关闭所有其他下拉
      closeAllOthers(selectId);
      
      // 切换当前下拉
      if (isOpen) {
        dropdown.classList.remove('show');
        trigger.classList.remove('open');
      } else {
        dropdown.classList.add('show');
        trigger.classList.add('open');
      }
    });

    // 点击选项
    dropdown.addEventListener('click', (e) => {
      const option = e.target.closest('.custom-select-option');
      if (!option || option.classList.contains('disabled')) return;

      const value = option.dataset.value;
      selectOption(instance, value, option.textContent);
      
      // 关闭下拉
      dropdown.classList.remove('show');
      trigger.classList.remove('open');
    });

    // 点击外部关闭
    document.addEventListener('click', (e) => {
      if (!instance.container.contains(e.target)) {
        dropdown.classList.remove('show');
        trigger.classList.remove('open');
      }
    });

    // ESC 键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dropdown.classList.contains('show')) {
        dropdown.classList.remove('show');
        trigger.classList.remove('open');
      }
    });
  }

  /**
   * 关闭其他所有下拉
   */
  function closeAllOthers(exceptId) {
    for (const [id, instance] of instances) {
      if (id !== exceptId) {
        instance.dropdown.classList.remove('show');
        instance.trigger.classList.remove('open');
      }
    }
  }

  /**
   * 选择选项
   */
  function selectOption(instance, value, text) {
    instance.selectedValue = value;
    
    // 更新触发按钮显示
    const trigger = instance.trigger;
    trigger.textContent = text;
    
    if (value !== '') {
      trigger.classList.add('selected');
    } else {
      trigger.classList.remove('selected');
    }

    // 更新原始 select
    instance.select.value = value;
    
    // 更新选中状态
    for (const option of instance.dropdown.children) {
      if (option.dataset.value === value) {
        option.classList.add('selected');
      } else {
        option.classList.remove('selected');
      }
    }

    // 触发 change 事件
    const event = new Event('change', { bubbles: true });
    instance.select.dispatchEvent(event);

    // 调用外部回调
    if (instance.onChange) {
      instance.onChange(value, text);
    }
  }

  /**
   * 获取选中值
   */
  function getValue(selectId) {
    const instance = instances.get(selectId);
    return instance ? instance.selectedValue : '';
  }

  /**
   * 设置选项值
   */
  function setValue(selectId, value) {
    const instance = instances.get(selectId);
    if (!instance) return;

    const option = instance.dropdown.querySelector(`[data-value="${value}"]`);
    if (option) {
      selectOption(instance, value, option.textContent);
    }
  }

  /**
   * 清空选项
   */
  function clearOptions(selectId) {
    const instance = instances.get(selectId);
    if (!instance) return;

    instance.select.innerHTML = '';
    instance.dropdown.innerHTML = '';
    instance.trigger.textContent = '请选择';
    instance.trigger.classList.remove('selected');
    instance.selectedValue = '';
  }

  /**
   * 添加选项
   */
  function addOption(selectId, value, text) {
    const instance = instances.get(selectId);
    if (!instance) return;

    // 添加到原始 select
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    instance.select.appendChild(option);

    // 添加到下拉列表
    const existing = instance.dropdown.querySelector(`[data-value="${value}"]`);
    if (!existing) {
      const el = document.createElement('div');
      el.className = 'custom-select-option';
      el.dataset.value = value;
      el.textContent = text;
      instance.dropdown.appendChild(el);
    }
  }

  /**
   * 禁用/启用
   */
  function setDisabled(selectId, disabled) {
    const instance = instances.get(selectId);
    if (!instance) return;

    instance.trigger.style.opacity = disabled ? '0.5' : '1';
    instance.trigger.style.cursor = disabled ? 'not-allowed' : 'pointer';
    instance.select.disabled = disabled;
  }

  // 暴露到全局
  window.CustomSelect = {
    create: createCustomSelect,
    getValue,
    setValue,
    addOption,
    clearOptions,
    setDisabled
  };

  // 自动初始化所有带有 data-custom-select 的 select
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('select[data-custom-select]').forEach(select => {
      createCustomSelect(select.id);
    });
  });

  // 如果 DOMContentLoaded 时元素还不存在（如 loginOverlay 延迟显示），重试初始化
  setTimeout(() => {
    document.querySelectorAll('select[data-custom-select]').forEach(select => {
      if (!instances.has(select.id)) {
        createCustomSelect(select.id);
      }
    });
  }, 500);
})();
