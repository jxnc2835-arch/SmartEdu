// ==================== AI 数据预测与人脸识别路由模块 ====================
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const PDFDocument = require('pdfkit');
require('dotenv').config();
const { beijingDateStr } = require('../utils/helpers');
const { buildStudentProfiles } = require('../utils/profile');
const { forecastSeries } = require('../utils/arima');
const { forecastSeriesLSTM } = require('../utils/lstm');
const { evaluateModels } = require('../utils/backtest');

/**
 * 初始化 AI 路由模块
 * @param {Object} opts - 依赖注入对象
 * @param {object} opts.db - sql.js Database 实例
 * @param {Function} opts.scheduleSave - 延迟保存函数
 * @param {object} opts.upload - multer 上传中间件
 * @param {object} opts.fs - Node.js fs 模块
 * @param {string} opts.ROOT_DIR - 项目根目录
 * @param {Function} opts.authMiddleware - 认证中间件
 * @param {Function} opts.nowTimestamp - 当前时间戳函数
 * @param {Function} opts.localDateStr - 本地日期字符串函数
 * @param {Function} opts.formatDate - 日期格式化函数
 * @param {Function} opts.addLog - 日志记录函数
 * @param {Function} opts.broadcast - WebSocket 广播函数
 * @param {Function} opts.validateToken - Token 验证函数
 * @param {Map} opts.STUDENT_TOKENS - 学生 Token 存储
 * @param {Function} opts.sendWebhook - Webhook 通知函数
 * @returns {Express.Router}
 */
