# Security Patterns for Express Applications

Security hardening patterns observed in SmartEdu project (v3.6.3).

## CSRF Protection Pattern

### When to use
- State-changing operations (POST/PUT/DELETE) in web applications
- When browser-based clients submit sensitive data
- Required for production deployments

### Implementation pattern
```javascript
// middleware/csrf.js
const crypto = require('crypto');
const csrfTokens = new Map();
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000;

function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, { createdAt: Date.now(), expiresAt: Date.now() + TOKEN_EXPIRY });
  return token;
}

function csrfProtection(req, res, next) {
  // Skip for tests and idempotent methods
  if (process.env.NODE_ENV === 'test' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  
  const token = req.headers['x-csrf-token'] || req.body?._csrf || req.query?._csrf;
  if (!token || !csrfTokens.delete(token)) {
    return res.status(403).json({ code: 1, message: 'CSRF token invalid or missing' });
  }
  next();
}

module.exports = { csrfProtection, generateToken };
```

### Frontend usage
```javascript
// On login success, fetch CSRF token
const csrfRes = await fetch('/api/csrf-token', { headers: { 'x-auth-token': token } });
const { token: csrfToken } = await csrfRes.json();

// Include in all state-changing requests
fetch('/api/students', {
  method: 'POST',
  headers: { 
    'x-auth-token': token,
    'x-csrf-token': csrfToken
  },
  body: JSON.stringify({...})
});
```

### Pitfall: Test compatibility
- CSRF middleware MUST skip in test environment
- Use `typeof jest !== 'undefined' || process.env.NODE_ENV === 'test'` check
- Don't force-test suites to include CSRF tokens

## HTTPS Redirect Pattern

### When to use
- Production deployments with SSL certificates
- Compliance requirements (PCI-DSS, HIPAA)
- WebSocket connections require WSS

### Implementation
```javascript
// In server.js, before route mounting
if (process.env.NODE_ENV !== 'test') {
  app.use((req, res, next) => {
    if (req.protocol === 'http' && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });
}

// Trust proxy for reverse proxy deployments
app.set('trust proxy', 1);
```

### Pitfall: Trust proxy
- Without `app.set('trust proxy', 1)`, `req.protocol` returns 'http' even behind HTTPS reverse proxy
- Required for nginx/Cloudflare/load balancer deployments

## Static Asset Caching Strategy

### When to use
- Production deployments
- Reduce bandwidth and improve load times

### Implementation
```javascript
// Server-side: cache JS/CSS, no-cache HTML
app.use('/js/', express.static(path.join(__dirname, 'public', 'js'), { maxAge: '31536000' }));
app.use('/css/', express.static(path.join(__dirname, 'public', 'css'), { maxAge: '31536000' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '0' }));
```

### Pitfall: Version bump required
- When updating JS/CSS files, change version number or add content hash
- Otherwise browsers serve stale cached files
- Pattern: `const APP_VERSION = 'v3.6.3';` in base.js, append `?v=${APP_VERSION}` to script tags

## API Documentation with Swagger

### When to use
- REST API projects
- Team collaboration requiring API visibility
- Client development needs contract documentation

### Implementation
```javascript
// Install: npm install swagger-jsdoc swagger-ui-express
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

function initSwagger(app) {
  const spec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }
      }
    },
    apis: ['./routes/**/*.js']
  });
  app.use('/swagger', swaggerUi.serve, swaggerUi.setup(spec));
  app.get('/swagger.json', (req, res) => res.json(spec));
}
```

### JSDoc annotation pattern
```javascript
/**
 * @openapi
 * /api/students:
 *   post:
 *     tags: [Students]
 *     summary: Create student
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, class_name]
 *             properties:
 *               name: { type: string }
 */
router.post('/api/students', authMiddleware, (req, res) => { ... });
```

## Database Seeding for Demo Environments

### When to use
- Product demonstrations
- Testing environments
- Quick setup for new installations

### Implementation pattern
```javascript
// utils/seed-demo.js
async function seedDemoData() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbFile));
  
  // Insert demo students
  const students = [/*...*/];
  const stmt = db.prepare(`INSERT OR REPLACE INTO students (student_id, name, ...) VALUES (?, ?, ...)`);
  for (const s of students) stmt.run([s.id, s.name, ...]);
  stmt.free();
  
  // Generate historical records
  for (let day = 0; day < 7; day++) {
    // ...
  }
  
  fs.writeFileSync(dbFile, Buffer.from(db.export()));
  db.close();
}
```

### Pitfall: Transaction safety
- sql.js doesn't support transactions natively
- Export and write atomically to avoid partial writes
- Always backup before seeding in production
