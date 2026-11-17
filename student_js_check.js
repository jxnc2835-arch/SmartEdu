
const esc=s=>{if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');};
// ===== PWA Service Worker 注册 =====
let deferredPrompt = null; // 安装提示事件
let myRefreshTimer = null; // "我的"页面自动刷新定时器

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // 有新版本，静默刷新（不弹 confirm）
          console.log('[SW] 检测到新版本，准备刷新...');
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.location.reload();
          }, { once: true });
          newWorker.postMessage({ action: 'skipWaiting' });
        }
      });
    });
    reg.update();
  }).catch(err => {
    console.warn('SW注册失败:', err);
  });

  // 监听新的SW控制器切换后刷新页面
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}

// 学生修改密码
async function changeMyPassword(){
  const pwd=document.getElementById('myNewPwd').value;
  const result=document.getElementById('myPwdResult');
  if(!pwd||pwd.length<6){result.textContent='⚠️ 密码至少6位';result.style.color='#ef4444';return;}
  if(!myStudentId){result.textContent='⚠️ 请先登录';return;}
  try{
    const r=await fetch('/api/student/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({student_id:myStudentId,password:pwd})
    });
    const j=await r.json();
    if(j.code===0){
      result.textContent='✅ 密码设置成功！';
      result.style.color='#22c55e';
      document.getElementById('myNewPwd').value='';
    }else{
      result.textContent='❌ '+j.message;
      result.style.color='#ef4444';
    }
  }catch(e){
    result.textContent='❌ 设置失败';
    result.style.color='#ef4444';
  }
}

// 学生操行分和日历
async function loadStudentDashboard(){
  if(!myStudentId)return;
  try{
// 操行评分
    const r=await fetch('/api/stats/conduct/public?days=30');const j=await r.json();
    if(j.code===0&&j.data){
      const me=j.data.find(s=>s.student_id===myStudentId)||j.data.find(s=>String(s.id)===myStudentId);
      if(me){
        document.getElementById('myConductScore').textContent=me.score;
        const lv=me.score>=90?'🌟 优秀':me.score>=75?'👍 良好':me.score>=60?'📖 及格':'💪 需加油';
        document.getElementById('myConductLevel').textContent=lv;
      }
    }
    // 30天日历
    const d=new Date();const days=[];
    for(let i=29;i>=0;i--){const t=new Date(d);t.setDate(t.getDate()-i);days.push(t.toISOString().slice(0,10));}
    const cr=await fetch('/api/students');const cj=await cr.json();
    if(cj.code===0&&cj.data){
      const records=cj.data.filter(s=>s.id===myStudentId);
      // 简化版日历显示
      let html='<div style="display:flex;flex-wrap:wrap;gap:3px">';
      days.forEach(date=>{
        const day=new Date(date).getDay();
        const isWeekend=day===0||day===6;
        html+=`<div style="width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;background:${isWeekend?'#f1f5f9':'#eef2ff'};color:#64748b">${new Date(date).getDate()}</div>`;
      });
      html+='</div>';
      document.getElementById('myCalendar').innerHTML=html+'<p style="margin-top:8px;font-size:11px;color:var(--gray)">灰色=周末 · 完整签到数据需等待查寝记录对接</p>';
    }
  }catch(e){}
}

// 监听beforeinstallprompt事件
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallPrompt();
});

// 请求桌面通知权限
function requestNotificationPermission() {
  if (!('Notification' in window)) {
    console.warn('此浏览器不支持桌面通知');
    return;
  }
  
  // 登录成功后请求权限
  const originalDoLogin = window.doLogin;
  window.doLogin = function() {
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          toast('✅ 已开启桌面通知');
        }
      });
    }
    return originalDoLogin.apply(this, arguments);
  };
}

// 页面加载完成后请求通知权限
if ('Notification' in window && Notification.permission === 'default') {
  // 延迟2秒后请求，避免打扰用户
  setTimeout(() => {
    const notifyDiv = document.createElement('div');
    notifyDiv.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #10b981, #34d399);
      color: white;
      padding: 12px 20px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(16,185,129,0.4);
      z-index: 10000;
      max-width: 90%;
      width: 340px;
      font-size: 13px;
      animation: slideDown 0.3s ease;
    `;
    notifyDiv.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">🔔</span>
        <div style="flex:1">
          <div style="font-weight:600;margin-bottom:2px">开启桌面通知</div>
          <div style="opacity:0.9;font-size:12px">请假审批结果将及时通知您</div>
        </div>
        <button id="notifyAllow" style="background:white;color:#10b981;border:none;padding:6px 12px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px">允许</button>
        <button id="notifyDeny" style="background:transparent;color:white;border:none;padding:4px 8px;font-size:16px;cursor:pointer">✕</button>
      </div>
    `;
    
    // 添加动画
    if (!document.getElementById('notify-style')) {
      const style = document.createElement('style');
      style.id = 'notify-style';
      style.textContent = `
        @keyframes slideDown {
          from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }
    
    document.body.appendChild(notifyDiv);
    
    notifyDiv.querySelector('#notifyAllow').addEventListener('click', async () => {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        toast('✅ 桌面通知已开启');
      }
      notifyDiv.remove();
    });
    
    notifyDiv.querySelector('#notifyDeny').addEventListener('click', () => {
      notifyDiv.remove();
    });
    
    // 8秒后自动消失
    setTimeout(() => {
      if (notifyDiv.parentElement) {
        notifyDiv.style.opacity = '0';
        notifyDiv.style.transition = 'opacity 0.3s';
        setTimeout(() => notifyDiv.remove(), 300);
      }
    }, 8000);
  }, 2000);
}

// 显示安装提示
function showInstallPrompt() {
  if (!deferredPrompt) return;
  
  // 检查是否已经提示过
  if (localStorage.getItem('pwa-install-dismissed')) {
    return;
  }
  
  // 延迟3秒后显示安装提示
  setTimeout(() => {
    const installDiv = document.createElement('div');
    installDiv.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #4f46e5, #6366f1);
      color: white;
      padding: 16px 20px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(79,70,229,0.4);
      z-index: 10000;
      max-width: 90%;
      width: 360px;
      animation: slideUp 0.3s ease;
    `;
    installDiv.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:32px">📱</span>
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">安装到桌面</div>
          <div style="font-size:12px;opacity:0.9">像APP一样快速访问</div>
        </div>
        <button id="installBtn" style="background:white;color:#4f46e5;border:none;padding:8px 16px;border-radius:8px;font-weight:600;cursor:pointer;font-size:13px">安装</button>
        <button onclick="this.parentElement.parentElement.remove();localStorage.setItem('pwa-install-dismissed','1')" style="background:transparent;color:white;border:none;padding:4px 8px;font-size:18px;cursor:pointer">✕</button>
      </div>
    `;
    
    // 添加动画样式
    if (!document.getElementById('pwa-install-style')) {
      const style = document.createElement('style');
      style.id = 'pwa-install-style';
      style.textContent = `
        @keyframes slideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }
    
    document.body.appendChild(installDiv);
    
    // 安装按钮点击事件
    installDiv.querySelector('#installBtn').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      
      if (outcome === 'accepted') {
        toast('✅ 安装成功！请在桌面打开');
      }
      
      deferredPrompt = null;
      installDiv.remove();
    });
    
    // 10秒后自动消失
    setTimeout(() => {
      if (installDiv.parentElement) {
        installDiv.style.opacity = '0';
        installDiv.style.transition = 'opacity 0.3s';
        setTimeout(() => installDiv.remove(), 300);
      }
    }, 10000);
  }, 3000);
}

// ===== 全局状态 =====
let myStudentId = localStorage.getItem('myStudentId') || '';
let myClassName = localStorage.getItem('myClassName') || '';
let myDorm = localStorage.getItem('myDorm') || '';
let myStudentToken = localStorage.getItem('myStudentToken') || '';
let cameraStream = null, camMode = '', photoData = '', faceDetected = false, modelsLoaded = false, detInterval = null;
let landmarkLoaded = false;          // 关键点+表情模型是否就绪（活体检测前置）
let expressionLoaded = false;        // 表情模型是否就绪（活体 blink 辅助信号，可选）
let livenessPassed = false;          // 活体检测是否通过
let livenessScore = 0;               // 活体置信度（基于眨眼动作稳定性）
let blinkCount = 0;                  // 检测到的眨眼次数
let eyeState = 'open';               // 当前眼睛状态（兼容保留）
let closedFrames = 0;                // 当前闭眼段持续帧数（兼容保留，眨眼模式下按通道判定，暂不使用）
let prevLivenessClosed = false;      // 上一帧是否处于闭眼（兼容保留，眨眼模式下按通道判定，暂不使用）
let livenessActive = false;          // 活体检测循环是否在运行
let livenessMode = '';               // 当前活体检测所属模式
let livenessSkipped = false;         // 用户手动跳过了活体检测（兜底通道）
let livenessSkipReason = '';         // 跳过原因（manual_学号 / auto_timeout 等，供后端审计）
// ===== 眨眼活体检测（唯一活体通道）=====
// 三通道判定：① EAR 相对动态基线骤降  ② 表情 blink 概率  ③ EAR 绝对值兜底
// EAR 取「眼睛开合度」（眼皮到眼角的水平/竖直比），人脸正面、睁眼时典型 0.25~0.45，闭眼骤降到 <0.15。
// 基线只在"稳定睁眼"时抬升（只抬不降、封顶 0.50），避免眨眼帧污染基线把降幅门槛压低（旧坑）
let livenessBaselineEar = null;    // 睁眼 EAR 动态基线（滑动衰减，仅稳定睁眼时抬升）
let livenessEarSamples = [];       // 近 30 帧 EAR 样本（用于判断是否"稳定睁眼"）
let prevEarSample = 0;            // 上一帧 EAR（用于骤降判定）
let livenessEarDropSeenAt = 0;     // 最近一次"骤降"时间戳（用于 3s 兜底窗口）
let livenessEarDropGraceMs = 3000; // 骤降后 3s 内有效（容忍采样滑过闭眼帧）
let livenessEarDropRatio = 0.30;   // EAR 相对基线骤降 ≥ 30% 视为一次眨眼（基线 0.28 时要求 EAR ≤0.196；睁眼 0.28~0.35 不误触发）
let livenessEarAbsolute = 0.20;    // EAR 绝对值 < 0.20 兜底（您实际眨眼瞬态最低 0.20~0.23；睁眼 0.28~0.35 不会误触发）
let livenessEarCeil = 0.45;        // EAR 合理上限（睁眼 0.25~0.35，封顶 0.45 防 landmark 抖动虚高）
let livenessBlinkExpr = 0.20;      // 表情 blink 概率 ≥ 0.20 视为一次眨眼
// ===== 窗口最低点判定（治"采样稀释"）=====
let livenessWindowMs = 600;          // 近 0.6s 窗口（采样 100ms 时约 6 帧）
let livenessEarWindow = [];          // [{t, ear}] 近窗口 EAR 样本
let livenessWindowDropRatio = 0.20;  // 窗口最低点相对基线降幅 ≥ 20% 即判眨眼（比单帧 30% 宽，容忍采样稀释）
let livenessOk = false;           // 本周期是否已判定到一次有效眨眼
const locState = { ci: null, cl: null };
const OFFLINE_QUEUE = []; // 离线队列
let isOnline = navigator.onLine; // 网络状态

// ===== IndexedDB 离线存储 =====
const DB_NAME = 'checkin-offline';
const DB_VERSION = 1;
const STORE_NAME = 'pending-submissions';
let dbConn = null;

function openIndexedDB() {
  return new Promise((resolve, reject) => {
    if (dbConn) { resolve(dbConn); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      dbConn = request.result;
      resolve(dbConn);
    };
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('synced', 'synced', { unique: false });
      }
    };
  });
}

async function saveOfflineRecord(record) {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.add(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('IndexedDB 保存失败:', e);
    return false;
  }
}

async function loadOfflineRecords() {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('synced');
      const request = index.getAll('false');
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('IndexedDB 读取失败:', e);
    return [];
  }
}

async function markAsSynced(recordId) {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(recordId);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (record) {
          record.synced = true;
          store.put(record);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch (e) {
    console.error('IndexedDB 标记失败:', e);
    return false;
  }
}

async function deleteOfflineRecord(recordId) {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(recordId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('IndexedDB 删除失败:', e);
    return false;
  }
}

async function clearOfflineRecords() {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('IndexedDB 清除失败:', e);
    return false;
  }
}

// 人脸检测库（本地化）已直接引入
let faceApiReady = false;

// 检测移动端并显示提示
(function() {
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isHttp = location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  if (isMobile && isHttp) {
    // 显示手机用户提示
    const hint = document.getElementById('ciCamMobileHint');
    if (hint) hint.style.display = 'block';
  }
})();
function loadFaceApi() {
  if (faceApiReady || typeof faceapi !== 'undefined') { faceApiReady = true; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    // 优先使用本地文件
    const s = document.createElement('script');
    s.src = 'face-api.min.js';
    s.onload = () => { faceApiReady = true; resolve(); };
    s.onerror = () => {
      // 本地加载失败，尝试 CDN
      console.warn('⚠️ 本地 face-api.js 加载失败，尝试 CDN');
      const cdn = document.createElement('script');
      cdn.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
      cdn.onload = () => { faceApiReady = true; resolve(); };
      cdn.onerror = () => reject(new Error('face-api.js 加载失败'));
      document.head.appendChild(cdn);
    };
    document.head.appendChild(s);
  });
}

// 监听网络状态变化并显示状态条
window.addEventListener('online', () => {
  isOnline = true;
  const bar = document.getElementById('networkStatus');
  if (bar) bar.style.display = 'none';
  syncOfflineData();
});
window.addEventListener('offline', () => {
  isOnline = false;
  const bar = document.getElementById('networkStatus');
  if (bar) bar.style.display = 'flex';
  toast('🔴 网络已断开，数据将本地保存');
});

function syncOfflineData() {
  if (OFFLINE_QUEUE.length === 0 || !isOnline) return;
  
  // 首先同步 IndexedDB 中的离线记录
  loadOfflineRecords().then(async (records) => {
    if (records.length === 0) return;
    
    let synced = 0;
    for (const record of records.slice(0, 10)) { // 每次最多同步10条
      try {
        const payload = { ...record.data };
        const headers = {'Content-Type': 'application/json'};
        if (myStudentToken) headers['x-student-token'] = myStudentToken;
        
        let url = '/api/checkin';
        if (record.type === 'voice') url = '/api/voice-checkin';
        else if (record.type === 'class') url = '/api/class-checkin';
        
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });
        
        const j = await res.json();
        if (j.code === 0) {
          await markAsSynced(record.id);
          synced++;
        }
      } catch (e) {
        console.error('同步单条记录失败:', e);
      }
    }
    
    if (synced > 0) {
      toast(`✅ 已同步 ${synced} 条离线数据`);
      // 重新加载当前页面数据
      refreshCurrentTab();
    }
  }).catch(() => {});
  
  // 同时同步内存中的 OFFLINE_QUEUE
  if (OFFLINE_QUEUE.length > 0) {
    const headers = {'Content-Type': 'application/json'};
    if (myStudentToken) headers['x-student-token'] = myStudentToken;
    fetch('/api/offline/sync', {
      method: 'POST',
      headers,
      body: JSON.stringify({ actions: OFFLINE_QUEUE })
    }).then(res => res.json()).then(j => {
      if (j.code === 0) {
        toast(`✅ 已同步 ${j.synced} 条离线数据`);
        OFFLINE_QUEUE.length = 0;
        localStorage.removeItem('offlineQueue');
      }
  }).catch(() => {});
}

// 刷新当前标签页数据
function refreshCurrentTab() {
  const pages = document.querySelectorAll('.page');
  pages.forEach(p => {
    if (p.classList.contains('active')) {
      const id = p.id;
      if (id === 'page-checkin') { loadCheckinData(); loadPendingCheckinTasks(); }
      else if (id === 'page-leave') { loadMyLeaves(); }
      else if (id === 'page-class') { loadMyClass(); }
      else if (id === 'page-my') { loadMyStatistics(); }
    }
  });
}
}

// ===== 人脸特征提取 =====
async function extractFaceEmbedding(base64OrUrl) {
  if (typeof faceapi === 'undefined') return null;
  try {
    // 确保模型已加载
    if (!modelsLoaded) {
      await loadFaceModels();
    }
    
    // 如果是base64字符串，先转成Image
    let img;
    if (base64OrUrl.startsWith('data:')) {
      const resp = await fetch(base64OrUrl);
      const blob = await resp.blob();
      img = await faceapi.bufferToImage(await blob.arrayBuffer());
    } else {
      img = await faceapi.fetchImage(base64OrUrl);
    }
    
    // 检测人脸并提取特征（128维向量）
    const detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions());
    
    if (detections.length === 0) {
      console.warn('未检测到人脸');
      return null;
    }
    
    // 取最清晰/最大的那张人脸
    const bestDetection = detections.sort((a, b) => {
      const scoreA = a.detection.score;
      const scoreB = b.detection.score;
      const sizeA = a.detection.box.width * a.detection.box.height;
      const sizeB = b.detection.box.width * b.detection.box.height;
      return (scoreB * sizeB) - (scoreA * sizeA);
    })[0];
    
    const faceVector = bestDetection.descriptor;
    
    // 转换为普通数组（Float32Array -> Array）
    return Array.from(faceVector);
  } catch (e) {
    console.warn('人脸特征提取失败:', e.message);
    return null;
  }
}

