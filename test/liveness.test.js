// ==================== 活体检测路由测试 ====================
// 核心策略：mock 掉 @vladmandic/face-api 和 sharp，
// 专注验证路由端点的参数校验、错误处理和响应结构。

// Mock @vladmandic/face-api
jest.mock('@vladmandic/face-api/dist/face-api.node-wasm.js', () => {
  const mockDetectSingleFace = jest.fn();
  const mockTensor3d = jest.fn((data, shape) => ({ data, shape }));

  const mockFaceApi = {
    tf: {
      setBackend: jest.fn().mockResolvedValue(undefined),
      ready: jest.fn().mockResolvedValue(undefined),
      tensor3d: mockTensor3d
    },
    nets: {
      tinyFaceDetector: { loadFromDisk: jest.fn().mockResolvedValue(undefined) },
      faceLandmark68Net: { loadFromDisk: jest.fn().mockResolvedValue(undefined) }
    },
    detectSingleFace: mockDetectSingleFace,
    TinyFaceDetectorOptions: function(options) {
      this.inputSize = options.inputSize;
      this.scoreThreshold = options.scoreThreshold;
      this.withFaceLandmarks = function() { return this; };
    }
  };

  return mockFaceApi;
});

// Mock sharp — 支持两次调用（第 1 次 metadata，第 2 次 extract→...→toBuffer）
// 通过 mockImplementation 按调用顺序返回不同的链
jest.mock('sharp', () => {
  const mockSharp = jest.fn();
  return mockSharp;
});

const request = require('supertest');
const express = require('express');
const { init: initLivenessRoutes } = require('../routes/liveness');

// 测试辅助函数：为 EAR 计算设计的眼点数组
// EAR > 0.2（睁眼）：
// eye[0]={0,0}, eye[3]={2,0} → p1p4=2
// eye[1]={0,1}, eye[5]={2,1} → p2p6=2
// eye[2]={1,0}, eye[4]={1,0} → p3p5=0
// EAR = (2+0)/(2*2) = 0.5
const OPEN_EYE_POINTS = [
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 1, y: 0 },
  { x: 2, y: 1 }
];

// EAR ≤ 0.2（闭眼）：
// eye[0]={0,0}, eye[3]={0.1,0} → p1p4=0.1
// eye[1]={0,0}, eye[5]={0,0}   → p2p6=0
// eye[2]={0,0}, eye[4]={0,0}   → p3p5=0
// EAR = (0+0)/(2*0.1) = 0
const CLOSED_EYE_POINTS = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0.1, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 }
];

