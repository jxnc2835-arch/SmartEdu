// ==================== 活体检测路由（已弃用） ====================
// 注意：/api/face/liveness 端点目前无前端调用，保留以备未来扩展
// 当前活体检测逻辑已集成到 routes/ai.js 中

const express = require('express');

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
  router.post('/api/face/liveness', authMiddleware, async (req, res) => {
    try {
      const { imageBase64 } = req.body;
      if (!imageBase64) return res.json({ code: 1, message: '缺少图片数据' });

      const faceapi = require('face-api.js');
      const { Canvas, Image } = require('canvas');
      const canvas = new Canvas();
      const img = new Image();
      img.src = Buffer.from(imageBase64, 'base64');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      await faceapi.nets.tinyFaceDetector.loadFromDisk('./models');
      await faceapi.nets.faceLandmark68TinyNet.loadFromDisk('./models');

      const detections = await faceapi.detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks(true);
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
