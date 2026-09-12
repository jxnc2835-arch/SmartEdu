// @ts-check
// ESLint 10 flat config（ESLint 10 已彻底移除 legacy .eslintrc.* 支持，
// 且 airbnb-base 未安装/不适配 flat config，故原 .eslintrc.json 无法被 ESLint 10 读取）。
// 原 .eslintrc.json 的规则（node/es2021/jest 环境 + 4 条 rules）已等价迁移于此；
// 旧 .eslintrc.json 保留仅作历史参考。
//
// 约定：遗留代码的风格类噪音规则降级为 warn（可见但不阻塞 npm run lint）；
//       真 bug 类（no-undef、no-const-assign、no-async-promise-executor 等）保持 error。
const js = require('@eslint/js');
const globals = require('globals');

// 对遗留代码噪音大、非真 bug 的风格规则统一降为 warn
const LEGACY_WARN = {
  'no-unused-vars': ['warn', { caughtErrors: 'none', args: 'after-used', caughtErrorsIgnorePattern: '^_' }],
  'no-empty': 'warn',
  'prefer-const': 'warn',
  'no-case-declarations': 'warn',
  'no-useless-escape': 'off',
  'no-useless-assignment': 'warn',
  // 本项目界面字符串中故意使用全角空格/破折号做显示对齐，非不可见字符误输入
  'no-irregular-whitespace': 'off',
};

module.exports = [
  // 全局忽略
  {
    ignores: ['node_modules/**', 'backups/**', 'logs/**', 'public/reports/**', '*.min.js', 'public/*.min.js'],
  },

  // Node 服务端（CommonJS）
  {
    files: [
      'server.js',
      'app.js',
      'swagger.js',
      'routes/**/*.js',
      'middleware/**/*.js',
      'services/**/*.js',
      'utils/**/*.js',
      'config/**/*.js',
      'scripts/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
        // JWT_SECRET 从 process.env 读取，ESLint 需知道此全局变量
        JWT_SECRET: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 等价迁移自原 .eslintrc.json
      'no-console': 'off',
      'func-names': 'off',
      'prefer-arrow-callback': 'off',
      'no-underscore-dangle': 'off',
      'no-var': 'off',
      'no-param-reassign': 'off',
      'no-restricted-syntax': 'off',
      'no-prototype-builtins': 'off',
      'no-else-return': 'off',
      'no-lonely-if': 'off',
      ...LEGACY_WARN,
    },
  },

  // Jest 测试文件
  {
    files: ['test/**/*.js', '**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.commonjs,
        ...globals.jest,
      },
    },
  },

  // 浏览器前端模块（public/js）
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-var': 'off',
      // 前端模块间通过 window.* 暴露函数、跨文件裸调用（项目既有约定），
      // no-undef 会对 ~280 处跨模块调用误报，故关闭
      'no-undef': 'off',
      'no-underscore-dangle': 'off',
      ...LEGACY_WARN,
    },
  },
];
