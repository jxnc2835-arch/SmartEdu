const CACHE_NAME = 'pwa-v5';
const STATIC_CACHE = 'static-v5';

// 更新日期 - 修改此值将触发 Service Worker 更新，刷新所有缓存
const BUILD_TIME = '2026-06-28_19:14';

// 需要缓存的资源（仅离线资源，HTML 文件走网络优先）
const OFFLINE_ASSETS = [
  '/manifest.json',
  '/ui-enhance.css',
  '/sw.js'
];

// 安装Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        return cache.addAll(OFFLINE_ASSETS).catch(err => {
          console.warn('Cache offline assets error:', err);
        });
      })
      .then(() => {
        // 立即激活新版本
        return self.skipWaiting();
      })
  );
});

// 激活Service Worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== STATIC_CACHE)
          .map(key => caches.delete(key))
      );
    }).then(() => {
      // 立即接管所有客户端
      return self.clients.claim();
    })
  );
});

// 拦截请求
self.addEventListener('fetch', event => {
  const { request } = event;
  
  // API请求：网络优先（离线时返回错误响应）
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .catch(() => {
          return new Response(JSON.stringify({
            code: 1,
            message: '离线模式，数据将稍后同步'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }
  
  // HTML 页面：网络优先（始终加载最新版，离线时回退到缓存）
  const isHtml = request.mode === 'navigate' || 
    request.url.endsWith('.html') || 
    request.url.endsWith('/');
  
  if (isHtml) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // 缓存最新版本以便离线使用
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(cache => {
            cache.put(request, clone);
          });
          return response;
        })
        .catch(() => {
          return caches.match(request).then(cached => {
            return cached || new Response('离线模式', { status: 200 });
          });
        })
    );
    return;
  }
  
  // 静态资源（CSS/JS/图片等）：缓存优先，网络更新
  event.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) {
          // 有缓存立即返回，同时后台请求最新版更新缓存
          fetch(request).then(response => {
            if (response.status === 200) {
              caches.open(STATIC_CACHE).then(cache => {
                cache.put(request, response);
              });
            }
          }).catch(() => {});
          return cached;
        }
        
        // 没有缓存，从网络获取
        return fetch(request).then(response => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then(cache => {
              cache.put(request, clone);
            });
          }
          return response;
        }).catch(() => {
          // 离线且无缓存
          return new Response('资源不可用', { status: 503 });
        });
      })
  );
});

// 消息处理
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CHECK_VERSION') {
    // 向页面回复当前版本
    event.source.postMessage({
      type: 'VERSION_INFO',
      buildTime: BUILD_TIME,
      cacheName: CACHE_NAME
    });
  }
});