// 保存离线数据到 localStorage
function saveOfflineQueue() {
  localStorage.setItem('offlineQueue', JSON.stringify(OFFLINE_QUEUE));
}

// 从 localStorage 恢复离线队列
function loadOfflineQueue() {
  const saved = localStorage.getItem('offlineQueue');
  if (saved) {
    try {
      Object.assign(OFFLINE_QUEUE, JSON.parse(saved));
    } catch (e) {}
  }
}

loadOfflineQueue();

function toast(m, duration){const e=document.getElementById('toast');e.textContent=m;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),duration||2500)}

// ===== 确认对话框 =====
function confirmDialog(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); z-index: 10001;
      display: flex; align-items: center; justify-content: center;
      animation: fadeIn 0.2s ease;
    `;
    
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white; border-radius: 16px; padding: 24px;
      max-width: 320px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      animation: slideUp 0.3s ease;
    `;
    dialog.innerHTML = `
      <h3 style="margin-bottom:12px;font-size:18px;color:#0f172a">${esc(title)}</h3>
      <p style="margin-bottom:20px;font-size:14px;color:#64748b;line-height:1.6">${esc(message)}</p>
      <div style="display:flex;gap:10px">
        <button id="confirmCancel" style="flex:1;padding:10px;border:1.5px solid #e2e8f0;border-radius:10px;background:#f8fafc;color:#475569;font-size:14px;font-weight:600;cursor:pointer">取消</button>
        <button id="confirmOk" style="flex:1;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:white;font-size:14px;font-weight:600;cursor:pointer">确定</button>
      </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    const close = (result) => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.2s';
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };
    
    dialog.querySelector('#confirmCancel').onclick = () => close(false);
    dialog.querySelector('#confirmOk').onclick = () => close(true);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
  });
}
function todayStr(){
  const d=new Date();
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// 统一时间格式化：中文年月日格式
function fmtTime(t, fallbackDate){
  if(!t) return fallbackDate || '-';
  try{
    const d=new Date(t);
    if(isNaN(d.getTime())){
      if(/^\d{2}:\d{2}/.test(t)){
        return fallbackDate ? fallbackDate + ' ' + t : t;
      }
      return t;
    }
    const y=d.getFullYear();
    const m=d.getMonth()+1;
    const day=d.getDate();
    const h=String(d.getHours()).padStart(2,'0');
    const mi=String(d.getMinutes()).padStart(2,'0');
    const s=String(d.getSeconds()).padStart(2,'0');
    return `${y}年${m}月${day}日 ${h}:${mi}:${s}`;
  }catch(e){return t;}
}

// ===== 学生数据 + 登录 =====
let studentMap = {}; // id → {name, dorm, class_name}
let classStudents = {}; // class_name → [students]
let allClasses = []; // 所有班级列表

async function loadStudents() {
  try {
    const r = await fetch('/api/students/public');
    const j = await r.json();
    if (j.code !== 0 || !j.data || j.data.length === 0) {
      console.warn('⚠️ 没有学生数据，请先在管理端导入学生');
      const classSel = document.getElementById('loginClass');
      if (classSel) classSel.innerHTML = '<option value="">— 暂无数据 —</option>';
      return;
    }
    
    studentMap = {};
    classStudents = {};
    allClasses = [];
    
    j.data.forEach(s => { 
      studentMap[s.id] = s; 
      // 按班级分组
      const cls = s.class_name || '未分班';
      if (!classStudents[cls]) classStudents[cls] = [];
      classStudents[cls].push(s);
      if (!allClasses.includes(cls)) allClasses.push(cls);
    });
    allClasses.sort();
    
    // 填充班级下拉
    const classSel = document.getElementById('loginClass');
    if (classSel) {
      classSel.innerHTML = '<option value="">— 请选择班级 —</option>';
      allClasses.forEach(cls => {
        classSel.innerHTML += `<option value="${esc(cls)}">${esc(cls)}（${classStudents[cls].length}人）</option>`;
      });
    }

    // 如果已登录则直接恢复
    if (myStudentId && studentMap[myStudentId]) {
      const s = studentMap[myStudentId];
      myClassName = s.class_name || '';
      myDorm = s.dorm || '';
      localStorage.setItem('myClassName', myClassName);
      localStorage.setItem('myDorm', myDorm);
      const cls = s.class_name || '未分班';
      if (classSel) classSel.value = cls;
      onStudentSearch(); // 过滤学生列表
      const studentId = myStudentId;
      document.getElementById('loginStudent').value = studentId;
      document.getElementById('loginOverlay').style.display = 'none';
      document.getElementById('userBar').style.display = 'flex';
      document.getElementById('userBarName').textContent = `👤 ${esc(s.name)}（${esc(s.dorm)}）`;
    }
  } catch(e) {
    console.error('加载学生数据失败:', e);
    toast('⚠️ 加载学生数据失败: ' + e.message);
  }
}

// 班级改变时，重置学生选择并搜索
function onClassChange() {
  const cls = document.getElementById('loginClass').value || '';
  const studentSel = document.getElementById('loginStudent');
  // 清空学生下拉
  studentSel.innerHTML = '<option value="">— 请选择学生 —</option>';
  document.getElementById('loginStudentSearch').value = '';
  document.getElementById('loginBtn').disabled = true;
  document.getElementById('loginStudentInfo').textContent = '';
  
  if (cls && classStudents[cls]) {
    classStudents[cls].forEach(s => {
      studentSel.innerHTML += `<option value="${s.id}">${esc(s.name)}（${esc(s.dorm)}）</option>`;
    });
  }
}

// 学生搜索（实时过滤）
function onStudentSearch() {
  const keyword = document.getElementById('loginStudentSearch').value.trim().toLowerCase();
  const cls = document.getElementById('loginClass').value || '';
  const studentSel = document.getElementById('loginStudent');
  
  // 清空学生下拉
  studentSel.innerHTML = '<option value="">— 请选择学生 —</option>';
  
  if (!cls) return;
  
  const students = classStudents[cls] || [];
  const filtered = students.filter(s => {
    if (!keyword) return true;
    return s.name.toLowerCase().includes(keyword) || 
           s.id.toLowerCase().includes(keyword);
  });
  
  filtered.forEach(s => {
    studentSel.innerHTML += `<option value="${esc(s.id)}">${esc(s.name)}（${esc(s.dorm)}）</option>`;
  });
  
  // 如果只有一个匹配，自动选中
  if (filtered.length === 1) {
    studentSel.value = filtered[0].id;
    onStudentSelect();
  }
}

// 学生选择变化
function onStudentSelect() {
  const id = document.getElementById('loginStudent').value;
  document.getElementById('loginBtn').disabled = !id;
  const s = id ? studentMap[id] : null;
  document.getElementById('loginStudentInfo').textContent = s ? `${esc(s.name)} · ${esc(s.dorm)}${s.class_name?' · '+esc(s.class_name):''}` : '';
}

// 监听学生选择变化
document.addEventListener('DOMContentLoaded', () => {
  const studentSel = document.getElementById('loginStudent');
  if (studentSel) {
    studentSel.onchange = onStudentSelect;
  }
});

// ==================== WebSocket 监听 ====================
// 连接服务器 WebSocket（WS 已启用鉴权：token 经 URL 查询参数传递，浏览器无法设自定义 header。
// 未登录时服务器拒绝 upgrade，登录成功/掉线后用当前 token 重建连接）
// 协议自适应：HTTPS 页面下用 wss://（自签证书手机会警告但可继续），HTTP 页面下用 ws://
let ws = null;
let wsReconnectAttempts = 0;        // 连续重连次数（指数退避用）
let wsReconnectTimer = null;        // 重连定时器句柄
const WS_MAX_RECONNECT = 8;         // 连续失败 N 次后停止重连（避免无限刷屏）
function connectStudentWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // 清理既有重连定时器，避免重复排队
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/?token=${encodeURIComponent(myStudentToken || '')}`);
  ws.onopen = () => {
    console.log('WebSocket connected');
    wsReconnectAttempts = 0; // 连上即清零退避计数
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'notification') {
        // 仅在学生已登录时处理
        if (myStudentId) {
          // 弹窗提示（esc 防止 XSS）
          toast(`📢 ${esc(msg.data.title)}: ${esc(msg.data.message)}`);
          
          // 浏览器桌面通知
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(msg.data.title, {
              body: msg.data.message,
              icon: '/icons/icon-192.svg',
              badge: '/icons/icon-96.svg',
              tag: msg.data.id || 'default'
            });
          }
          
          // 如果在请假页面，刷新列表
          if (document.getElementById('page-leave').classList.contains('active')) {
            loadMyLeaves();
          }
          // 无论是否在请假页面，都刷新（因为审批结果需要实时看到）
          loadMyLeaves();
        }
      }
      if (msg.type === 'announcement' && myStudentId) {
        // 教师发布新公告：弹提示 + 桌面通知 + 刷新公告横幅
        toast(`📢 新公告：${esc(msg.data.title)}`);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('📢 ' + msg.data.title, {
            body: msg.data.content || '',
            icon: '/icons/icon-192.svg',
            badge: '/icons/icon-96.svg',
            tag: msg.data.id || 'announcement'
          });
        }
        loadAnnouncements();
        // 若正停留在"我的"页，同步刷新公告记录列表
        const mp = document.getElementById('page-my');
        if (mp && mp.classList.contains('active')) loadMyAnnouncements();
      }
      if (msg.type === 'leave_updated' && myStudentId && msg.data.student_id === myStudentId) {
        // 教师审批后，刷新学生端的请假列表
        const statusText = msg.data.status === 'approved' ? '✅ 已批准' : (msg.data.status === 'rejected' ? '❌ 已驳回' : '📋 已更新');
        toast(`${statusText}：${esc(msg.data.comment || '无备注')}`);
        
        // 浏览器桌面通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('请假审批结果', {
            body: `${statusText}：${esc(msg.data.comment || '请查看详情')}`,
            icon: '/icons/icon-192.svg',
            tag: msg.data.id || 'leave-update'
          });
        }
        
        loadMyLeaves();
      }
      if (msg.type === 'course_updated' && myStudentId) {
        // 教师端创建/删除课程：防抖刷新今日课表下拉，无需手动刷新页面
        clearTimeout(window._courseRefreshTimer);
        window._courseRefreshTimer = setTimeout(() => {
          loadCourses();
          // 课堂页可见时同步刷新签到记录区
          const cp = document.getElementById('page-class');
          if (cp && cp.classList.contains('active')) loadMyClass();
        }, 600);
        const act = msg.data && msg.data.action === 'deleted' ? '课程已更新（删除）' : '课程表已更新';
        toast(`🔄 ${act}，课表已自动刷新`);
      }
      if (msg.type === 'checkin_task' && myStudentId) {
        // 教师发布查寝任务：查寝页横幅 + toast + 桌面通知
        const t = msg.data;
        const tClass = t.class_name || '';
        // 仅对本人班级或全年级（class_name 为空）显示（班级名归一化比较）
        const relevant = !normClassName(tClass) || normClassName(tClass) === normClassName(myClassName);
        if (relevant) {
          renderCheckinTaskBanner(t);
          toast(`📢 新查寝任务：${tClass || '全年级'} · 日期 ${t.date}${t.remark ? ' · ' + t.remark : ''}`);
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('新查寝任务', {
              body: `班级：${tClass || '全年级'}\n日期：${t.date}${t.remark ? '\n备注：' + t.remark : ''}`,
              icon: '/icons/icon-192.svg',
              tag: 'checkin-task-' + t.id
            });
          }
          // 切到查寝页让横幅可见
          const cp = document.getElementById('page-checkin');
          if (cp && !cp.classList.contains('active')) switchTab('checkin');
        }
      }
    } catch (e) {
      console.error('WebSocket message parse error', e);
    }
  };
  ws.onerror = (e) => { /* 实际结果在 onclose 统一处理；不再单独打 error 刷屏 */ };
  ws.onclose = () => {
    if (!myStudentToken) return; // 未登录不重连（服务器会拒绝 upgrade）
    // 首次断开时探测会话有效性：token 过期（401）则弹登录层并停止重连，
    // 治"token 过期后 WS 静默连不上、学生收不到查寝通知却毫无感知"
    if (!_sessionExpiredHandled) probeStudentSession();
    if (wsReconnectAttempts >= WS_MAX_RECONNECT) {
      console.warn('WebSocket 连续 ' + WS_MAX_RECONNECT + ' 次重连失败，停止重连（避免刷屏）。可刷新页面重试。');
      return;
    }
    wsReconnectAttempts++;
    // 指数退避：1s → 2s → 4s → 8s → …（上限 30s），避免服务器宕机时疯狂重连刷红字
    const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), 30000);
    console.warn('WebSocket closed，' + (delay/1000) + 's 后第 ' + wsReconnectAttempts + '/' + WS_MAX_RECONNECT + ' 次重连…');
    wsReconnectTimer = setTimeout(connectStudentWS, delay);
  };
}
connectStudentWS();
function doLogin() {
  const id = document.getElementById('loginStudent').value;
  if (!id || !studentMap[id]) { toast('⚠️ 请选择身份'); return; }
  const password = document.getElementById('loginPassword').value;
  if (!password) { toast('⚠️ 请输入密码'); return; }
  
  // 向后端获取学生身份Token
  fetch('/api/student/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ student_id: id, password: password })
  }).then(r => r.json()).then(j => {
    if (j.code !== 0) {
      toast('⚠️ ' + j.message);
      return;
    }
    myStudentToken = j.token;
    _sessionExpiredHandled = false; // 重新登录成功，恢复会话过期处理
    localStorage.setItem('myStudentToken', myStudentToken);
    myStudentId = id;
    myClassName = j.student.class_name || '';
    myDorm = j.student.dorm || '';
    localStorage.setItem('myStudentId', id);
    localStorage.setItem('myClassName', myClassName);
    localStorage.setItem('myDorm', myDorm);
    document.getElementById('loginOverlay').style.display = 'none';
    
    // 如果必须修改密码，显示强制修改密码界面
    if (j.mustChangePwd) {
      document.getElementById('forcePwdOverlay').style.display = 'flex';
      document.getElementById('forceOldPwd').value = '123456';
      document.getElementById('forceNewPwd').value = '';
      document.getElementById('forceNewPwd2').value = '';
      document.getElementById('forcePwdMsg').textContent = '';
      toast('🔑 密码已重置，请修改密码后使用系统');
      return;
    }
    
    document.getElementById('userBar').style.display = 'flex';
    document.getElementById('userBarName').textContent = `👤 ${esc(j.student.name)}（${j.student.dorm}）`;
    toast(`✅ 欢迎，${j.student.name}`);
    loadAnnouncements();
    // 登录成功后用新 token 重建 WebSocket（WS 鉴权后，未登录建立的连接会被服务器拒绝）
    connectStudentWS();
    // 重新加载各模块数据
    if (document.getElementById('page-checkin').classList.contains('active')) loadCheckinData();
    if (document.getElementById('page-leave').classList.contains('active')) { loadMyLeaves(); checkLvReady(); }
    if (document.getElementById('page-class').classList.contains('active')) { loadMyClass(); checkClReady(); }
    if (document.getElementById('page-my').classList.contains('active')) {}
  }).catch(e => {
    toast('❌ 网络错误，请检查连接');
    console.error('登录失败:', e);
  });
}
// 强制修改密码（首次登录/密码被重置后）
async function doForceChangePwd(){
  const oldPwd = document.getElementById('forceOldPwd').value;
  const newPwd = document.getElementById('forceNewPwd').value;
  const newPwd2 = document.getElementById('forceNewPwd2').value;
  const msgEl = document.getElementById('forcePwdMsg');
  
  if (!newPwd || newPwd.length < 6) { msgEl.textContent = '⚠️ 新密码至少6位'; return; }
  if (newPwd !== newPwd2) { msgEl.textContent = '⚠️ 两次密码不一致'; return; }
  if (newPwd === '123456') { msgEl.textContent = '⚠️ 新密码不能与初始密码相同'; return; }
  
  document.getElementById('forcePwdBtn').disabled = true;
  document.getElementById('forcePwdBtn').textContent = '⏳ 修改中...';
  
  try{
    const r = await fetch('/api/student/change-password', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({student_id: myStudentId, oldPassword: oldPwd, newPassword: newPwd})
    });
    const j = await r.json();
    if(j.code === 0){
      msgEl.textContent = '';
      document.getElementById('forcePwdOverlay').style.display = 'none';
      document.getElementById('userBar').style.display = 'flex';
      document.getElementById('userBarName').textContent = `👤 ${studentMap[myStudentId]?.name || '用户'}（${studentMap[myStudentId]?.dorm || ''}）`;
      toast('✅ 密码修改成功！欢迎使用系统');
      // 重新加载各模块数据
      if (document.getElementById('page-checkin').classList.contains('active')) loadCheckinData();
      if (document.getElementById('page-leave').classList.contains('active')) { loadMyLeaves(); checkLvReady(); }
      if (document.getElementById('page-class').classList.contains('active')) { loadMyClass(); checkClReady(); }
    } else {
      msgEl.textContent = '❌ ' + j.message;
    }
  } catch(e) {
    msgEl.textContent = '❌ 修改失败，请检查网络';
  }
  document.getElementById('forcePwdBtn').disabled = false;
  document.getElementById('forcePwdBtn').textContent = '🔑 修改密码';
}
// ===== 忘记密码 =====
let forgotResetToken = '';

