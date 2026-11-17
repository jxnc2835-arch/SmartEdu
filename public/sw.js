/**
 * SmartEdu Service Worker - 安全版 (v6)
 * 策略：
 *  - HTML 页面 / API 请求：永不拦截（始终走网络，杜绝旧页缓存导致"进不去"）
 *  - 静态资源 (js/css/图片/字体)：缓存优先 + 后台更新
 *  - 激活时自动清理所有旧版本缓存
 *  - 新版本安装后自动 skipWaiting，一次刷新即生效
 */

const CACHE_VERSION = 'smartedu-v11-facelib';
const KEEP_CACHES = [CACHE_VERSION];

// 需要缓存的静态资源特征
function isStaticAsset(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return false;
  // 关键脚本不走 SW 缓存拦截（face-api 等），始终走网络，避免缓存的旧/损坏副本导致 ERR_FAILED
  if (['face-api.min.js', 'face-api.js'].includes(url.pathname.split('/').pop())) return false;
  // 明确的静态资源类型
  if (['script', 'style', 'image', 'font', 'manifest', 'icon'].includes(request.destination)) return true;
  return /\.(js|css|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|map)(\?|$)/i.test(url.pathname);
}

// ==================== 安装 ====================
self.addEventListener('install', () => {
  // 不预缓存（避免任一 URL 404 导致安装失败），按需懒缓存
  self.skipWaiting();
});

// ==================== 激活：清理所有旧缓存 ====================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => {
          console.log('[SW] 清理旧缓存:', k);
          return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ==================== 请求拦截：只处理静态资源 ====================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isStaticAsset(request)) return; // HTML / API / 跨域 → 不拦截，走网络

  event.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(request).then((cached) => {
        // 有缓存立即返回，同时后台拉新版刷新缓存（stale-while-revalidate）
        const network = fetch(request)
          .then((resp) => {
            if (resp && resp.status === 200) cache.put(request, resp);
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});

// ==================== 消息：允许新 SW 立即接管 ====================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ==================== 推送通知（可选） ====================
self.addEventListener('push', (event) => {
  const data = (event.data && event.data.json()) || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'SmartEdu', {
      body: data.body || '',
      icon: '/icons/icon-192.svg',
      data: { url: data.url || '/teacher.html' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/teacher.html';
  event.waitUntil(clients.openWindow(target));
});

console.log('[SW] SmartEdu Service Worker v6 (HTML/API 不拦截)');