describe('Liveness API', () => {
  let faceApiMock;
  let sharpMock;

  /** 创建 detectSingleFace 的 mock 返回值（带 withFaceLandmarks） */
  function makeDetectionResult(result) {
    return {
      withFaceLandmarks: jest.fn().mockResolvedValue(result)
    };
  }

  beforeEach(() => {
    faceApiMock = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    sharpMock = require('sharp');
    jest.clearAllMocks();

    // 默认：face-api 模型加载成功
    faceApiMock.tf.setBackend.mockResolvedValue(undefined);
    faceApiMock.tf.ready.mockResolvedValue(undefined);
    faceApiMock.nets.tinyFaceDetector.loadFromDisk.mockResolvedValue(undefined);
    faceApiMock.nets.faceLandmark68Net.loadFromDisk.mockResolvedValue(undefined);
    faceApiMock.tf.tensor3d.mockImplementation((data, shape) => ({ data, shape }));

    // 默认：sharp 两次调用链
    // 第 1 次：metadata
    // 第 2 次：extract→resize→removeAlpha→raw→toBuffer
    let callCount = 0;
    sharpMock.mockImplementation((buf) => {
      callCount++;
      if (callCount === 1) {
        return {
          metadata: jest.fn().mockResolvedValue({ width: 500, height: 400 })
        };
      } else {
        return {
          extract: jest.fn().mockReturnThis(),
          resize: jest.fn().mockReturnThis(),
          removeAlpha: jest.fn().mockReturnThis(),
          raw: jest.fn().mockReturnThis(),
          toBuffer: jest.fn().mockResolvedValue({ data: new Uint8Array(416 * 416 * 3) })
        };
      }
    });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    const router = initLivenessRoutes({
      authMiddleware: (req, res, next) => {
        req.user = { userId: 'test_user', role: 'admin' };
        next();
      }
    });
    app.use(router);
    return app;
  }

  describe('POST /api/face/liveness', () => {
    test('缺少 imageBase64 时返回错误', async () => {
      const app = createApp();
      const res = await request(app).post('/api/face/liveness').send({});
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toBe('缺少图片数据');
    });

    test('imageBase64 为空字符串时返回错误', async () => {
      const app = createApp();
      const res = await request(app).post('/api/face/liveness').send({ imageBase64: '' });
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toBe('缺少图片数据');
    });

    test('模型加载失败时返回错误', async () => {
      faceApiMock.tf.setBackend.mockRejectedValue(new Error('wasm 初始化失败'));
      const app = createApp();
      const res = await request(app)
        .post('/api/face/liveness')
        .send({ imageBase64: 'iVBORw0KGgo=' });
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('wasm');
    });

    test('未检测到人脸时返回提示', async () => {
      faceApiMock.detectSingleFace.mockImplementation(() => ({
        withFaceLandmarks: jest.fn().mockReturnValue(null)
      }));
      const base64 = Buffer.from('fake-image-data').toString('base64');
      const app = createApp();
      const res = await request(app)
        .post('/api/face/liveness')
        .send({ imageBase64: base64 });
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toBe('未检测到人脸');
    });

    test('检测到人脸且 EAR > 0.2 时返回 liveness_score=1', async () => {
      faceApiMock.detectSingleFace.mockImplementation(() => ({
        withFaceLandmarks: jest.fn().mockReturnValue({
          landmarks: {
            getLeftEye: () => OPEN_EYE_POINTS,
            getRightEye: () => OPEN_EYE_POINTS
          }
        })
      }));
      const base64 = Buffer.from('test-face-data').toString('base64');
      const app = createApp();
      const res = await request(app)
        .post('/api/face/liveness')
        .send({ imageBase64: base64 });
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.liveness_score).toBe(1);
      expect(res.body.data.ear).toBeGreaterThan(0.2);
    });

    test('检测到人脸但 EAR ≤ 0.2 时返回 liveness_score=0', async () => {
      faceApiMock.detectSingleFace.mockImplementation(() => ({
        withFaceLandmarks: jest.fn().mockReturnValue({
          landmarks: {
            getLeftEye: () => CLOSED_EYE_POINTS,
            getRightEye: () => CLOSED_EYE_POINTS
          }
        })
      }));
      const base64 = Buffer.from('test-face-data').toString('base64');
      const app = createApp();
      const res = await request(app)
        .post('/api/face/liveness')
        .send({ imageBase64: base64 });
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.liveness_score).toBe(0);
    });

    test('sharp 处理图片失败时返回错误', async () => {
      // 覆盖默认 mockImplementation：让第 1 次 sharp 调用失败
      let callCount = 0;
      sharpMock.mockImplementation((buf) => {
        callCount++;
        if (callCount === 1) {
          return { metadata: jest.fn().mockRejectedValue(new Error('Invalid image data')) };
        } else {
          return {
            extract: jest.fn().mockReturnThis(),
            resize: jest.fn().mockReturnThis(),
            removeAlpha: jest.fn().mockReturnThis(),
            raw: jest.fn().mockReturnThis(),
            toBuffer: jest.fn()
          };
        }
      });
      const base64 = Buffer.from('corrupt-data').toString('base64');
      const app = createApp();
      const res = await request(app)
        .post('/api/face/liveness')
        .send({ imageBase64: base64 });
      expect(res.statusCode).toBe(200);
      expect(res.body.code).toBe(1);
      expect(res.body.message).toContain('Invalid image data');
    });
  });
});