function showForgotPwd(){
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('forgotPwdOverlay').style.display = 'flex';
  document.getElementById('forgotStep1').style.display = 'block';
  document.getElementById('forgotStep2').style.display = 'none';
  document.getElementById('forgotPhone').value = '';
  document.getElementById('forgotDorm').value = '';
  document.getElementById('forgotNewPwd').value = '';
  document.getElementById('forgotNewPwd2').value = '';
  document.getElementById('forgotStep1Msg').textContent = '';
  document.getElementById('forgotStep2Msg').textContent = '';
  forgotResetToken = '';
}

function hideForgotPwd(){
  document.getElementById('forgotPwdOverlay').style.display = 'none';
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('forgotStep1').style.display = 'block';
  document.getElementById('forgotStep2').style.display = 'none';
  forgotResetToken = '';
}

async function startForgotVerify(){
  const phone = document.getElementById('forgotPhone').value.trim();
  const dorm = document.getElementById('forgotDorm').value.trim();
  const msgEl = document.getElementById('forgotStep1Msg');
  
  if (!phone && !dorm) { msgEl.textContent = '⚠️ 请填写手机号或宿舍号'; msgEl.style.color = '#ef4444'; return; }
  
  document.getElementById('forgotVerifyBtn').disabled = true;
  document.getElementById('forgotVerifyBtn').textContent = '⏳ 验证中...';
  msgEl.textContent = '';
  
  try{
    const r = await fetch('/api/student/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, dorm })
    });
    const j = await r.json();
    if (j.code === 0) {
      forgotResetToken = j.resetToken;
      document.getElementById('forgotStudentName').textContent = '👤 ' + (j.studentName || '');
      document.getElementById('forgotStep1').style.display = 'none';
      document.getElementById('forgotStep2').style.display = 'block';
      document.getElementById('forgotStep2Msg').textContent = '';
    } else {
      msgEl.textContent = '❌ ' + j.message;
      msgEl.style.color = '#ef4444';
    }
  } catch(e) {
    msgEl.textContent = '❌ 验证失败，请检查网络';
    msgEl.style.color = '#ef4444';
  }
  document.getElementById('forgotVerifyBtn').disabled = false;
  document.getElementById('forgotVerifyBtn').textContent = '✅ 验证身份';
}

async function doForgotResetPwd(){
  const newPwd = document.getElementById('forgotNewPwd').value;
  const newPwd2 = document.getElementById('forgotNewPwd2').value;
  const msgEl = document.getElementById('forgotStep2Msg');
  
  if (!newPwd || newPwd.length < 6) { msgEl.textContent = '⚠️ 新密码至少6位'; msgEl.style.color = '#ef4444'; return; }
  if (newPwd !== newPwd2) { msgEl.textContent = '⚠️ 两次密码不一致'; msgEl.style.color = '#ef4444'; return; }
  if (!forgotResetToken) { msgEl.textContent = '⚠️ 验证已过期，请重新验证'; msgEl.style.color = '#ef4444'; return; }
  
  document.getElementById('forgotResetBtn').disabled = true;
  document.getElementById('forgotResetBtn').textContent = '⏳ 重置中...';
  msgEl.textContent = '';
  
  try{
    const r = await fetch('/api/student/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken: forgotResetToken, newPassword: newPwd })
    });
    const j = await r.json();
    if (j.code === 0) {
      msgEl.textContent = '✅ ' + j.message;
      msgEl.style.color = '#22c55e';
      setTimeout(() => {
        hideForgotPwd();
        toast('✅ 密码已重置，请用新密码登录');
      }, 1500);
    } else {
      msgEl.textContent = '❌ ' + j.message;
      msgEl.style.color = '#ef4444';
    }
  } catch(e) {
    msgEl.textContent = '❌ 重置失败，请检查网络';
    msgEl.style.color = '#ef4444';
  }
  document.getElementById('forgotResetBtn').disabled = false;
  document.getElementById('forgotResetBtn').textContent = '🔑 重置密码';
}
async function doLogout() {
  // 显示确认对话框
  const confirmed = await confirmDialog('确认退出', '确定要退出当前账号吗？');
  if (!confirmed) return;
  
  myStudentId = '';
  myClassName = '';
  myStudentToken = '';
  localStorage.removeItem('myStudentId');
  localStorage.removeItem('myClassName');
  localStorage.removeItem('myStudentToken');
  // 主动断开 WebSocket 会话（token 已失效，避免服务器侧残留连接）
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  wsReconnectAttempts = 0;
  if (ws && ws.readyState === WebSocket.OPEN) { ws.onclose = null; ws.close(); }
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('forcePwdOverlay').style.display = 'none';
  document.getElementById('userBar').style.display = 'none';
  // 重置所有功能状态
  resetCi();
  ciActiveTask = null; ciStepDone = { voice: false, qrcode: false };
  const ciBanner = document.getElementById('ciTaskBanner');
  if (ciBanner) ciBanner.style.display = 'none';
  document.getElementById('lvReason').value = '';
  document.getElementById('lvMyList').innerHTML = '<div class="empty-state"><p>请先登录</p></div>';
  document.getElementById('clMyList').innerHTML = '<div class="empty-state"><p>请先登录</p></div>';
  document.getElementById('loginBtn').disabled = true;
  document.getElementById('loginStudentInfo').textContent = '';
  toast('👋 已退出');
}

// ===== 查寝 =====
// 当前生效的查寝任务（含教师勾选的 required_steps）与独立通道完成状态
// required_steps 为教师发布任务时勾选的必做项（location/photo/voice/qrcode），空则默认 定位+拍照
let ciActiveTask = null;
let ciStepDone = { voice: false, qrcode: false };
const CI_STEP_LABELS = { location: '📍 获取位置', photo: '📷 拍照/上传照片', voice: '🎤 语音签到', qrcode: '📷 扫码签到' };

function checkCiReady(){
  const loc=locState.ci, p=photoData;
  // 摄像头模式下要求通过活体检测；模型未就绪时降级放行（后端会如实标记 liveness_passed=0）
  // 用户手动跳过活体（livenessSkipped）时也可提交，避免活体检测故障卡死签到
  const livenessOk = (camMode==='ci' && p && p.startsWith('data:image'))
    ? ((landmarkLoaded && livenessPassed) || livenessSkipped)  // [P0修复] 模型未加载时必须拒绝提交（除非手动跳过）
    : true;
  // 教师勾选的必做步骤：无任务时默认要求 定位+拍照（传统每日签到行为不变）
  const req = (ciActiveTask && Array.isArray(ciActiveTask.required_steps) && ciActiveTask.required_steps.length)
    ? ciActiveTask.required_steps : ['location','photo'];
  let ok = !!myStudentId;
  if (req.includes('location') && !loc) ok = false;
  if (req.includes('photo') && !(p && livenessOk)) ok = false;
  if (req.includes('voice') && !ciStepDone.voice) ok = false;
  if (req.includes('qrcode') && !ciStepDone.qrcode) ok = false;
  document.getElementById('ciSubmit').disabled = !ok;
  const hint=document.getElementById('ciLivenessStatus');
  if(req.includes('photo') && p && !livenessOk && hint && !livenessSkipped){
    hint.textContent='⚠️ 请先完成活体检测（眨一下眼睛）再提交，或点「⏩ 跳过活体」走人工复核';
  }
  updateCiTaskStepStatus();
}
// 横幅内逐项完成状态实时刷新（任务要求的步骤对应 ⬜/✅）
function updateCiTaskStepStatus(){
  if (!ciActiveTask) return;
  const st = { location: !!locState.ci, photo: !!photoData, voice: ciStepDone.voice, qrcode: ciStepDone.qrcode };
  (ciActiveTask.required_steps || []).forEach(k => {
    const el = document.getElementById('ciStep_' + k);
    if (el) { el.textContent = st[k] ? '✅ 已完成' : '⬜ 待完成'; el.style.color = st[k] ? '#166534' : '#b45309'; }
  });
}
// 渲染查寝任务横幅（WS 实时推送 / 页面加载兜底共用）
function renderCheckinTaskBanner(task) {
  const banner = document.getElementById('ciTaskBanner');
  const body = document.getElementById('ciTaskBannerBody');
  if (!banner || !body) return;
  // 新任务到来时重置独立通道（语音/扫码）完成状态
  if (!ciActiveTask || ciActiveTask.id !== task.id) ciStepDone = { voice: false, qrcode: false };
  ciActiveTask = task;
  const tClass = task.class_name || '全年级';
  const req = (Array.isArray(task.required_steps) && task.required_steps.length) ? task.required_steps : ['location','photo','voice','qrcode'];
  if (!Array.isArray(task.required_steps) || !task.required_steps.length) task.required_steps = req;
  const lines = [`班级：${esc(tClass)} · 日期：${esc(task.date || '')}`];
  lines.push('需完成：' + req.map(k => `<span id="ciStep_${esc(k)}">⬜ 待完成</span> ${esc(CI_STEP_LABELS[k] || k)}`).join('　'));
  if (task.remark) lines.push(`备注：${esc(task.remark)}`);
  if (task.created_at) lines.push(`发布：${esc(String(task.created_at).slice(0, 19).replace('T',' '))}`);
  body.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  banner.style.display = 'block';
  checkCiReady();
}
// 班级名归一化（去首尾空白），避免教师端发布班级与学生端 class_name 因空格差异匹配失败
function normClassName(s){ return String(s||'').trim(); }
// 会话过期统一处理：清本地态、弹登录层并明确提示（治"token 过期后页面看似已登录、
// WS 连不上 / 接口 401 全被静默吞掉，学生收不到查寝通知也无感知"的问题）
let _sessionExpiredHandled = false;
function handleSessionExpired(){
  if(_sessionExpiredHandled) return;
  _sessionExpiredHandled = true;
  myStudentId=''; myClassName=''; myStudentToken='';
  localStorage.removeItem('myStudentId');
  localStorage.removeItem('myClassName');
  localStorage.removeItem('myStudentToken');
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws && ws.readyState === WebSocket.OPEN) { ws.onclose = null; ws.close(); }
  const lo = document.getElementById('loginOverlay');
  if (lo) lo.style.display = 'flex';
  toast('⚠️ 登录已过期，请重新登录后再接收查寝通知', 4000);
}
// 会话有效性探测：带 token 轻量请求，401 即判定过期（区分"网络不通"与"登录失效"）
async function probeStudentSession(){
  if (!myStudentId || !myStudentToken) return;
  try {
    const r = await fetch('/api/tasks/student?_probe=1&_t=' + Date.now(), { headers: { 'x-student-token': myStudentToken } });
    if (r.status === 401) handleSessionExpired();
  } catch (e) { /* 网络异常不判定过期 */ }
}
// 离线兜底：查寝页打开/刷新时拉取本人班级当天 pending 查寝任务（WS 未连接也能看到）
async function loadPendingCheckinTasks() {
  if (!myStudentId || !myStudentToken) return;
  try {
    const headers = { 'x-student-token': myStudentToken };
    const url = `/api/tasks/student?status=pending&_t=${Date.now()}`;
    const r = await fetch(url, { headers });
    if (r.status === 401) { handleSessionExpired(); return; }
    const j = await r.json();
    if (j.code !== 0 || !j.data || !j.data.length) {
      const b = document.getElementById('ciTaskBanner');
      if (b) b.style.display = 'none';
      ciActiveTask = null; ciStepDone = { voice: false, qrcode: false }; checkCiReady();
      return;
    }
    const today = todayStr();
    // 仅显示 pending 且（无班级限制 或 班级匹配）的任务（班级名归一化比较）
    const visible = j.data.filter(t =>
      t.status === 'pending' &&
      (!normClassName(t.class_name) || normClassName(t.class_name) === normClassName(myClassName))
    );
    if (!visible.length) {
      const b = document.getElementById('ciTaskBanner');
      if (b) b.style.display = 'none';
      ciActiveTask = null; ciStepDone = { voice: false, qrcode: false }; checkCiReady();
      return;
    }
    // 取最近一条展示（多条合并备注）
    const top = visible[0];
    renderCheckinTaskBanner(top);
  } catch (e) {
    // 学生 token 拉 tasks 被 401/403 拦截时静默（实时 WS 通道兜底）
    console.warn('加载查寝任务失败（WS 通道兜底）:', e);
  }
}
// 加载查寝记录
async function loadCheckinData() {
  const list = document.getElementById('ciRecordsList');
  if (!list) return;
  
  if (!myStudentId) {
    list.innerHTML = '<div class="empty-state"><p>请先登录查看</p></div>';
    return;
  }
  
  try {
    showLoadingAuto('加载查寝记录...', 2000);
    list.innerHTML = '<div class="empty-state"><p>⏳ 加载中...</p></div>';
    const r = await fetch(`/api/records?student_id=${myStudentId}&type=checkin&_t=${Date.now()}`);
    const j = await r.json();
    hideLoading();
    
    if (j.code !== 0 || !j.data || j.data.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>暂无查寝记录</p></div>';
      document.getElementById('ciWeekStats').style.display = 'none';
      return;
    }
    
    // 本周统计
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStart = weekAgo.toISOString().slice(0, 10);
    const weekRecords = j.data.filter(r => r.date >= weekStart);
    const weekChecked = weekRecords.filter(r => r.status === '在寝').length;
    const leaveStatuses = ['未归','病假','事假','公假','丧假','请假'];
    const weekMissed = weekRecords.filter(r => leaveStatuses.includes(r.status)).length;
    document.getElementById('ciWeekChecked').textContent = weekChecked;
    document.getElementById('ciWeekMissed').textContent = weekMissed;
    document.getElementById('ciWeekStats').style.display = 'block';
    
    list.innerHTML = j.data.map(rec => {
      const isLeave = ['病假','事假','公假','丧假','请假'].includes(rec.status);
      const statusColor = rec.status === '在寝' ? '#22c55e' : isLeave ? '#f59e0b' : '#ef4444';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9">
        <div>
          <div style="font-size:13px;font-weight:500">${fmtTime(rec.time, rec.date)}</div>
          <div style="font-size:12px;color:#94a3b8">${rec.status==='在寝' && rec.address ? esc(rec.address) : ''}</div>
        </div>
        <span style="font-size:12px;padding:3px 10px;border-radius:12px;background:${statusColor}20;color:${statusColor};font-weight:500">${esc(rec.status)||''}</span>
      </div>`;
    }).join('');
  } catch(e) {
    console.error('加载查寝记录失败:', e);
    hideLoading();
    list.innerHTML = '<div class="empty-state"><p>加载失败: ' + esc(e.message || '网络异常') + '</p></div>';
  }
}
function startLocate(mode){
  const btn = document.getElementById(mode+'Locate');
  if (!navigator.geolocation) { toast('⚠️ 浏览器不支持定位'); return; }

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isSecure = location.protocol==='https:' || location.hostname==='localhost' || location.hostname==='127.0.0.1';
  if (isMobile && !isSecure) {
    toast('⚠️ 手机浏览器在非 HTTPS / localhost 下可能无法定位，建议访问 HTTPS 地址或使用校园网');
  }

  btn.disabled=true; btn.textContent='⏳ 高精度定位中...';

  const progressDiv = document.getElementById(mode+'LocProgress');
  const progressBar = document.getElementById(mode+'LocProgressBar');
  const progressText = document.getElementById(mode+'LocProgressText');
  const addrEl = document.getElementById(mode+'Address');
  if(progressDiv){ progressDiv.style.display='block'; }
  if(progressBar){ progressBar.style.width='5%'; }
  if(progressText){ progressText.textContent='正在获取高精度定位...'; }

  // 采样策略：手机端为主——动态采样最多 8 次（让 GPS 收敛），加"收敛早退"避免白等；
  // 电脑端（网络定位）保持 3 次即可，网络定位精度本就有限，不必长等。
  const maxSamples = isMobile ? 8 : 3;
  const sampleDelay = 800;   // 采样间隔
  const overallTimeout = isMobile ? 25000 : 12000; // 整体兜底超时（手机端放宽让 GPS 收敛）
  const CONVERGE_MS = 2500;  // 收敛早退窗口：近 2.5s 内坐标稳定即提前结束
  const MOVE_EPS_M = 15;     // 收敛判据：与最近样本位移 <15m 视为已稳定
  const samples = [];
  let finished = false;

  const haversineM = (a, b) => {
    const R = 6371000, r = Math.PI/180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };

  const finish = async () => {
    if(finished) return; finished=true;
    if(progressDiv) progressDiv.style.display='none';
    if(samples.length===0){
      toast('⚠️ 定位失败：未获取到有效位置，请检查 GPS/定位权限，或确认是否为 HTTPS 访问');
      btn.disabled=false; btn.textContent='📍 重新获取位置';
      return;
    }
    // 多因子加权：精度(1/accuracy) × 时间新鲜度(越新越重) × 与历史均值一致性(离群漂移点降权)
    const n = samples.length;
    let latSum=0, lngSum=0, accSum=0;
    samples.forEach((s,idx)=>{ latSum+=s.lat; lngSum+=s.lng; accSum+=s.accuracy; });
    const meanLat = latSum/n, meanLng = lngSum/n;
    let totalWeight=0; const weighted=[];
    samples.forEach((s,idx)=>{
      const wAcc = 1/Math.max(s.accuracy,1);                 // 精度因子
      const wTime = (idx+1)/n;                                // 新鲜度因子（越靠后越新）
      const dispM = haversineM({lat:meanLat,lng:meanLng},{lat:s.lat,lng:s.lng});
      const wCons = 1/(1+dispM/25);                            // 一致性因子（离群点位移大→降权）
      const w = wAcc*wTime*wCons;
      totalWeight+=w;
      weighted.push({lat:s.lat,lng:s.lng,w});
    });
    const avgLat = weighted.reduce((sum,p)=>sum+p.lat*p.w,0)/totalWeight;
    const avgLng = weighted.reduce((sum,p)=>sum+p.lng*p.w,0)/totalWeight;
    const avgAccuracy = Math.round(accSum/n);
    locState[mode] = {lat: avgLat, lng: avgLng, accuracy: avgAccuracy};

    const coordAddr = `${avgLat.toFixed(6)}, ${avgLng.toFixed(6)}`;
    const accNote = `（精度：${avgAccuracy}米，正在解析地址...）`;
    addrEl.textContent = coordAddr + accNote;
    document.getElementById(mode+'LocInfo').style.display='block';

    try {
      const configRes = await fetch('/api/config/map');
      const mapConfigJson = await configRes.json();
      // 接口返回 {code:0, data:{provider, amapKey,...}}，需取 data 字段
      const mapConfig = mapConfigJson.data || mapConfigJson;
      let address = '';
      if (mapConfig.provider === 'tencent' && mapConfig.tencentKey) {
        const txUrl = `https://apis.map.qq.com/ws/geocoder/v1/?location=${avgLat},${avgLng}&key=${mapConfig.tencentKey}`;
        const r = await fetch(txUrl); const d = await r.json();
        if (d.status === 0 && d.result) {
          const precise = d.result.address_detail;
          const parts = [precise.province, precise.city, precise.district, precise.street].filter(Boolean);
          if (precise.nearby?.length) parts.push(precise.nearby[0]);
          address = parts.join(' ') || d.result.address;
        }
      } else if (mapConfig.provider === 'baidu' && mapConfig.baiduKey) {
        const bdUrl = `https://api.map.baidu.com/reverse_geocoding/v3/?ak=${mapConfig.baiduKey}&location=${avgLat},${avgLng}&output=json&coordtype=wgs84ll`;
        const r = await fetch(bdUrl); const d = await r.json();
        if (d.status === 0 && d.result) address = d.result.formatted_address;
      } else if (mapConfig.provider === 'amap' && mapConfig.amapKey) {
        const amUrl = `https://restapi.amap.com/v3/geocode/regeo?location=${avgLng},${avgLat}&key=${mapConfig.amapKey}&radius=1000&extensions=all`;
        const r = await fetch(amUrl); const d = await r.json();
        if (d.status === '1' && d.regeocode) {
          const re = d.regeocode;
          // 优先用高德拼好的完整地址 formatted_address（最可靠）
          if (re.formatted_address) {
            address = re.formatted_address;
          } else {
            // 兜底：手动拼（高德字段为 neighborhood 美式拼写；街道在 streetNumber.street）
            const a = re.addressComponent;
            const parts = [a.province, a.city, a.district].filter(Boolean);
            const poi = (a.neighborhood && a.neighborhood.name) || (a.streetNumber && a.streetNumber.street + (a.streetNumber.number || ''));
            if (poi) parts.push(poi);
            address = parts.join(' ');
          }
        }
      }
      if(address) addrEl.textContent = address + `（精度：${avgAccuracy}米）`;
      else addrEl.textContent = coordAddr + `（精度：${avgAccuracy}米）`;
    } catch(e) {
      console.warn('地址解析失败:', e);
      addrEl.textContent = coordAddr + `（精度：${avgAccuracy}米）`;
    }

    btn.className='locate-btn success'; btn.textContent='✅ 定位成功'; btn.disabled=false;
    if(mode==='ci') checkCiReady();
    if(mode==='cl') checkClReady();
  };

  const takeSample = () => new Promise((resolve)=>{
    navigator.geolocation.getCurrentPosition(
      (pos)=>{
        samples.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 100 });
        resolve(true);
      },
      (err)=>{ console.warn('定位采样失败:', err); resolve(false); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });

  (async ()=>{
    for(let i=0;i<maxSamples;i++){
      if(finished) break;
      const progress = Math.round((i/maxSamples)*100);
      if(progressBar) progressBar.style.width=progress+'%';
      if(progressText) progressText.textContent=`采样中... (${i}/${maxSamples})`;
      addrEl && (addrEl.textContent=`采样中... (${i}/${maxSamples})`);
      await takeSample();
      // 收敛早退：至少采 3 次后，若与上一样本位移 <15m 且当前精度 ≤ 上一轮均值，说明 GPS 已稳定，提前结束
      const last = samples[samples.length-1];
      if(samples.length>=3 && last){
        const prev = samples[samples.length-2];
        const moveM = haversineM(prev, last);
        const avgAccSoFar = samples.reduce((s,x)=>s+x.accuracy,0)/samples.length;
        if(moveM < MOVE_EPS_M && last.accuracy <= avgAccSoFar){
          if(progressText) progressText.textContent='定位已收敛，完成采样';
          break;
        }
      }
      if(i<maxSamples-1 && !finished) await new Promise(r=>setTimeout(r,sampleDelay));
    }
    await finish();
  })();

  // 兜底：整体超时后强制结束，避免浏览器回调不触发导致按钮卡住
  setTimeout(()=>{ if(!finished) finish(); }, overallTimeout);
}

