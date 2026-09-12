// export 路由核心逻辑测试（简化版）
jest.mock('../utils/helpers', () => ({
  formatDate: jest.fn((d) => String(d)),
  localDateStr: jest.fn(() => '2026-09-12'),
}));

describe('export 核心逻辑', () => {
  test('导出功能模块可加载', () => {
    const { init } = require('../routes/export');
    expect(typeof init).toBe('function');
  });
});
