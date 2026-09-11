// ==================== 活体检测路由（已弃用） ====================
// 注意：/api/face/liveness 端点目前无前端调用，保留以备未来扩展
// 当前活体检测逻辑已集成到 routes/ai.js 中

const express = require('express');
const path = require('path');

/**
 * 初始化活体检测路由模块
 * @param {Object} opts - 依赖注入对象
 * @param {Function} opts.authMiddleware - 认证中间件
 * @returns {Express.Router}
 */
function init(opts) {
  const { authMiddleware } = opts || {};
  const router = express.Router();

  // POST /api/face/liveness - 活体检测接口（EAR计算）
  // 说明：原实现依赖 face-api.js(锁 tfjs 1.x，与项目 tfjs 4.22 冲突) + 未安装的 canvas 包，
  // 实际不可用。改用 @vladmandic/face-api (wasm 构建, 纯 JS) + sharp 解码，与 routes/ai.js 同源。
  let _faceReady = null;
  async function ensureLivenessFaceModels() {
    if (!_faceReady) {
      _faceReady = (async () => {
        const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
        await faceapi.tf.setBackend('wasm');
        await faceapi.tf.ready();
        const modelDir = path.join(__dirname, '..', 'models');
        await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
        return faceapi;
      })().catch(err => { _faceReady = null; throw err; });
    }
    return _faceReady;
  }

  router.post('/api/face/liveness', authMiddleware, async (req, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) return res.json({ code: 1, message: '缺少图片数据' });

      const faceapi = await ensureLivenessFaceModels();
      const sharp = require('sharp');

      // base64 → Buffer → sharp 解码为 416×416×3 张量（居中裁剪 + 去 alpha）
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      const meta = await sharp(imageBuffer).metadata();
      const side = Math.min(meta.width, meta.height);
      const { data } = await sharp(imageBuffer)
        .extract({ left: Math.floor((meta.width - side) / 2), top: Math.floor((meta.height - side) / 2), width: side, height: side })
        .resize(416, 416)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const image = faceapi.tf.tensor3d(data, [416, 416, 3]);

      // withFaceLandmarks() 默认用完整 68 关键点网络（models/ 中为 face_landmark_68_model）
      const detections = await faceapi.detectSingleFace(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 })).withFaceLandmarks();
      if (!detections) return res.json({ code: 1, message: '未检测到人脸' });

      const landmarks = detections.landmarks;
      const leftEye = landmarks.getLeftEye();
      const rightEye = landmarks.getRightEye();
      const ear = (calcEAR(leftEye) + calcEAR(rightEye)) / 2;
      const livenessScore = ear > 0.2 ? 1 : 0;

      res.json({ code: 0, data: { liveness_score: livenessScore, ear: parseFloat(ear.toFixed(4)) } });
    } catch (e) {
      console.error('活体检测错误:', e);
      res.json({ code: 1, message: e.message });
    }
  });

  return router;
}

/**
 * 计算 EAR（Eye Aspect Ratio）
 */
function calcEAR(eye) {
  const p2p6 = dist(eye[1], eye[5]);
  const p3p5 = dist(eye[2], eye[4]);
  const p1p4 = dist(eye[0], eye[3]);
  return (p2p6 + p3p5) / (2.0 * p1p4);
}

function dist(pA, pB) {
  return Math.hypot(pA.x - pB.x, pA.y - pB.y);
}

module.exports = { init };