// 人脸模型加载（仅在需要时触发）
// 优先加载本地模型（离线可用），失败则回退 CDN
async function loadFaceModels() {
  if (modelsLoaded) return;
  await loadFaceApi(); // 先确保 face-api.js 已加载

  // ===== 诊断日志：记录模型加载全过程，方便在浏览器 Console 定位问题 =====
  console.log('[活体诊断] 开始加载人脸模型...');
  console.log('[活体诊断] faceapi 对象:', typeof faceapi, '| detectSingleFace:', typeof faceapi?.detectSingleFace, '| detectLandmarks:', typeof faceapi?.detectLandmarks);

  // ===== 移动端关键：强制 tf.js 优先用 WebGL 后端（GPU 推理，比 CPU 快 5~10 倍）=====
  // 不 setBackend 时 tf.js 默认可能落到 CPU（尤其某些安卓 WebView），导致三模型推理极慢、卡顿。
  let _finalBackend = 'cpu (未指定)';
  try {
    if (typeof tf !== 'undefined') {
      _finalBackend = tf.getBackend();
      // 已有 GPU 后端则保留；否则强制试 webgl
      if (_finalBackend === 'cpu' || !_finalBackend) {
        try {
          await tf.setBackend('webgl');
          await tf.ready();
          _finalBackend = 'webgl';
          console.log('[活体诊断] ✓ tf.js 已切换到 WebGL 后端（GPU 加速）');
        } catch (webglErr) {
          console.warn('[活体诊断] ⚠️ WebGL 后端不可用，回退 CPU:', webglErr.message);
        }
      }
    }
  } catch (e) { /* ignore */ }
  console.log('[活体诊断] tfjs backend:', _finalBackend);

  // 检查 WebGL 支持
  try {
    const _c = document.createElement('canvas');
    const _gl = _c.getContext('webgl') || _c.getContext('experimental-webgl');
    if (_gl) {
      const _dbg = _gl.getExtension('WEBGL_debug_renderer_info');
      const _renderer = _dbg ? _gl.getParameter(_dbg.UNMASKED_RENDERER) : _gl.getParameter(_gl.RENDERER);
      console.log('[活体诊断] WebGL OK:', _renderer);
    } else {
      console.warn('[活体诊断] ⚠️ WebGL 不可用！tf.js 将使用 CPU 后端（移动端已降采样+跳表情模型缓解）');
    }
  } catch (e) {
    console.warn('[活体诊断] ⚠️ WebGL 检查异常:', e.message);
  }

  const sources = [
    '/models/',  // 本地优先（离线/演示稳定）
    'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights/'  // 原版 face-api 官方权重 CDN 回退（jsdelivr GitHub 镜像，实测 200）
  ];
  let lastErr = null;
  // [P1] 模型加载失败自动重试 1 次：同一源连续失败 2 次后判定该源不可用，换下一源
  for (const base of sources) {
    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      try {
        console.log('[活体诊断] 加载模型源:', base, '| 第', attempts, '次');
        const t0 = performance.now();
        await faceapi.nets.tinyFaceDetector.loadFromUri(base);
        const t1 = performance.now();
        let lmOk = false;
        try {
          await faceapi.nets.faceLandmark68Net.loadFromUri(base);   // 68点关键点：眨眼检测
          const t2 = performance.now();
          const tinyOk = faceapi.nets.tinyFaceDetector.isLoaded;
          lmOk = faceapi.nets.faceLandmark68Net.isLoaded;
          console.log('[活体诊断] 模型 isLoaded: tiny=' + tinyOk + ' landmark=' + lmOk + ' | 耗时: tiny=' + (t1 - t0).toFixed(0) + 'ms landmark=' + (t2 - t1).toFixed(0) + 'ms');
        } catch (lmErr) {
          console.warn('[活体诊断] 关键点模型加载失败，降级为纯脸检测（眨眼判定暂不可用）:', lmErr.message);
        }
        // 表情模型（活体 blink 辅助信号）独立加载，失败不阻断核心人脸检测
        expressionLoaded = false;
        try { await faceapi.nets.faceExpressionNet.loadFromUri(base); expressionLoaded = true; }
        catch (ee) { console.warn('表情模型加载失败，活体检测降级为纯眨眼模式:', ee.message); }
        // ===== 部分加载即降级运行（治本）=====
        // 只要人脸检测器就绪就标记 modelsLoaded，让检测循环/脸判定先跑起来；
        // 关键点缺失时 landmarkLoaded=false，analyzeLiveness 需 landmark，
        // 但此时用户至少能走"跳过活体"兜底，不再整链卡死在"未检测到人脸"。
        const tinyOkNow = faceapi.nets.tinyFaceDetector.isLoaded;
        if (tinyOkNow) {
          modelsLoaded = true;
          landmarkLoaded = lmOk;
          console.log('[活体诊断] ✓ 人脸模型已加载:', base,
            '（关键点:', lmOk ? 'OK' : '缺失', '| 表情:', expressionLoaded ? 'OK' : '跳过', '）');
          return; // 检测器就绪即返回（部分加载也算成功，不再 throw）
        }
        // 检测器都没加载上才视为失败，继续尝试下一源
        const emsg = '人脸检测器权重未真正加载（isLoaded=' + tinyOkNow + '，可能权重文件损坏）: ' + base;
        console.warn(emsg);
        lastErr = new Error(emsg);
        break;  // 该源无效 → 换下一源
      } catch (e) {
        // tinyFaceDetector 加载抛错（网络/文件 404）→ 该源作废，换下一源
        lastErr = e;
        console.warn('[活体诊断] 模型加载失败（第'+attempts+'次）:', base, '| 错误:', e.message, '| 堆栈:', (e.stack || '').substring(0, 200));
        if (attempts < 2) {
          console.log('[活体诊断] 1 秒后自动重试...');
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  }
  modelsLoaded = false;
  landmarkLoaded = false;
  console.error('[活体诊断] ❌ 所有模型源均加载失败:', lastErr?.message);
  throw lastErr || new Error('模型加载失败');
}

// 辅助：从 video 元素取当前帧到 canvas（face-api 传 video 时依赖 video.width 属性，
// 移动端浏览器常不更新该属性导致检测永远失败；手动 drawImage 后传 canvas 最可靠）
let _detectCanvas = null;
function _getDetectCanvas(video) {
  if (!_detectCanvas) _detectCanvas = document.createElement('canvas');
  const w = video.videoWidth || 640, h = video.videoHeight || 480;
  if (_detectCanvas.width !== w || _detectCanvas.height !== h) {
    _detectCanvas.width = w; _detectCanvas.height = h;
  }
  _detectCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return _detectCanvas;
}

async function toggleCam(mode){
  const video=document.getElementById(mode+'Video');
  const ph=document.getElementById(mode+'CamPlaceholder');

  // 如果摄像头已经在运行，直接拍照
  if (cameraStream) {
    capturePhoto(mode);
    return;
  }

  // 检查浏览器是否支持摄像头
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    let msg = '⚠️ 当前浏览器不支持摄像头功能';
    const ua = navigator.userAgent;
    if (/MicroMessenger/i.test(ua)) {
      msg += '（微信内置浏览器限制，请使用手机自带Chrome/Safari）';
    } else if (/QQ\//i.test(ua) || /MQQBrowser/i.test(ua)) {
      msg += '（QQ内置浏览器限制，请使用手机自带Chrome/Safari）';
    } else if (/Android/i.test(ua) || /iPhone|iPad|iPod/i.test(ua)) {
      msg += '（手机浏览器通过HTTP访问无法使用摄像头，请点击下方「📁 上传照片」按钮代替）';
    } else {
      msg += '（请使用Chrome/Safari浏览器）';
    }
    toast(msg);
    return;
  }

  // 检查HTTPS/localhost（移动端必须HTTPS才能使用摄像头）
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    if (isMobile) {
      toast('⚠️ 手机浏览器摄像头需要HTTPS连接，请点击下方「📁 上传照片」按钮拍照');
    } else {
      toast('⚠️ 摄像头功能需要HTTPS连接，请使用HTTPS地址访问');
    }
    return;
  }

  try{
    // 前置加载人脸模型，避免打开摄像头后模型未就绪导致无法检测
    const modelPromise = loadFaceModels().then(()=>true).catch(()=>false);

    const constraints = {
      video: {
        facingMode: isMobile ? 'user' : 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!cameraStream.getVideoTracks().length) {
      throw new Error('未获取到视频轨道');
    }

    video.srcObject = cameraStream;
    video.style.display = 'block';
    ph.style.display = 'none';
    // 显示 DOM 绿框（初始隐藏，检测到人脸时由 detectFace 动态定位显示）
    const faceBox = document.getElementById(mode+'FaceBox');
    if(faceBox) faceBox.style.display = 'none';
    camMode = mode;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play().then(resolve).catch(resolve);
      };
    });

    if(mode==='ci'){
      document.getElementById('ciLivenessBox').style.display='block';
      document.getElementById('ciLivenessPanel').style.display='block';
      document.getElementById('ciCamBox').classList.add('has-liveness');
      resetLivenessState();
      livenessActive=true; livenessMode='ci';
      const st=document.getElementById('ciLivenessStatus');
      if(st) st.textContent='正在加载人脸检测模型...';
      // 等待模型加载完成后启动检测循环
      modelPromise.then((ok)=>{
        if(!livenessActive || camMode!=='ci') return;
        if(ok && modelsLoaded){
          if(st) st.textContent='请将人脸对准框内，眨一下眼睛（正常眨眼即可）';
          detInterval=setInterval(()=>detectFace('ci'),isMobile?150:100);
          // 兜底①：6秒内仍未检测到人脸 → 高亮「跳过活体」按钮
          setTimeout(()=>{
            if(!livenessActive || livenessPassed || livenessSkipped) return;
            if(!faceDetected){
              const skipBtn=document.getElementById('ciSkipLivenessBtn');
              if(skipBtn) skipBtn.style.display='block';
              if(st) st.textContent='⚠️ 6秒未检测到人脸，可调整角度/光线，或点「⏩ 跳过活体」走人工复核';
              st.style.color='#fca5a5';
            }
          }, 6000);
          // 兜底②：已检测到人脸但 12 秒内没眨动 → 自动放行（标记人工复核），彻底避免卡死
          // 治本：眨眼是唯一的活体通道，超时是"眨不动/不会眨"场景下的最后保险
          setTimeout(()=>{
            if(!livenessActive || livenessPassed || livenessSkipped) return;
            if(faceDetected){
              livenessPassed=true; livenessScore=1; livenessSkipReason='auto_timeout';
              updateLivenessUI(); checkCiReady();
              const skipBtn=document.getElementById('ciSkipLivenessBtn');
              if(skipBtn) skipBtn.style.display='none';
              if(st){ st.textContent='⚠️ 12秒未检测到眨眼，已自动放行（将人工复核）'; st.style.color='#fbbf24'; }
            }
          }, 12000);
        } else {
          landmarkLoaded=false; livenessPassed=false;
          // 模型加载失败 → 高亮「跳过活体」兜底按钮，用户可手动放行
          if(st) st.textContent='⚠️ 人脸模型加载失败，无法自动活体检测；可点击下方「⏩ 跳过活体」走人工复核';
          st.style.color = '#fca5a5';
          const skipBtn = document.getElementById('ciSkipLivenessBtn');
          if (skipBtn) skipBtn.style.display = 'block';
          checkCiReady();
        }
      });
    }
  }catch(e){
    let msg = '⚠️ 无法访问摄像头';
    if (e.name === 'NotAllowedError') {
      msg = '⚠️ 摄像头权限被拒绝，请在浏览器设置中允许访问摄像头';
    } else if (e.name === 'NotFoundError') {
      msg = '⚠️ 未找到摄像头设备';
    } else if (e.message === '未获取到视频轨道') {
      msg = '⚠️ 摄像头获取失败';
    } else if(location.protocol !== 'https:' && location.hostname === 'localhost') {
      msg += '（本地开发环境请在地址栏右侧点击摄像头图标允许）';
    } else if(location.protocol !== 'https:') {
      msg += '；摄像头功能需要HTTPS协议';
    }
    toast(msg);
    console.error('Camera error:', e);
  }
}

