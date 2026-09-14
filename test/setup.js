// Jest setup file to provide TextEncoder/TextDecoder polyfills for Node environments lacking them
if (typeof TextEncoder === 'undefined') {
  global.TextEncoder = require('util').TextEncoder;
}
if (typeof TextDecoder === 'undefined') {
  global.TextDecoder = require('util').TextDecoder;
}

// 设置测试环境变量，避免 auth.js 在 requireActual 时抛错
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-unit-tests-only-do-not-use-in-production-32chars';

// Mock logger to reduce test noise
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

// Increase timeout for slow tests
jest.setTimeout(10000);
