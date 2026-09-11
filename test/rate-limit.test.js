/**
 * 限流中间件测试
 */
const { rateLimit, loginRateLimit } = require('../middleware/rate-limit');

describe('rate-limit middleware', () => {
  test('should set rate limit headers', (done) => {
    const opts = { windowMs: 60000, maxRequests: 100 };
    const middleware = rateLimit(opts);
    
    // Create mock request/response objects
    const req = { ip: '127.0.0.1' };
    const res = {
      setHeader: jest.fn(),
      locals: {}
    };
    const next = jest.fn();
    
    middleware(req, res, next);
    
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 100);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
    
    done();
  });

  test('login rate limit should track attempts', (done) => {
    const middleware = loginRateLimit({ windowMs: 60000, maxAttempts: 5 });
    
    const req = { ip: '127.0.0.1', path: '/api/login' };
    const res = {
      setHeader: jest.fn(),
      locals: {}
    };
    const next = jest.fn();
    
    // Simulate 5 requests (should all pass)
    for (let i = 0; i < 5; i++) {
      middleware(req, res, next);
      next.mockClear();
    }
    
    // 6th request should be blocked
    middleware(req, res, next);
    
    // Check that the 6th call was rejected
    expect(res.statusCode).toBe(429);
    
    done();
  });
});