// 综合人脸检测 + 活体检测（眨眼）
// 用检测锁防止并发重叠（首次推理较慢时 setInterval 会累积多个未完成调用）
let _detectLock = {};
let _diagLogged = false, _diagLogged2 = false, _diagLogged3 = false; // 诊断标志
async function detectFace(mode){
  const video=document.getElementById(mode+'Video');
  if(!video.videoWidth)return;
  // 并发锁：上一帧还在推理中则直接跳过本帧，避免状态机错乱
  if(_detectLock[mode]) return;
  _detectLock[mode]=true;
  try{
    // 从 video 取当前帧到 canvas（face-api 对 <video> 元素的 width/height 支持不稳定）
    const frame = _getDetectCanvas(video);
    // ===== 首帧诊断日志（只输出一次，不刷屏）=====
    if (!_diagLogged) {
      _diagLogged = true;
      console.log('[活体诊断] detectFace 首次运行 | video:', video.videoWidth+'x'+video.videoHeight,
        '| canvas:', frame.width+'x'+frame.height,
        '| offset:', video.offsetWidth+'x'+video.offsetHeight,
        '| modelsLoaded:', modelsLoaded, '| landmarkLoaded:', landmarkLoaded,
        '| tfjs backend:', typeof tf !== 'undefined' ? tf.getBackend() : 'n/a');
    }
    let det;
    // 先试正常阈值，失败再试低阈值（不同摄像头/光线下人脸分数差异大）
    // 关键：detectSingleFace 未 await 时返回「惰性 Thenable」，它带有 .withFaceLandmarks() 方法，
    // 内部会正确关联 faceBox + 原始 canvas 输入，避免 toNetInput 类型错误。
    // 官方推荐：faceapi.detectSingleFace(input).withFaceLandmarks()
    // 移动端（CPU/弱 WebGL）降输入尺寸到 288、跳过表情模型，显著降低单帧推理耗时
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const inputSize = isMobile ? 288 : 416;
    const tryDetect = async (threshold) => {
      const options = new faceapi.TinyFaceDetectorOptions({ inputSize: inputSize, scoreThreshold: threshold });
      const t0 = performance.now();
      let det;
      if (landmarkLoaded && expressionLoaded && !isMobile) {
        // 检测 + 关键点 + 表情 三步链式（官方 API，内部正确关联 canvas 媒体输入）
        // 表情模型提供 blink 概率，是比 EAR 更可靠的眨眼信号（专为检测眨眼设计）
        det = await faceapi.detectSingleFace(frame, options).withFaceLandmarks().withFaceExpressions();
      } else if (landmarkLoaded) {
        det = await faceapi.detectSingleFace(frame, options).withFaceLandmarks();
      } else {
        det = await faceapi.detectSingleFace(frame, options);
      }
      const elapsed = performance.now() - t0;
      // 首帧输出检测结果
      if (!_diagLogged2) {
        _diagLogged2 = true;
        if (det) {
          // WithFaceLandmarks 的 box 在 det.detection.box（顶层 .box 不存在）
          const _b = det.detection ? det.detection.box : det.box;
          console.log('[活体诊断] 检测成功 (阈值'+threshold+'): box='+JSON.stringify(_b)+' 耗时='+elapsed.toFixed(0)+'ms'
            + (det.landmarks ? ' | landmarks 点数='+det.landmarks.positions.length : ' | 无 landmarks'));
        } else {
          console.log('[活体诊断] 检测失败 (阈值'+threshold+'): 未检测到人脸 耗时='+elapsed.toFixed(0)+'ms | canvas尺寸='+frame.width+'x'+frame.height);
        }
      }
      if (!det) return undefined; // 无脸，直接返回
      // 规范化：把 box 提到顶层（WithFaceLandmarks/WithFaceDetection 的 box 在 .detection.box）
      if (det.detection && !det.box) det.box = det.detection.box;
      if (!det.box) return undefined; // 防御：box 仍缺失则本帧不画框，避免读 undefined 崩
      return det; // det 含 .box（已规范化）和 .landmarks
    };
    det = await tryDetect(0.15);
    if (!det) det = await tryDetect(0.05); // 兜底：低阈值重试（模糊/弱光场景）
    // DOM 绿框：坐标换算从 canvas 像素空间到 CSS 渲染空间
    // canvas 内部尺寸 = videoWidth×videoHeight，video 渲染尺寸 = offsetWidth×offsetHeight
    const faceBox = document.getElementById(mode+'FaceBox');
    if(det){
      faceDetected=true;
      const b=det.box; // 已规范化的检测框
      if(faceBox){
        const scaleX = video.offsetWidth / video.videoWidth;
        const scaleY = video.offsetHeight / video.videoHeight;
        faceBox.style.display='block';
        faceBox.style.left  =(b.x      * scaleX) + 'px';
        faceBox.style.top   =(b.y      * scaleY) + 'px';
        faceBox.style.width =(b.width  * scaleX) + 'px';
        faceBox.style.height=(b.height * scaleY) + 'px';
      }
      if(mode==='ci' && landmarkLoaded && livenessActive) analyzeLiveness(det);
      else {
        // lv 模式无活体要求，仅在底部状态条给出检测反馈（ci 模式交由 analyzeLiveness 管理文案）
        const hint=document.getElementById(mode+'LivenessStatus');
        if(hint) hint.textContent='🔍 检测到人脸';
      }
    } else {
      faceDetected=false;
      if(faceBox) faceBox.style.display='none';
      const st=document.getElementById('ciLivenessStatus');
      if(st && !livenessPassed && livenessActive){
        // 眨眼模式：未检测到人脸 → 直接提示调整角度/光线，眨眼即可识别
        st.textContent='⚠️ 未检测到人脸，请调整角度/光线；眨一下眼睛可识别';
        st.style.color='#fca5a5';
        const skipBtn=document.getElementById('ciSkipLivenessBtn');
        if(skipBtn && !livenessSkipped) skipBtn.style.display='block';
      }
    }
  }catch(e){
    console.warn('人脸检测帧异常:', e);
    faceDetected=false;
    const fb=document.getElementById(mode+'FaceBox');
    if(fb) fb.style.display='none';
  } finally {
    _detectLock[mode]=false;
  }
}

// 活体分析：基于「眨眼」判定（EAR 骤降 + 表情 blink + EAR 绝对兜底 三通道 OR）
// 关键修复：EAR 基线"只抬不降"且仅在稳定睁眼时抬升，避免眨眼帧污染基线；
// 配合 3s 兜底窗口（骤降后 3s 内有效）容忍采样滑过闭眼帧。
function computeEAR(landm){
  // face-api 的 68 点 landmark：landm = det.landmarks.positions（数组，每项 {x,y}）。
  // 若传入的是 FaceLandmarks68 对象则取其 .positions。取不到坐标一律安全返回 -1（不抛错）。
  const pts = Array.isArray(landm) ? landm : (landm && landm.positions ? landm.positions : null);
  if(!pts || pts.length < 50) return -1; // landmark 不可用时负值标记，调用方跳过
  // ===== 4 点 v/h EAR（您实际数据验证可用：睁眼 0.21~0.28，闭眼 <0.15）=====
  // 每眼取「内眼角、外眼角、上睑中点、下睑中点」4 点：
  //   水平跨度 h = 内外眼角距离；竖直开合 v = 上睑中点与下睑中点的 |Δy|。
  // 闭眼时 v→0、EAR→0；睁眼稳定时 EAR 约 0.2~0.3。
  const Linner=36, Louter=41, Ltop=38, Lbot=39;   // 左眼 内/外/上/下
  const Rinner=42, Router=47, Rtop=44, Rbot=45;   // 右眼 内/外/上/下
  const earFor = (iInner, iOuter, iTop, iBot) => {
    const a = pts[iInner], b = pts[iOuter], c = pts[iTop], d = pts[iBot];
    if(!a || !b || !c || !d) return 0;
    const h = Math.hypot(b.x-a.x, b.y-a.y);                  // 水平跨度（内外眼角）
    const v = Math.abs((c.y+d.y)/2 - (a.y+b.y)/2);           // 竖直开合（上下睑中点）
    return (h===0)?0:v/h;
  };
  const L = earFor(Linner, Louter, Ltop, Lbot);
  const R = earFor(Rinner, Router, Rtop, Rbot);
  const e = (L+R)/2;
  // 封顶到合理区间（防 landmark 抖动导致虚高）
  return Math.max(0, Math.min(e, 0.5));
}
var _earDiag = 0; // 诊断日志节流计数（模块级，跨调用保持）
function analyzeLiveness(det){
  // face-api 的 68 点 landmark 坐标在 det.landmarks.positions（数组）。
  const landm = det.landmarks?.positions || det.landmarks?.landmarks;
  if(!landm) return; // 无 landmark 时不判活体（等待 landmark 模型就绪）
  const now = Date.now();
  const curEar = computeEAR(landm);
  if(curEar < 0) return; // landmark 不可用（取不到坐标），本帧跳过
  // ===== 动态基线：只在"稳定睁眼"时抬升（近 20 帧里 ≥75% 帧 EAR>0.15），且只抬不降、封顶 0.50 =====
  livenessEarSamples.push(curEar);
  if(livenessEarSamples.length > 30) livenessEarSamples.shift();
  const recent = livenessEarSamples.slice(-20);
  const stableOpenCount = recent.filter(e=>e>0.15).length;
  const stableOpen = recent.length>=6 && stableOpenCount>=Math.max(6,recent.length*0.75);
  if(livenessBaselineEar === null){
    // 初始基线：取最近 20 帧 EAR 的中位数（比单帧稳得多，避免首帧异常把基线撑大）
    const sortRecent = recent.slice().sort((a,b)=>a-b);
    const mid = sortRecent[Math.floor(sortRecent.length/2)];
    livenessBaselineEar = Math.max(Math.min(mid, livenessEarCeil), 0.10);
  } else if(stableOpen && curEar > livenessBaselineEar*1.05 && curEar < livenessEarCeil){
    // 仅稳定睁眼且当前 EAR 明显高于基线时，向当前值衰减抬升（封顶 0.50）
    livenessBaselineEar = livenessBaselineEar*0.95 + Math.min(curEar, livenessEarCeil)*0.05;
  }
  // ===== 基线总闸封顶（防眼角漂移把基线撑大，且一旦被撑大必须能拉回）=====
  // 基线若超出合理区间 [0.10, 0.50]，立即强制拉回最近 20 帧 EAR 中位数
  if(livenessBaselineEar > livenessEarCeil || livenessBaselineEar < 0.08){
    const sortRecent = recent.slice().sort((a,b)=>a-b);
    livenessBaselineEar = Math.max(Math.min(sortRecent[Math.floor(sortRecent.length/2)], livenessEarCeil), 0.08);
  }
  // ===== 四通道判定一次有效眨眼 =====
  const baseline = livenessBaselineEar || 0.20;
  // ① EAR 相对基线骤降（当前帧比基线低 40% 以上即算）
  const drop = (curEar <= baseline*(1-livenessEarDropRatio)) && (curEar > 0.02);
  // ② EAR 绝对值兜底（物理闭眼；睁眼不会误触发）
  const absolute = curEar < livenessEarAbsolute && curEar > 0.02;
  // ③ 表情 blink 概率（防御：blink 字段可能缺失/非数字，取不到按 0）
  const _blinkP = det.expressions && typeof det.expressions.blink === 'number' ? det.expressions.blink : 0;
  const exprBlink = _blinkP >= livenessBlinkExpr;
  // ④ 窗口最低点判定（治"采样稀释"：近 0.6s 内 EAR 最低点比基线低 25% 即算，容忍闭眼瞬态被采样滑过）
  livenessEarWindow.push({t: now, ear: curEar});
  while(livenessEarWindow.length && livenessEarWindow[0].t < now - livenessWindowMs) livenessEarWindow.shift();
  let windowMin = Infinity;
  for(const s of livenessEarWindow) if(s.ear < windowMin) windowMin = s.ear;
  const windowDrop = (isFinite(windowMin) && windowMin <= baseline*(1-livenessWindowDropRatio)) && windowMin > 0.02;
  // ⑤ 绝对降幅通道：部分用户眨眼是"浅眨"（EAR 0.44→0.38 仅降 13.6%，相对阈值判不到），
  //    但 EAR 绝对下降 ≥0.05 已是明确的闭眼动作，头部平移/俯仰不会造成这么大的 EAR 变化
  const windowDropAbs = isFinite(windowMin) && (baseline - windowMin) >= 0.05 && windowMin > 0.02;
  if(drop || absolute || exprBlink || windowDrop || windowDropAbs){
    livenessEarDropSeenAt = now;
  }
  // 3s 兜底窗口：最近 3s 内出现过一次骤降/窗口低值即判过（容忍采样滑过闭眼帧）
  const withinGrace = (now - livenessEarDropSeenAt) <= livenessEarDropGraceMs;
  if(withinGrace && !livenessPassed){
    livenessScore = 1; livenessPassed = true; livenessOk = true;
    prevEarSample = curEar;
    updateLivenessUI(); checkCiReady();
    return;
  }
  prevEarSample = curEar;
  // 诊断日志（节流）：输出 EAR + 窗口最低点 + 命中通道，便于按实际分布定阈值
  _earDiag = (_earDiag||0)+1;
  const _blinkVal = det.expressions && typeof det.expressions.blink === 'number' ? det.expressions.blink : null;
  if(_earDiag % 6 === 1){
    console.log('[活体诊断·眨眼] EAR='+curEar.toFixed(3)
      +' 基线='+(livenessBaselineEar||0).toFixed(3)
      +' 降幅='+(baseline?((baseline-curEar)/baseline*100):0).toFixed(0)+'%'
      +' 窗口最低='+(isFinite(windowMin)?windowMin.toFixed(3):'-')
      +' 绝对阈值='+livenessEarAbsolute+' 降幅阈值='+livenessEarDropRatio+' 窗口降幅='+livenessWindowDropRatio
      +' blink='+(_blinkVal!=null?_blinkVal.toFixed(2):'-')
      +' | 命中='+(drop?'骤降·':windowDrop?'窗口·':absolute?'绝对·':'')+(_blinkP>=livenessBlinkExpr?'表情':''));
  }
  // 实时状态文案（未通过时）
  const st = document.getElementById('ciLivenessStatus');
  if(st && !livenessPassed){
    st.textContent = '请眨一下眼睛 👀  EAR='+curEar.toFixed(2)+'  基线='+(livenessBaselineEar||0).toFixed(2)
      +'  窗口最低='+(isFinite(windowMin)?windowMin.toFixed(2):'-');
    st.style.color = '';
  }
}

// 更新活体检测 UI 进度与步骤
function updateLivenessUI(){
  const faceStep=document.querySelector('#ciLivenessSteps [data-step="face"]');
  const blinkStep=document.querySelector('#ciLivenessSteps [data-step="blink"]');
  const bar=document.getElementById('ciLivenessBar');
  if(faceStep) faceStep.className='liveness-step '+(faceDetected?'done':'active');
  if(blinkStep){
    if(livenessPassed){ blinkStep.className='liveness-step done'; blinkStep.textContent='② 眨眼 ✓'; }
    else { blinkStep.className='liveness-step active'; blinkStep.textContent='② 眨一下眼 👀'; }
  }
  // 进度：通过=100%；检测到一次骤降=60%；还没=30%
  if(bar){
    let pct = 30;
    if(livenessEarDropSeenAt) pct = 60;
    if(livenessPassed) pct = 100;
    bar.style.width = pct + '%';
  }
}

// 重置活体检测状态（重拍/重新打开摄像头时）
function resetLivenessState(){
  livenessPassed=false; livenessScore=0; blinkCount=0; eyeState='open';
  closedFrames=0; prevLivenessClosed=false;
  livenessBaselineEar=null; livenessEarSamples=[]; prevEarSample=0;
  livenessEarWindow=[];
  livenessEarDropSeenAt=0; livenessOk=false;
  livenessSkipped=false;
  const st=document.getElementById('ciLivenessStatus');
  if(st){ st.textContent='请将人脸对准框内，眨一下眼睛（正常眨眼即可）'; st.style.color=''; }
  // 「跳过活体」兜底按钮：默认收起，仅在模型加载失败 / 长时间检不到人脸时才高亮
  const skipBtn=document.getElementById('ciSkipLivenessBtn');
  if(skipBtn) skipBtn.style.display='none';
  updateLivenessUI();
}