function init(opts) {
  const { db, scheduleSave, upload, fs, path: _path, authMiddleware, nowTimestamp, localDateStr, formatDate, addLog, broadcast, validateToken, ROOT_DIR, STUDENT_TOKENS, sendWebhook } = opts;
  let faceapi;      // @vladmandic/face-api (wasm 构建, Node 纯 JS 无需 C++)
  let _sharp;       // sharp (图片解码 → RGBA → tfjs Tensor3D)
  let _faceModelsPromise = null;

  // 服务端人脸识别模型懒加载：
  // 原 face-api.js@0.20 锁 tfjs 1.x，与项目顶层 tfjs 4.22 版本冲突（引擎崩溃）。
  // 改用 @vladmandic/face-api (wasm 构建)：前端已验证同 API，Node 下用 tfjs-backend-wasm 纯 JS 推理，
  // 无需 @tensorflow/tfjs-node C++ 编译。图片解码复用已装的 sharp（居中裁剪 + 缩放 416×416 + RGB 3 通道）。
  async function ensureFaceModels() {
    if (!_faceModelsPromise) {
      _faceModelsPromise = (async () => {
        faceapi = faceapi || require('@vladmandic/face-api/dist/face-api.node-wasm.js');
        _sharp = _sharp || require('sharp');
        await faceapi.tf.setBackend('wasm');
        await faceapi.tf.ready();
        const modelDir = path.join(__dirname, '..', 'models');
        await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
        await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
        await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);
      })().catch(err => { _faceModelsPromise = null; throw err; });
    }
    return _faceModelsPromise;
  }

  // 将图片 Buffer 解码为 tfjs Tensor3D (416×416×3)：居中正方形裁剪 + 缩放 + 去 alpha
  async function decodeFaceTensor(imageBuffer) {
    const meta = await _sharp(imageBuffer).metadata();
    const side = Math.min(meta.width, meta.height);
    const { data } = await _sharp(imageBuffer)
      .extract({ left: Math.floor((meta.width - side) / 2), top: Math.floor((meta.height - side) / 2), width: side, height: side })
      .resize(416, 416)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return faceapi.tf.tensor3d(data, [416, 416, 3]);
  }

  const router = express.Router();

  // ==================== AI 数据预测 API ====================

  /**
   * 服务端结果缓存：AI 预测/回测计算开销大，按 (dim, today, params) 缓存，TTL 5 分钟
   */
  const aiCache = new Map();
  const AI_CACHE_TTL_MS = 5 * 60 * 1000;
  
  /**
   * 生成缓存键
   * @param {string} prefix - 前缀
   * @param {...string} parts - 键部分
   * @returns {string} 缓存键
   */
  function getCacheKey(prefix, ...parts) { return prefix + ':' + parts.join(':'); }
  
  /**
   * 获取缓存数据
   * @param {string} key - 缓存键
   * @returns {any|null} 缓存数据或 null
   */
  function getCached(key) {
    const entry = aiCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > AI_CACHE_TTL_MS) { aiCache.delete(key); return null; }
    return entry.data;
  }
  
  /**
   * 设置缓存数据
   * @param {string} key - 缓存键
   * @param {any} data - 缓存数据
   */
  function setCached(key, data) { aiCache.set(key, { ts: Date.now(), data }); }

  // 维度配置：寝室(在寝率) / 课堂(出勤率)。type、present 取自白名单，可安全拼入 SQL。
  const DIM_CONFIG = {
    checkin: { type: 'checkin', present: '在寝', label: '寝室在寝率' },
    class:   { type: 'class',   present: '出勤', label: '课堂出勤率' }
  };

  // 班级名称缓存与简称解析（如"测绘1班" → "测绘2301"）
  let CLASS_NAMES = [];
  function loadClassNames() {
    try {
      const r = db.exec("SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name!='' ORDER BY class_name")[0];
      CLASS_NAMES = r ? r.values.map(v => v[0]) : [];
    } catch (e) { CLASS_NAMES = []; }
  }
  loadClassNames();

  const CN_NUM = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };
  function resolveClassName(raw) {
    if (!raw) return '';
    const trimmed = raw.trim();
    // 已经是完整班级名
    if (CLASS_NAMES.includes(trimmed)) return trimmed;
    // 尝试匹配专业简称+班号，例如 "测绘1" / "测绘一班"
    const m = trimmed.match(/^([\u4e00-\u9fa5]+?)([一二三四五六七八九十\d]{1,2})$/);
    if (m) {
      const major = m[1];
      const num = CN_NUM[m[2]] || m[2];
      const candidates = CLASS_NAMES.filter(c => c.startsWith(major) && c.includes(num));
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        // 多个候选（如测绘2301/测绘2302 都符合"测绘2"），再按数字精确匹配
        const exact = candidates.find(c => new RegExp(major + '\\d*' + num + '($|[^0-9])').test(c));
        if (exact) return exact;
        return candidates[0];
      }
    }
    // 兜底：用 raw 做 LIKE 匹配（如用户输入"测绘"）
    const likeCandidates = CLASS_NAMES.filter(c => c.includes(trimmed));
    return likeCandidates.length === 1 ? likeCandidates[0] : (likeCandidates[0] || trimmed);
  }


  // GET /api/predict/checkin-trend — 预测未来N天签到率趋势（支持 dim=checkin|class，支持班级过滤）
  router.get('/api/predict/checkin-trend', authMiddleware, (req, res) => {
    try {
      const { days = 7, model = 'arima', dim = 'checkin' } = req.query;
      const numDays = parseInt(days) || 7;
      const dimKey = DIM_CONFIG[dim] ? dim : 'checkin';
      const cfg = DIM_CONFIG[dimKey];
      const className = (req.query.class_name || '').trim();
      const today = localDateStr();

      // 服务端缓存：相同维度/日期/模型/步长/班级直接命中，避免重复训练
      const cacheKey = getCacheKey('trend', dimKey, today, model, numDays, className || '*');
      const cached = getCached(cacheKey);
      if (cached) { return res.json(cached); }

      // “今天”经 clampedToday 锚定（时钟越界时回退到数据冻结日），起点 = 今天 - 29 天；避免“今天”误标为真实时钟日
      const [hy, hm, hd] = today.split('-').map(Number);
      const startD = new Date(hy, hm - 1, hd);
      startD.setDate(startD.getDate() - 30 + 1);
      const startDate = `${startD.getFullYear()}-${String(startD.getMonth()+1).padStart(2,'0')}-${String(startD.getDate()).padStart(2,'0')}`;

      // 注意：records.time 仅存时刻(如 '08:00')，真实日期在 date 列，故按 date 分组与过滤
      const classJoin = className ? ' INNER JOIN students s ON r.student_id = s.student_id' : '';
      const classCond = className ? ' AND s.class_name = ?' : '';
      const dailyData = db.exec(
        `SELECT r.date,
          COUNT(CASE WHEN r.status='${cfg.present}' THEN 1 END) as checked_in,
          COUNT(*) as total
        FROM records r${classJoin}
        WHERE r.type='${cfg.type}' AND r.date >= ? AND r.date <= ?${classCond}
        GROUP BY r.date ORDER BY r.date`,
        className ? [startDate, today, className] : [startDate, today]
      )[0]?.values || [];

      if (dailyData.length < 7) {
        return res.json({ code: 0, data: { message: '数据不足，需要至少7天的历史记录', actual_days: dailyData.length } });
      }

      const rates = dailyData.map(r => {
        const total = r[2];
        const checkedIn = r[1];
        return total > 0 ? (checkedIn / total) * 100 : 0;
      });

      const useLSTM = String(model).toLowerCase() === 'lstm';
      // LSTM 训练较耗时，预测场景降低 epochs 以换取响应速度
      const fc = useLSTM
        ? forecastSeriesLSTM(rates, { steps: numDays, lookBack: 7, hiddenSize: 12, epochs: 50, mcSamples: 20, seed: 12345 })
        : forecastSeries(rates, { steps: numDays, maxP: 3, maxD: 2, maxQ: 3 });

      const predictions = [];
      for (let i = 0; i < numDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i + 1);
        const v = fc.forecast[i];
        predictions.push({
          date: beijingDateStr(new Date(d)),
          predicted_rate: Math.max(0, Math.min(100, v)),
          lower: Math.max(0, Math.min(100, fc.lower[i])),
          upper: Math.max(0, Math.min(100, fc.upper[i])),
          confidence: Number(((fc.upper[i] - fc.lower[i]) > 0 ? Math.max(0.3, 1 - i * 0.08) : 0.9).toFixed(2))
        });
      }

      const history = dailyData.map((r, i) => ({
        date: r[0], rate: rates[i], checked_in: r[1], total: r[2]
      }));

      const trend_direction = fc.forecast[numDays - 1] > rates[rates.length - 1] ? '上升' : (fc.forecast[numDays - 1] < rates[rates.length - 1] ? '下降' : '平稳');
      const result = {
        code: 0,
        data: {
          history, predictions,
          trend_direction,
          dim: dimKey,
          dim_label: cfg.label,
          class_name: className || '全部',
          average_rate: rates.reduce((a, b) => a + b, 0) / rates.length,
          model: fc.model || fc.method,
          order: fc.order || null,
          aic: fc.aic != null ? Number(fc.aic.toFixed(2)) : null,
          look_back: fc.look_back,
          hidden_size: fc.hidden_size,
          epochs: fc.epochs,
          final_loss: fc.final_loss,
          mc_samples: fc.mc_samples
        }
      };
      setCached(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('签到率预测失败:', err);
      res.json({ code: 1, message: err.message });
    }
  });

  // GET /api/predict/at-risk — 学生行为画像 / 风险学生预测
  router.get('/api/predict/at-risk', authMiddleware, (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const limit = parseInt(req.query.limit) || 20;
      const { profiles, summary } = buildStudentProfiles(db, { days });

      const atRisk = profiles
        .filter(p => p.risk_score > 0)
        .sort((a, b) => b.risk_score - a.risk_score)
        .slice(0, limit)
        .map(p => ({
          id: p.id,
          student_id: p.student_id,
          name: p.name,
          class_name: p.class_name,
          absent_count: p.absent_count,
          late_count: p.late_count,
          leave_count: p.leave_count,
          max_consecutive_absent: p.max_consecutive_absent,
          risk_score: p.risk_score,
          risk_level: p.risk_level,
          trend: p.trend,
          factors: p.factors,
          recent_dates: p.recent_dates
        }));

      res.json({ code: 0, data: { at_risk: atRisk, summary } });
    } catch (err) {
      console.error('风险学生预测失败:', err);
      res.json({ code: 1, message: err.message });
    }
  });

  // GET /api/predict/leave-trend — 请假趋势预测
  router.get('/api/predict/leave-trend', authMiddleware, (req, res) => {
    try {
      const { model = 'arima' } = req.query;
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const monthlyLeave = db.exec(
        `SELECT strftime('%Y-%m', start_date) as month, COUNT(*) as count FROM leaves WHERE status IN ('approved','已批准') AND start_date >= ? GROUP BY strftime('%Y-%m', start_date) ORDER BY month`,
        [beijingDateStr(new Date(sixMonthsAgo))]
      )[0]?.values || [];

      const counts = monthlyLeave.map(r => r[1]);
      let forecast = null;
      let mdl = null, order = null, aic = null, meta = {};
      const useLSTM = String(model).toLowerCase() === 'lstm';
      if (useLSTM && counts.length >= 4) {
        const fc = forecastSeriesLSTM(counts, { steps: 3, hiddenSize: 16, epochs: 150, mcSamples: 30, seed: 12345 });
        const now = new Date();
        forecast = Array.from({ length: 3 }, (_, i) => {
          const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
          return {
            date: d.toISOString().slice(0, 7),
            predicted_count: Math.max(0, Math.round(fc.forecast[i])),
            lower: Math.max(0, Math.round(fc.lower[i])),
            upper: Math.max(0, Math.round(fc.upper[i])),
            confidence: Number(((fc.upper[i] - fc.lower[i]) > 0 ? Math.max(0.4, 0.8 - i * 0.12) : 0.9).toFixed(2))
          };
        });
        mdl = fc.model; order = fc.order; meta = { look_back: fc.look_back, hidden_size: fc.hidden_size, epochs: fc.epochs, final_loss: fc.final_loss, mc_samples: fc.mc_samples };
      } else if (!useLSTM && counts.length >= 2) {
        const fc = forecastSeries(counts, { steps: 3, maxP: 3, maxD: 2, maxQ: 3 });
        const now = new Date();
        forecast = Array.from({ length: 3 }, (_, i) => {
          const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
          return {
            date: d.toISOString().slice(0, 7),
            predicted_count: Math.max(0, Math.round(fc.forecast[i])),
            lower: Math.max(0, Math.round(fc.lower[i])),
            upper: Math.max(0, Math.round(fc.upper[i])),
            confidence: Number(((fc.upper[i] - fc.lower[i]) > 0 ? Math.max(0.4, 0.8 - i * 0.12) : 0.9).toFixed(2))
          };
        });
        mdl = fc.method; order = fc.order; aic = fc.aic != null ? Number(fc.aic.toFixed(2)) : null;
      }

      res.json({
        code: 0,
        data: {
          history: monthlyLeave.map(r => ({ month: r[0], total: r[1] })),
          forecast,
          model: mdl, order, aic, ...meta,
          trend: counts.length > 0 ? (counts[counts.length-1] > counts[0] ? '上升' : '下降') : '暂无数据'
        }
      });
    } catch (err) {
      console.error('请假趋势预测失败:', err);
      res.json({ code: 1, message: err.message });
    }
  });

  // GET /api/predict/evaluate — 预测模型精度回测（ARIMA vs LSTM），支持 dim=checkin|class 与班级过滤
  router.get('/api/predict/evaluate', authMiddleware, (req, res) => {
    try {
      const includeLSTM = String(req.query.lstm || '1') !== '0';
      const lookbackDays = parseInt(req.query.days) || 30;
      const dim = DIM_CONFIG[req.query.dim] ? req.query.dim : 'checkin';
      const cfg = DIM_CONFIG[dim];
      const className = (req.query.class_name || '').trim();
      const today = localDateStr();

      // 服务端缓存：同维度、同日期、同窗口、同模型组合、同班级直接复用
      const cacheKey = getCacheKey('evaluate', dim, today, lookbackDays, includeLSTM ? 1 : 0, className || '*');
      const cached = getCached(cacheKey);
      if (cached) { return res.json(cached); }

      // “今天”经 clampedToday 锚定；起点 = 今天 - (lookbackDays-1) 天；与全站“今天”口径一致
      const [hy, hm, hd] = today.split('-').map(Number);
      const startD = new Date(hy, hm - 1, hd);
      startD.setDate(startD.getDate() - lookbackDays + 1);
      const startDate = `${startD.getFullYear()}-${String(startD.getMonth()+1).padStart(2,'0')}-${String(startD.getDate()).padStart(2,'0')}`;

      // 按 date 列分组/过滤（records.time 仅存时刻，真实日期在 date 列）
      const classJoin = className ? ' INNER JOIN students s ON r.student_id = s.student_id' : '';
      const classCond = className ? ' AND s.class_name = ?' : '';
      const dailyData = db.exec(
        `SELECT r.date,
          COUNT(CASE WHEN r.status='${cfg.present}' THEN 1 END) as checked_in,
          COUNT(*) as total
        FROM records r${classJoin}
        WHERE r.type='${cfg.type}' AND r.date >= ? AND r.date <= ?${classCond}
        GROUP BY r.date ORDER BY r.date`,
        className ? [startDate, today, className] : [startDate, today]
      )[0]?.values || [];

      if (dailyData.length < 9) {
        return res.json({ code: 0, data: { message: '数据不足，模型回测至少需要 9 天历史记录', actual_days: dailyData.length, results: [] } });
      }

      const rates = dailyData.map(r => (r[2] > 0 ? (r[1] / r[2]) * 100 : 0));

      // 回测中 LSTM 每步都要重训，降低 epochs 与测试点数量以控制响应时间
      const evalResult = evaluateModels(rates, { minTrain: 7, maxTests: Math.min(7, rates.length - 7), epochs: 30, includeLSTM });

      const result = {
        code: 0,
        data: {
          dim,
          dim_label: cfg.label,
          class_name: className || '全部',
          metric_desc: {
            rmse: '均方根误差（越小越好，单位%）',
            mae: '平均绝对误差（越小越好，单位%）',
            mape: '平均绝对百分比误差（越小更好，%）'
          },
          ...evalResult
        }
      };
      setCached(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('模型精度回测失败:', err);
      res.json({ code: 1, message: err.message });
    }
  });

  // ==================== 人脸识别 API ====================

  // GET /api/face/students — 学生人脸注册状态列表
  router.get('/api/face/students', authMiddleware, (req, res) => {
    try {
      const students = db.exec("SELECT id, name, class_name, face_hash FROM students ORDER BY class_name, name")[0]?.values || [];
      res.json({ code: 0, data: students.map(r => ({ id: r[0], name: r[1], class_name: r[2], has_face: !!(r[3] && r[3].trim().length > 0) })) });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // POST /api/face/register — 为学生注册/更新人脸特征
  router.post('/api/face/register', upload.single('photo'), async (req, res) => {
    try {
      const { student_id } = req.body;
      if (!student_id) return res.json({ code: 1, message: '请提供学生ID' });

      const studentResult = db.exec("SELECT student_id, name, class_name, face_hash FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0];
      if (!studentResult || studentResult.values.length === 0) return res.json({ code: 1, message: '学生不存在' });
      const student = studentResult.values[0];

      if (!req.file) return res.json({ code: 1, message: '请上传人脸照片' });

      let faceHash = null;
      try {
        await ensureFaceModels(); // 服务端模型懒加载（wasm 后端 + 检测+关键点+128维描述子），失败则抛出
        // 读取上传的图片文件并解码为 416×416×3 张量
        const imageBuffer = fs.readFileSync(req.file.path);
        const image = await decodeFaceTensor(imageBuffer);
        const detection = await faceapi.detectSingleFace(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptor();
        
        if (!detection) {
          return res.json({ code: 1, message: '未检测到人脸，请确保照片清晰且包含完整人脸' });
        }
        
        // 提取128维特征向量并转为数组存储
        const descriptor = detection.descriptor; // Float32Array of length 128
        faceHash = Array.from(descriptor);
        
        // 验证特征向量维度
        if (!faceHash || faceHash.length !== 128) {
          console.error('人脸特征维度异常:', faceHash?.length, '应为128');
          return res.json({ code: 1, message: '人脸特征提取异常，请重新上传照片' });
        }
        
      } catch (faceErr) {
        console.error('人脸特征提取失败:', faceErr.message);
        return res.json({ code: 1, message: '人脸特征提取失败: ' + faceErr.message });
      }

      if (!faceHash) {
        return res.json({ code: 1, message: '人脸特征提取失败' });
      }

      db.run("UPDATE students SET face_hash=? WHERE student_id=? OR id=?", [JSON.stringify(faceHash), student_id, student_id]);
      scheduleSave();
      res.json({ code: 0, message: '人脸注册成功', data: { student_name: student[1], class_name: student[2], features_extracted: true } });
    } catch (err) {
      console.error('人脸注册失败:', err);
      res.json({ code: 1, message: err.message });
    }
  });

  // POST /api/face/compare — 人脸比对验证
  router.post('/api/face/compare', authMiddleware, (req, res) => {
    try {
      const { student_id, face_hash, liveness_score } = req.body;
      if (!student_id || !face_hash) return res.json({ code: 1, message: '缺少必要参数' });

      const studentResult = db.exec("SELECT student_id, name, class_name, face_hash FROM students WHERE student_id=? OR id=?", [student_id, student_id])[0];
      if (!studentResult || studentResult.values.length === 0) return res.json({ code: 1, message: '学生不存在' });
      const student = studentResult.values[0];
      const registeredHash = student[3];

      if (!registeredHash || registeredHash.trim().length === 0) return res.json({ code: 1, message: '该学生尚未注册人脸' });

      let registeredArr, submittedArr;
      try {
        registeredArr = JSON.parse(registeredHash);
        submittedArr = JSON.parse(face_hash);
      } catch (e) {
        return res.json({ code: 1, message: '人脸特征数据格式错误' });
      }

      if (registeredArr.length !== submittedArr.length || registeredArr.length === 0) return res.json({ code: 1, message: '人脸特征维度不匹配' });

      let dotProduct = 0, magA = 0, magB = 0;
      for (let i = 0; i < registeredArr.length; i++) {
        dotProduct += registeredArr[i] * submittedArr[i];
        magA += registeredArr[i] * registeredArr[i];
        magB += submittedArr[i] * submittedArr[i];
      }
      magA = Math.sqrt(magA);
      magB = Math.sqrt(magB);
      if (magA === 0 || magB === 0) return res.json({ code: 1, message: '人脸特征向量为空' });

      const similarity = dotProduct / (magA * magB);
      const FACE_THRESHOLD = 0.65;
      // 活体阈值（默认 0.8），若未提供则视为通过
      const LIVENESS_THRESHOLD = 0.8;
      const livenessOk = (typeof liveness_score === 'number') ? liveness_score >= LIVENESS_THRESHOLD : true;

      const matched = similarity >= FACE_THRESHOLD && livenessOk;
      const message = matched ? '人脸匹配成功' : (similarity < FACE_THRESHOLD ? '人脸匹配失败' : '活体检测未通过');
      res.json({
        code: 0,
        message,
        data: {
          similarity: parseFloat(similarity.toFixed(4)),
          matched,
          face_threshold: FACE_THRESHOLD,
          liveness_score: typeof liveness_score === 'number' ? parseFloat(liveness_score.toFixed(4)) : null,
          liveness_threshold: LIVENESS_THRESHOLD,
          student_name: student[1],
          class_name: student[2]
        }
      });
    } catch (err) {
      console.error('人脸比对失败:', err);
      res.json({ code: 1, message: err.message });
    }
  });

  // ==================== AI 智能问答引擎（已拆分至 ai-chat.js）====================
  const { initChatSubRouter } = require('./ai-chat');
  const chatRouter = initChatSubRouter({ db, fs, ROOT_DIR, authMiddleware, localDateStr, addLog, broadcast, STUDENT_TOKENS, sendWebhook, scheduleSave });
  router.use(chatRouter);


  return router;
}

module.exports = { init };