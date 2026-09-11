# Security Hardening Patterns

## CSRF Protection for Express Apps

### Pattern: One-time token with 24h expiry
```js
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
  // Skip for idempotent methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  
  const token = req.headers['x-csrf-token'] || req.body?._csrf || req.query?._csrf;
  if (!token || !csrfTokens.delete(token)) {
    return res.status(403).json({ code: 1, message: 'CSRF token invalid or expired' });
  }
  next();
}
```

### Key rules
- Token is **consumed once** (delete after use) — prevents replay
- GET/HEAD/OPTIONS exempt (idempotent, no state change)
- Token source priority: Header > Body > Query
- Test environment bypass: check `process.env.NODE_ENV === 'test'`

### Frontend integration
```js
// On login success, fetch token and store
const tokenRes = await fetch('/api/csrf-token', { headers: { 'x-auth-token': token } });
window.csrfToken = (await tokenRes.json()).data.token;

// Include in all write requests
fetch('/api/endpoint', {
  method: 'POST',
  headers: { 'x-csrf-token': window.csrfToken, 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
});
```

## HTTPS Enforcement

### Pattern: 301 redirect from HTTP to HTTPS
```js
// In server.js before route mounting
if (process.env.NODE_ENV !== 'test') {
  app.use((req, res, next) => {
    if (req.protocol === 'http' && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });
}
app.set('trust proxy', 1); // Required when behind reverse proxy
```

### Why trust proxy matters
Without `app.set('trust proxy', 1)`, Express sees `req.protocol` as `http` even when
the client connected via HTTPS through nginx/Cloudflare. This breaks redirect logic.

## XSS Prevention via DOM-Safe Operations

### Pattern: Replace innerHTML with safe alternatives
```js
// public/js/modules/dom-safe.js
window.createSafeElement = function(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  // Remove dangerous elements
  div.querySelectorAll('script').forEach(s => s.remove());
  // Remove event handlers
  div.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    });
  });
  return div.firstChild || div;
};

// Usage: replace el.innerHTML = '<div>...</div>'
// With: el.appendChild(createSafeElement('<div>...</div>'))
```

### Audit checklist for innerHTML
1. Find all `innerHTML` assignments: `grep -n innerHTML *.html`
2. Categorize each:
   - **Safe**: Contains `esc()` calls for all user data
   - **Risky**: Static strings only (e.g., "暂无数据") — low risk but should use `textContent`
   - **Dangerous**: Interpolates user data without escaping → must fix
3. Fix dangerous cases with `createSafeElement()` or DOM API

### Static analysis script
```bash
# Find innerHTML without esc()
grep -n 'innerHTML' public/*.html | grep -v 'esc(' | grep -v '//' | head -30
```

## Secure File Download Pattern

### Pattern: Auth-gated download + path traversal guard
```js
// In server.js
app.get(['/reports/:file', '/uploads/:file'], authMiddleware, (req, res) => {
  const dirName = req.path.startsWith('/uploads') ? 'uploads' : 'reports';
  const safe = path.basename(req.params.file || ''); // Removes path traversal
  if (!safe || safe === '.' || safe === '..') {
    return res.status(400).json({ code: 1, message: '非法文件名' });
  }
  const fp = path.join(__dirname, 'public', dirName, safe);
  fs.stat(fp, (err) => {
    if (err) return res.status(404).json({ code: 1, message: '资源不存在' });
    res.download(fp, safe);
  });
});

// Block bare directory access
app.use(['/uploads/', '/reports/'], (req, res) => {
  res.status(403).json({ code: 1, message: '该资源需登录后通过认证接口访问' });
});
```

## Database Migration Pattern

### Pattern: Schema version management
```js
// utils/migrations.js
const CURRENT_SCHEMA_VERSION = 15;

function runMigrations(db) {
  const versionRow = db.exec("SELECT value FROM settings WHERE key='schema_version'")[0]?.values?.[0];
  const currentVersion = versionRow ? parseInt(versionRow[0]) : 0;
  
  if (currentVersion >= CURRENT_SCHEMA_VERSION) return;
  
  // Execute incremental migrations
  const migrations = [
    { version: 11, apply: (db) => { /* ... */ } },
    // ...
  ];
  
  for (const m of migrations) {
    if (m.version > currentVersion) {
      m.apply(db);
      db.run("INSERT OR REPLACE INTO settings(key, value) VALUES('schema_version', ?)", [m.version]);
    }
  }
}
```

## Static Asset Caching Strategy

### Pattern: Different cache policies by file type
```js
// In server.js
// Long cache for versioned/static assets
app.use('/js/', express.static(path.join(__dirname, 'public', 'js'), { maxAge: '31536000' }));
app.use('/css/', express.static(path.join(__dirname, 'public', 'css'), { maxAge: '31536000' }));
app.use('/icons/', express.static(path.join(__dirname, 'public', 'icons'), { maxAge: '31536000' }));

// No cache for HTML (always get latest)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '0' }));
```

## Testing Considerations

### Pattern: Skip security checks in test environment
```js
function csrfProtection(req, res, next) {
  // Bypass in tests to avoid breaking test suites
  if (typeof jest !== 'undefined' || process.env.NODE_ENV === 'test') {
    return next();
  }
  // ... normal CSRF logic
}
```