// 兜底：模型加载失败/检测不到人脸时，允许用户手动跳过活体（后端会标记 liveness_passed=0）
// [P0修复] 增加二次确认门槛：需输入本人学号，防止他人代跳，且后端记录审计
async function skipLiveness(){
  // 二次确认：必须输入本人学号
  const inputId = prompt('活体检测异常，需人工复核。请输入您的学号以确认跳过（将记录审计日志）：');
  if (inputId === null) return;
  const sid = inputId.trim();
  if (!sid) { toast('⚠️ 学号不能为空，无法跳过'); return; }
  if (myStudentId && sid !== myStudentId) { toast('❌ 学号不匹配，无法跳过'); return; }

  livenessSkipped=true; livenessPassed=false; livenessScore=0; livenessSkipReason='manual_'+sid;
  const st=document.getElementById('ciLivenessStatus');
  if(st) st.textContent='⚠️ 已跳过活体检测（人工复核，学号 '+sid+'）';
  const btn=document.getElementById('ciSkipLivenessBtn');
  if(btn) btn.style.display='none';
  const blinkStep=document.querySelector('#ciLivenessSteps [data-step="blink"]');
  if(blinkStep){ blinkStep.className='liveness-step done'; blinkStep.textContent='② 跳过 ⏩'; }
  updateLivenessUI();
  checkCiReady();
  toast('⚠️ 已标记为人工复核（学号 '+sid+'），继续拍照提交');
}

// 图片压缩工具
function compressImage(base64, quality = 0.7, maxWidth = 1200) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;
      
      // 计算压缩后的尺寸
      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }
      
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      
      const compressed = canvas.toDataURL('image/jpeg', quality);
      resolve(compressed);
    };
    img.onerror = () => resolve(base64); // 压缩失败返回原图
    img.src = base64;
  });
}

function capturePhoto(mode){
  const video=document.getElementById(mode+'Video'),img=document.getElementById(mode+'Photo');
  const c=document.createElement('canvas'); c.width=video.videoWidth||320; c.height=video.videoHeight||240;
  const ctx=c.getContext('2d'); ctx.drawImage(video,0,0,c.width,c.height);
  photoData=c.toDataURL('image/jpeg',0.85);
  
  // 异步压缩图片（不阻塞界面）
  compressImage(photoData, 0.7, 800).then(compressed => {
    photoData = compressed;
    img.src = photoData;
    img.style.display = 'block';
    video.style.display = 'none';

    // 更新按钮文字
    const camBtns = document.getElementById(mode+'CamBox').parentElement.querySelectorAll('.cam-btn');
    camBtns.forEach(b => b.textContent = '📷 重拍');
    const retake = document.getElementById(mode+'Retake');
    if(retake) retake.style.display = 'inline-flex';
    // 隐藏 DOM 绿框
    const faceBox = document.getElementById(mode+'FaceBox');
    if(faceBox) faceBox.style.display = 'none';

    // 查寝场景：拍照后定格活体检测进度，停止实时循环（保留结果）
    if(mode==='ci'){
      livenessActive=false;
      document.getElementById('ciCamBox').classList.remove('has-liveness');
      const lb=document.getElementById('ciLivenessBox');
      if(lb) lb.style.display='none';
      const lp=document.getElementById('ciLivenessPanel');
      if(lp) lp.style.display='none';
      checkCiReady();
    }
    if(mode==='lv') checkLvReady();
    stopCam();
  });
}

function retakeCam(mode){
  photoData=''; faceDetected=false;
  document.getElementById(mode+'Photo').style.display='none';
  document.getElementById(mode+'Retake').style.display='none';
  const fi=document.getElementById(mode+'FileInput');
  if(fi)fi.value='';
  resetLivenessState();
  toggleCam(mode);
}

function stopCam(){
  if(cameraStream){cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;}
  if(detInterval){clearInterval(detInterval);detInterval=null;}
  document.querySelectorAll('video').forEach(v=>v.style.display='none');
  // 隐藏 DOM 绿框
  document.querySelectorAll('[id$="FaceBox"]').forEach(el=>el.style.display='none');
}

// 提交查寝
document.getElementById('ciSubmit').onclick=async function(){
  const btn=this; btn.disabled=true; btn.textContent='⏳ 提交中...';
  if(!myStudentId){toast('⚠️ 请先登录');btn.disabled=false;btn.textContent='✅ 提交签到';return;}
  
  // 显示确认对话框
  const confirmed = await confirmDialog('确认签到', '确定要提交签到吗？');
  if (!confirmed) {
    btn.disabled = false;
    btn.textContent = '✅ 提交签到';
    return;
  }
  
  const checkinData = {
    student_id:myStudentId,date:todayStr(),status:'在寝',
    note:document.getElementById('ciNote').value.trim(),
    latitude:locState.ci?.lat,longitude:locState.ci?.lng,
    address:document.getElementById('ciAddress').textContent,
    photo:photoData
  };
  
  // 尝试提取人脸特征
  let faceHash = null;
  if (typeof faceapi !== 'undefined' && photoData && myStudentId) {
    try {
      const faceVec = await extractFaceEmbedding(photoData);
      if (faceVec) {
        faceHash = JSON.stringify(faceVec);
      }
    } catch (e) {
      console.warn('人脸特征提取失败，将继续无人脸验证签到:', e.message);
      faceHash = null;
    }
  }

  const checkinPayload = {
    ...checkinData,
    face_hash: faceHash,
    liveness_passed: livenessPassed ? 1 : 0,
    liveness_score: Math.round(livenessScore * 100) / 100,
    offline: false
  };

  // 检测网络状态
  if(isOnline){
    const headers = {'Content-Type':'application/json'};
    if (myStudentToken) headers['x-student-token'] = myStudentToken;
    const res=await fetch('/api/checkin',{
      method:'POST',headers,
      body:JSON.stringify(checkinPayload)
    });
    const j=await res.json();
    if(j.code===0){
      let msg = '签到成功！';
      if (j.data?.face_match) {
        if (j.data.face_match.matched) {
          msg = '✅ 签到成功！人脸识别通过（相似度:' + j.data.face_match.similarity.toFixed(4) + '）';
        } else {
          msg = '⚠️ 签到成功，但人脸比对失败（相似度:' + j.data.face_match.similarity.toFixed(4) + '，请核实身份）';
        }
      } else if (faceHash) {
        msg = '✅ 签到成功！活体检测通过';
      }
      toast(msg);
      resetCi();
      loadCheckinData();
    } else {
      toast('⚠️ '+j.message);
      btn.disabled=false; btn.textContent='✅ 提交签到';
    }
  } else {
    // 离线模式：同时保存到 IndexedDB 和内存队列
    const offlineRecord = {
      type: 'checkin',
      userId: myStudentId,
      data: checkinData,
      synced: false,
      createdAt: new Date().toISOString()
    };
    saveOfflineRecord(offlineRecord).then(() => {
      OFFLINE_QUEUE.push(offlineRecord);
      saveOfflineQueue();
      toast('📴 离线模式：数据已保存，联网后将自动同步');
    }).catch(() => {
      // IndexedDB 不可用时回退到 localStorage
      const offlineAction = { id: 'off_' + Date.now(), type: 'checkin', userId: myStudentId, data: checkinData, timestamp: new Date().toISOString() };
      OFFLINE_QUEUE.push(offlineAction);
      saveOfflineQueue();
      toast('📴 离线模式：数据已保存');
    });
    resetCi();
  }
};

function resetCi(){
  // 仅重置签到按钮状态和照片（保留定位/活体结果）
  // 说明：扫码/语音签到成功后也调用 resetCi，但不该清掉用户已采集的定位和活体结果，
  // 否则「✅ 提交签到」按钮会被重新灰化，用户误以为功能坏了。
  photoData='';
  document.getElementById('ciPhoto').style.display='none';
  document.getElementById('ciRetake').style.display='none';
  document.getElementById('ciCamBtn').textContent='📷 拍照';
  document.getElementById('ciCamMobileHint').style.display='none';
  // 重新计算按钮可用状态（基于现有定位/活体结果）
  checkCiReady();
}

// 上传照片功能（摄像头不可用时的备选方案）
function uploadPhoto(mode) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment'; // 优先调用后置摄像头
  
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // 检查文件大小（最大10MB，压缩后会变小）
    if (file.size > 10 * 1024 * 1024) {
      toast('⚠️ 图片大小不能超过10MB');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = function(event) {
      const originalData = event.target.result;
      
      // 压缩图片
      compressImage(originalData, 0.7, 800).then(compressed => {
        photoData = compressed;
        const img = document.getElementById(mode + 'Photo');
        img.src = photoData;
        img.style.display = 'block';
        
        // 隐藏摄像头相关元素
        const video = document.getElementById(mode + 'Video');
        video.style.display = 'none';
        const faceBox = document.getElementById(mode + 'FaceBox');
        if (faceBox) faceBox.style.display = 'none';
        document.getElementById(mode + 'CamPlaceholder').style.display = 'none';
        
        // 显示重拍按钮
        document.getElementById(mode + 'Retake').style.display = 'inline-block';
        document.getElementById(mode + 'CamBtn').textContent = '📷 重新拍照';
        
        // 显示压缩信息
        const originalSize = Math.round(originalData.length * 0.75 / 1024);
        const compressedSize = Math.round(compressed.length * 0.75 / 1024);
        toast(`✅ 照片已加载 (${originalSize}KB → ${compressedSize}KB)`);
      });
    };
    reader.readAsDataURL(file);
  };
  
  input.click();
}

// ===== 请假 =====
function checkLvReady(){
  document.getElementById('lvSubmit').disabled=!myStudentId
    ||!document.getElementById('lvReason').value.trim()
    ||!photoData;  // 证明材料改为必填：必须上传/拍照照片
}
document.getElementById('lvStart').value=todayStr();
document.getElementById('lvEnd').value=todayStr();
document.getElementById('lvReason').oninput=()=>checkLvReady();

function handleFileUpload(e){
  const file=e.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=function(ev){
    photoData=ev.target.result;
    document.getElementById('lvPhoto').src=photoData;
    document.getElementById('lvPhoto').style.display='block';
    document.getElementById('lvCamPlaceholder').style.display='none';
    checkLvReady();
  };
  reader.readAsDataURL(file);
}

async function submitLeave(){
  const btn=document.getElementById('lvSubmit'); btn.disabled=true; btn.textContent='⏳ 提交中...';
  
  // 显示确认对话框
  const confirmed = await confirmDialog('确认提交', '确定要提交请假申请吗？');
  if (!confirmed) {
    btn.disabled = false;
    btn.textContent = '📤 提交申请';
    return;
  }

  // 证明材料改为必填：无照片则阻断提交
  if (!photoData) {
    toast('⚠️ 证明材料为必填项，请上传图片');
    btn.disabled = false;
    btn.textContent = '📤 提交申请';
    return;
  }
  
  const fd=new FormData();
  fd.append('student_id', myStudentId);
  fd.append('type', document.getElementById('lvType').value);
  fd.append('reason', document.getElementById('lvReason').value.trim());
  fd.append('start_date', document.getElementById('lvStart').value);
  fd.append('end_date', document.getElementById('lvEnd').value);
  // 如果有照片数据(base64)，转为Blob附加到FormData
  if(photoData){
    const byteString=atob(photoData.split(',')[1]);
    const ab=new ArrayBuffer(byteString.length);
    const ua=new Uint8Array(ab);
    for(let i=0;i<byteString.length;i++) ua[i]=byteString.charCodeAt(i);
    const blob=new Blob([ab],{type:'image/jpeg'});
    fd.append('attachment', blob, 'leave_photo.jpg');
  }
  const headers = {};
  if (myStudentToken) headers['x-student-token'] = myStudentToken;
  const res=await fetch('/api/leaves',{method:'POST',headers,body:fd});
  const j=await res.json();
  if(j.code===0){
    toast('✅ 请假已提交，等待审批');
    document.getElementById('lvReason').value='';
    document.getElementById('lvPhoto').style.display='none';
    photoData='';
    loadMyLeaves();
    checkLvReady();
  } else toast('⚠️ '+j.message);
  btn.disabled=false; btn.textContent='📤 提交申请';
}

// 拉取并渲染教师公告横幅（最近 3 条，登录后与收到 WS 公告时调用）
async function loadAnnouncements(){
  if(!myStudentId) return;
  const wrap=document.getElementById('annBanner');
  const body=document.getElementById('annBannerBody');
  if(!wrap||!body) return;
  try{
    const r=await fetch('/api/announcements',{headers:{'x-student-token':myStudentToken||''}});
    const j=await r.json();
    const rows=(j.data||[]).slice(0,3);
    if(!rows.length){wrap.style.display='none';return;}
    body.innerHTML=rows.map(a=>{
      const t=(a.created_at||'').replace('T',' ').slice(5,16);
      return `<div style="padding:6px 0;border-bottom:1px dashed #bfdbfe">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <span style="font-size:13px;font-weight:600;color:#1e40af">${esc(a.title)}</span>
          <span style="font-size:11px;color:#60a5fa;white-space:nowrap">${esc(t)}</span>
        </div>
        <div style="font-size:12.5px;color:#1e3a8a;margin-top:2px;white-space:pre-wrap;word-break:break-word">${esc(a.content)}</div>
      </div>`;
    }).join('');
    wrap.style.display='block';
  }catch(e){ /* 静默失败，不打扰签到主流程 */ }
}

// ===== 公告记录（"我的"页持久列表，防止弹窗被忽略后看不到历史公告） =====
async function loadMyAnnouncements(){
  if(!myStudentId) return;
  const box=document.getElementById('myAnnList');
  if(!box) return;
  try{
    const r=await fetch('/api/announcements',{headers:{'x-student-token':myStudentToken||''}});
    if(r.status===401) return;
    const j=await r.json();
    const rows=j.data||[];
    if(!rows.length){box.innerHTML='<div class="empty-state"><p>暂无公告</p></div>';return;}
    box.innerHTML=rows.map(a=>{
      const t=(a.created_at||'').replace('T',' ').slice(0,16);
      return `<div class="lv-card">
        <div class="hd">
          <span class="nm">📢 ${esc(a.title)}</span>
          <span class="tag tg-gray" style="white-space:nowrap">${esc(t)}</span>
        </div>
        <div class="bd" style="white-space:pre-wrap;word-break:break-word">${esc(a.content)}</div>
      </div>`;
    }).join('');
  }catch(e){ /* 静默失败 */ }
}

async function loadMyLeaves(){
  if(!myStudentId) return;
  const r=await fetch(`/api/leaves?student_id=${myStudentId}&_t=${Date.now()}`);
  const j=await r.json();
  const container=document.getElementById('lvMyList');
  if(!j.data||!j.data.length){container.innerHTML='<div class="empty-state"><p>暂无请假记录</p></div>';return;}
  container.innerHTML=j.data.map(l=>{
    const tc=l.status==='已批准'?'tag-green':l.status==='已驳回'?'tag-red':'tag-yellow';
    const att=l.attachment_path?`<span style="font-size:12px;color:#4f46e5;cursor:pointer" onclick="window.open('${esc(l.attachment_path)}','_blank')">📎 查看附件</span>`:'';
    return `<div class="list-item"><div class="left">
      <div class="title">${esc(l.type)} · <span class="tag ${tc}">${esc(l.status)}</span></div>
      <div class="meta">${esc(l.start_date)} ~ ${esc(l.end_date)} · ${esc(l.reason).slice(0,30)}${l.reason.length>30?'...':''}</div>
      ${l.comment?`<div class="meta">审批意见：${esc(l.comment)}</div>`:''}
      ${att?`<div class="meta">${att}</div>`:''}
    </div></div>`;
  }).join('');
}

