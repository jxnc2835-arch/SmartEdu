/**
 * SmartEdu Service Worker
 * 提供离线缓存、后台同步、推送通知能力
 */

const CACHE_NAME = 'smartedu-v3.6.3';
const STATIC_ASSETS = [
  '/',
  '/teacher.html',
  '/student.html',
  '/dashboard.html',
  '/ui-enhance.css',
  '/favicon.ico',
  '/js/modules/base.js',
  '/js/modules/auth.js',
  '/js/modules/navigation.js',
  '/js/modules/notifications.js',
  '/js/modules/dom-safe.js',
  '/js/modules/checkin.js',
  '/js/modules/students.js'
];

// 安装事件 - 预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] 缓存静态资源');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] 删除旧缓存:', name);
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

// 请求拦截 - 优先使用缓存
self.addEventListener('fetch', (event) => {
  const { request } = event;
  
  // API 请求使用网络优先
  if (request.url.includes('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }
  
  // 静态资源使用缓存优先
  event.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request).then((response) => {
        // 成功获取后更新缓存
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
        }
        return response;
      }).catch(() => {
        // 离线时返回 fallback 页面
        if (request.destination === 'document') {
          return caches.match('/teacher.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// 网络优先策略
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // 成功时更新缓存
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch (error) {
    // 失败时返回缓存
    return caches.match(request);
  }
}

// 后台同步 - 处理离线提交的签到
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-checkin') {
    event.waitUntil(syncCheckinRecords());
  }
});

// 推送通知
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const options = {
    body: data.body || '新通知',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/',
      timestamp: Date.now()
    },
    actions: [
      { action: 'view', title: '查看' },
      { action: 'dismiss', title: '关闭' }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title || 'SmartEdu', options)
  );
});

// 通知点击
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  if (event.action === 'view') {
    event.waitUntil(
      self.clients.openWindow(event.notification.data.url)
    );
  }
});

// 消息处理
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};
  
  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'CLEAR_CACHE':
      caches.delete(CACHE_NAME);
      break;
    case 'REQUEST_SYNC':
      self.registration.sync.register('sync-checkin');
      break;
  }
});

console.log('[SW] SmartEdu Service Worker loaded');
