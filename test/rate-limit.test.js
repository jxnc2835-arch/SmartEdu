/**
 * 限流中间件测试
 */
const { rateLimit, loginRateLimit } = require('../middleware/rate-limit');

describe('rate-limit middleware', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should set rate limit headers', (done) => {
    const opts = { windowMs: 60000, maxRequests: 100 };
    const middleware = rateLimit(opts);

    const req = { ip: '127.0.0.1' };
    const res = {
      headers: {},
      setHeader: jest.fn().mockImplementation((name, value) => {
        res.headers[name] = value;
        return res;
      }),
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
    const middleware = loginRateLimit({ windowMs: 60000, maxRequests: 5 });

    const req1 = { ip: '127.0.0.1', path: '/api/login' };
    const res1 = { headers: {}, setHeader: jest.fn() };
    const next1 = jest.fn();

    // First 5 requests should pass
    for (let i = 0; i < 5; i++) {
      middleware(req1, res1, next1);
    }

    expect(next1).toHaveBeenCalledTimes(5);

    // 6th request should be blocked
    const res6 = {
      statusCode: null,
      json: jest.fn().mockReturnValue({ statusCode: null }),
      status: jest.fn().mockReturnValue({ json: jest.fn() }),
      setHeader: jest.fn()
    };
    const next6 = jest.fn();

    // Manually simulate the 6th request hitting the limit
    middleware(req1, res6, next6);

    // The middleware should have called res.status(429).json()
    expect(res6.status).toHaveBeenCalledWith(429);

    done();
  });
});