// ===== 课堂签到 =====
async function loadCourses(){
  let url = `/api/courses?date=${todayStr()}&_t=${Date.now()}`;
  if (myClassName) url += `&class_name=${encodeURIComponent(myClassName)}`;
  const r=await fetch(url);
  const j=await r.json();
  const sel=document.getElementById('clCourse');
  sel.innerHTML='<option value="">请选择</option>';
  if(j.data && j.data.length){
    j.data.forEach(c=>{sel.innerHTML+=`<option value="${c.id}">${esc(c.name)||''} ${esc(c.start_time)||''} ${esc(c.location)||''}</option>`;});
  } else {
    // 显示友好提示
    const tip = myClassName 
      ? `今日无课程（班级：${myClassName}）`
      : '今日无课程';
    const opt = document.createElement('option');
    opt.value = ''; opt.disabled = true; opt.textContent = tip;
    sel.appendChild(opt);
  }
}
document.getElementById('clCourse').onchange=()=>checkClReady();
function checkClReady(){
  const c=document.getElementById('clCourse').value;
  const loc=locState.cl;
  // 启用定位按钮（只要选了课程就可以定位）
  document.getElementById('clLocate').disabled = !c;
  // 签到按钮需要：学生ID + 课程 + 位置
  document.getElementById('clSubmit').disabled=!(myStudentId&&c&&loc);
}
document.getElementById('clSubmit').onclick=async function(){
  const btn=this; btn.disabled=true; btn.textContent='⏳ 签到中...';
  const headers = {'Content-Type':'application/json'};
  if (myStudentToken) headers['x-student-token'] = myStudentToken;
  const res=await fetch('/api/class-checkin',{
    method:'POST',headers,
    body:JSON.stringify({
      student_id:myStudentId,
      course_id:document.getElementById('clCourse').value,
      date:todayStr(),
      latitude:locState.cl.lat,longitude:locState.cl.lng,
      address:document.getElementById('clAddress').textContent
    })
  });
  const j=await res.json();
  if(j.code===0){toast('✅ '+j.message);locState.cl=null;document.getElementById('clLocate').className='locate-btn';document.getElementById('clLocate').textContent='📍 获取位置';document.getElementById('clLocInfo').style.display='none';document.getElementById('clSubmit').disabled=true;loadMyClass();}
  else toast('⚠️ '+j.message);
  btn.disabled=false; btn.textContent='✅ 签到';
};
async function loadMyClass(){
  if(!myStudentId)return;
  const r=await fetch(`/api/records?student_id=${myStudentId}&type=class,attendance&_t=${Date.now()}`);
  const j=await r.json();
  const my=(j.data||[]).slice(0,10);
  const container=document.getElementById('clMyList');
  if(!my.length){container.innerHTML='<div class="empty-state"><p>暂无课堂签到记录</p></div>';return;}
  container.innerHTML=my.map(d=>`<div class="list-item"><div class="left"><div class="title">🏫 ${esc(d.course_name)||'课堂'} <span class="tag tag-green">${esc(d.status)}</span></div><div class="meta">${fmtTime(d.time, d.date)}</div></div></div>`).join('');
}

// ===== 标签切换 =====
function switchTab(name){
  if(!myStudentId){toast('⚠️ 请先登录');return;}
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(t=>t.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  document.querySelector(`.tab-btn[onclick*="'${name}'"]`).classList.add('active');
  stopCam();
  if(myRefreshTimer){clearInterval(myRefreshTimer);myRefreshTimer=null;}
  if(name==='checkin') loadCheckinData();
  if(name==='leave'){loadMyLeaves();document.getElementById('lvStart').value=todayStr();document.getElementById('lvEnd').value=todayStr();}
  if(name==='class'){loadCourses();loadMyClass();}
  if(name==='my'){loadMyStatistics();loadMyAnnouncements();loadStudentDashboard();myRefreshTimer=setInterval(()=>{loadMyStatistics();loadStudentDashboard();},30000);}
}

// ===== 我的请假进度（考勤统计卡片已按需求移除，仅保留请假进度渲染） =====
async function loadMyStatistics() {
  if (!myStudentId) return;

  try {
    // 加载请假记录
    const lvR = await fetch(`/api/leaves?student_id=${myStudentId}&_t=${Date.now()}`);
    const lvJ = await lvR.json();
    const leaves = lvJ.data || [];

    // 请假进度
    const progress = document.getElementById('myLeaveProgress');
    if (!leaves.length) {
      progress.innerHTML = '<div class="empty-state"><p>暂无请假记录</p></div>';
    } else {
      const statusIcon = { '待审批': '⏳', '已批准': '✅', '已驳回': '❌' };
      const statusClass = { '待审批': 'tg-yellow', '已批准': 'tg-green', '已驳回': 'tg-red' };
      progress.innerHTML = leaves.map(l => `
        <div class="lv-card">
          <div class="hd">
            <span class="nm">${statusIcon[l.status]||'📝'} ${esc(l.type)}假</span>
            <span class="tag ${statusClass[l.status]||'tg-gray'}">${esc(l.status)}</span>
          </div>
          <div class="bd">
            <b>日期：</b>${esc(l.start_date)} ~ ${esc(l.end_date)}<br/>
            <b>原因：</b>${esc(l.reason)}
            ${l.comment ? `<br/><b>审批意见：</b>${esc(l.comment)}` : ''}
          </div>
        </div>
      `).join('');
    }
  } catch (e) {
    console.error('加载统计失败:', e);
  }
}

// ===== 语音签到（应急模式） =====
// 双通道：① 原生 SpeechRecognition（桌面 Chrome/Edge，可自动转文字）
//          ② MediaRecorder 通用录音（移动端/微信/Safari，设备无关，录完可试听）
// 任一通道不可用时，始终提供「手动输入」兜底。
// 展开/收起查寝语音签到区域（按钮 onclick 调用，之前缺失导致点按钮抛 ReferenceError、区域打不开）
function toggleVoiceCheckin() {
  const a = document.getElementById('voiceCheckinArea');
  if (a) a.style.display = a.style.display === 'none' ? 'block' : 'none';
}

let recognition = null;
let isRecording = false;
let voiceRecordTimer = null;
let mediaRecorder = null;          // MediaRecorder 实例
let mediaStream = null;            // 麦克风媒体流
let mediaChunks = [];              // 录音数据块
let voiceAudioUrl = '';           // 录音试听 URL
let voiceAudioBlob = null;       // 录音 blob（提交转 base64 用）
let recStartTs = 0, recTick = null; // 录音计时

// 把 ObjectURL 指向的 blob 读成 base64 dataURL（提交语音签到时上传音频用）
function blobToBase64(objUrl) {
  return new Promise((resolve) => {
    if (!objUrl || !voiceAudioBlob) { resolve(''); return; }
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve('');
    fr.readAsDataURL(voiceAudioBlob);
  });
}

// 原生语音识别（仅桌面浏览器可用）
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'zh-CN';

  recognition.onresult = (event) => {
    let finalTranscript = '', interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += transcript;
      else interimTranscript += transcript;
    }
    const el = document.getElementById('voiceText');
    if (el) {
      el.value = finalTranscript + interimTranscript;
      const sb = document.getElementById('voiceSubmitBtn');
      if (sb) sb.disabled = !finalTranscript.trim();
    }
  };
  recognition.onerror = (event) => {
    let msg = '❌ 识别失败：' + event.error;
    if (event.error === 'no-speech') msg = '🎤 未检测到语音，请靠近麦克风大声说（也可手动输入）';
    else if (event.error === 'audio-capture') msg = '❌ 无法捕获麦克风，请检查权限或浏览器';
    else if (event.error === 'not-allowed') msg = '❌ 麦克风权限被拒绝';
    else if (event.error === 'network') msg = '❌ 语音识别需要联网，当前网络可能受限';
    const st = document.getElementById('voiceStatus');
    if (st) st.textContent = msg;
    if (event.error !== 'no-speech') stopVoiceRecord();
  };
  recognition.onend = () => {
    if (isRecording) setVoiceRecUI(false);
  };
}

// MediaRecorder 是否可用（通用录音兜底）
function voiceRecorderSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

// 选择最通用的录音格式（优先 mp4，Safari/iOS 都能回放；再 webm/ogg/opus）
// 解决"默认 webm 在部分浏览器/手机端 <audio> 无法解码、回放显示 0/没声"的问题
function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  // 顺序关键：webm(opus) 在桌面 Chrome/Edge/Firefox 录制+回放都支持；
  // mp4 容器（Apple Safari/iOS 可录但桌面 Chrome 无法回放 mp4 内的 opus），故 mp4 放最后兜底。
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const m of candidates) { if (MediaRecorder.isTypeSupported(m)) return m; }
  return '';
}

// 创建 MediaRecorder，指定最优 MIME（避免默认 webm 在 Safari/手机无法回放）
function createMediaRecorder(stream) {
  const mime = pickAudioMime();
  try { return mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { try { return new MediaRecorder(stream); } catch (e2) { return null; } }
}

// 可视化录音指示器
function setVoiceRecUI(recording) {
  const ind = document.getElementById('voiceRecIndicator');
  const btn = document.getElementById('voiceRecordBtn');
  if (ind) ind.classList.toggle('active', recording);
  if (btn) btn.textContent = recording ? '⏹️ 停止录音' : '🎙️ 开始录音';
  if (!recording) stopRecTick();
}

function startRecTick() {
  recStartTs = Date.now();
  updateRecTick();
  stopRecTick();
  recTick = setInterval(updateRecTick, 500);
}
function updateRecTick() {
  const el = document.getElementById('voiceRecTimer');
  if (!el) return;
  const s = Math.floor((Date.now() - recStartTs) / 1000);
  el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function stopRecTick() {
  if (recTick) { clearInterval(recTick); recTick = null; }
}

// 释放 MediaRecorder 资源
function releaseMediaRecorder() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) {}
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
  mediaChunks = [];
}

async function startVoiceRecord() {
  if (isRecording) { stopVoiceRecord(); return; }

  const useSTT = !!recognition;
  const useRec = voiceRecorderSupported();
  const st = document.getElementById('voiceStatus');

  // 两条通道都不可用（如微信/部分移动端 WebView）：直接引导手动输入，避免"假录音"
  if (!useSTT && !useRec) {
    if (st) st.textContent = '⚠️ 当前浏览器不支持语音识别/录音，请手动输入签到口令';
    toast('⚠️ 请手动输入签到口令');
    const tx = document.getElementById('voiceText');
    if (tx) { tx.focus(); }
    return;
  }

  // ① 原生语音识别（可自动转文字）
  if (useSTT) {
    try { recognition.start(); }
    catch (e) { console.warn('原生识别启动失败，降级到通用录音:', e); }
  }

  // ② MediaRecorder 通用录音（任何设备都有效，提供录音反馈）
  if (useRec) {
    let recorderOk = false, recErr = null;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = createMediaRecorder(mediaStream);
      if (!mediaRecorder) { releaseMediaRecorder(); throw new Error('MediaRecorder unavailable'); }
      mediaChunks = [];
      mediaRecorder.ondataavailable = (evt) => { if (evt.data && evt.data.size) mediaChunks.push(evt.data); };
      mediaRecorder.onstop = () => {
        if (mediaChunks.length) {
          const blob = new Blob(mediaChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          if (voiceAudioUrl) URL.revokeObjectURL(voiceAudioUrl);
          voiceAudioUrl = URL.createObjectURL(blob);
          voiceAudioBlob = blob;
          const s2 = document.getElementById('voiceStatus');
          // 移动端仅录音不转文字：录音完成后启用提交按钮，保证「录完就能提交」
          const sb = document.getElementById('voiceSubmitBtn');
          if (sb) sb.disabled = false;
          if (s2) s2.textContent = '✅ 录音完成，可点击下方回放试听，确认无误后提交';
          showVoiceReplay();
        }
        releaseMediaRecorder();
      };
      mediaRecorder.start(250); // 每 250ms 输出一块，确保数据完整、<audio> 可正常解码回放
      recorderOk = true;
    } catch (err) {
      recErr = err;
      console.warn('MediaRecorder 启动失败:', err);
      releaseMediaRecorder();
    }
    // 仅当原生识别不可用、且录音也启动失败时，才提示手动输入
    if (!recorderOk && !useSTT && st) {
      st.textContent = '❌ 无法启动录音（' + (recErr && (recErr.name || recErr.message) || '权限不足') + '），请检查麦克风权限或手动输入口令';
    }
  }

  isRecording = true;
  setVoiceRecUI(true);
  startRecTick();
  if (st) st.textContent = '🔴 正在录音，请说出签到内容…（10 秒后自动结束）';

  if (voiceRecordTimer) clearTimeout(voiceRecordTimer);
  voiceRecordTimer = setTimeout(() => { if (isRecording) stopVoiceRecord(); }, 10000);
}

function stopVoiceRecord() {
  if (recognition && recognition.state !== 'idle') { try { recognition.stop(); } catch (e) {} }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch (e) {} }
  if (voiceRecordTimer) { clearTimeout(voiceRecordTimer); voiceRecordTimer = null; }
  isRecording = false;
  setVoiceRecUI(false);
}

// 录音回放试听
function showVoiceReplay() {
  if (!voiceAudioUrl) return;
  let wrap = document.getElementById('voiceReplayWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'voiceReplayWrap';
    wrap.style.cssText = 'margin-top:8px;display:none';
    wrap.innerHTML = '<div style="background:#f1f5f9;border-radius:10px;padding:10px;font-size:12px;color:#475569">🔊 录音回放</div><audio controls style="width:100%;margin-top:6px"></audio>';
    const area = document.getElementById('voiceCheckinArea');
    const status = document.getElementById('voiceStatus');
    if (area && status) area.insertBefore(wrap, status.nextSibling);
  }
  const audio = wrap.querySelector('audio');
  audio.src = voiceAudioUrl;
  wrap.style.display = 'block';
}

async function submitVoiceCheckin() {
  const textEl = document.getElementById('voiceText');
  let text = textEl.value.trim();
  // 录音完成但未自动转文字（移动端 MediaRecorder 通道）：允许以录音为准提交，文案兜底
  const hasAudio = !!voiceAudioUrl;
  if (!text && !hasAudio) { toast('⚠️ 请说出或输入签到口令'); return; }
  if (!text) text = '（语音签到，已录音频）';

  const btn = document.getElementById('voiceSubmitBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 提交中...';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (myStudentToken) headers['x-student-token'] = myStudentToken;

    const body = { student_id: myStudentId, text, date: todayStr(), note: '应急语音签到' };
    // 若录了音频但未转文字，把音频转 base64 一并上传，供后端存档/复核
    if (hasAudio && !textEl.value.trim()) {
      body.audioBase64 = await blobToBase64(voiceAudioUrl);
    }

    // 加 AbortController 超时保护（30s），防止网络挂起导致按钮永久卡在「提交中」
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      res = await fetch('/api/voice-checkin', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const j = await res.json();
    if (j.code === 0) {
      // 语音通道完成 → 满足任务 required_steps 中的 voice 项（若教师勾选）
      ciStepDone.voice = true;
      checkCiReady();
      // 明确提示：语音是独立签到通道，已完成签到，下面「提交签到」是人脸+定位的传统通道，不必再点
      toast('✅ 语音签到成功！（无需再点「✅ 提交签到」）', 4000);
      document.getElementById('voiceText').value = '';
      btn.disabled = true;
      btn.textContent = '✅ 已提交';
      loadCheckinData();
    } else {
      toast('⚠️ ' + j.message);
      btn.disabled = false;
      btn.textContent = '✅ 提交语音签到';
    }
  } catch (e) {
    toast(e.name === 'AbortError' ? '⚠️ 提交超时，请检查网络后重试' : '⚠️ 提交失败：' + e.message);
    btn.disabled = false;
    btn.textContent = '✅ 提交语音签到';
  }
}

// ===== 课堂语音签到（双通道：原生识别 + MediaRecorder 通用录音） =====
let clRecognition = null;
let isClRecording = false;
let clVoiceRecordTimer = null;
let clMediaRecorder = null, clMediaStream = null, clMediaChunks = [];
let clRecStartTs = 0, clRecTick = null, clVoiceAudioUrl = '';
let clVoiceAudioBlob = null; // 课堂录音 blob

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  clRecognition = new SR();
  clRecognition.continuous = true;
  clRecognition.interimResults = true;
  clRecognition.lang = 'zh-CN';
  clRecognition.onresult = (ev) => {
    let final = '', interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final += t; else interim += t;
    }
    const el = document.getElementById('clVoiceText');
    if (el) { el.value = final + interim; document.getElementById('clVoiceSubmitBtn').disabled = !final.trim(); }
  };
  clRecognition.onerror = (ev) => {
    let msg = '❌ 识别失败：' + ev.error;
    if (ev.error === 'no-speech') msg = '🎤 未检测到语音，请靠近麦克风（也可手动输入）';
    else if (ev.error === 'not-allowed') msg = '❌ 麦克风权限被拒绝';
    else if (ev.error === 'network') msg = '❌ 语音识别需要联网';
    const st = document.getElementById('clVoiceStatus');
    if (st) st.textContent = msg;
    if (ev.error !== 'no-speech') stopClVoiceRecord();
  };
  clRecognition.onend = () => {
    if (isClRecording) setClRecUI(false);
  };
}

function toggleClVoiceCheckin() {
  const a = document.getElementById('clVoiceArea');
  a.style.display = a.style.display === 'none' ? 'block' : 'none';
}

function setClRecUI(recording) {
  const ind = document.getElementById('clVoiceRecIndicator');
  const btn = document.getElementById('clVoiceRecordBtn');
  if (ind) ind.classList.toggle('active', recording);
  if (btn) btn.textContent = recording ? '⏹️ 停止录音' : '🎙️ 开始录音';
  if (!recording) stopClRecTick();
}
function startClRecTick() {
  clRecStartTs = Date.now(); updateClRecTick(); stopClRecTick();
  clRecTick = setInterval(updateClRecTick, 500);
}
function updateClRecTick() {
  const el = document.getElementById('clVoiceRecTimer');
  if (!el) return;
  const s = Math.floor((Date.now() - clRecStartTs) / 1000);
  el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function stopClRecTick() { if (clRecTick) { clearInterval(clRecTick); clRecTick = null; } }
function releaseClMediaRecorder() {
  if (clMediaRecorder && clMediaRecorder.state !== 'inactive') { try { clMediaRecorder.stop(); } catch (e) {} }
  if (clMediaStream) { clMediaStream.getTracks().forEach(t => t.stop()); clMediaStream = null; }
  clMediaRecorder = null; clMediaChunks = [];
}

async function startClVoiceRecord() {
  if (isClRecording) { stopClVoiceRecord(); return; }
  const useSTT = !!clRecognition;
  const useRec = voiceRecorderSupported();
  const st = document.getElementById('clVoiceStatus');

  // 两条通道都不可用（如微信/部分移动端 WebView）：直接引导手动输入，避免"假录音"
  if (!useSTT && !useRec) {
    if (st) st.textContent = '⚠️ 当前浏览器不支持语音识别/录音，请手动输入签到口令';
    toast('⚠️ 请手动输入签到口令');
    const tx = document.getElementById('clVoiceText');
    if (tx) tx.focus();
    return;
  }

  if (useSTT) { try { clRecognition.start(); } catch (e) { console.warn('原生识别启动失败:', e); } }

  if (useRec) {
    let recorderOk = false, recErr = null;
    try {
      clMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      clMediaRecorder = createMediaRecorder(clMediaStream);
      if (!clMediaRecorder) { releaseClMediaRecorder(); throw new Error('MediaRecorder unavailable'); }
      clMediaChunks = [];
      clMediaRecorder.ondataavailable = (evt) => { if (evt.data && evt.data.size) clMediaChunks.push(evt.data); };
      clMediaRecorder.onstop = () => {
        if (clMediaChunks.length) {
          const blob = new Blob(clMediaChunks, { type: clMediaRecorder.mimeType || 'audio/webm' });
          if (clVoiceAudioUrl) URL.revokeObjectURL(clVoiceAudioUrl);
          clVoiceAudioUrl = URL.createObjectURL(blob);
          clVoiceAudioBlob = blob;
          // 录音完成后启用提交按钮（移动端只录音不转文字也能提交）
          const sb = document.getElementById('clVoiceSubmitBtn');
          if (sb) sb.disabled = false;
          const s2 = document.getElementById('clVoiceStatus');
          if (s2) s2.textContent = '✅ 录音完成，可回放试听，确认无误后提交';
          showClVoiceReplay();
        }
        releaseClMediaRecorder();
      };
      clMediaRecorder.start(250);
      recorderOk = true;
    } catch (err) {
      recErr = err;
      console.warn('MediaRecorder 启动失败:', err);
      releaseClMediaRecorder();
    }
    if (!recorderOk && !useSTT && st) {
      st.textContent = '❌ 无法启动录音（' + (recErr && (recErr.name || recErr.message) || '权限不足') + '），请检查麦克风权限或手动输入口令';
    }
  }

  isClRecording = true;
  setClRecUI(true);
  startClRecTick();
  if (st) st.textContent = '🔴 正在录音，请说出签到内容…（10 秒后自动结束）';
  if (clVoiceRecordTimer) clearTimeout(clVoiceRecordTimer);
  clVoiceRecordTimer = setTimeout(() => { if (isClRecording) stopClVoiceRecord(); }, 10000);
}

function stopClVoiceRecord() {
  if (clRecognition && clRecognition.state !== 'idle') { try { clRecognition.stop(); } catch (e) {} }
  if (clMediaRecorder && clMediaRecorder.state !== 'inactive') { try { clMediaRecorder.stop(); } catch (e) {} }
  if (clVoiceRecordTimer) { clearTimeout(clVoiceRecordTimer); clVoiceRecordTimer = null; }
  isClRecording = false;
  setClRecUI(false);
}

function showClVoiceReplay() {
  if (!clVoiceAudioUrl) return;
  let wrap = document.getElementById('clVoiceReplayWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'clVoiceReplayWrap';
    wrap.style.cssText = 'margin-top:8px;display:none';
    wrap.innerHTML = '<div style="background:#f1f5f9;border-radius:10px;padding:10px;font-size:12px;color:#475569">🔊 录音回放</div><audio controls style="width:100%;margin-top:6px"></audio>';
    const area = document.getElementById('clVoiceArea');
    const status = document.getElementById('clVoiceStatus');
    if (area && status) area.insertBefore(wrap, status.nextSibling);
  }
  wrap.querySelector('audio').src = clVoiceAudioUrl;
  wrap.style.display = 'block';
}

async function submitClVoiceCheckin() {
  const textEl = document.getElementById('clVoiceText');
  let text = textEl.value.trim();
  // 录音完成但未自动转文字（移动端 MediaRecorder 通道）：允许以录音为准提交，文案兜底
  if (!text) text = '（语音签到，已录音频）';
  const courseId = document.getElementById('clCourse').value;
  if (!courseId) { toast('⚠️ 请先选择课程'); return; }

  const btn = document.getElementById('clVoiceSubmitBtn');
  btn.disabled=true; btn.textContent='⏳ 提交中...';
  try {
    const headers = {'Content-Type':'application/json'};
    if (myStudentToken) headers['x-student-token'] = myStudentToken;
    const res = await fetch('/api/class-checkin', {
      method:'POST', headers,
      body: JSON.stringify({
        student_id: myStudentId, course_id: courseId,
        date: todayStr(), note: '语音签到: '+text
      })
    });
    const j = await res.json();
    if (j.code===0) { toast('✅ 课堂语音签到成功！'); document.getElementById('clVoiceText').value=''; btn.disabled=true; loadMyClass(); }
    else { toast('⚠️ '+j.message); btn.disabled=false; btn.textContent='✅ 提交语音签到'; }
  } catch(e) { toast('⚠️ 提交失败：'+e.message); btn.disabled=false; btn.textContent='✅ 提交语音签到'; }
}

// ===== QR 扫码签到 =====
let qrScannerInstance = null;
let currentQrMode = '';

function startQrScan(mode) {
  if (!myStudentId) { toast('⚠️ 请先登录'); return; }
  
  // 检查 html5-qrcode 是否加载
  if (typeof Html5Qrcode === 'undefined') {
    toast('⚠️ 扫码库加载中，请稍后重试');
    return;
  }
  
  currentQrMode = mode;
  const modeLabel = mode === 'ci' ? '查寝签到' : '课堂签到';
  document.getElementById('qrScanMode').textContent = modeLabel;
  document.getElementById('qrScannerOverlay').style.display = 'flex';
  document.getElementById('qrScanResult').textContent = '正在启动摄像头...';
  
  // 创建扫码器
  try {
    qrScannerInstance = new Html5Qrcode('qrScannerContainer');
    qrScannerInstance.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
      },
      (decodedText) => {
        // 扫码成功
        handleQrResult(decodedText, mode);
      },
      () => {} // 忽略中间结果
    ).catch(err => {
      document.getElementById('qrScanResult').textContent = '❌ 摄像头启动失败: ' + err;
      setTimeout(closeQrScanner, 3000);
    });
  } catch (e) {
    document.getElementById('qrScanResult').textContent = '❌ 扫码初始化失败';
    setTimeout(closeQrScanner, 2000);
  }
}

function closeQrScanner() {
  if (qrScannerInstance) {
    try {
      qrScannerInstance.stop().catch(() => {});
    } catch(e) {}
    qrScannerInstance = null;
  }
  document.getElementById('qrScannerOverlay').style.display = 'none';
}

// 从二维码文本中提取宿舍信息（支持新版 JSON 与旧版 URL ?dorm= 两种格式）
function extractQrDorm(text) {
  try {
    const data = JSON.parse(text);
    if (data.dorm) return String(data.dorm).trim();
  } catch (e) {
    const m = text.match(/[?&]dorm=([^&]+)/);
    if (m) return decodeURIComponent(m[1]).trim();
  }
  return '';
}

async function handleQrResult(text, mode) {
  // 停止扫描
  if (qrScannerInstance) {
    try { await qrScannerInstance.stop(); } catch(e) {}
    qrScannerInstance = null;
  }

  const resultEl = document.getElementById('qrScanResult');
  resultEl.textContent = '✅ 扫码成功！处理中...';

  try {
    let data = {};
    // 尝试解析 JSON
    try {
      data = JSON.parse(text);
    } catch (e) {
      // 如果不是 JSON，尝试提取宿舍信息兜底
      const dorm = extractQrDorm(text);
      data = { type: mode === 'ci' ? 'checkin' : 'class', dorm: dorm, token: text };
    }

    if (data.type === 'checkin' || data.type === 'ci' || mode === 'ci') {
      // 查寝签到：必须校验宿舍归属，防止扫其他寝室二维码代签
      const qrDorm = (data.dorm || extractQrDorm(text) || '').trim();
      const note = data.note || data.remark || '扫码签到';
      const headers = {'Content-Type': 'application/json'};
      if (myStudentToken) headers['x-student-token'] = myStudentToken;

      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          student_id: myStudentId,
          date: todayStr(),
          status: '在寝',
          note: note,
          dorm: qrDorm,
          offline: false
        })
      });
      const j = await res.json();
      if (j.code === 0) {
        // 扫码通道完成 → 满足任务 required_steps 中的 qrcode 项（若教师勾选）
        ciStepDone.qrcode = true;
        checkCiReady();
        // 明确提示：扫码是独立签到通道，已完成签到，下面「提交签到」是人脸+定位的传统通道，不必再点
        toast('✅ 扫码签到成功！（无需再点「✅ 提交签到」）', 4000);
        closeQrScanner();
        loadCheckinData();
      } else {
        resultEl.textContent = '❌ 签到失败: ' + j.message;
        setTimeout(closeQrScanner, 2500);
      }
    } else if (data.type === 'class' || mode === 'cl') {
      // 课堂签到 - 获取或选择课程
      const courseId = data.course_id || data.id || data.token;
      const courseName = data.course_name || data.name || '';
      
      if (courseId) {
        // 直接签到
        const headers = {'Content-Type': 'application/json'};
        if (myStudentToken) headers['x-student-token'] = myStudentToken;
        
        const res = await fetch('/api/class-checkin', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            student_id: myStudentId,
            course_id: courseId,
            date: todayStr(),
            class_name: myClassName,
            note: courseName || '扫码签到'
          })
        });
        const j = await res.json();
        if (j.code === 0) {
          toast('✅ 课堂扫码签到成功！');
          closeQrScanner();
          loadMyClass();
        } else {
          resultEl.textContent = '❌ 签到失败: ' + j.message;
          setTimeout(closeQrScanner, 2000);
        }
      } else {
        resultEl.textContent = '❌ 无效的课堂二维码';
        setTimeout(closeQrScanner, 2000);
      }
    } else {
      resultEl.textContent = '❌ 不支持的二维码类型';
      setTimeout(closeQrScanner, 2000);
    }
  } catch (e) {
    resultEl.textContent = '❌ 处理失败: ' + e.message;
    setTimeout(closeQrScanner, 2000);
  }
}

// ===== 课堂拍照签到 =====
let clPhotoStream = null;
let clPhotoData = '';

async function startClPhotoCheckin(){
  if (!myStudentId) { toast('⚠️ 请先登录'); return; }
  const courseId = document.getElementById('clCourse').value;
  if (!courseId) { toast('⚠️ 请先选择课程'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('⚠️ 当前环境不支持拍照'); return; }
  document.getElementById('photoCheckinOverlay').style.display='flex';
  document.getElementById('clPhotoStatus').textContent='正在启动摄像头...';
  document.getElementById('clPhotoPreview').style.display='none';
  document.getElementById('clPhotoVideo').style.display='block';
  document.getElementById('clPhotoCaptureBtn').style.display='inline-block';
  document.getElementById('clPhotoRetakeBtn').style.display='none';
  document.getElementById('clPhotoSubmitBtn').style.display='none';
  clPhotoData='';
  try {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:1280}, height:{ideal:720} }, audio:false }); }
    catch(e1) { stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false }); }
    clPhotoStream = stream;
    document.getElementById('clPhotoVideo').srcObject = stream;
    document.getElementById('clPhotoStatus').textContent='对准自己或现场，点击下方按钮拍照';
  } catch(e) {
    document.getElementById('clPhotoStatus').textContent='❌ 摄像头启动失败：'+e.message;
  }
}

function stopClPhotoStream(){
  if (clPhotoStream) { try{ clPhotoStream.getTracks().forEach(t=>t.stop()); }catch(e){} clPhotoStream=null; }
}

function closeClPhotoCheckin(){
  stopClPhotoStream();
  document.getElementById('photoCheckinOverlay').style.display='none';
  clPhotoData='';
}

function captureClPhoto(){
  const video=document.getElementById('clPhotoVideo');
  if(!video.videoWidth){ toast('⚠️ 摄像头未就绪，请稍候'); return; }
  const c=document.createElement('canvas'); c.width=video.videoWidth; c.height=video.videoHeight;
  c.getContext('2d').drawImage(video,0,0,c.width,c.height);
  compressImage(c.toDataURL('image/jpeg',0.85), 0.7, 800).then(compressed=>{
    clPhotoData=compressed;
    document.getElementById('clPhotoPreview').src=compressed;
    document.getElementById('clPhotoPreview').style.display='block';
    document.getElementById('clPhotoVideo').style.display='none';
    document.getElementById('clPhotoCaptureBtn').style.display='none';
    document.getElementById('clPhotoRetakeBtn').style.display='inline-block';
    document.getElementById('clPhotoSubmitBtn').style.display='inline-block';
    document.getElementById('clPhotoStatus').textContent='确认照片无误后提交签到';
  });
}

function retakeClPhoto(){
  clPhotoData='';
  document.getElementById('clPhotoPreview').style.display='none';
  document.getElementById('clPhotoVideo').style.display='block';
  document.getElementById('clPhotoCaptureBtn').style.display='inline-block';
  document.getElementById('clPhotoRetakeBtn').style.display='none';
  document.getElementById('clPhotoSubmitBtn').style.display='none';
  document.getElementById('clPhotoStatus').textContent='对准自己或现场，点击下方按钮拍照';
}

async function submitClPhotoCheckin(){
  if(!clPhotoData){ toast('⚠️ 请先拍照'); return; }
  const courseId=document.getElementById('clCourse').value;
  if(!courseId){ toast('⚠️ 请先选择课程'); closeClPhotoCheckin(); return; }
  const btn=document.getElementById('clPhotoSubmitBtn');
  btn.disabled=true; btn.textContent='⏳ 提交中...';
  document.getElementById('clPhotoStatus').textContent='正在提交签到...';
  try{
    const headers={'Content-Type':'application/json'};
    if(myStudentToken) headers['x-student-token']=myStudentToken;
    const body={ student_id:myStudentId, course_id:courseId, date:todayStr(), class_name:myClassName, note:'拍照签到', photo:clPhotoData };
    if(locState.cl){ body.latitude=locState.cl.lat; body.longitude=locState.cl.lng; body.address=document.getElementById('clAddress').textContent; }
    const res=await fetch('/api/class-checkin',{method:'POST',headers,body:JSON.stringify(body)});
    const j=await res.json();
    if(j.code===0){
      toast('✅ 拍照签到成功！');
      closeClPhotoCheckin();
      loadMyClass();
    } else {
      document.getElementById('clPhotoStatus').textContent='❌ 签到失败：'+j.message;
    }
  }catch(e){
    document.getElementById('clPhotoStatus').textContent='❌ 提交失败：'+e.message;
  }
  btn.disabled=false; btn.textContent='✅ 确认签到';
}

// ===== 底部弹出确认框（替代原生 confirm）=====
let _bottomSheetResolve = null;

function showBottomSheet(title, body) {
  return new Promise((resolve) => {
    _bottomSheetResolve = resolve;
    document.getElementById('bottomSheetTitle').textContent = title;
    document.getElementById('bottomSheetBody').innerHTML = body;
    document.getElementById('bottomSheet').style.display = 'block';
  });
}

function confirmBottomSheet() {
  document.getElementById('bottomSheet').style.display = 'none';
  if (_bottomSheetResolve) _bottomSheetResolve(true);
  _bottomSheetResolve = null;
}

function closeBottomSheet() {
  document.getElementById('bottomSheet').style.display = 'none';
  if (_bottomSheetResolve) _bottomSheetResolve(false);
  _bottomSheetResolve = null;
}

// ===== 初始化 =====
document.getElementById('checkinDate').textContent = '📅 '+todayStr();

// ===== 夜间模式 =====
if(localStorage.getItem('dark_mode')==='1')document.body.classList.add('dark');

function toggleDark(){
  document.body.classList.toggle('dark');
  localStorage.setItem('dark_mode',document.body.classList.contains('dark')?'1':'0');
}

// 等待 DOM 加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  loadStudents();
  loadCourses();
  // 启动时会话校验：token 过期立即弹登录层（治"看似已登录实则失效，收不到查寝通知"）
  probeStudentSession();
});

// ===== 加载动画工具 =====
const loadingOverlay = document.createElement('div');
loadingOverlay.className = 'loading-overlay';
loadingOverlay.innerHTML = `
  <div class="spinner"></div>
  <div class="loading-text" id="loadingText">加载中...</div>
`;
document.body.appendChild(loadingOverlay);

function showLoading(text = '加载中...') {
  document.getElementById('loadingText').textContent = text;
  loadingOverlay.classList.add('active');
}

function hideLoading() {
  loadingOverlay.classList.remove('active');
}

// 自动隐藏加载动画（超时3秒）
let loadingTimer = null;
function showLoadingAuto(text = '加载中...', timeout = 3000) {
  showLoading(text);
  if (loadingTimer) clearTimeout(loadingTimer);
  loadingTimer = setTimeout(hideLoading, timeout);
}
