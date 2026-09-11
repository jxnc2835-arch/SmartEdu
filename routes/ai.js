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
  let COURSE_NAMES = [];
  function loadClassNames() {
    try {
      const r = db.exec("SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name!='' ORDER BY class_name")[0];
      CLASS_NAMES = r ? r.values.map(v => v[0]) : [];
    } catch (e) { CLASS_NAMES = []; }
  }
  loadClassNames();
  loadCourseNames();

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

  // ==========================================================================
  // ====================  AI 智能问答引擎（v2 — 重构版）======================
  // ==========================================================================

  // ==================== 会话记忆（内存存储 + 文件持久化，重启不丢） ====================
  const sessionMemory = new Map();
  const MAX_SESSION_TURNS = 10;
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'ai_sessions.json');

  // 启动时从文件恢复会话（跳过过期）
  function loadSessions() {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (obj && typeof obj === 'object') {
        const now = Date.now();
        for (const [sid, sess] of Object.entries(obj)) {
          const hist = sess.messages || [];
          if (hist.length > 0 && now - (hist[hist.length - 1].ts || 0) > SESSION_TTL_MS) continue;
          sessionMemory.set(sid, sess);
        }
        // console.log(`[AI Sessions] 已恢复 ${sessionMemory.size} 个历史会话`); // DEBUG: disabled in production
      }
    } catch (e) {
      console.error('[AI Sessions] 加载失败（忽略，使用空会话）:', e.message);
    }
  }

  // 内存会话落盘（过滤过期，序列化失败则忽略该条）
  function persistSessions() {
    try {
      const now = Date.now();
      const obj = {};
      for (const [sid, sess] of sessionMemory.entries()) {
        const hist = sess.messages || [];
        if (hist.length > 0 && now - (hist[hist.length - 1].ts || 0) > SESSION_TTL_MS) continue;
        try { JSON.stringify(sess); obj[sid] = sess; }
        catch (_) { /* 跳过不可序列化会话 */ }
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) {
      console.error('[AI Sessions] 持久化失败（忽略）:', e.message);
    }
  }

  function getSessionHistory(sessionId) {
    if (!sessionMemory.has(sessionId)) sessionMemory.set(sessionId, { messages: [], lastIntent: null, lastClassFilter: '', lastQuestion: '', lastData: null });
    return sessionMemory.get(sessionId);
  }
  function addMessage(sessionId, role, content) {
    const sess = getSessionHistory(sessionId);
    sess.messages.push({ role, content, ts: Date.now() });
    if (sess.messages.length > MAX_SESSION_TURNS * 2) sess.messages.splice(0, sess.messages.length - MAX_SESSION_TURNS * 2);
  }
  function updateSessionContext(sessionId, updates) {
    const sess = getSessionHistory(sessionId);
    Object.assign(sess, updates);
  }

  // 启动时恢复
  loadSessions();

  // 定期清理过期会话并落盘
  setInterval(() => {
    const now = Date.now();
    for (const [sid, sess] of sessionMemory.entries()) {
      const hist = sess.messages || [];
      if (hist.length > 0 && now - (hist[hist.length - 1].ts || 0) > SESSION_TTL_MS) sessionMemory.delete(sid);
    }
    persistSessions();
  }, 5 * 60 * 1000);

  // 每分钟兜底落盘，确保异常退出也能保留
  setInterval(() => { persistSessions(); }, 60 * 1000);

  // ==================== 动态数据查询引擎 ====================

  /** 获取有效的"今天"日期（无数据则回退到最近有数据的日期） */
  function getEffectiveToday() {
    // 业务“今天”：取最近一个【签到数据完整】的日期，而非 wall-clock 当天。
    // 原因：当天往往只有零星请假记录（尚未批量打卡），若直接以当天为准，
    // 会把“数据未生成”误判为“全员缺勤”，导致班级对比全 0、今日未归名单虚高。
    const studentCount = db.exec("SELECT COUNT(*) FROM students WHERE class_name IS NOT NULL AND class_name!=''")[0]?.values?.[0]?.[0] || 0;
    const threshold = Math.max(20, Math.floor(studentCount * 0.5)); // 至少半数学员有记录才算“完整日”
    const today = localDateStr();
    const todayCount = db.exec("SELECT COUNT(*) FROM records WHERE type='checkin' AND date=?", [today])[0]?.values?.[0]?.[0] || 0;
    if (todayCount >= threshold) return today; // 当天数据确实完整，就用当天
    // 否则回退到最近一个数据完整的日期
    const latest = db.exec("SELECT date FROM records WHERE type='checkin' GROUP BY date HAVING COUNT(*) >= ? ORDER BY date DESC LIMIT 1", [threshold])[0]?.values?.[0]?.[0];
    return latest || today;
  }

  // ==================== 日期与相对日期解析 ====================
  function parseDateStr(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
  function fmtDate(d) { const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const da = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${da}`; }
  function shiftDate(s, delta) { const d = parseDateStr(s); d.setDate(d.getDate() + delta); return fmtDate(d); }
  function dateDiffDays(a, b) { return Math.round((parseDateStr(b) - parseDateStr(a)) / 86400000) + 1; }
  function weekRange(s) {
    const d = parseDateStr(s); const dow = d.getDay(); const diff = (dow + 6) % 7;
    const mon = new Date(d); mon.setDate(d.getDate() - diff);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: fmtDate(mon), end: fmtDate(sun) };
  }
  // 解析自然语言中的相对日期/周期，返回 {kind, date?, days?, start?, end?}
  function resolveDateRef(q) {
    const eff = getEffectiveToday();
    const rn = /最近\s*(\d+)\s*天|近\s*(\d+)\s*天|(\d+)\s*天[内里]|过去\s*(\d+)\s*天/.exec(q);
    if (rn) { const n = parseInt(rn[1] || rn[2] || rn[3] || rn[4]); if (n > 0 && n <= 120) return { kind: 'recentN', days: n }; }
    if (/(大前天|大大前天)/.test(q)) return { kind: 'day', date: shiftDate(eff, -3) };
    if (/(前天|前一日)/.test(q)) return { kind: 'day', date: shiftDate(eff, -2) };
    if (/(昨天|昨日|前一天)/.test(q)) return { kind: 'day', date: shiftDate(eff, -1) };
    if (/(本周|这周|这一周|这星期|这周)/.test(q)) { const w = weekRange(eff); return { kind: 'week', start: w.start, end: w.end }; }
    if (/(上周|上一周|上个星期)/.test(q)) { const w = weekRange(shiftDate(eff, -7)); return { kind: 'week', start: w.start, end: w.end }; }
    if (/(本月|这个月|这月|近一个月|最近一个月|过去一个月|近一月|最近一月|过去一月)/.test(q)) { const d = parseDateStr(eff); return { kind: 'month', start: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, end: eff }; }
    return { kind: 'today', date: eff };
  }
  function dateRefDate(ir) { const d = ir && ir.dateRef; if (d && d.date) return d.date; return getEffectiveToday(); }
  function dateRefEnd(ir) { const d = ir && ir.dateRef; if (d && d.date) return d.date; return getEffectiveToday(); }
  function dateRefDays(ir) { const d = ir && ir.dateRef; if (d && d.kind === 'recentN' && d.days) return d.days; return 30; }
  function dateRefRange(ir) { const d = ir && ir.dateRef; if (!d) return null; if ((d.kind === 'week' || d.kind === 'month') && d.start && d.end) return { start: d.start, end: d.end }; if (d.kind === 'recentN' && d.days) { const end = getEffectiveToday(); const start = shiftDate(end, -(d.days - 1)); return { start, end }; } return null; }

  // 从数据对象中收集所有真实实体（姓名/班级/宿舍），用于回答落地校验
  function collectAllowed(obj) {
    const names = new Set(), classes = new Set(), dorms = new Set();
    const walk = (o) => {
      if (o == null || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      for (const k in o) {
        const v = o[k];
        if (k === 'name' || k === 'student_name') { if (v) names.add(String(v)); }
        else if (k === 'class_name') { if (v) classes.add(String(v)); }
        else if (k === 'dorm') { if (v) dorms.add(String(v)); }
        else if (typeof v === 'object') walk(v);
      }
    };
    walk(obj);
    const prefixes = new Set();
    classes.forEach(c => { const p = c.replace(/\d.*$/, ''); if (p) prefixes.add(p); });
    return { names: [...names], classes: [...classes], dorms: [...dorms], prefixes: [...prefixes] };
  }

  // 常见非人名的词/短语白名单（防止把正常叙述误判为编造）。
  // 覆盖：代词、时间、考勤术语、数据分析词、质量形容词、常用动词、连词副词、名词等。
  const SAFE_WORDS = ['同学','老师','学生','今日','今天','昨日','昨天','前天','大前天','本周','上周','本月','上月','今年','去年','现在','目前','当前','刚刚','刚才','之前','之后','最近','近期','过去','未来','将来','早晨','上午','下午','晚上','凌晨','半夜','周末','工作日','签到','未归','缺席','不在','晚归','在寝','请假','病假','事假','公假','丧假','宿舍','寝室','班级','学校','学院','辅导','辅导员','家长','电话','安全','确认','联系','名单','数据','分析','记录','处理','异常','趋势','风险','高危','缺勤','课堂','到课','考勤','上课','销号','闭环','整体','全局','概览','统计','排名','对比','比较','预测','历史','未来','走向','曲线','变化','建议','情况','智能','汇报','总结','月报','简报','系统','问题','关注','重点','突出','明显','集中','普遍','特殊','个别','局部','总体','全面','部分','多数','少数','全部','全员','全体','整队','现象','源头','及时','尽快','务必','推荐','提示','说明','诚实','缺失','没有','暂无','无','有','正常','优秀','良好','较好','较差','较低','较高','平稳','稳定','上升','下降','增加','减少','增长','降低','改善','恶化','好转','显著','基本','大致','大概','大约','接近','几乎','完全','彻底','充分','不足','不够','有待','略','微','需要','应该','应当','必须','可以','能够','希望','期待','留意','重视','加强','改进','提升','提高','控制','落实','执行','完成','推进','开展','组织','安排','部署','配合','协调','沟通','反馈','跟踪','跟进','记录','归档','整理','评估','研判','预警','处置','解决','回应','答复','解答','解释','询问','了解','掌握','排查','走访','约谈','谈话','生成','展示','查看','点击','下载','值得','来看','表现','不错','略有','相比','相比之下','总体而言','据了解','经统计','从数据看','需要说明的是','值得注意的是','综上所述','一般情况下','波动不大','值得关注','重点关注','及时处置','闭环管理','通过','根据','结合','针对','对于','关于','方面','层面','角度','维度','视角','因此','所以','但是','不过','然而','另外','此外','同时','首先','其次','然后','最后','总之','一般','通常','往往','偶尔','尤其','特别','比如','例如','如下','具体','详细','简要','如果','由于','因为','虽然','尽管','即使','只要','只有','无论','还是','以及','并且','而且','从而','进而','随之','存在','显示','表明','反映','涉及','包括','出现','发生','层面','这位','那位','各位','咱们','他们','我们','你们','这','那','哪','谁','什么','怎么','如何','为什么','多少','几个','哪些','所有','全体','全部','总览','概况','未到','没回','回来','到位','辛苦','保持','继续','加油','注意','提醒','查一下','帮我查','继续问','接着问','追问','谢谢','感谢','麻烦','学工小智','小智','人工智能','助手','机器人','智能体','模型','大模型','语言','自然','交互','能力','功能','帮助','介绍','能做','在哪','哪里','几点','时间','日期','星期','姓名','学号','课程','作业','考试','成绩','学业','健康','体温','出行','回家','在校','离校','入校','查询','搜索','查找','原因','如何','怎么','哪里','几点','地理','遥感','测绘','信息','工程','科学','技术','大学','教授','讲师','助教','打卡','门禁','学习态度','工作态度','生活习惯','心理状态','家庭情况','经济状况','沟通方式','管理方式','重点关注','及时跟进','保持联系','家校','舍友','室友','同班','班委','班干','班干部','学工办','班主任','面对面','一对一','常态化','总体情况','具体情况','实际情况','签到情况','出勤情况','未归情况','请假情况','缺勤情况','异常情况','风险情况','告警情况','统计结果','分析结果','对比结果','历史数据','实时数据','当前数据','最新数据','本周数据','本月数据','近期数据','近七天','近7天','近三十天','近30天','下一步','后续','定期','一站式','全覆盖','零报告','日报告','周通报','月总结','数据看板','看板','台账','销号','闭环','家访','电访','谈心','谈话记录','预警名单','红色预警','橙色预警','黄色预警'];

  // 中文姓氏集合（用于识别"疑似编造的人名"：以姓氏开头且不含非姓名用字）
  const SURNAME_SET = '王李张刘陈杨黄赵周吴徐孙朱马胡郭林何高梁郑罗宋谢唐韩曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢傅钟姜崔谭廖范汪陆金石戴贾韦夏邱方侯邹熊孟秦白江阎薛尹段雷黎史龙陶贺顾毛郝龚邵万钱严覃武戚莫孔尹康尚卓舒柯乔丛边辜项池滕晋苑邝栗廉匡柴蒙盖单柏宁刁甘巫居包童仇燕冀娄窦章云辛耿关屈阮臧邢牟商柏涂卓';
  // 非姓名用字（出现在姓名里概率极低，用于排除"张老师""姓李的"等叙述片段）
  const NON_NAME_CHARS = '的了是未在有们也都我很真不就多少数大好坏师生同老家长电话安全联系记录数据情况分析建议报告总结趋势异常风险原因改进提升降低增减保持稳定波动明显突出集中普遍特殊个别局部整体全面部分全员辛苦加油注意提醒排查走访约谈谈话了解生成展示查看点击下载需要应该必须可以能够希望期待留意重视加强落实执行完成推进开展组织安排部署配合协调沟通反馈跟踪跟进归档整理评估研判处置解决回应答复解答解释询问掌握着啊呢吧吗呀哦嗯姓之而叫位位名';

  // 校验 LLM 回答是否基于系统数据（防幻觉兜底）。
  // 思路：先剔除真实实体（姓名/班级/宿舍）与常见词，再扫描"以姓氏开头、不含非姓名用字的 2-3 字片段"，
  // 这类片段才像真实人名；普通叙述（好的/出勤率/张老师）不会触发，避免误杀导致回退本地模板。
  function verifyGrounded(answer, allowed) {
    if (!answer) return true;
    let text = answer;
    const entities = [...allowed.names, ...allowed.classes, ...allowed.dorms, ...allowed.prefixes, '学工小智']
      .filter(Boolean).sort((a, b) => b.length - a.length);
    for (const e of entities) { if (!e) continue; text = text.split(e).join('\u0000'.repeat(e.length)); }
    for (const w of SAFE_WORDS) { text = text.split(w).join(''); }
    text = text.replace(/[\u0000-\u001f\s\dA-Za-z%.,，。、；：:！!？?（）()""''《》<>\[\]【】\n\r#*+\-=/\\|_`~@#$^&]/g, '');
    const runs = text.match(/[一-鿿]{2,3}/g) || [];
    const suspicious = runs.filter(r => {
      if (SAFE_WORDS.includes(r)) return false;
      if (r.length < 2 || r.length > 3) return false;
      if (!SURNAME_SET.includes(r[0])) return false;        // 必须以姓氏开头
      for (const ch of r) if (NON_NAME_CHARS.includes(ch)) return false; // 含非姓名用字则排除
      return true;
    });
    // if (suspicious.length > 0) console.log('[grounding] 疑似编造实体:', JSON.stringify([...new Set(suspicious)])); // DEBUG: disabled in production
    return suspicious.length === 0;
  }

  function finalIntent(intent, classFilter, lastClassFilter, dateRef, lastIntent, lastParam, param, courseFilter, lastCourseFilter) {
    let cf;
    if (classFilter === '__WHOLE__') cf = '';
    else if (classFilter) cf = classFilter;
    else cf = lastClassFilter || '';
    const ccf = courseFilter || lastCourseFilter || '';
    return {
      intent,
      classFilter: cf,
      courseFilter: ccf,
      inherited: !classFilter && classFilter !== '__WHOLE__' && !!lastClassFilter,
      dateRef: dateRef || { kind: 'today', date: getEffectiveToday() },
      lastIntent,
      param: param
    };
  }

  /** 0) 今日签到总览（支持按班级过滤、指定日期） */
  function analyzeTodayCheckin(classFilter, dateOverride) {
    const today = dateOverride || getEffectiveToday();
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    const r1 = db.exec(`
      WITH today_status AS (
        SELECT r.student_id, MIN(CASE 
          WHEN r.status='在寝' THEN 1 
          WHEN r.status IN ('请假','事假','病假','公假','丧假') THEN 2
          WHEN r.status IN ('未归','晚归','不在寝','缺席') THEN 3 ELSE 5 END) as priority
        FROM records r INNER JOIN students s ON r.student_id = s.student_id
        WHERE r.type='checkin' AND r.date=?${clsCond} GROUP BY r.student_id
      )
      SELECT SUM(CASE WHEN priority=1 THEN 1 ELSE 0 END),
             SUM(CASE WHEN priority=3 THEN 1 ELSE 0 END),
             SUM(CASE WHEN priority=2 THEN 1 ELSE 0 END)
      FROM today_status
    `, [today, ...clsParam])[0]?.values?.[0] || [0, 0, 0];
    const total = classFilter
      ? (db.exec(`SELECT COUNT(*) FROM students WHERE class_name LIKE ?`, [`%${classFilter}%`])[0]?.values?.[0]?.[0] || 0)
      : (db.exec(`SELECT COUNT(*) FROM students`)[0]?.values?.[0]?.[0] || 0);
    return { date: today, total_students: total, present: r1[0]||0, absent: r1[1]||0, leave: r1[2]||0,
             attendance_rate: total > 0 ? Math.round((r1[0]||0)/total*100) : 0, classFilter: classFilter || '全部' };
  }

  /** 1) 未归学生名单（含联系方式，支持班级过滤、指定日期） */
  function analyzeAbsentList(classFilter, dateOverride) {
    const today = dateOverride || getEffectiveToday();
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    const r = db.exec(`
      SELECT s.name, s.class_name, s.dorm, s.student_id, s.gender, s.phone
      FROM records r INNER JOIN students s ON r.student_id = s.student_id
      WHERE r.type='checkin' AND r.date=? AND r.status IN ('未归','晚归','不在寝','缺席')${clsCond}
      ORDER BY s.class_name, s.name
    `, [today, ...clsParam])[0];
    if (!r) return { count: 0, students: [], date: today, classFilter: classFilter || '全部' };
    return { count: r.values.length, date: today, classFilter: classFilter || '全部',
      students: r.values.map(v => ({ name:v[0], class_name:v[1], dorm:v[2], student_id:v[3], gender:v[4], phone:v[5] })) };
  }

  /** 2) 高风险学生（近N天缺勤≥3次，支持班级过滤、指定截止日） */
  function analyzeHighRisk(classFilter, endDateOverride, daysOverride) {
    const days = daysOverride || 30;
    const end = endDateOverride || localDateStr();
    const start = endDateOverride ? shiftDate(endDateOverride, -(days - 1)) : beijingDateStr(new Date(Date.now() - days*24*3600*1000));
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    const r = db.exec(`
      SELECT s.name, s.class_name, s.dorm, s.student_id, s.gender,
        COUNT(DISTINCT CASE WHEN r.status IN ('未归','不在寝') THEN r.date END) as absent_days,
        COUNT(DISTINCT CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN r.date END) as leave_days,
        GROUP_CONCAT(DISTINCT CASE WHEN r.status IN ('未归','不在寝') THEN r.date END) as absent_dates
      FROM records r INNER JOIN students s ON r.student_id = s.student_id
      WHERE r.type='checkin' AND r.date>=? AND r.date<=?${clsCond}
      GROUP BY s.id HAVING absent_days >= 3
      ORDER BY absent_days DESC LIMIT 20
    `, [start, end, ...clsParam])[0];
    if (!r) return { count: 0, students: [], classFilter: classFilter || '全部' };
    return { count: r.values.length, classFilter: classFilter || '全部',
      students: r.values.map(v => ({ name:v[0], class_name:v[1], dorm:v[2], student_id:v[3],
        gender:v[4], absent:v[5], leaves:v[6], recent_dates: (v[7]||'').split(',') })) };
  }

  /** 3) 近N天缺勤趋势（N 默认30；支持按学生名过滤，生成个人缺勤趋势） */
  function analyzeAbsentTrend(daysOverride, studentName) {
    const days = daysOverride || 30;
    const end = localDateStr(), start = beijingDateStr(new Date(Date.now() - days*24*3600*1000));
    let nameCond = '', nameParam = [];
    if (studentName) {
      nameCond = ` AND s.name LIKE ?`;
      nameParam = [`%${studentName}%`];
    }
    const r = db.exec(`
      SELECT r.date, COUNT(DISTINCT r.student_id) as cnt
      FROM records r INNER JOIN students s ON r.student_id = s.student_id
      WHERE r.type='checkin' AND r.status IN ('未归','不在寝')
      AND r.date>=? AND r.date<=?${nameCond}
      GROUP BY r.date ORDER BY r.date
    `, [start, end, ...nameParam])[0];
    if (!r) return { daily:[], peak:0, total:0, avg:0, studentName: studentName || '' };
    const daily = r.values.map(v => ({date:v[0], count:v[1]}));
    const total = daily.reduce((s,d)=>s+d.count,0);
    return { daily, peak: Math.max(...daily.map(d=>d.count),0), total, avg: daily.length?Math.round(total/daily.length):0, studentName: studentName || '' };
  }

  /** 3b) 区间未归学生（本周/上周/最近N天），返回去重学生名单与各自缺勤日期 */
  function analyzeAbsentRange(classFilter, start, end) {
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    const r = db.exec(`
      SELECT s.name, s.class_name, s.dorm, s.student_id,
        GROUP_CONCAT(DISTINCT r.date) as dates
      FROM records r INNER JOIN students s ON r.student_id = s.student_id
      WHERE r.type='checkin' AND r.date>=? AND r.date<=? AND r.status IN ('未归','晚归','不在寝','缺席')${clsCond}
      GROUP BY s.id ORDER BY s.class_name, s.name
    `, [start, end, ...clsParam])[0];
    const days = db.exec(`SELECT COUNT(DISTINCT date) FROM records WHERE type='checkin' AND date>=? AND date<=?`, [start, end])[0]?.values?.[0]?.[0] || 0;
    if (!r) return { count: 0, students: [], start, end, days };
    return { count: r.values.length, start, end, days,
      students: r.values.map(v => ({ name:v[0], class_name:v[1], dorm:v[2], student_id:v[3],
        dates: (v[4]||'').split(',').filter(Boolean) })) };
  }

  /** 3d) 学生个人周期汇总分析：查寝 + 课堂 + 请假 综合记录 */
  function analyzeStudentPeriodSummary(studentName, classFilter, start, end) {
    let rows = db.exec(`SELECT name, student_id, class_name, dorm, phone, gender FROM students WHERE name=?`, [studentName])[0];
    if (!rows || !rows.values.length) {
      return { error: `未找到名为「${studentName}」的学生信息` };
    }
    // 同名时按班级过滤消歧
    let chosen = rows.values[0];
    if (classFilter && rows.values.length > 1) {
      const hit = rows.values.find(v => v[2] && v[2].indexOf(classFilter) >= 0);
      if (hit) chosen = hit;
    }
    const [name, studentId, className, dorm, phone, gender] = chosen;

    // 查寝记录
    const checkin = db.exec(`
      SELECT date, status, time FROM records
      WHERE student_id=? AND type='checkin' AND date>=? AND date<=? ORDER BY date DESC, time DESC
    `, [studentId, start, end])[0];
    const checkinRecords = checkin ? checkin.values.map(v => ({date:v[0], status:v[1], time:v[2]})) : [];
    // 课堂记录
    const course = db.exec(`
      SELECT date, status, time, course_name FROM records
      WHERE student_id=? AND type='class' AND date>=? AND date<=? ORDER BY date DESC, time DESC
    `, [studentId, start, end])[0];
    const courseRecords = course ? course.values.map(v => ({date:v[0], status:v[1], time:v[2], course:v[3]})) : [];
    // 请假记录（周期有交集）
    const leaves = db.exec(`
      SELECT start_date, end_date, type, reason, status FROM leaves
      WHERE student_id=? AND start_date<=? AND end_date>=? ORDER BY start_date DESC
    `, [studentId, end, start])[0];
    const leaveRecords = leaves ? leaves.values.map(v => ({start:v[0], end:v[1], type:v[2], reason:v[3], status:v[4]})) : [];

    const stats = {
      checkin: {
        present: checkinRecords.filter(r => r.status === '在寝').length,
        absent: checkinRecords.filter(r => ['未归','不在寝','缺席'].includes(r.status)).length,
        late: checkinRecords.filter(r => r.status === '晚归').length,
        leave: checkinRecords.filter(r => ['请假','病假','事假','公假','丧假'].includes(r.status)).length,
        total: checkinRecords.length
      },
      course: {
        present: courseRecords.filter(r => r.status === '出勤').length,
        late: courseRecords.filter(r => r.status === '迟到').length,
        absent: courseRecords.filter(r => r.status === '缺课').length,
        total: courseRecords.length
      },
      leave: leaveRecords.length
    };

    return { student: { name, student_id: studentId, class_name: className, dorm, phone, gender },
      start, end, days: Math.max(1, Math.round((new Date(end) - new Date(start)) / (24*3600*1000)) + 1),
      checkinRecords, courseRecords, leaveRecords, stats };
  }

  /** 3c) 周期签到总览（本周/上月/本月汇总） */
  function analyzePeriodOverview(classFilter, start, end) {
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    // 先按 日期+学生 聚合出每日状态，再跨天汇总，避免"按学生取最好一天"导致缺勤被掩盖
    const rows = db.exec(`
      WITH sd AS (
        SELECT r.date, r.student_id, MIN(CASE
          WHEN r.status='在寝' THEN 1
          WHEN r.status IN ('请假','事假','病假','公假','丧假') THEN 2
          WHEN r.status IN ('未归','晚归','不在寝','缺席') THEN 3 ELSE 5 END) as priority
        FROM records r INNER JOIN students s ON r.student_id = s.student_id
        WHERE r.type='checkin' AND r.date>=? AND r.date<=?${clsCond}
        GROUP BY r.date, r.student_id
      )
      SELECT date,
        SUM(CASE WHEN priority=1 THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN priority=3 THEN 1 ELSE 0 END) as absent,
        SUM(CASE WHEN priority=2 THEN 1 ELSE 0 END) as leave
      FROM sd GROUP BY date ORDER BY date
    `, [start, end, ...clsParam])[0];
    const days = rows ? rows.values.length : 0;
    let present = 0, absent = 0, leave = 0;
    if (rows) rows.values.forEach(v => { present += v[1] || 0; absent += v[2] || 0; leave += v[3] || 0; });
    const total = classFilter
      ? (db.exec(`SELECT COUNT(*) FROM students WHERE class_name LIKE ?`, [`%${classFilter}%`])[0]?.values?.[0]?.[0] || 0)
      : (db.exec(`SELECT COUNT(*) FROM students`)[0]?.values?.[0]?.[0] || 0);
    const expected = total * days;
    return { start, end, days, total_students: total, present, absent, leave,
      attendance_rate: expected > 0 ? Math.round(present / expected * 100) : 0, classFilter: classFilter || '全部' };
  }

  /** 4) 班级对比 */
  function analyzeClassCompare() {
    const today = getEffectiveToday();
    const r = db.exec(`
      SELECT s.class_name, COUNT(DISTINCT s.id) as students,
        COUNT(DISTINCT CASE WHEN r.status='在寝' THEN r.student_id END) as present,
        COUNT(DISTINCT CASE WHEN r.status IN ('未归','不在寝') THEN r.student_id END) as absent,
        COUNT(DISTINCT CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN r.student_id END) as leave
      FROM students s LEFT JOIN records r ON s.student_id=r.student_id AND r.type='checkin' AND r.date=?
      WHERE s.class_name IS NOT NULL AND s.class_name!=''
      GROUP BY s.class_name ORDER BY absent DESC LIMIT 20
    `, [today])[0];
    if (!r) return [];
    return r.values.map(v => ({ class_name:v[0], students:v[1], present:v[2]||0, absent:v[3]||0, leave:v[4]||0,
      attendance_rate: v[1]>0 ? Math.round((v[2]||0)/v[1]*100):0 }));
  }

  /** 4b) 按日期范围统计班级签到率（用于周期综合分析） */
  function analyzeClassCompareRange(classFilter, start, end) {
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    const r = db.exec(`
      WITH daily AS (
        SELECT s.class_name, s.student_id, r.date,
          MIN(CASE
            WHEN r.status='在寝' THEN 1
            WHEN r.status IN ('请假','事假','病假','公假','丧假') THEN 2
            WHEN r.status IN ('未归','晚归','不在寝','缺席') THEN 3
            ELSE 5 END) as priority
        FROM students s LEFT JOIN records r ON s.student_id=r.student_id AND r.type='checkin' AND r.date>=? AND r.date<=?
        WHERE s.class_name IS NOT NULL AND s.class_name!=''${clsCond}
        GROUP BY s.class_name, s.student_id, r.date
      )
      SELECT class_name, COUNT(DISTINCT student_id) as students,
        SUM(CASE WHEN priority=1 THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN priority=3 THEN 1 ELSE 0 END) as absent,
        SUM(CASE WHEN priority=2 THEN 1 ELSE 0 END) as leave
      FROM daily GROUP BY class_name
    `, [start, end, ...clsParam])[0];
    if (!r) return [];
    const days = dateDiffDays(start, end);
    return r.values.map(v => {
      const students = v[1] || 0;
      const present = v[2] || 0;
      const rate = students > 0 && days > 0 ? Math.round(present / (students * days) * 100) : 0;
      return { class_name: v[0], students, present, absent: v[3]||0, leave: v[4]||0, attendance_rate: rate };
    }).sort((a,b) => b.attendance_rate - a.attendance_rate);
  }

  /** 5) 请假分析（增强：含最近请假详情，支持班级过滤；支持按班级对比） */
  function analyzeLeave(classFilter, param = '') {
    const today = localDateStr();
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];

    // 按班级对比模式
    if (param === 'class_compare') {
      const start30 = beijingDateStr(new Date(Date.now()-30*24*3600*1000));
      const r = db.exec(`
        SELECT s.class_name,
          COUNT(*) as total_leaves,
          SUM(CASE WHEN l.type='病假' THEN 1 ELSE 0 END) as sick,
          SUM(CASE WHEN l.type='事假' THEN 1 ELSE 0 END) as personal,
          SUM(CASE WHEN l.type='公假' THEN 1 ELSE 0 END) as official,
          SUM(CASE WHEN l.type='丧假' THEN 1 ELSE 0 END) as bereavement,
          SUM(CASE WHEN l.status='待审批' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN date(l.start_date)<=? AND date(l.end_date)>=? THEN 1 ELSE 0 END) as on_leave
        FROM leaves l INNER JOIN students s ON l.student_id=s.student_id
        WHERE l.start_date>=?${clsCond}
        GROUP BY s.class_name
        ORDER BY total_leaves DESC
      `, [today, today, start30, ...clsParam])[0];
      const students = db.exec(`SELECT class_name, COUNT(*) as cnt FROM students WHERE class_name IS NOT NULL AND class_name!=''${classFilter ? ' AND class_name LIKE ?' : ''} GROUP BY class_name`, clsParam)[0];
      const studentMap = {};
      if (students) students.values.forEach(v => studentMap[v[0]] = v[1] || 0);
      const classBreakdown = r ? r.values.map(v => {
        const total = v[1] || 0;
        const students = studentMap[v[0]] || 0;
        return {
          class_name: v[0], total_leaves: total, sick: v[2]||0, personal: v[3]||0, official: v[4]||0, bereavement: v[5]||0, pending: v[6]||0, on_leave: v[7]||0,
          leave_rate: students > 0 ? Math.round((total / students) * 100) : 0
        };
      }) : [];
      return { mode: 'class_compare', classFilter: classFilter || '全部', classBreakdown };
    }

    const pending = db.exec(`SELECT COUNT(*) FROM leaves l INNER JOIN students s ON l.student_id=s.student_id WHERE l.status='待审批'${clsCond}`, clsParam)[0]?.values?.[0]?.[0] || 0;
    const onLeave = db.exec(`SELECT COUNT(*) FROM leaves l INNER JOIN students s ON l.student_id=s.student_id WHERE date(l.start_date)<=? AND date(l.end_date)>=?${clsCond}`, [today,today, ...clsParam])[0]?.values?.[0]?.[0] || 0;
    const types = db.exec(`SELECT l.type,COUNT(*) as cnt FROM leaves l INNER JOIN students s ON l.student_id=s.student_id WHERE l.start_date>=?${clsCond} GROUP BY l.type ORDER BY cnt DESC`,
      [beijingDateStr(new Date(Date.now()-30*24*3600*1000)), ...clsParam])[0];
    const recent = db.exec(`
      SELECT l.type,l.reason,s.name,s.class_name,l.start_date,l.end_date,l.status
      FROM leaves l INNER JOIN students s ON l.student_id=s.student_id
      WHERE 1=1${clsCond}
      ORDER BY l.created_at DESC LIMIT 8
    `, clsParam)[0];
    return { pending, today_on_leave: onLeave, classFilter: classFilter || '全部',
      recent_30d_types: types ? types.values.map(v=>({type:v[0]||'未分类',count:v[1]})) : [],
      recent_leaves: recent ? recent.values.map(v=>({type:v[0],reason:v[1],name:v[2],class_name:v[3],start:v[4],end:v[5],status:v[6]})) : [] };
  }

  /** 6) 宿舍异常（近7天缺勤≥2的宿舍） */
  function analyzeDormAnomaly() {
    const end=localDateStr(), start=beijingDateStr(new Date(Date.now()-7*24*3600*1000));
    const r = db.exec(`
      SELECT s.dorm, COUNT(DISTINCT s.id) as total,
        COUNT(DISTINCT CASE WHEN r.status IN ('未归','不在寝') THEN s.id END) as absent
      FROM students s LEFT JOIN records r ON s.student_id=r.student_id AND r.type='checkin' AND r.date>=? AND r.date<=?
      WHERE s.dorm IS NOT NULL AND s.dorm!=''
      GROUP BY s.dorm HAVING absent>=2 ORDER BY absent DESC LIMIT 15
    `, [start,end])[0];
    if (!r) return [];
    return r.values.map(v => ({ dorm:v[0], total:v[1], absent:v[2]||0, rate: v[1]>0?Math.round(v[2]/v[1]*100):0 }));
  }

  /** 6.1) 指定宿舍今日缺勤名单（支持 2栋101、3-205、A101 等格式） */
  function analyzeDormAbsence(dormLike, classFilter, dateOverride) {
    const date = dateOverride || localDateStr();
    if (!dormLike) return analyzeDormAnomaly();
    // 模糊匹配：兼容“2栋101”与“2-101”两种写法（库里存的是带“栋”的格式）
    const raw = String(dormLike).replace(/\s/g, '');
    const dormCond = "(s.dorm LIKE ? OR s.dorm LIKE ? OR s.dorm LIKE ?)";
    const dormParams = [`%${raw}%`, `%${raw.replace('栋','-')}%`, `%${raw.replace('-','栋')}%`];
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    // 该宿舍总人数
    const totalR = db.exec(`SELECT COUNT(*) FROM students s WHERE ${dormCond}${clsCond}`, dormParams.concat(clsParam))[0];
    const total = totalR ? totalR.values[0][0] : 0;
    // 缺勤记录
    const r = db.exec(`
      SELECT s.name, s.class_name, s.dorm, s.student_id, r.status, r.time
      FROM students s LEFT JOIN records r ON s.student_id=r.student_id AND r.type='checkin' AND r.date=?
      WHERE ${dormCond}${clsCond}
      ORDER BY s.name
    `, [date].concat(dormParams).concat(clsParam))[0];
    const present = new Set(), absent = [];
    if (r) {
      r.values.forEach(v => {
        const status = v[4];
        if (status && status !== '未归' && status !== '不在寝') present.add(v[3]);
      });
      r.values.forEach(v => {
        const status = v[4];
        if (!status || status === '未归' || status === '不在寝') {
          if (!present.has(v[3])) absent.push({ name:v[0], class_name:v[1], dorm:v[2], student_id:v[3], status: status || '未归', time: v[5] || '' });
        }
      });
    }
    return { dormLike, date, total, absent_count: absent.length, absent: absent };
  }

  /** 5b) 同宿舍其他人（基于上一条学生档案的宿舍上下文） */
  function analyzeDormMates(dormLike, classFilter) {
    if (!dormLike) return { dorm: '', count: 0, mates: [], error: '暂无宿舍信息，请先查询一位学生。' };
    const raw = String(dormLike).replace(/\s/g, '');
    const dormCond = "(s.dorm LIKE ? OR s.dorm LIKE ? OR s.dorm LIKE ?)";
    const dormParams = [`%${raw}%`, `%${raw.replace('栋','-')}%`, `%${raw.replace('-','栋')}%`];
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    const r = db.exec(`
      SELECT s.name, s.student_id, s.class_name, s.dorm, s.gender, s.phone
      FROM students s
      WHERE ${dormCond}${clsCond}
      ORDER BY s.name
    `, dormParams.concat(clsParam))[0];
    const mates = r ? r.values.map(v => ({ name: v[0], student_id: v[1], class_name: v[2], dorm: v[3], gender: v[4], phone: v[5] })) : [];
    return { dorm: raw, count: mates.length, mates };
  }

  /** 7) 课程到课率（增强：含最近签到记录，支持班级/课程名过滤） */
  function analyzeCourseAttendance(absenceOnly = false, classFilter = '', courseFilter = '', analysisMode = false) {
    const extraCond = absenceOnly ? " AND status != '出勤'" : '';
    const clsJoin = classFilter ? ' INNER JOIN students s ON r.student_id=s.student_id' : '';
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const courseCond = courseFilter ? " AND r.course_name = ?" : '';
    const params = [beijingDateStr(new Date(Date.now()-7*24*3600*1000))];
    if (classFilter) params.push(`%${classFilter}%`);
    if (courseFilter) params.push(courseFilter);
    const count = db.exec(`SELECT COUNT(*) FROM records r${clsJoin} WHERE r.type='class' AND r.date>=?${extraCond}${clsCond}${courseCond}`,
      params)[0]?.values?.[0]?.[0] || 0;
    const studentCount = db.exec(`SELECT COUNT(DISTINCT r.student_id) FROM records r${clsJoin} WHERE r.type='class' AND r.date>=?${extraCond}${clsCond}${courseCond}`,
      params)[0]?.values?.[0]?.[0] || 0;
    const recentParams = [];
    if (courseFilter) recentParams.push(courseFilter);
    if (classFilter) recentParams.push(`%${classFilter}%`);
    const recent = db.exec(`
      SELECT s.name,s.class_name,r.course_name,r.time,status
      FROM records r INNER JOIN students s ON r.student_id=s.student_id
      WHERE r.type='class'${extraCond}${courseCond}${classFilter ? ' AND s.class_name LIKE ?' : ''}
      ORDER BY r.time DESC LIMIT 30
    `, recentParams)[0];
    const result = { recent_7d_attendance_records: count, recent_7d_student_count: studentCount, absenceOnly, classFilter: classFilter || '全部', courseFilter: courseFilter || '',
      recent_records: recent ? recent.values.map(v=>({name:v[0],class_name:v[1],course:v[2],time:v[3],status:v[4]})):[] };

    if (!analysisMode) return result;

    // 分析模式：补充出勤率、迟到率、缺课率、班级分布、缺课/迟到名单、按天趋势
    const start = beijingDateStr(new Date(Date.now()-7*24*3600*1000));
    const statsParams = [start];
    if (classFilter) statsParams.push(`%${classFilter}%`);
    if (courseFilter) statsParams.push(courseFilter);
    const statusStats = db.exec(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='出勤' THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN status='迟到' THEN 1 ELSE 0 END) as late,
        SUM(CASE WHEN status='缺课' THEN 1 ELSE 0 END) as absent
      FROM records r${clsJoin}
      WHERE r.type='class' AND r.date>=?${clsCond}${courseCond}
    `, statsParams)[0];
    if (statusStats) {
      const [total, present, late, absent] = statusStats.values[0];
      result.total = total || 0;
      result.present = present || 0;
      result.late = late || 0;
      result.absent = absent || 0;
      result.attendance_rate = total ? Math.round((present / total) * 100) : 0;
      result.late_rate = total ? Math.round((late / total) * 100) : 0;
      result.absent_rate = total ? Math.round((absent / total) * 100) : 0;
    }
    // 按班级统计
    result.class_stats = analyzeClassCourseStats(classFilter, courseFilter, 7);
    // 缺课学生名单
    const absentParams = [start];
    if (classFilter) absentParams.push(`%${classFilter}%`);
    if (courseFilter) absentParams.push(courseFilter);
    const absentStudents = db.exec(`
      SELECT s.name, s.class_name, s.student_id, COUNT(*) as cnt
      FROM records r INNER JOIN students s ON r.student_id=s.student_id
      WHERE r.type='class' AND r.date>=? AND r.status='缺课'${classFilter ? ' AND s.class_name LIKE ?' : ''}${courseCond}
      GROUP BY s.student_id, s.name, s.class_name
      ORDER BY cnt DESC, s.name
      LIMIT 30
    `, absentParams)[0];
    result.absent_students = absentStudents ? absentStudents.values.map(v=>({name:v[0], class_name:v[1], student_id:v[2], count:v[3]})) : [];
    // 迟到学生名单
    const lateParams = [start];
    if (classFilter) lateParams.push(`%${classFilter}%`);
    if (courseFilter) lateParams.push(courseFilter);
    const lateStudents = db.exec(`
      SELECT s.name, s.class_name, s.student_id, COUNT(*) as cnt
      FROM records r INNER JOIN students s ON r.student_id=s.student_id
      WHERE r.type='class' AND r.date>=? AND r.status='迟到'${classFilter ? ' AND s.class_name LIKE ?' : ''}${courseCond}
      GROUP BY s.student_id, s.name, s.class_name
      ORDER BY cnt DESC, s.name
      LIMIT 30
    `, lateParams)[0];
    result.late_students = lateStudents ? lateStudents.values.map(v=>({name:v[0], class_name:v[1], student_id:v[2], count:v[3]})) : [];
    // 近7天按天趋势
    const trendParams = [start];
    if (classFilter) trendParams.push(`%${classFilter}%`);
    if (courseFilter) trendParams.push(courseFilter);
    const trend = db.exec(`
      SELECT r.date,
        COUNT(*) as total,
        SUM(CASE WHEN status='出勤' THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN status='迟到' THEN 1 ELSE 0 END) as late,
        SUM(CASE WHEN status='缺课' THEN 1 ELSE 0 END) as absent
      FROM records r${clsJoin}
      WHERE r.type='class' AND r.date>=?${clsCond}${courseCond}
      GROUP BY r.date
      ORDER BY r.date
    `, trendParams)[0];
    result.daily_trend = trend ? trend.values.map(v=>({date:v[0], total_records:v[1], present_records:v[2], late_records:v[3], absent_records:v[4]})) : [];
    return result;
  }

  /** 7c) 各班级课堂出勤率统计（用于课堂考勤报告，支持班级/课程名过滤） */
  function analyzeClassCourseStats(classFilter = '', courseFilter = '', days = 7) {
    const start = beijingDateStr(new Date(Date.now() - days * 24 * 3600 * 1000));
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const courseCond = courseFilter ? " AND r.course_name = ?" : '';
    const params = [start];
    if (classFilter) params.push(`%${classFilter}%`);
    if (courseFilter) params.push(courseFilter);
    const r = db.exec(`
      SELECT s.class_name,
        COUNT(*) as total,
        SUM(CASE WHEN r.status='出勤' THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN r.status='缺课' THEN 1 ELSE 0 END) as absent,
        SUM(CASE WHEN r.status='迟到' THEN 1 ELSE 0 END) as late
      FROM records r INNER JOIN students s ON r.student_id=s.student_id
      WHERE r.type='class' AND r.date>=?${clsCond}${courseCond}
      GROUP BY s.class_name
      ORDER BY s.class_name
    `, params)[0];
    if (!r) return [];
    return r.values.map(v => {
      const total = v[1] || 0;
      const present = v[2] || 0;
      const absent = v[3] || 0;
      const late = v[4] || 0;
      return { class_name: v[0], total, present, absent, late, attendance_rate: total ? Math.round((present / total) * 100) : 0 };
    });
  }

  /** 7b) 迟到/晚归学生（默认今日，支持班级过滤） */
  function analyzeLateStudents(classFilter, dateOverride) {
    const date = dateOverride || getEffectiveToday();
    const clsCond = classFilter ? " AND s.class_name LIKE ?" : '';
    const clsParam = classFilter ? [`%${classFilter}%`] : [];
    const r = db.exec(`
      SELECT s.name, s.class_name, s.dorm, s.student_id, r.status, r.time, r.type
      FROM records r INNER JOIN students s ON r.student_id = s.student_id
      WHERE r.date=? AND ((r.type='class' AND r.status='迟到') OR (r.type='checkin' AND r.status='晚归'))${clsCond}
      ORDER BY r.type, s.class_name, s.name
    `, [date, ...clsParam])[0];
    if (!r) return { count: 0, late: 0, lateBack: 0, students: [], date, classFilter: classFilter || '全部' };
    const students = r.values.map(v => ({ name: v[0], class_name: v[1], dorm: v[2], student_id: v[3], status: v[4], time: v[5], type: v[6] }));
    return {
      count: students.length,
      late: students.filter(s => s.status === '迟到').length,
      lateBack: students.filter(s => s.status === '晚归').length,
      students,
      date,
      classFilter: classFilter || '全部'
    };
  }

  /** 8) 学生模糊搜索（按姓名/学号） */
  function searchStudent(keyword) {
    const r = db.exec(`
      SELECT name,student_id,class_name,dorm,gender,phone FROM students
      WHERE name LIKE ? OR student_id LIKE ?
      LIMIT 15
    `, [`%${keyword}%`,`%${keyword}%`])[0];
    if (!r) return { keyword, count:0, students:[] };
    return { keyword, count:r.values.length,
      students: r.values.map(v=>({name:v[0],student_id:v[1],class_name:v[2],dorm:v[3],gender:v[4],phone:v[5]})) };
  }

  /** 9) 单个学生完整档案（含签到历史、统计、请假记录；classFilter 用于同名歧义消歧） */
  function getStudentProfile(nameOrId, classFilter) {
    let rows = db.exec(`
      SELECT id,name,student_id,class_name,dorm,gender,phone FROM students
      WHERE name=? OR student_id=? OR CAST(id AS TEXT)=?
    `, [nameOrId,nameOrId,String(nameOrId).replace(/\D/g,'')||'-1'])[0];
    if (!rows || !rows.values.length) return null;
    // 同名时优先取指定班级的学生；若仍有多条且未指定班级，则提示歧义
    let chosen = null;
    if (classFilter && rows.values.length > 1) {
      const hit = rows.values.find(v => classFilter && v[3] && v[3].indexOf(classFilter) >= 0);
      if (hit) chosen = hit;
    }
    if (!chosen && rows.values.length > 1) {
      // 同名歧义：返回候选列表，由前端/用户选择，绝不跨班误认
      const candidates = rows.values.map(v => ({ name: v[1], class_name: v[3], dorm: v[4], student_id: v[2] }));
      return { ambiguous: true, name: rows.values[0][1], candidates };
    }
    chosen = chosen || rows.values[0];
    const s = chosen;
    const basic = { id:s[0],name:s[1],student_id:s[2],class_name:s[3],dorm:s[4],gender:s[5],phone:s[6] };
    const start = beijingDateStr(new Date(Date.now()-30*24*3600*1000));

    // 查寝记录与统计
    const checkinRecs = db.exec(`
      SELECT date,status,time,type FROM records
      WHERE student_id=? AND type='checkin' AND date>=? ORDER BY date DESC LIMIT 30
    `, [basic.student_id, start])[0];
    basic.recent_records = checkinRecs ? checkinRecs.values.map(v=>({date:v[0],status:v[1],time:v[2],type:v[3]})) : [];
    const checkinStats = db.exec(`
      SELECT
        COUNT(CASE WHEN status='在寝' THEN 1 END) as present,
        COUNT(CASE WHEN status IN ('未归','不在寝') THEN 1 END) as absent,
        COUNT(CASE WHEN status IN ('病假','事假','公假','丧假') THEN 1 END) as leave,
        COUNT(CASE WHEN status='晚归' THEN 1 END) as late,
        COUNT(*) as total
      FROM records WHERE student_id=? AND type='checkin' AND date>=?
    `, [basic.student_id, start])[0]?.values?.[0] || [0,0,0,0,0];
    basic.checkin_stats_30d = { present:checkinStats[0], absent:checkinStats[1], leave:checkinStats[2], late:checkinStats[3], total:checkinStats[4],
      attend_rate: checkinStats[4]>0 ? Math.round(checkinStats[0]/checkinStats[4]*100) : 0 };
    // 保留 stats_30d 别名，兼容旧代码/LLM摘要
    basic.stats_30d = basic.checkin_stats_30d;

    // 课堂记录与统计
    const classRecs = db.exec(`
      SELECT date,status,time,type,course_name FROM records
      WHERE student_id=? AND type='class' AND date>=? ORDER BY date DESC LIMIT 30
    `, [basic.student_id, start])[0];
    basic.recent_class = classRecs ? classRecs.values.map(v=>({date:v[0],status:v[1],time:v[2],type:v[3],course_name:v[4]})) : [];
    const classStats = db.exec(`
      SELECT
        COUNT(CASE WHEN status='出勤' THEN 1 END) as present,
        COUNT(CASE WHEN status='缺课' THEN 1 END) as absent,
        COUNT(CASE WHEN status='迟到' THEN 1 END) as late,
        COUNT(CASE WHEN status IN ('病假','事假','公假','丧假') THEN 1 END) as leave,
        COUNT(*) as total
      FROM records WHERE student_id=? AND type='class' AND date>=?
    `, [basic.student_id, start])[0]?.values?.[0] || [0,0,0,0,0];
    basic.class_stats_30d = { present:classStats[0], absent:classStats[1], late:classStats[2], leave:classStats[3], total:classStats[4],
      attend_rate: classStats[4]>0 ? Math.round(classStats[0]/classStats[4]*100) : 0 };

    // 请假记录
    const lvs = db.exec(`SELECT type,reason,start_date,end_date,status FROM leaves WHERE student_id=? ORDER BY created_at DESC LIMIT 10`,
      [basic.student_id])[0];
    basic.recent_leaves = lvs ? lvs.values.map(v=>({type:v[0],reason:v[1],start_date:v[2],end_date:v[3],status:v[4]})) : [];
    return basic;
  }

  /** 10) 全量数据快照（供通用问答使用，支持班级过滤） */
  function getFullDataSnapshot(classFilter) {
    const today = analyzeTodayCheckin(classFilter);
    const absent = analyzeAbsentList(classFilter);
    const risk = analyzeHighRisk(classFilter);
    const leave = analyzeLeave(classFilter);
    const classes = analyzeClassCompare();
    const dorms = analyzeDormAnomaly();
    const trend = analyzeAbsentTrend();
    const alerts = getAlertSummary();
    const totalStudents = db.exec(`SELECT COUNT(*) FROM students`)[0]?.values?.[0]?.[0] || 0;
    const totalClasses = db.exec(`SELECT COUNT(DISTINCT class_name) FROM students WHERE class_name IS NOT NULL AND class_name!=''`)[0]?.values?.[0]?.[0] || 0;
    const totalDorms = db.exec(`SELECT COUNT(DISTINCT dorm) FROM students WHERE dorm IS NOT NULL AND dorm!=''`)[0]?.values?.[0]?.[0] || 0;
    const totalRecords = db.exec(`SELECT COUNT(*) FROM records WHERE type='checkin'`)[0]?.values?.[0]?.[0] || 0;
    const now = new Date();
    const weekDays = ['日','一','二','三','四','五','六'];
    return {
      system_time: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
      weekday: `星期${weekDays[now.getDay()]}`,
      overview: { totalStudents, totalClasses, totalDorms, totalRecords },
      today, absent, risk, leave, classes, dorms, trend, alerts
    };
  }

  /** 11) 最近签到记录（带详情） */
  function getRecentRecords(limit) {
    limit = limit || 20;
    const r = db.exec(`
      SELECT s.name,s.class_name,s.dorm,r.date,r.status,r.time,r.type,r.location
      FROM records r INNER JOIN students s ON r.student_id=s.student_id
      WHERE r.type='checkin' ORDER BY r.time DESC LIMIT ?
    `, [limit])[0];
    if (!r) return [];
    return r.values.map(v => ({ name:v[0],class_name:v[1],dorm:v[2],date:v[3],status:v[4],time:v[5],type:v[6],location:v[7] }));
  }

  /** 12) 异常告警摘要 */
  function getAlertSummary() {
    const openCount = db.exec(`SELECT COUNT(*) FROM absence_alerts WHERE status='open'`)[0]?.values?.[0]?.[0] || 0;
    const closedToday = db.exec(`SELECT COUNT(*) FROM absence_alerts WHERE status='closed' AND closed_at>=?`,
      [localDateStr()+' 00:00:00'])[0]?.values?.[0]?.[0] || 0;
    const recent = db.exec(`
      SELECT a.id,s.name,s.class_name,a.reason,a.status,a.created_at
      FROM absence_alerts a INNER JOIN students s ON a.student_id=s.student_id
      ORDER BY a.created_at DESC LIMIT 5
    `)[0];
    return { open: openCount, closed_today: closedToday,
      recent: recent ? recent.values.map(v=>({id:v[0],name:v[1],class_name:v[2],reason:v[3],status:v[4],created_at:v[5]})) : [] };
  }

  // 提取班级名称：优先从 CLASS_NAMES 中匹配完整班级名（如测绘2301）
  function extractClassFilter(question) {
    if (!question) return '';
    const q = String(question);
    for (const cls of CLASS_NAMES) {
      const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(?:^|[^\\u4e00-\\u9fa5])' + esc + '(?:\\s|班|届|级)?(?:[^0-9A-Za-z\\u4e00-\\u9fa5]|$)').test(q)) {
        return cls;
      }
    }
    // 支持班级简称：如"测绘1班" / "测绘一班" / "地信1"
    const majorPrefixes = [...new Set(CLASS_NAMES.map(c => c.replace(/\d.*$/, '')).filter(Boolean))].sort((a,b)=>b.length-a.length);
    for (const major of majorPrefixes) {
      if (major.length < 2) continue;
      const re = new RegExp(major + '([一二三四五六七八九十\\d]{1,4})(?:班|的|签到|出勤|未归|情况|数据|统计)?');
      const m = q.match(re);
      if (m) {
        const resolved = resolveClassName(major + m[1]);
        if (CLASS_NAMES.includes(resolved)) return resolved;
      }
    }
    return '';
  }

  // 缓存课程名，用于提取课程维度过滤
  function loadCourseNames() {
    try {
      const r = db.exec("SELECT DISTINCT course_name FROM records WHERE type='class' AND course_name IS NOT NULL AND course_name!='' ORDER BY course_name")[0];
      COURSE_NAMES = r ? r.values.map(v => v[0]) : [];
    } catch (e) { COURSE_NAMES = []; }
  }

  // 提取课程名称：优先从 COURSE_NAMES 中匹配完整课程名（如摄影测量学）
  function extractCourseFilter(question) {
    if (!question || COURSE_NAMES.length === 0) return '';
    const q = String(question).replace(/[?？！!。，,]/g, '');
    // 按课程名长度降序，避免"测绘学概论"被"测绘"误截
    for (const cn of [...COURSE_NAMES].sort((a,b)=>b.length-a.length)) {
      if (q.includes(cn)) return cn;
    }
    // 兜底：部分匹配（如"摄影测量"匹配"摄影测量学"），仅当唯一候选时
    for (const cn of COURSE_NAMES) {
      if (cn.length >= 4 && q.includes(cn.slice(0, 4))) {
        const candidates = COURSE_NAMES.filter(c => c.startsWith(cn.slice(0, 4)));
        if (candidates.length === 1) return candidates[0];
      }
    }
    return '';
  }

  // ==================== 智能意图路由 v2（支持人名/宿舍/班级/搜索/告警等） ====================
  function routeIntent(question, sessionCtx) {
    const q = (question || '').toLowerCase().trim();
    const lastIntent = sessionCtx ? sessionCtx.lastIntent : null;
    const lastClassFilter = sessionCtx ? (sessionCtx.lastClassFilter || '') : '';
    const lastCourseFilter = sessionCtx ? (sessionCtx.lastCourseFilter || '') : '';
    const lastParam = sessionCtx ? sessionCtx.lastParam : undefined;
    // 统一提取上一轮上下文中的学生名（兼容 student_detail 与 student_period_analysis 等不同数据结构）
    const ctxStudentName = sessionCtx && sessionCtx.lastData
      ? (sessionCtx.lastData.name || (sessionCtx.lastData.student && sessionCtx.lastData.student.name) || '')
      : '';

    let classFilter = extractClassFilter(question);
    let courseFilter = extractCourseFilter(question);
    const dateRef = resolveDateRef(q);

    // 自我介绍 / 能力说明：最早拦截，避免被当作数据查询或系统概况
    const qPlain = q.replace(/[?？！!。，,]/g, '').trim();
    if (/^(你是|你是谁|你叫什么|你是什么|你是ai吗|你是机器人吗|介绍一下|自我介绍一下|你能做什么|你能帮我|你能查|你有什么功能|功能|帮助|help|你是谁)$/.test(qPlain) || /你好|您好|hello|hi|嗨|哈啰|hallo|在吗|在么|早上好|中午好|晚上好/.test(q)) {
      return finalIntent('self_intro', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }

    // 报告维度修正：上一轮在讨论报告/PDF，本轮只限定范围（如"只要上课考勤的""我要查寝的"），继续走 report 意图
    if (lastIntent === 'report' && /^(?:只要|我要的只是|我要的是|我要|换成|改为|重新出|重新生成|只要.*就|只.*就).+/.test(q)) {
      const scopeCorrection = /(课堂|课程|上课|到课|考勤|各课|各门课|出勤|缺课|旷课|逃课|课堂签到|到课率|查寝|寝室|宿舍|在寝|未归|晚归|就寝|熄灯)/;
      if (scopeCorrection.test(q)) {
        let scope = 'comprehensive';
        if (/(课堂|课程|上课|到课|考勤|各课|各门课|出勤|缺课|旷课|逃课|课堂签到|到课率)/.test(q)) scope = 'course';
        else if (/(查寝|寝室|宿舍|在寝|未归|晚归|就寝|熄灯)/.test(q)) scope = 'dorm';
        return finalIntent('report', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, scope, courseFilter, lastCourseFilter);
      }
    }

    // 用户纠正上一轮范围过大：用"那个学生/这个学生/该学生"指代，并表达"不是所有/只要个人"
    // 例如："我要的是那个学生的不是所有的" / "我只要那个学生，不要全校" / "给我那个学生的" / "只看那个学生"
    if (ctxStudentName &&
        /(那个学生|这个学生|该学生|该生|他|她|此人|这个同学|那个同学|该同学)/.test(q) &&
        /(不是|不要|别|只要|只|仅|只是|就要|个人|单个|那一个|这一个|具体|私人|专属)|全部|全校|整体|所有|大家|每个|每位|人人|都/.test(q)) {
      let targetIntent = 'student_detail';
      if (lastIntent === 'student_period_analysis') targetIntent = 'student_period_analysis';
      else if (lastIntent === 'period_overview' || lastIntent === 'period_advice' || lastIntent === 'advice') targetIntent = 'student_period_analysis';
      else if (lastIntent === 'trend') targetIntent = 'trend';
      // 清除可能继承的全局/班级过滤，保证只看该学生个人
      return finalIntent(targetIntent, '', lastClassFilter, dateRef, lastIntent, ctxStudentName, ctxStudentName, courseFilter, lastCourseFilter);
    }

    // 宿舍号识别（最高优先级，放在任何模糊组合之前）：2栋101、3-205、A101 等 + 缺勤/未归/谁/哪些 词 → 查寝维度
    const dormMatch = q.match(/(\d+[栋-]\d+|[A-Za-z]\d+|[东西南北]\d+栋?\d*)/);
    if (dormMatch && /(缺勤|未归|未到|不在|谁|哪些|名单|人|同学|学生)/.test(q)) {
      return finalIntent('dorm_absence', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, dormMatch[1], courseFilter, lastCourseFilter);
    }

    // 整体/全校语义：未显式指定班级时清除继承的班级过滤（避免上下文污染）
    // 用哨兵 __WHOLE__ 标记"明确要求全校"，finalIntent 据此禁止继承上一轮班级
    const WHOLE = '__WHOLE__';
    const wholeSchool = /全部|整体|所有班级|所有班|全校|总览|总体|全校概况|总体情况|所有学生|全体|各班级|各班/.test(q);
    if (wholeSchool && !extractClassFilter(question)) classFilter = WHOLE;

    // 追问检测：简短回复、省略主语的追问，继承上一轮意图和班级
    const followUpPatterns = /^(要|是的|好|可以|行|嗯|哦|详细|具体|名单|名单呢|有哪些人|谁|他们是谁|他们|接着|继续|上面|刚才|之前|再|再看|还有呢|然后呢|接着问|追问|帮我查|查一下|告诉我|说说|为什么|什么原因|哪[0-9一二两三四五六七八九十百十]*人|哪些人|哪几个|哪几位|哪一些|那[0-9一二两三四五六七八九十百十]*人|那些人|那几个|那几位|那一些)(.*)?$|为什么|什么原因|怎么回事|为啥|咋回事|原因呢/;
    const isFollowUp = q.length <= 24 && (followUpPatterns.test(q) || (/^(要|详细|具体|名单|谁|哪些|哪|那)/.test(q) && lastIntent && ['today','today_with_absent','absent_list','high_risk','leave','dorm','course','alerts'].includes(lastIntent)));

    // 解释/追问上一轮数据：这个签到率是指？/ 这个是什么意思？/ 怎么算的？/ 解释一下
    const EXPLAINABLE_INTENTS = ['period_overview','today','today_with_absent','class_compare','dorm','late','course','leave','high_risk','trend','advice','student_detail','search','absent_range','absent_list'];
    const explainKeyPhrases = /(什么意思|怎么理解|怎么算|怎么计算|怎么算的|如何计算|解释一下|解释|指什么|是指什么|是什么|含义|是指|这个签到率|这个出勤率|这个率|那个签到率|那个率|这个率|这个数据|那个数据|这些数据|上面那个|刚才那个)/;
    const reasonKeyPhrases = /(为什么|什么原因|怎么回事|为何|为啥|咋回事|怎么这么|怎么这么低|怎么这么高|怎么这样|为什么这样|为何这样|为什么低|为什么高)/;
    const isExplainQuestion = qPlain.length <= 24 && !reasonKeyPhrases.test(qPlain) && explainKeyPhrases.test(qPlain);
    if (isExplainQuestion && lastIntent && EXPLAINABLE_INTENTS.includes(lastIntent)) {
      return finalIntent('explain', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, lastIntent, courseFilter, lastCourseFilter);
    }

    // 基于上一条学生档案的上下文追问：同宿舍其他人 / 同寝室其他人 / 室友
    const lastStudentDorm = sessionCtx && sessionCtx.lastData && sessionCtx.lastData.dorm ? sessionCtx.lastData.dorm : '';
    const asksDormMates = /(同宿舍|同寝室|同房间|同寝|同宿|室友|宿舍其他|寝室其他|宿舍还有|寝室还有|宿舍有谁|寝室有谁|住一起)/.test(q);
    if (asksDormMates) {
      if (lastStudentDorm) return finalIntent('dorm_mates', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, lastStudentDorm, courseFilter, lastCourseFilter);
      // 有宿舍上下文关键词但无宿舍信息 → 反问澄清，而不是当成人名
      return finalIntent('clarify', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, question, courseFilter, lastCourseFilter);
    }

    const asksAbsent = /未归|未到|不在|没回来|没回|没来|缺席|没归|谁没|哪些人没|没到校|未归名单|没归|没回宿舍|没回寝/;
    const asksTrend = /趋势|走向|未来|预测|曲线|变化|历史/;
    // 趋势优先（含"最近N天…趋势/走向/变化"等；但明确要"名单"时仍走名单分支）
    if (asksTrend.test(q) && !/未归名单|谁没|哪些人没|名单/.test(q)) {
      // 基于上一条学生档案的上下文追问：该生 / 这个学生 / 他 / 她 / 此人 + 趋势
      const refersStudent = /(该生|这个学生|那个学生|此学生|该同学|这位同学|他|她|此人|这个同学|那个同学)/.test(q);
      if (refersStudent) {
        const hasStudentCtx = lastIntent === 'student_detail' || ctxStudentName;
        if (hasStudentCtx) {
          const studentName = ctxStudentName || lastParam;
          return finalIntent('trend', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, studentName, courseFilter, lastCourseFilter);
        }
        // 有"该生"指代但无学生上下文 → 反问，而不是返回全校趋势
        return finalIntent('clarify', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, question, courseFilter, lastCourseFilter);
      }
      return finalIntent('trend', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }
    // 课堂缺勤优先：上课/课堂/课 + 缺勤相关词 → 课堂缺勤（而非查寝未归）
    if (/(上课|课堂|课).*(没来|没到|未到|没去|缺席|旷课|缺课|迟到)|没来上课|上课没到|来上课没|上课没来|谁没来上课|今天谁没来上课/.test(q)) {
      return finalIntent('course', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, 'absence', courseFilter, lastCourseFilter);
    }
    // 归因类提问（为什么今天未归这么多）→ 数据归因（必须在"今天+未归→总览"之前）
    if (/(为什么|什么原因|怎么回事|为何|为啥|咋回事|怎么这么|为什么这么|为何这么|怎么这样|为什么这样)/.test(q) && /(未归|签到率|出勤率|在寝率|缺勤|请假|趋势|出勤|在寝|人数|这么多|这么少|这么低|这么高|这么差|情况|数据|查寝)/.test(q)) {
      return finalIntent('reason', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }
    // 区间未归：本周/上周/本月/最近N天 + 未归 → 区间去重名单
    if (asksAbsent.test(q) && (dateRef.kind === 'week' || dateRef.kind === 'month' || dateRef.kind === 'recentN')) {
      return finalIntent('absent_range', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }
    // 组合：今天/指定某天 + 未归名单
    const asksToday = /今日|今天|当前|现在|签到率|总体|概览|统计|情况(?!.*学生)|数据|怎么样|本周|上周|本月|最近|近|前天|昨天|昨日/;
    if (asksToday.test(q) && asksAbsent.test(q)) {
      if (dateRef.kind === 'week' || dateRef.kind === 'month' || dateRef.kind === 'recentN') return finalIntent('absent_range', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
      return finalIntent('today_with_absent', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }

    // 学生个人周期分析：学生名 + 近N天 + 所有记录/分析汇总 → 优先于全校/全班 period_advice
    const periodPhrase = /最近\s*[0-9一二两三四五六七八九十百]+\s*天|近\s*[0-9一二两三四五六七八九十百]+\s*天|本周|这周|本月|这月|上周|上周/;
    const isPeriod = (dateRef.kind === 'recentN' || dateRef.kind === 'week' || dateRef.kind === 'month') || periodPhrase.test(q);
    const personalAnalysisWords = /(所有记录|记录分析|分析汇总|汇总分析|记录汇总|考勤汇总|出勤汇总|情况汇总|数据汇总|分析|汇总|记录)/;
    if (isPeriod && personalAnalysisWords.test(q)) {
      // 句首学生名，如 "叶剑，该生近3天..."
      const namePrefix = q.match(/^([\u4e00-\u9fa5]{2,4})[,，,、\s]/);
      const INVALID_NAME = /(班级|班|宿舍|寝室|课程|课堂|查寝|请假|签到|缺勤|考勤|学生|老师|今天|昨天|昨日|前天|未归|在寝|情况|数据|预警|异常|高危|风险|排名|对比|总览|概览|周|月|分析|汇总|记录|近|最|过|去|前|上|本|下|的|了|是|给|我|查|看|下|一|下|请|问|把|发|汇|总|情|况|数|据)/;
      if (namePrefix && !INVALID_NAME.test(namePrefix[1])) {
        return finalIntent('student_period_analysis', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, namePrefix[1], courseFilter, lastCourseFilter);
      }
      // "该生/他/她" 指代，继承上一条学生名
      if (/(该生|这个学生|那个学生|此学生|该同学|这位同学|他|她|此人|这个同学|那个同学)/.test(q) && ctxStudentName) {
        return finalIntent('student_period_analysis', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, ctxStudentName, courseFilter, lastCourseFilter);
      }
    }

    // 周期 + 考勤/数据 + 建议/分析 → 综合周期建议（优先于单一周期总览，给出权威研判）
    if (isPeriod &&
        /(考勤|出勤|数据|情况|分析|风险|异常|未归|请假)/.test(q) &&
        /(建议|给出|提出|分析|提升|改进|提高|加强|管理|措施|方案|意见|优化|研判|对策)/.test(q)) {
      return finalIntent('advice', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, 'period_advice', courseFilter, lastCourseFilter);
    }
    // 周期 + 考勤/签到率/总览/情况 → 周期总览（而非课堂原始记录）
    if ((dateRef.kind === 'week' || dateRef.kind === 'month') && /(考勤|签到率|总览|总体|概览|情况|统计|怎么样|如何)/.test(q)) {
      return finalIntent('period_overview', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }

    // 完整课程名优先：问题中包含 COURSE_NAMES 里的课程名 + 记录/情况/考勤等 → 直接走课程记录
    // 避免《误差理论与测量平差》因含"与"被拆成两人对比
    if (courseFilter && /(记录|情况|考勤|出勤|签到|缺勤|明细|数据|怎么样|如何)/.test(q)) {
      const isAnalysis = /(分析|统计|报告|研判|总结|概况|怎么样|如何)/.test(q);
      return finalIntent('course', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, isAnalysis ? 'analysis' : undefined, courseFilter, lastCourseFilter);
    }

    // 两人对比（张三和李四谁缺勤多）暂不支持精确对比 → 引导逐个查询，而非返回全校高风险列表
    const _CAT = /(班级|班|宿舍|寝室|课程|课堂|查寝|请假|签到|缺勤|考勤|学生|老师|今天|昨天|昨日|前天|未归|在寝|情况|数据|预警|异常|高危|风险|排名|对比|总览|概览|周|月)/;
    const _two = q.match(/([\u4e00-\u9fa5]{2,4})[、，,与和跟]([\u4e00-\u9fa5]{2,4})/);
    if (_two && !_CAT.test(_two[1]) && !_CAT.test(_two[2]) && /(缺勤|签到|请假|出勤|情况|对比|比较|谁|多|少|怎么样|如何|分析|档案|记录)/.test(q)) {
      // 若匹配到的整体能组成完整课程名，优先走课程查询（例如"误差理论与测量平差"）
      const combined = _two[1] + '与' + _two[2];
      const reversed = _two[2] + '与' + _two[1];
      if (COURSE_NAMES.includes(combined) || COURSE_NAMES.includes(reversed)) {
        return finalIntent('course', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
      }
      return finalIntent('clarify', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, question, courseFilter, lastCourseFilter);
    }
    // 高风险学生必须在人名识别之前拦截，否则“高风险学生”会被当成人名
    if (/(风险|高危|缺勤多|经常不|经常缺|老是缺|老缺|总是缺|反复缺|总缺勤|重点关注|问题学生|需关注|关注谁|关注|盯紧|盯一下|重点盯|常缺|老是不)/.test(q)) return finalIntent('high_risk', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);

    // 联系家长 / 通知家长 / 家长确认：操作指令，必须在人名识别之前拦截，避免“家长确认”被当成人名
    if (/(联系家长|通知家长|告知家长|家长确认|给家长打电话|电话家长)/.test(q)) {
      // 若上一轮正在查看某位学生，直接针对该学生给出联系家长建议
      return finalIntent('advice', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, ctxStudentName || 'contact_parent', courseFilter, lastCourseFilter);
    }

    // 报告 / PDF 导出：必须在人名识别之前拦截，否则“出一份文件”会把“文件”当成人名
    // 同时识别用户限定的报告维度：课堂考勤 / 查寝 / 综合
    if (/(pdf|报表|报告|导出|下载).*?(文件|pdf|数据分析)|出.*?(pdf|文件|报告|报表)|生成.*?(pdf|文件|报告|报表)|给我.*?(pdf|文件|报告|报表)|数据分析.*?(pdf|报告|文件)|打印.*?(报告|报表|pdf)|(查寝|宿舍|寝室|课堂|课程|考勤|出勤|签到|未归|晚归|请假|班级).{0,3}(报告|报表|pdf)/i.test(q)) {
      let reportScope = 'comprehensive';
      if (/(课堂|课程|上课|到课|考勤|各课|各门课|出勤|缺课|旷课|逃课|课堂签到|到课率)/.test(q)) reportScope = 'course';
      else if (/(查寝|寝室|宿舍|在寝|未归|晚归|就寝|熄灯).*(报告|pdf|报表|数据分析|分析)/i.test(q)) reportScope = 'dorm';
      return finalIntent('report', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, reportScope, courseFilter, lastCourseFilter);
    }

    // 智能建议/月报/综合分析 必须在人名识别之前拦截，否则“生成月报简报”会被当成人名
    if (/(月报|简报|汇报|总结|综合分析|管理建议|给我建议|怎么办|怎么处理|怎么管|如何改善|优化方案|生成.*报告|生成.*分析|给我.*分析|给我.*建议)/.test(q)) return finalIntent('advice', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);

    // 迟到/晚归 必须在人名识别之前拦截，否则“迟到”会被当成人名
    if (/(迟到|晚归|谁迟到|谁晚归|迟到学生|晚归学生|迟到名单|晚归名单|迟到情况|晚归情况)/.test(q)) return finalIntent('late', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);

    // 旷课/课堂缺勤/未到课 必须在人名识别之前拦截，否则“同学旷课”会被当成人名
    if (/(旷课|缺课|课堂缺勤|上课未到|未到课|没到课|未去上课|逃课|旷课学生|谁旷课)/.test(q)) return finalIntent('course', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, 'absence', courseFilter, lastCourseFilter);

    // 课程/课堂签到 必须在人名识别之前拦截，否则“课程签到”会被当成人名
    if (/(课程|课堂|上课|到课|考勤|出勤)/.test(q)) {
      // 泛问“上课情况/课堂考勤”且未指定班级、也未用“这个班/我们班/本班”指代时，按全校课堂总览处理，避免继承上一轮班级
      const refersToLastClass = /(这个班|那个班|该班|我们班|你们班|本班|他们班|此班|上述班级|前面说的班|之前.*班)/.test(q);
      let cf = classFilter;
      if (!cf && !refersToLastClass) cf = '__WHOLE__';
      return finalIntent('course', cf, lastClassFilter, dateRef, lastIntent, lastParam, 'analysis', courseFilter, lastCourseFilter);
    }

    // 课程指代（这门课/那门课/该课程）优先：避免"这门课"被当成人名
    if (/(这门课|那门课|该门课|此门课|这节课|那节课|该节课|此节课|该课程|此课程|这门课程|此课程|该课|此课)/.test(q)) {
      if (lastIntent === 'course' && lastCourseFilter) {
        return finalIntent('course', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, lastCourseFilter, lastCourseFilter);
      }
      if (courseFilter) {
        return finalIntent('course', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
      }
      return finalIntent('clarify', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, question, courseFilter, lastCourseFilter);
    }

    // 追问当前讨论范围："你指的是哪个班/说的是哪个班" → 解释上一轮，而非班级对比
    if (/(指|说|聊|讨论|谈|问).*?(哪个班|什么班|哪班|哪个班级|什么班级)|现在.*?哪个班|刚才.*?哪个班|哪个班.*?(指|说|聊|讨论)/.test(q)) {
      return finalIntent('explain', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, lastIntent, courseFilter, lastCourseFilter);
    }

    // 班级级对比/排名/最值：必须在学生名识别之前，否则"哪个班最差"会被当成人名
    if (/(哪个班|哪个.*班|各班|各班级|班级.*对比|班级.*排名|班级.*最|班.*最差|班.*排名|班.*对比|班.*最|班级.*情况|班级.*怎么样)/.test(q)) {
      return finalIntent('class_compare', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }
    // 简单统计类：学生总数 / 班级数
    if (/(学生.*总数|总数.*学生|一共.*学生|多少.*学生|学生.*多少|总人数|学生总数|共有.*学生|几个班|多少班|班级.*总数|几个班级|共有.*班|总共.*班|多少.*班)/.test(q)) {
      return finalIntent('stats', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }

    // ===== 以下管理类意图必须在人名识别之前拦截，防止"宿舍异常""异常告警"等被当成人名 =====
    // 宿舍/寝室相关 → 宿舍异常
    if (/(宿舍|寝室)/.test(q)) return finalIntent('dorm', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    // 异常/告警/预警/闭环 → 告警汇总
    if (/(告警|异常|预警|闭环|处理)/.test(q)) return finalIntent('alerts', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    // 未归/缺勤名单
    if (/(未归|未到|不在|没回来|缺席|没归|谁没|哪些人没|没到校|未归名单)/.test(q)) {
      if (dateRef.kind === 'week' || dateRef.kind === 'month' || dateRef.kind === 'recentN') return finalIntent('absent_range', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
      return finalIntent('absent_list', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }
    // 请假
    if (/(请假|休假|审批)/.test(q)) {
      const isClassCompare = /(各班级|各班|对比|比较|哪个班|哪个.*最|排名)/.test(q);
      return finalIntent('leave', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, isClassCompare ? 'class_compare' : undefined, courseFilter, lastCourseFilter);
    }
    // 改进建议
    if (/(改进|提升|提高|改善|加强|优化|整改|怎么办|怎么处理|怎么管|措施|建议).*(签到率|出勤率|在寝率|班级|班)|低签到率|低出勤率|低在寝率|签到率.*低|出勤率.*低|在寝率.*低/.test(q)) {
      return finalIntent('improve_attendance', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }
    // 班级对比/排名（兜底）
    if (/(班级|对比|比较|排名|哪个班|哪个.*最|各班级|各班)/.test(q)) return finalIntent('class_compare', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);

    // 具体学生：剥离班级/动词前缀/尾缀后，取剩余 2-4 字中文作为姓名，并排除统计类关键词
    const nameKw = /(地信|测绘|遥感|资源|环境|土木|计算机|软件|电子|机械|材料|化工|数学|物理|英语|工商|经济|法学|文学|艺术|建筑|交通|自动化|通信|网络|安全|数据|智能|人工智能|班的?|班)/g;
    let qName = q.replace(nameKw, ' ').replace(/\s+/g, ' ').trim();
    qName = qName.replace(/^(查一下|查询|查找|搜索|看看|关于|查看|搜一下|问一下|请问|帮我查|想问|我想问|给我看一下|给我看看|给我看下|给我看|看一下|看下|看看|展示|显示|给我)/, '').trim();
    qName = qName.replace(/(的同学|同学|的学生|学生|情况|的情况|的签到|签到|的缺勤|缺勤|的请假|请假|的信息|信息|怎么样|表现|最近表现|近期表现|是谁|的档案|档案|的记录|记录|最近|近期|的数据|数据|给我看一下|给我看看|给我看下|给我看|看一下|看下|看看|展示|显示|给我|了|这孩子|那孩子|这同学|那同学|这学生|那学生|这位同学|那位同学|这个学生|那个学生|这名同学|那位同学)$/, '').trim();
    // 去掉包裹在人名前后的"这孩子/那同学/这名"等指代，避免把指代误当人名尾缀
    qName = qName.replace(/(这孩子|那孩子|这同学|那同学|这学生|那学生|这位同学|那位同学|这个学生|那个学生|这名|那名|最近|近期)/g, '').trim();
    qName = qName.replace(/((的|数据|情况|信息|记录|档案|学生|同学|最近|表现|近期表现|了)+)$/, '').trim();
    // 仅当剩余整串就是 2-4 个汉字时才视为姓名（避免尾部误抓"表现/最近"等）
    const nm = qName.match(/^([\u4e00-\u9fa5]{2,4})$/);
    // 拒绝把功能词/代词误当成人名（如"不用管""这孩子""那位""全部""其他"等）
    const STAT_WORD = /(课程|课堂|迟到|晚归|旷课|风险|请假|未归|签到|缺勤|情况|统计|排名|对比|趋势|率|记录|档案|所有|名单|列表|文件|为什么|什么原因|为何|什么|怎么|如何|谁|哪|多少|几个|给我看下|给我看|看一下|看下|看看|给我|展示|显示|数据|家长|联系|确认|宿舍|寝室|异常|告警|预警|闭环|处理|不用管|别管|不管|只要|别的|其他|全班|全校|这个|那个|该生|此生|这位|那位|这孩子|那孩子|这同学|那同学|这学生|那学生|大家|人人|每位|他们|她们|咱们)/;
    if (nm && nm[1] && !STAT_WORD.test(nm[1])
        && !/(为什么|什么原因|为何|怎么办|怎么处理|怎么管|整体|全部|所有|各班级|各班|哪位|哪些)/.test(q)
        && !/哪些|多少|几个|所有|列表|名单|排名|对比|趋势|建议|搜索|查找/.test(q)) {
      return finalIntent('student_detail', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, nm[1].trim(), courseFilter, lastCourseFilter);
    }

    // 已提前拦截的管理类意图兜底（理论上不会走到这里，保留以防御万一）
    if (/(宿舍|寝室)/.test(q)) return finalIntent('dorm', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    if (/(趋势|走向|未来|预测|曲线|变化|历史|最近|近)/.test(q)) return finalIntent('trend', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    if (/(搜|找|查找|查询|.*叫.*名字|学生信息)/.test(q)) return finalIntent('search', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, q.replace(/搜|找|查找|查询|叫|名字|学生|信息|的|是|哪/g,'').trim() || '', courseFilter, lastCourseFilter);

    // 今日/总体/概览 + 周期 → 周期总览（去掉过宽的"数据/怎么样"，避免模糊问法硬猜）
    if (/(今日|今天|当前|现在|签到率|总体|概览|统计|情况(?!.*学生)|本周|上周|本月)/.test(q)) {
      if (dateRef.kind === 'week' || dateRef.kind === 'month') return finalIntent('period_overview', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
      return finalIntent('today', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);
    }
    if (/(最近|最新|刚刚|刚才|记录|签到记录)/.test(q)) return finalIntent('recent_records', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, undefined, courseFilter, lastCourseFilter);

    // 模糊追问继承上一轮意图
    if (isFollowUp && lastIntent) {
      let intent = lastIntent;
      // 当上一轮是今日签到率/总览，但追问要名单时，转回带名单的今日未归
      if (lastIntent === 'today' && /要|名单|谁|哪些|哪|那|详细|具体|原因|同学/.test(q)) intent = 'today_with_absent';
      return finalIntent(intent, classFilter, lastClassFilter, dateRef, lastIntent, lastParam, lastParam, courseFilter, lastCourseFilter);
    }

    return finalIntent('clarify', classFilter, lastClassFilter, dateRef, lastIntent, lastParam, question, courseFilter, lastCourseFilter);
  }

  // ==================== 数据加载器（根据意图加载对应数据） ====================
  function loadDataForIntent(intentResult, sessionCtx) {
    const intent = intentResult.intent, param = intentResult.param, classFilter = intentResult.classFilter, courseFilter = intentResult.courseFilter;
    const ir = intentResult;
    switch (intent) {
      case 'today': return analyzeTodayCheckin(classFilter, dateRefDate(ir));
      case 'today_with_absent': {
        const twaToday = analyzeTodayCheckin(classFilter, dateRefDate(ir));
        const twaAbsent = analyzeAbsentList(classFilter, dateRefDate(ir));
        return { today: twaToday, absent: twaAbsent };
      }
      case 'absent_list': return analyzeAbsentList(classFilter, dateRefDate(ir));
      case 'absent_range': {
        const rng = dateRefRange(ir) || { start: getEffectiveToday(), end: getEffectiveToday() };
        return analyzeAbsentRange(classFilter, rng.start, rng.end);
      }
      case 'period_overview': {
        const rng = dateRefRange(ir) || { start: getEffectiveToday(), end: getEffectiveToday() };
        const ov = analyzePeriodOverview(classFilter, rng.start, rng.end);
        ov.class_compare = analyzeClassCompareRange(classFilter, rng.start, rng.end);
        ov.classBreak = ov.class_compare;
        return ov;
      }
      case 'high_risk': return analyzeHighRisk(classFilter, dateRefEnd(ir), dateRefDays(ir));
      case 'trend': {
        let days = 30;
        const rr = ir.dateRef;
        if (rr && rr.kind === 'recentN' && rr.days) days = rr.days;
        else if ((rr && (rr.kind === 'week' || rr.kind === 'month')) && rr.start && rr.end) days = dateDiffDays(rr.start, rr.end);
        // 若 param 为学生名，则生成该生个人缺勤趋势
        const t = analyzeAbsentTrend(days, ir.param);
        t.days = days;
        return t;
      }
      case 'class_compare': return analyzeClassCompare();
      case 'improve_attendance': {
        const cmp = analyzeClassCompare();
        const lowClasses = cmp.filter(c => c.attendance_rate < 85).sort((a,b)=>a.attendance_rate-b.attendance_rate);
        const risk = analyzeHighRisk(classFilter, dateRefEnd(ir), 30);
        const recommendations = generateClassImprovementAdvice(cmp, lowClasses, risk);
        return { comparison: cmp, lowClasses, risk, recommendations };
      }
      case 'leave': return analyzeLeave(classFilter, ir.param);
      case 'late': return analyzeLateStudents(classFilter, dateRefDate(ir));
      case 'dorm': return analyzeDormAnomaly();
      case 'dorm_absence': return analyzeDormAbsence(param, classFilter, dateRefDate(ir));
      case 'dorm_mates': return analyzeDormMates(param, classFilter);
      case 'course': return analyzeCourseAttendance(ir.param === 'absence', classFilter, courseFilter, ir.param === 'analysis');
      case 'student_period_analysis': {
        const rng = dateRefRange(ir) || { start: shiftDate(getEffectiveToday(), -2), end: getEffectiveToday() };
        return analyzeStudentPeriodSummary(param, classFilter, rng.start, rng.end);
      }
      case 'advice':
        // 联系家长建议：若 param 为学生名，或 session 中上一轮是学生档案，则加载该学生信息
        const isContactParent = param === 'contact_parent' || (sessionCtx && sessionCtx.lastData && sessionCtx.lastData.name && /(联系家长|通知家长|告知家长|家长确认)/.test((sessionCtx.lastQuestion || '')));
        if (isContactParent) {
          const contactStudentName = (sessionCtx && sessionCtx.lastData && sessionCtx.lastData.name) || (typeof param === 'string' && param !== 'contact_parent' && param !== 'period_advice' && param.trim().length >= 2 ? param.trim() : '');
          const contactStudent = contactStudentName ? getStudentProfile(contactStudentName, classFilter) : null;
          const cpToday = analyzeTodayCheckin(classFilter, dateRefDate(ir));
          const cpAbsent = analyzeAbsentList(classFilter, dateRefDate(ir));
          const cpSnap = { today: cpToday, absent: cpAbsent, contactStudentName, contactStudent: (contactStudent && !contactStudent.error && !contactStudent.ambiguous) ? contactStudent : null };
          cpSnap.recommendations = [];
          return cpSnap;
        }
        // 综合周期建议：近N天/本周/月 + 考勤数据 + 建议/分析，返回综合数据与权威研判
        if (param === 'period_advice') {
          const rng = dateRefRange(ir) || { start: shiftDate(getEffectiveToday(), -6), end: getEffectiveToday() };
          const advOverview = analyzePeriodOverview(classFilter, rng.start, rng.end);
          const advRisk = analyzeHighRisk(classFilter, rng.end, dateDiffDays(rng.start, rng.end));
          const advClass = analyzeClassCompareRange(classFilter, rng.start, rng.end);
          const advLeave = analyzeLeave(classFilter);
          const advCourse = analyzeCourseAttendance(false, classFilter, courseFilter);
          const advDorm = analyzeDormAnomaly();
          const advSnap = { period: advOverview, risk: advRisk, class_compare: advClass, leave: advLeave, course: advCourse, dorm: advDorm, dateRange: rng, classFilter, periodAdvice: true };
          advSnap.recommendations = generatePeriodAdvice(advSnap);
          return advSnap;
        }
        // advice 默认：只取关键数据（今日+未归+风险+趋势），避免全量快照导致 422
        const advToday = analyzeTodayCheckin(classFilter, dateRefDate(ir));
        const advAbsent = analyzeAbsentList(classFilter, dateRefDate(ir));
        const advRisk = analyzeHighRisk(classFilter, dateRefEnd(ir), dateRefDays(ir));
        const advTrend = analyzeAbsentTrend(dateRefDays(ir));
        let contactStudentName = '';
        if (param && param !== 'contact_parent' && param !== 'period_advice' && typeof param === 'string' && param.trim().length >= 2 && param.trim().length <= 8) {
          contactStudentName = param.trim();
        }
        let contactStudent = null;
        if (contactStudentName) {
          contactStudent = getStudentProfile(contactStudentName, classFilter);
          if (!contactStudent || contactStudent.error || contactStudent.ambiguous) contactStudent = null;
        }
        const advSnap = { today: advToday, absent: advAbsent, risk: advRisk, trend: advTrend, contactStudentName, contactStudent };
        advSnap.recommendations = generateAdvice(advSnap);
        return advSnap;
      case 'report': {
        // report / PDF 导出：按用户限定维度加载数据（course=课堂考勤，dorm=查寝，comprehensive=综合）
        const scope = ir.param || 'comprehensive';
        const isCourse = scope === 'course' || scope === 'comprehensive';
        const isDorm = scope === 'dorm' || scope === 'comprehensive';
        const isAll = scope === 'comprehensive';
        const reportToday = isDorm ? analyzeTodayCheckin(classFilter, dateRefDate(ir)) : null;
        const reportAbsent = isDorm ? analyzeAbsentList(classFilter, dateRefDate(ir)) : null;
        const reportRisk = isAll ? analyzeHighRisk(classFilter, dateRefEnd(ir), 30) : null;
        const reportTrend = (isDorm || isCourse) ? analyzeAbsentTrend(7) : null;
        const reportClass = isDorm ? analyzeClassCompare() : null;
        const reportDorm = isDorm ? analyzeDormAnomaly() : null;
        const reportLeave = isAll ? analyzeLeave(classFilter) : null;
        const reportCourse = isCourse ? analyzeCourseAttendance(false, classFilter, courseFilter) : null;
        const reportCourseClass = isCourse ? analyzeClassCourseStats(classFilter, courseFilter) : null;
        const reportSnap = { scope, classFilter: classFilter || '全部', courseFilter: courseFilter || '', today: reportToday, absent: reportAbsent, risk: reportRisk, trend: reportTrend, class_compare: reportClass, dorm: reportDorm, leave: reportLeave, course: reportCourse, course_class: reportCourseClass };
        reportSnap.recommendations = generateAdvice({ today: reportToday, absent: reportAbsent, risk: reportRisk, trend: reportTrend, dorm: reportDorm, leave: reportLeave });
        return reportSnap;
      }
      case 'student_detail': {
        const prof = getStudentProfile(param, classFilter);
        if (prof) return prof;
        return { error: `未找到名为"${param}"的学生信息`, name: param };
      }
      case 'search':
        return searchStudent(param || '', classFilter);
      case 'alerts':
        return getAlertSummary();
      case 'recent_records':
        return getRecentRecords(15);
      case 'reason': return analyzeReason(classFilter, dateRefDate(ir));
      case 'stats': {
        const totalStudents = db.exec(`SELECT COUNT(*) FROM students`)[0]?.values?.[0]?.[0] || 0;
        const totalClasses = db.exec(`SELECT COUNT(DISTINCT class_name) FROM students WHERE class_name IS NOT NULL AND class_name!=''`)[0]?.values?.[0]?.[0] || 0;
        const totalDorms = db.exec(`SELECT COUNT(DISTINCT dorm) FROM students WHERE dorm IS NOT NULL AND dorm!=''`)[0]?.values?.[0]?.[0] || 0;
        return { totalStudents, totalClasses, totalDorms };
      }
      case 'self_intro':
        return { subTopic: 'self', today: analyzeTodayCheckin(classFilter, dateRefDate(ir)) };
      default:
        // general 回退：仅含汇总与今日签到率，不含任何具体姓名（防止大模型借名编造）
        const t = analyzeTodayCheckin(classFilter, dateRefDate(ir));
        const ov = {
          totalStudents: db.exec(`SELECT COUNT(*) FROM students`)[0]?.values?.[0]?.[0] || 0,
          totalClasses: db.exec(`SELECT COUNT(DISTINCT class_name) FROM students WHERE class_name IS NOT NULL AND class_name!=''`)[0]?.values?.[0]?.[0] || 0,
          totalDorms: db.exec(`SELECT COUNT(DISTINCT dorm) FROM students WHERE dorm IS NOT NULL AND dorm!=''`)[0]?.values?.[0]?.[0] || 0
        };
        return { intent: 'clarify', today: { date: t.date, attendance_rate: t.attendance_rate, present: t.present, absent: t.absent, leave: t.leave, total_students: t.total_students, classFilter: t.classFilter }, overview: ov };
    }
  }

  // ==================== 数据归因（为什么今天未归这么多 / 签到率这么低） ====================
  function analyzeReason(classFilter, date) {
    const d = date || getEffectiveToday();
    const dow = parseDateStr(d).getDay();
    const isWeekend = (dow === 0 || dow === 6);
    const today = analyzeTodayCheckin(classFilter, d);
    // 近30天日均未归（用于对比）
    const start = shiftDate(d, -29);
    let avgAbsent = 0;
    try {
      const r = db.exec(`SELECT COUNT(DISTINCT student_id) as c FROM records WHERE type='checkin' AND status IN ('未归','不在寝') AND date>=? AND date<=? GROUP BY date`, [start, d])[0];
      if (r) { const vals = r.values.map(v => v[0]); avgAbsent = vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : 0; }
    } catch (e) {}
    // 今日各班未归分布
    let classBreak = [];
    try {
      const r = db.exec(`SELECT s.class_name, COUNT(DISTINCT r.student_id) as c FROM records r JOIN students s ON r.student_id=s.id WHERE r.type='checkin' AND r.status IN ('未归','不在寝') AND r.date=? GROUP BY s.class_name ORDER BY c DESC`, [d])[0];
      if (r) classBreak = r.values.map(v => ({ class_name: v[0], count: v[1] }));
    } catch (e) {}
    return { date: d, isWeekend, todayAbsent: today.absent, avgAbsent, classBreak, onLeave: today.leave, rate: today.attendance_rate };
  }

  // ==================== 智能建议生成器（基于实际数据动态生成） ====================
  function generateAdvice(snap) {
    const adv = [];
    const t = snap.today || {};
    if (t.attendance_rate < 85 && t.attendance_rate > 0) {
      adv.push({ level: 'warning', text: `今日签到率仅 ${t.attendance_rate}%，有 ${t.absent||0} 名学生未归，建议尽快联系确认安全` });
    } else if (t.attendance_rate >= 95) {
      adv.push({ level: 'good', text: `今日签到率高达 ${t.attendance_rate}%，整体情况优秀！继续保持` });
    }
    const rk = snap.risk || {};
    if (rk.count > 0) {
      const topNames = (rk.students||[]).slice(0,3).map(s=>s.name).join('、');
      adv.push({ level: 'danger', text: `近30天有 ${rk.count} 名学生缺勤≥3次，其中${topNames}等尤为突出，建议约谈关注` });
    }
    const dm = snap.dorms || snap.dormAnomaly || snap.dorm || [];
    if (Array.isArray(dm) && dm.length > 0) {
      adv.push({ level: 'warning', text: `宿舍"${dm[0].dorm}"近7天缺勤${dm[0].absent}人，异常率${dm[0].rate}%，建议重点排查` });
    }
    const lv = snap.leave || {};
    if (lv.pending > 3) {
      adv.push({ level: 'info', text: `还有 ${lv.pending} 条请假待审批，请尽快处理以免影响学生安排` });
    }
    const al = snap.alerts || {};
    if (al.open > 0) {
      adv.push({ level: 'danger', text: `当前有 ${al.open} 条异常告警待处理，建议优先跟进闭环` });
    }
    if (adv.length === 0) adv.push({ level: 'good', text: '✅ 各项指标正常，暂无特别需要关注的事项' });
    return adv;
  }

  /** 基于班级签到率对比，生成低签到率班级的针对性改进建议 */
  function generateClassImprovementAdvice(allClasses, lowClasses, risk) {
    const adv = [];
    const sorted = [...allClasses].sort((a,b)=>a.attendance_rate-b.attendance_rate);
    const bottom3 = sorted.slice(0, 3);
    const threshold = 85;

    if (lowClasses.length === 0) {
      adv.push({ level: 'good', text: `✅ 所有班级签到率均≥${threshold}%，整体表现良好，建议继续保持现有查寝与考勤管理措施。` });
      return adv;
    }

    // 最低班级
    const bottom = lowClasses[0];
    adv.push({ level: 'warning', text: `🔴 重点整改：${bottom.class_name} 签到率仅 ${bottom.attendance_rate}%（在寝${bottom.present}/未归${bottom.absent}/请假${bottom.leave}），建议辅导员近期加强查寝与考勤督导。` });

    // 其他较低班级
    if (lowClasses.length > 1) {
      const others = lowClasses.slice(1, 4).map(c => `${c.class_name}(${c.attendance_rate}%)`).join('、');
      adv.push({ level: 'warning', text: `⚠️ 同步关注：${others}，共 ${lowClasses.length} 个班级签到率低于${threshold}%，需列入重点观察名单。` });
    }

    // 与最好班级的差距
    const top = sorted[sorted.length-1];
    if (top && top.attendance_rate - bottom.attendance_rate > 10) {
      adv.push({ level: 'info', text: `📊 对标先进：${top.class_name} 签到率达到 ${top.attendance_rate}%，建议组织${bottom.class_name}班委与${top.class_name}交流管理经验。` });
    }

    // 高风险学生
    if (risk && risk.count > 0) {
      const topRisk = risk.students.slice(0, 3).map(s => s.name).join('、');
      adv.push({ level: 'danger', text: `🎯 重点学生：近30天有 ${risk.count} 名学生缺勤≥3次，其中 ${topRisk} 等需逐一约谈并建立帮扶台账。` });
    }

    // 通用改进措施
    adv.push({ level: 'info', text: `💡 建议措施：①召开班会重申考勤纪律与未归安全要求；②对连续未归学生逐一电话确认并记录原因；③建立寝室长每日日报与班委轮值抽查机制；④对签到率持续低于80%的班级启动辅导员驻班随访；⑤将签到率纳入班级月度考核与评优参考。` });

    return adv;
  }

  /** 基于周期综合考勤数据（查寝+课堂+请假+班级对比）生成权威管理建议 */
  function generatePeriodAdvice(snap) {
    const adv = [];
    const p = snap.period || {};
    const days = p.days || 7;
    const rate = p.attendance_rate || 0;
    const present = p.present || 0;
    const absent = p.absent || 0;
    const leave = p.leave || 0;
    const total = p.total_students || 0;

    // 整体查寝签到率判断（核心指标）
    if (rate < 70) {
      adv.push({ level: 'danger', text: `🔴 查寝维度：整体签到率仅 ${rate}%（在寝 ${present} 人次 / 未归 ${absent} 人次 / 请假 ${leave} 人次），显著低于正常水平，需立即排查并加强管理。` });
    } else if (rate < 85) {
      adv.push({ level: 'warning', text: `⚠️ 查寝维度：整体签到率 ${rate}%（在寝 ${present} 人次 / 未归 ${absent} 人次 / 请假 ${leave} 人次），处于偏低区间，建议关注未归学生并强化查寝。` });
    } else {
      adv.push({ level: 'good', text: `✅ 查寝维度：整体签到率 ${rate}%（在寝 ${present} 人次 / 未归 ${absent} 人次 / 请假 ${leave} 人次），宿舍考勤秩序总体良好。` });
    }

    // 课堂维度
    const co = snap.course || {};
    if (co.recent_7d_attendance_records > 0) {
      adv.push({ level: 'info', text: `📚 课堂维度：近7天产生课堂签到记录 ${co.recent_7d_attendance_records} 条，建议结合课堂缺勤名单与查寝异常名单交叉比对，识别“查寝正常但课堂缺勤”或“课堂出勤但宿舍未归”的异常学生。` });
    }

    // 班级对比
    const cls = snap.class_compare || [];
    if (cls.length > 1) {
      const sorted = [...cls].sort((a, b) => b.attendance_rate - a.attendance_rate);
      const top = sorted[0];
      const bottom = sorted[sorted.length - 1];
      if (bottom.attendance_rate < 85) {
        adv.push({ level: 'warning', text: `🏫 班级差距：表现最好的是 ${top.class_name}（${top.attendance_rate}%），最低的是 ${bottom.class_name}（${bottom.attendance_rate}%），建议对 ${bottom.class_name} 重点督导并学习 ${top.class_name} 的管理经验。` });
      }
    }

    // 高风险学生
    const risk = snap.risk || {};
    if (risk.count > 0) {
      const topRisk = (risk.students || []).slice(0, 3).map(s => s.name).join('、');
      adv.push({ level: 'danger', text: `🎯 重点关注：周期内有 ${risk.count} 名学生缺勤≥3次${topRisk ? '，其中 ' + topRisk + ' 等' : ''}建议逐一约谈并建立帮扶台账。` });
    }

    // 请假待审批
    const lv = snap.leave || {};
    if (lv.pending > 0) {
      adv.push({ level: 'info', text: `📋 请假待办：当前仍有 ${lv.pending} 条请假待审批，建议及时审批以免影响学生安排与考勤统计。` });
    }

    // 宿舍异常
    const dm = snap.dorm || [];
    if (dm.length > 0) {
      adv.push({ level: 'warning', text: `🏠 宿舍异常：${dm[0].dorm} 近7天缺勤 ${dm[0].absent} 人，异常率 ${dm[0].rate}%，建议辅导员走访排查。` });
    }

    // 通用管理措施
    adv.push({ level: 'info', text: `💡 管理措施：①对未归学生实行“发现—联系—记录—闭环”四步管理；②对连续缺勤学生启动辅导员/班主任约谈；③利用班级签到率排名开展良性竞赛；④将宿舍异常纳入寝室长考核；⑤每日早会通报前一日考勤情况，形成常态化管理。` });

    return adv;
  }

  // ==================== 澄清反问生成器（不确定时反问，不瞎答） ====================
  function buildClarify(question, timeDesc) {
    const q = (question || '').trim();
    // 课程指代类（这门课/那门课/该课程）：没有上下文时，提示用户给出课程名
    if (/(这门课|那门课|该门课|此门课|这节课|那节课|该节课|此节课|该课程|此课程|这门课程|此课程|该课|此课)/.test(q)) {
      return `💬 你提到的"这门课"没有上下文，我还不知道具体是哪门课～\n\n` +
        `👉 请直接告诉我课程名，例如：\n` +
        `• "摄影测量学上课情况"\n` +
        `• "误差理论与测量平差记录"\n` +
        `• "测量平差出勤率"\n\n` +
        `🔎 如果你刚查过某门课，直接说"这门课的情况"我会自动继承上下文哦～`;
    }
    // 学生指代类（那个学生/这个学生/该学生）：没有上下文时，请用户给出姓名
    if (/(那个学生|这个学生|该学生|该生|这个同学|那个同学|该同学)/.test(q)) {
      return `💬 你提到的"那个学生"没有上下文，我还不知道具体是谁～\n\n` +
        `👉 请直接告诉我学生姓名，例如：\n` +
        `• "查一下叶剑的情况"\n` +
        `• "叶剑近3天的记录汇总"\n` +
        `• "联系家长确认叶剑"\n\n` +
        `🔎 如果你刚查过某位学生，直接说"那个学生"或"该生"我会自动继承上下文哦～`;
    }
    // 两人对比类（张三和李四谁缺勤多）：给出针对性引导，而非泛泛反问
    const two = q.match(/([\u4e00-\u9fa5]{2,4})[、，,与和跟]([\u4e00-\u9fa5]{2,4})/);
    if (two && /(缺勤|签到|请假|出勤|情况|对比|比较|谁|多|少|怎么样|如何|分析|档案|记录)/.test(q)) {
      return `💬 关于「${q}」，目前我一次只能精确分析**一位**学生的出勤/缺勤情况，暂不支持两人直接对比～\n\n` +
        `👉 你可以分别问我：\n` +
        `• "查一下${two[1]}的情况"\n` +
        `• "查一下${two[2]}的情况"\n\n` +
        `我会分别给出两人的查寝、课堂出勤与请假记录，你就能直接对比啦。`;
    }
    const qText = q ? `关于「${q}」，` : '';
    return `💬 ${qText}我还不太确定你想了解哪方面，先跟你确认一下～\n\n` +
      `你可以这样问我：\n` +
      `• **查寝 / 宿舍**："今天谁没归"、"2栋101哪些人未归"、"宿舍异常情况"\n` +
      `• **签到率**："今天全校签到率"、"测绘2301班签到情况"\n` +
      `• **课堂出勤**："今天课堂出勤如何"、"谁旷课 / 缺课"\n` +
      `• **风险 / 趋势**："高风险学生有哪些"、"最近缺勤趋势"\n` +
      `• **学生档案**："查一下张三的情况"、"搜一下李四"\n` +
      `• **请假**："待审批请假有哪些"\n\n` +
      `🔎 小提示：查寝的「缺勤 / 未归」和课堂的「出勤 / 缺课」是两个维度，告诉我具体方向我就帮你精确查～`;
  }

  // ==================== 自然语言回答生成器 v2（本地回退——智能自然语言生成） ====================
  function formatLocalAnswer(intentResult, data, _rawQuestion) {
    const intent = intentResult.intent;
    const now = new Date();
    const weekDays = ['日','一','二','三','四','五','六'];
    // 星期取自有效"今天"（getEffectiveToday），避免与日期标签（如 2026-07-17）矛盾
    const effDow = parseDateStr(getEffectiveToday()).getDay();
    const timeDesc = `现在是${now.getHours()}点${now.getMinutes()}分，星期${weekDays[effDow]}`;

    switch (intent) {
      case 'stats': {
        return `【基础统计】${timeDesc}\n\n` +
          `👥 在校学生总数：**${data.totalStudents}** 人\n` +
          `🏫 班级总数：**${data.totalClasses}** 个\n` +
          `🛏️ 宿舍总数：**${data.totalDorms}** 间\n\n` +
          `💡 如需查看具体班级或宿舍的签到情况，告诉我班级名或宿舍号即可～`;
      }
      case 'reason': {
        const delta = data.avgAbsent > 0 ? (data.todayAbsent - data.avgAbsent) : 0;
        let head = `【数据归因 · ${data.date}】${timeDesc}\n\n`;
        head += `📊 今日未归 **${data.todayAbsent}** 人（签到率 ${data.rate}%），近30天日均未归约 **${data.avgAbsent}** 人`;
        head += delta > 0 ? `，较平日**多 ${delta}** 人。\n` : `，与平日基本持平。\n`;
        const reasons = [];
        if (data.isWeekend) reasons.push('📅 今天是**周末**，学生离校/外出比例通常更高，未归人数易高于工作日；');
        if (delta > 0) reasons.push(`📈 较近30天日均多 ${delta} 人，属阶段性升高，建议结合具体日期排查是否有集体活动、节假日或天气因素；`);
        if (data.classBreak && data.classBreak.length) {
          const top = data.classBreak.slice(0, 3).map(c => `${c.class_name}(${c.count}人)`).join('、');
          reasons.push(`🏫 未归集中在：${top}，可优先向这些班级的辅导员核实；`);
        }
        if (data.onLeave > 0) reasons.push(`📋 今日另有 **${data.onLeave}** 人处于请假状态（已审批），这部分不计入未归但会减少在寝人数；`);
        reasons.push('💡 进一步定位：可问"今天XX班谁没归"或"本周未归名单"查看明细，并在异常闭环中登记处理。');
        return head + '\n🔎 可能原因（基于数据）：\n' + reasons.map((r, i) => `${i + 1}. ${r}`).join('\n');
      }
      case 'clarify': {
        return buildClarify(intentResult.param || _rawQuestion, timeDesc);
      }
      case 'today': {
        const d = data;
        const rateLevel = d.attendance_rate >= 95 ? '🎉 非常好' : d.attendance_rate >= 85 ? '✅ 良好' : d.attendance_rate >= 70 ? '⚠️ 需关注' : '🔴 较低';
        const clsLabel = d.classFilter && d.classFilter !== '全部' ? `【${d.classFilter}班】` : '';
        return `${clsLabel}【${d.date} 签到总览】${timeDesc}\n\n` +
          `📊 今日签到率 **${d.attendance_rate}%**（${rateLevel}）\n` +
          `👥 在寝 **${d.present}** 人 / 未归 **${d.absent}** 人 / 请假 **${d.leave}** 人\n` +
          `📝 应到学生总数 **${d.total_students}** 人\n` +
          (d.absent > 0 ? `\n⚠️ 有 ${d.absent} 名学生未归，建议点击下方"未归学生分析"查看详细名单并联系确认。` :
           d.attendance_rate >= 95 ? '\n👍 今天出勤情况很好，辛苦各位辅导员老师！' :
           '\n💡 整体情况正常，继续保持。');
      }

      case 'today_with_absent': {
        const t = data.today || {};
        const a = data.absent || {};
        const rateLevel = t.attendance_rate >= 95 ? '🎉 非常好' : t.attendance_rate >= 85 ? '✅ 良好' : t.attendance_rate >= 70 ? '⚠️ 需关注' : '🔴 较低';
        const clsLabel = t.classFilter && t.classFilter !== '全部' ? `【${t.classFilter}班】` : '';
        let ans = `${clsLabel}【${t.date} 签到总览】${timeDesc}\n\n` +
          `📊 今日签到率 **${t.attendance_rate}%**（${rateLevel}）\n` +
          `👥 在寝 **${t.present}** 人 / 未归 **${t.absent}** 人 / 请假 **${t.leave}** 人\n` +
          `📝 应到学生总数 **${t.total_students}** 人\n`;
        if (a.count > 0) {
          const list = a.students.map(s => `• **${s.name}**（${s.class_name} / ${s.dorm}${s.phone ? ` / ${s.phone}` : ''}）`).join('\n');
          ans += `\n⚠️ 未归学生名单（共 ${a.count} 人）：\n${list}\n\n💡 建议逐一电话联系确认安全，并在异常闭环中登记处理结果。`;
        } else {
          ans += '\n🎉 太棒了！今天没有未归学生，全员到位。';
        }
        return ans;
      }

      case 'absent_list': {
        if (data.count === 0) return `【未归学生】${timeDesc}\n\n🎉 太棒了！${data.date||'今天'}没有未归学生，全员到位！`;
        const list = data.students.map(s => `• **${s.name}**（${s.class_name} / ${s.dorm}${s.phone ? ` / ${s.phone}`:''}）`).join('\n');
        return `【${data.date} 未归学生 · 共 ${data.count} 人】${timeDesc}\n\n${list}\n\n` +
          `💡 建议逐一电话联系确认安全，并在异常闭环中登记处理结果。`;
      }

      case 'high_risk': {
        if (data.count === 0) return `【高风险学生】${timeDesc}\n\n🎉 近30天内没有发现缺勤≥3次的高风险学生，表现不错！`;
        const list = data.students.map(s =>
          `• **${s.name}**（${s.class_name}）：缺勤 **${s.absent}** 天${s.leaves>0?` / 请假 ${s.leaves} 天`:''}`
        ).join('\n');
        return `【高风险学生 · 近30天缺勤≥3次 · 共 ${data.count} 人】${timeDesc}\n\n${list}\n\n` +
          `⚠️ 这些学生需要重点关注，建议安排辅导员一对一谈话了解原因。`;
      }

      case 'trend': {
        if (!data.daily || data.daily.length === 0) {
          if (data.studentName) return `【${data.studentName} 近30天缺勤趋势】${timeDesc}\n\n该生近30天暂无未归记录。`;
          return `【缺勤趋势】${timeDesc}\n\n暂无足够的历史数据来分析趋势。`;
        }
        const worstDay = data.daily.reduce((a,b)=>a.count>b.count?a:b);
        const bestDay = data.daily.reduce((a,b)=>a.count<b.count?a:b);
        const trendDir = data.daily.length >= 2
          ? (data.daily[data.daily.length-1].count > data.daily[0].count ? '📈 呈上升趋势' :
             data.daily[data.daily.length-1].count < data.daily[0].count ? '📉 呈下降趋势' : '➡️ 基本平稳')
          : '';
        const daysLabel = data.days ? `近${data.days}天` : '近30天';
        if (data.studentName) {
          return `【${data.studentName} ${daysLabel}缺勤趋势】${timeDesc}\n\n` +
            `📊 累计未归 **${data.total}** 人次 | 日均 **${data.avg}** 次 | 峰值 **${data.peak}** 次/天\n` +
            `🔴 缺勤最多：${worstDay.date}（${worstDay.count}次）\n` +
            `🟢 缺勤最少：${bestDay.date}（${bestDay.count}次）\n` +
            `${trendDir}\n` +
            (data.peak > data.avg * 2 ? '\n⚠️ 峰值天数是日均的2倍以上，建议关注该生近期状态。' : '');
        }
        return `【${daysLabel}缺勤趋势】${timeDesc}\n\n` +
          `📊 累计缺勤 **${data.total}** 人次 | 日均 **${data.avg}** 人 | 峰值 **${data.peak}** 人/天\n` +
          `🔴 缺勤最多：${worstDay.date}（${worstDay.count}人）\n` +
          `🟢 缺勤最少：${bestDay.date}（${bestDay.count}人）\n` +
          `${trendDir}\n` +
          (data.peak > data.avg * 2 ? '\n⚠️ 峰值天数是日均的2倍以上，存在集中性缺勤现象，建议排查原因。' : '');
      }

      case 'class_compare': {
        if (!data || data.length === 0) return `【班级对比】${timeDesc}\n\n暂无班级数据。`;
        const sorted = [...data].sort((a,b)=>b.attendance_rate-a.attendance_rate);
        const top = sorted[0], bottom = sorted[sorted.length-1];
        const list = data.slice(0, 8).map(c =>
          `• **${c.class_name}**：签到率 **${c.attendance_rate}%**（在寝${c.present}/未归${c.absent}/请假${c.leave}）`
        ).join('\n');
        return `【各班级签到率对比】${timeDesc}\n\n${list}` +
          (data.length > 8 ? `\n... 共 ${data.length} 个班级` : '') +
          `\n\n🏆 表现最佳：**${top.class_name}**（${top.attendance_rate}%）\n` +
          (bottom.attendance_rate < top.attendance_rate - 10 ? `💪 需加油：**${bottom.class_name}**（${bottom.attendance_rate}%），差距较明显` : '');
      }

      case 'improve_attendance': {
        const cmp = data.comparison || [];
        if (cmp.length === 0) return `【低签到率班级改进建议】${timeDesc}\n\n暂无班级数据。`;
        const lowClasses = data.lowClasses || [];
        const list = cmp.slice(0, 8).map(c =>
          `• **${c.class_name}**：签到率 **${c.attendance_rate}%**（在寝${c.present}/未归${c.absent}/请假${c.leave}）`
        ).join('\n');
        const items = (data.recommendations || []).map(a => a.text || a).join('\n\n');
        return `【低签到率班级改进建议】${timeDesc}\n\n📊 各班级签到率对比：\n${list}` +
          (cmp.length > 8 ? `\n... 共 ${cmp.length} 个班级` : '') +
          `\n\n💡 针对性改进建议：\n\n${items}`;
      }

      case 'period_overview': {
        const d = data;
        const label = (d.classFilter && d.classFilter !== '全部') ? `【${d.classFilter}班】` : '【全校】';
        if (!d.days || d.days <= 0) return `【周期签到总览】${timeDesc}\n\n该时间段暂无签到数据。`;
        return `${label}【${d.start} ~ ${d.end} 周期总览 · 共 ${d.days} 天】${timeDesc}\n\n` +
          `📊 在寝 **${d.present}** 人次 | 未归 **${d.absent}** 人次 | 请假 **${d.leave}** 人次\n` +
          `📝 应到合计 **${d.total_students}** 人 × ${d.days} 天 = ${d.total_students * d.days} 人次\n` +
          `📈 周期签到率 **${d.attendance_rate}%**\n` +
          (d.attendance_rate < 85 ? '\n⚠️ 该周期整体出勤偏低，建议结合每日明细排查集中缺勤日。' : '\n✅ 该周期出勤情况总体平稳。');
      }

      case 'absent_range': {
        if (!data || data.count === 0) return `【区间未归学生】${timeDesc}\n\n🎉 ${data && data.start ? `${data.start}~${data.end}` : '该时间段'}没有未归学生，全员到位！`;
        const list = data.students.slice(0, 50).map(s =>
          `• **${s.name}**（${s.class_name} / ${s.dorm}）缺勤：${(s.dates||[]).join('、')}`
        ).join('\n');
        const extra = data.count > 50 ? `\n... 等 ${data.count} 名学生` : '';
        return `【${data.start} ~ ${data.end} 未归学生 · 共 ${data.count} 人（${data.days} 天）】${timeDesc}\n\n${list}${extra}\n\n💡 建议逐一电话联系确认安全，并在异常闭环中登记处理结果。`;
      }

      case 'leave': {
        const d = data;
        if (d.mode === 'class_compare') {
        const list = (d.classBreakdown || []).map(c =>
          `• **${c.class_name}**：近30天请假 **${c.total_leaves}** 人次，人均约 **${(c.leave_rate/100).toFixed(2)}** 次（病假${c.sick}/事假${c.personal}/公假${c.official}/丧假${c.bereavement}，今日在假${c.on_leave}，待审批${c.pending}）`
        ).join('\n');
          if (!d.classBreakdown || d.classBreakdown.length === 0) return `【各班级请假情况对比】${timeDesc}\n\n暂无班级请假数据。`;
          const sorted = [...d.classBreakdown].sort((a,b)=>b.total_leaves - a.total_leaves);
          const top = sorted[0], bottom = sorted[sorted.length-1];
          return `【各班级请假情况对比 · 近30天】${timeDesc}\n\n${list}\n\n` +
            `📊 请假最多班级：**${top.class_name}**（${top.total_leaves}人次，人均约${(top.leave_rate/100).toFixed(2)}次）\n` +
            `📊 请假最少班级：**${bottom.class_name}**（${bottom.total_leaves}人次，人均约${(bottom.leave_rate/100).toFixed(2)}次）\n` +
            (top.total_leaves > bottom.total_leaves * 1.5 ? `⚠️ ${top.class_name}的请假人次比${bottom.class_name}高出${Math.round((top.total_leaves/bottom.total_leaves-1)*100)}%，建议关注该班学生健康与事务压力。` : '');
        }
        const recentList = (d.recent_leaves||[]).slice(0,5).map(l =>
          `• **${l.name}**（${l.class_name}）：${l.type}-${l.status}${l.reason?' · '+l.reason.substring(0,20):''}`
        ).join('\n');
        return `【请假情况】${timeDesc}\n\n` +
          `📋 待审批 **${d.pending}** 条 | 今日在假 **${d.today_on_leave}** 人\n` +
          (d.recent_30d_types.length ? `📂 近30天类型分布：${d.recent_30d_types.map(t=>`${t.type}(${t.count})`).join('、')}\n` : '') +
          (recentList ? `\n📌 最近请假：\n${recentList}` : '') +
          (d.pending > 0 ? '\n\n⏰ 有待审批的请假，建议及时处理。' : '\n✅ 当前无积压的待审批请假。');
      }

      case 'dorm': {
        if (!data || data.length === 0) return `【宿舍异常】${timeDesc}\n\n🎉 近7天没有发现异常宿舍，各宿舍表现良好！`;
        const list = data.map(d =>
          `• **${d.dorm}**（共${d.total}人）：缺勤 **${d.absent}** 人，异常率 **${d.rate}%**`
        ).join('\n');
        return `【近7天异常宿舍 · 共 ${data.length} 间】${timeDesc}\n\n${list}\n\n` +
          `💡 建议对异常率较高的宿舍进行走访了解，排除管理盲区。`;
      }

      case 'dorm_absence': {
        if (!data || data.absent_count === 0) {
          return `【${data.dormLike || '该宿舍'} 查寝缺勤】${timeDesc}\n\n🎉 ${data.date} 该宿舍（共 ${data.total||0} 人）暂无查寝未归记录，表现良好！`;
        }
        const list = data.absent.map(s => {
          const t = s.time || '';
          const tStr = t.includes(' ') ? t.split(' ')[1] : t;
          return `• **${s.name}**（${s.class_name} / ${s.dorm}）：${s.status}${tStr ? ' @ ' + tStr : ''}`;
        }).join('\n');
        return `【${data.dormLike} 查寝缺勤 · 共 ${data.absent_count} 人】${data.date}${timeDesc}\n\n` +
          `🏫 该宿舍共 ${data.total||0} 人，当日查寝未归 **${data.absent_count}** 人：\n${list}\n\n` +
          `💡 以上为查寝维度（未归/不在寝），与课堂出勤是不同统计口径，如需课堂缺课请单独问我~`;
      }

      case 'late': {
        if (data.count === 0) return `【迟到 / 晚归】${timeDesc}\n\n🎉 今日暂无课堂迟到或查寝晚归学生。`;
        // 按维度分组：课堂迟到 vs 查寝晚归（不混为一谈）
        const classLate = data.students.filter(s => s.type === 'class');
        const checkinBack = data.students.filter(s => s.type === 'checkin');
        const classList = classLate.map(s => {
          const t = s.time || '';
          const tStr = t.includes(' ') ? t.split(' ')[1] : t;
          return `• **${s.name}**（${s.class_name}）迟到${tStr ? ' @ ' + tStr : ''}`;
        }).join('\n');
        const checkinList = checkinBack.map(s => {
          const t = s.time || '';
          const tStr = t.includes(' ') ? t.split(' ')[1] : t;
          return `• **${s.name}**（${s.class_name} / ${s.dorm||'-'}）晚归${tStr ? ' @ ' + tStr : ''}`;
        }).join('\n');
        let body = '';
        if (classLate.length) body += `📚 **课堂迟到（出勤维度）· ${classLate.length} 人**\n${classList}\n\n`;
        if (checkinBack.length) body += `🏫 **查寝晚归（宿舍维度）· ${checkinBack.length} 人**\n${checkinList}\n\n`;
        return `【迟到 / 晚归 · 共 ${data.count} 人】${timeDesc}\n\n${body}` +
          `💡 课堂迟到与查寝晚归分属不同维度，已分别列出；建议及时关注并确认原因。`;
      }

      case 'course': {
        const d = data;
        const isAnalysis = intentResult.param === 'analysis';
        const courseLabel = d.courseFilter ? `「${d.courseFilter}」` : '';
        if (isAnalysis) {
          // 课堂考勤分析：给出出勤率、迟到率、缺课率、班级分布、缺课/迟到名单、趋势
          const title = `【课程考勤分析${courseLabel}】`;
          const clsStats = (d.class_stats || []).map(c =>
            `• **${c.class_name}**：出勤率 ${c.attendance_rate}%（出勤 ${c.present} / 总 ${c.total}，迟到 ${c.late}，缺课 ${c.absent}）`
          ).join('\n') || '暂无班级统计数据。';
          const absentList = (d.absent_students || []).slice(0, 10).map(s =>
            `• **${s.name}**（${s.class_name}）：缺课 ${s.count} 次`
          ).join('\n');
          const lateList = (d.late_students || []).slice(0, 10).map(s =>
            `• **${s.name}**（${s.class_name}）：迟到 ${s.count} 次`
          ).join('\n');
          const trend = (d.daily_trend || []).map(day =>
            `${day.date}: 出勤 ${day.present_records || day.present}/${day.total_records || day.total}，迟到 ${day.late_records || day.late}，缺课 ${day.absent_records || day.absent}`
          ).join('\n') || '暂无按天趋势数据。';
          const absentTip = d.absent_students && d.absent_students.length
            ? `\n\n⚠️ **缺课重点关注（近7天）**\n${absentList}`
            : '';
          const lateTip = d.late_students && d.late_students.length
            ? `\n\n⏰ **迟到重点关注（近7天）**\n${lateList}`
            : '';
          return `${title}${timeDesc}\n\n` +
            `📊 近7天课堂考勤总体情况\n` +
            `• 总记录：${d.total || 0} 条\n` +
            `• 出勤：${d.present || 0} 人次（出勤率 ${d.attendance_rate || 0}%）\n` +
            `• 迟到：${d.late || 0} 人次（迟到率 ${d.late_rate || 0}%）\n` +
            `• 缺课：${d.absent || 0} 人次（缺课率 ${d.absent_rate || 0}%）\n\n` +
            `🏫 各班级出勤情况\n${clsStats}\n\n` +
            `📈 近7天按天趋势\n${trend}` +
            absentTip +
            lateTip +
            ((d.absent_rate || 0) >= 10 ? '\n\n💡 建议：该课程缺课率偏高，建议任课教师/辅导员重点跟进缺课学生，必要时联系家长确认原因。' :
             (d.late_rate || 0) >= 10 ? '\n\n💡 建议：该课程迟到率偏高，建议加强课堂纪律提醒，关注迟到频繁学生。' : '');
        }
        const title = d.absenceOnly ? `【课堂缺勤/旷课${courseLabel}】` : `【课程签到${courseLabel}】`;
        const recList = (d.recent_records||[]).slice(0,8).map(r =>
          `• **${r.name}**（${r.class_name}）：${r.course_name||'课程'} - ${r.status} (${r.time})`
        ).join('\n');
        return `${title}${timeDesc}\n\n` +
          `📚 近7天${d.absenceOnly ? '课堂缺勤/旷课记录' : '课堂签到记录'} **${d.recent_7d_attendance_records}** 条\n` +
          (recList ? `\n📌 最近记录：\n${recList}` : '\n暂无相关课堂记录。') +
          (d.recent_7d_attendance_records < 5 ? '\n\n💡 近期课堂签到记录偏少，记得按时发布签到任务哦。' : '');
      }

      case 'advice': {
        const isContactParent = intentResult.param === 'contact_parent' || (data.contactStudent && data.contactStudent.name) || data.contactStudentName;
        if (isContactParent) {
          const student = data.contactStudent;
          const studentName = (student && student.name) || data.contactStudentName || '';
          const absent = data.absent || {};
          let body = '';
          if (student && student.name) {
            body = `📞 针对学生：**${student.name}**（${student.class_name || '-'} / ${student.dorm || '-'} / 学号 ${student.student_id || '-'}）\n\n`;
            body += `• 联系电话：${student.phone || '暂无'}\n`;
            body += `• 近30天查寝在寝率：${student.checkin_stats_30d?.attend_rate || 0}%（在寝 ${student.checkin_stats_30d?.present || 0} / 总计 ${student.checkin_stats_30d?.total || 0}）\n`;
            body += `• 近30天课堂出勤率：${student.class_stats_30d?.attend_rate || 0}%（出勤 ${student.class_stats_30d?.present || 0} / 总计 ${student.class_stats_30d?.total || 0}）\n`;
            body += `• 近30天未归次数：${student.checkin_stats_30d?.absent || 0} 次，课堂缺课：${student.class_stats_30d?.absent || 0} 次，请假：${student.recent_leaves ? student.recent_leaves.length : 0} 条\n\n`;
          } else if (studentName) {
            body = `📞 已指定学生：${studentName}（未找到完整档案，请核对姓名）\n\n`;
          } else {
            body = `📞 当前未指定具体学生，今日未归 ${absent.count || 0} 人，可逐一电话联系确认安全。\n\n`;
          }
          body += `💡 联系家长/确认安全的建议流程：\n\n`;
          body += `1. **先联系学生本人**：拨打学生电话，确认当前位置、安全状态与未归原因；\n`;
          body += `2. **再联系家长/紧急联系人**：若学生电话未接、关机或情况异常，立即联系家长，说明学生近30天考勤/查寝情况；\n`;
          body += `3. **记录闭环信息**：通话时间、联系人、学生状态、家长反馈、后续处理措施（如辅导员介入、寝室长关注等）；\n`;
          body += `4. **分级处理**：对连续未归或高风险学生，建议辅导员/班主任面谈，必要时启动学院预警流程；\n`;
          body += `5. **保护隐私**：联系时注意措辞，避免在公开场合泄露学生个人信息。`;
          return `【联系家长确认】${timeDesc}\n\n${body}`;
        }
        const items = (data.recommendations || []).map(a => a.text || a).join('\n\n');
        // 周期综合建议（近N天/本周/月 + 考勤数据 + 建议）输出权威综合分析
        if (data.period && data.dateRange) {
          const p = data.period;
          const r = data.risk || {};
          const cls = data.class_compare || [];
          const lv = data.leave || {};
          const co = data.course || {};
          const dm = data.dorm || [];
          const clsLabel = (p.classFilter && p.classFilter !== '全部') ? `【${p.classFilter}】` : '';
          const topClass = cls.length > 0 ? [...cls].sort((a, b) => b.attendance_rate - a.attendance_rate)[0] : null;
          const bottomClass = cls.length > 0 ? [...cls].sort((a, b) => a.attendance_rate - b.attendance_rate)[0] : null;
          const leaveTotal = (lv.recent_30d_types || []).reduce((s, t) => s + (t.count || 0), 0);
          return `${clsLabel}【近${p.days}天综合考勤分析与建议】${timeDesc}\n\n` +
            `📅 分析周期：${p.start} 至 ${p.end}（共 ${p.days} 天，覆盖 ${p.total_students} 名学生）\n\n` +
            `🏠 查寝综合：在寝 ${p.present} 人次 / 未归 ${p.absent} 人次 / 请假 ${p.leave} 人次，平均签到率 **${p.attendance_rate}%**\n` +
            `📚 课堂综合：近7天课堂签到记录 **${co.recent_7d_attendance_records || 0}** 条\n` +
            `📋 请假综合：近30天请假 **${leaveTotal}** 人次，当前待审批 **${lv.pending || 0}** 条\n` +
            `⚠️ 高风险学生：近${p.days}天有 **${r.count || 0}** 人缺勤≥3次\n` +
            (topClass && bottomClass ? `🏫 班级对比：最高 ${topClass.class_name}（${topClass.attendance_rate}%），最低 ${bottomClass.class_name}（${bottomClass.attendance_rate}%）\n` : '') +
            (dm.length > 0 ? `🏠 异常宿舍：${dm[0].dorm} 缺勤 ${dm[0].absent} 人，异常率 ${dm[0].rate}%\n` : '') +
            `\n💡 管理建议：\n\n${items}`;
        }
        const clsLabel = (data.today && data.today.classFilter && data.today.classFilter !== '全部') ? `【${data.today.classFilter}班】` : '';
        return `${clsLabel}【🤖 智能管理建议】${timeDesc}\n\n基于系统数据分析，为您生成以下建议：\n\n${items}`;
      }

      case 'student_period_analysis': {
        const d = data;
        if (d.error) return `【学生个人周期分析】${timeDesc}\n\n${d.error}`;
        const s = d.student;
        const st = d.stats;
        const checkinSummary = `🏠 查寝：在寝 ${st.checkin.present} 天 / 未归 ${st.checkin.absent} 天 / 晚归 ${st.checkin.late} 天 / 请假 ${st.checkin.leave} 天（共 ${st.checkin.total} 条记录）`;
        const courseSummary = `📚 课堂：出勤 ${st.course.present} 次 / 迟到 ${st.course.late} 次 / 缺课 ${st.course.absent} 次（共 ${st.course.total} 条记录）`;
        const leaveSummary = `📝 请假：共 ${st.leave} 条请假记录`;

        // 每日明细：合并查寝与课堂记录
        const dateMap = new Map();
        d.checkinRecords.forEach(r => {
          if (!dateMap.has(r.date)) dateMap.set(r.date, { checkin: [], course: [] });
          dateMap.get(r.date).checkin.push(r);
        });
        d.courseRecords.forEach(r => {
          if (!dateMap.has(r.date)) dateMap.set(r.date, { checkin: [], course: [] });
          dateMap.get(r.date).course.push(r);
        });
        const sortedDates = Array.from(dateMap.keys()).sort().reverse();
        const detailLines = sortedDates.slice(0, 10).map(date => {
          const day = dateMap.get(date);
          const checkinStr = day.checkin.length ? `查寝：${day.checkin.map(r => r.status).join('、')}` : '';
          const courseStr = day.course.length ? `课堂：${day.course.map(r => `${r.course || '课程'}-${r.status}`).join('、')}` : '';
          return `• ${date} ${[checkinStr, courseStr].filter(Boolean).join('；')}`;
        }).join('\n');

        // 风险提示
        let riskTip = '';
        if (st.checkin.absent >= 2) riskTip += '\n⚠️ 近3天多次未归，建议联系学生确认安全状况。';
        if (st.course.absent >= 2) riskTip += '\n⚠️ 近3天多次缺课，建议关注学业状态并提醒任课教师。';
        if (st.course.late >= 2) riskTip += '\n⚠️ 近3天多次迟到，建议加强课堂纪律提醒。';
        if (!riskTip) riskTip = '\n✅ 近3天整体表现正常，无显著异常。';

        // 若用户是在纠正上一轮范围（如"我要的是那个学生的不是所有的"），先给出自然语言确认
        const isCorrection = _rawQuestion && /(那个学生|这个学生|该学生|不是所有|不要全部|不要全校|只要.*个人|不要.*整体|不要.*大家)/.test(_rawQuestion);
        const ack = isCorrection ? `好的，我理解为只要 **${s.name}** 个人的记录，不是全班/全校数据。\n\n` : '';

        return `${ack}【${s.name} 近${d.days}天综合记录汇总】${timeDesc}\n\n` +
          `👤 学生：${s.name}（${s.class_name} / ${s.dorm || '-'} / 学号 ${s.student_id || '-'}）\n` +
          `📅 分析周期：${d.start} 至 ${d.end}（共 ${d.days} 天）\n\n` +
          `${checkinSummary}\n` +
          `${courseSummary}\n` +
          `${leaveSummary}\n\n` +
          `📋 每日明细（最近 ${Math.min(sortedDates.length, 10)} 天）：\n${detailLines || '暂无记录'}\n` +
          `${riskTip}`;
      }

      case 'report': {
        // 正常走 PDF 分支生成文件，这里仅作为 PDF 生成失败或 fallback 的文本兜底
        const scope = (data.scope || 'comprehensive');
        const cf = data.classFilter || '全部';
        const ccf = data.courseFilter || '';
        const clsLabel = cf !== '全部' ? `【${cf}】` : '';
        const courseLabel = ccf ? `「${ccf}」` : '';
        const t = data.today || {};
        const a = data.absent || {};
        const r = data.risk || {};
        const tr = data.trend || {};
        const cls = data.class_compare || [];
        const dms = data.dorm || [];
        const lv = data.leave || {};
        const co = data.course || {};
        const ccls = data.course_class || [];
        const adv = (data.recommendations || []).map(x => x.text || x).join('\n');
        if (scope === 'course') {
          return `【📚 ${clsLabel}${courseLabel}课堂考勤数据分析报告】${timeDesc}\n\n` +
            `📚 近7天${clsLabel}${courseLabel}课堂签到记录：${co.recent_7d_attendance_records || 0} 条\n` +
            (ccls.length > 0 ? `🏫 各班级课堂出勤情况：\n${ccls.slice(0, 20).map(c => `• ${c.class_name}：出勤率 ${c.attendance_rate}%（出勤 ${c.present} / 缺课 ${c.absent} / 迟到 ${c.late}）`).join('\n')}\n\n` : '') +
            `📌 最近课堂记录：\n${(co.recent_records || []).slice(0, 10).map(rec => `• ${rec.name}（${rec.class_name}）${rec.course || '课程'} - ${rec.status} (${rec.time})`).join('\n') || '暂无记录'}\n\n` +
            `💡 管理建议：\n${adv || '课堂出勤情况正常，暂无特别建议。'}`;
        }
        if (scope === 'dorm') {
          return `【🏠 ${clsLabel}查寝数据分析报告】${timeDesc}\n\n` +
            `📅 今日签到率：${t.attendance_rate || 0}%（在寝 ${t.present || 0} / 未归 ${t.absent || 0} / 请假 ${t.leave || 0}）\n` +
            `⚠️ 今日未归：${a.count || 0} 人\n` +
            `🏫 各班级签到率对比：\n${cls.slice(0, 20).map(c => `• ${c.class_name}：${c.attendance_rate}%（在寝${c.present}/未归${c.absent}/请假${c.leave}）`).join('\n') || '暂无数据'}\n\n` +
            `🏠 异常宿舍：${dms.length > 0 ? dms.slice(0, 20).map(d => `• ${d.dorm}：缺勤 ${d.absent} 人，异常率 ${d.rate}%`).join('\n') : '近7天未发现异常宿舍'}\n\n` +
            `💡 管理建议：\n${adv || '查寝情况正常，暂无特别建议。'}`;
        }
        return `【📊 ${clsLabel}综合数据分析报告】${timeDesc}\n\n` +
          `📅 今日签到率：${t.attendance_rate || 0}%（在寝 ${t.present || 0} / 未归 ${t.absent || 0} / 请假 ${t.leave || 0}）\n` +
          `⚠️ 今日未归：${a.count || 0} 人\n` +
          `🔴 高风险学生：${r.count || 0} 人\n` +
          `📈 近7天累计缺勤：${tr.total || 0} 人次（日均 ${tr.avg || 0} / 峰值 ${tr.peak || 0}）\n` +
          `🏫 班级数：${cls.length} 个\n` +
          `🏠 异常宿舍：${dms.length} 间\n` +
          `📝 待审批请假：${lv.pending || 0} 条\n` +
          `📚 近7天课堂记录：${co.recent_7d_attendance_records || 0} 条\n\n` +
          `💡 管理建议：\n${adv || '各项指标正常，暂无特别建议。'}`;
      }

      case 'student_detail': {
        if (data.ambiguous) {
          const list = data.candidates.map((c, i) => `${i + 1}. **${c.name}**（${c.class_name || '-'}班${c.dorm ? (' · ' + c.dorm) : ''}）`).join('\n');
          return `【学生查询】${timeDesc}\n\n系统中有 ${data.candidates.length} 位名为「${data.name}」的学生，请告诉我你要查的是哪一位：\n${list}\n\n💡 也可以在问题中加上班级，例如「查一下测绘2301班的${data.name}」。`;
        }
        if (data.error) {
          return `【学生查询】${timeDesc}\n\n` +
            `💬 未找到名为「${data.name || '该学生'}」的学生信息。\n\n` +
            `可能的原因：\n` +
            `1. 姓名输入有误（如谐音、错别字、繁简体不一致）；\n` +
            `2. 该姓名不是学生姓名，而是考勤/管理关键词（如"宿舍异常"、"班级对比"等）；\n` +
            `3. 学生数据尚未导入。\n\n` +
            `👉 你可以尝试：\n` +
            `• 输入完整姓名或学号，例如「查一下张三」「2023050101」；\n` +
            `• 加上班级限定，例如「查一下测绘2301班的张三」；\n` +
            `• 如果是查考勤/宿舍/课堂，请用对应关键词，例如「今天谁没归」「宿舍异常」「课堂缺勤」。`;
        }
        const s = data;
        const cst = s.checkin_stats_30d || s.stats_30d || {};
        const clst = s.class_stats_30d || {};
        const checkinRecent = (s.recent_records||[]).slice(0,5).map(r => {
          const t = r.time || '';
          const tStr = t.includes(' ') ? t.split(' ')[1] : t;
          return `  ${r.date}：${r.status}${tStr?'('+tStr+')':''}`;
        }).join('\n');
        const classRecent = (s.recent_class||[]).slice(0,5).map(r => {
          const t = r.time || '';
          const tStr = t.includes(' ') ? t.split(' ')[1] : t;
          return `  ${r.date}：${r.status}${r.course_name?'《'+r.course_name+'》':''}${tStr?'('+tStr+')':''}`;
        }).join('\n');
        const lvInfo = (s.recent_leaves||[]).map(l=>`${l.type}(${l.start_date}~${l.end_date})-${l.status}`).join('、') || '无';
        return `【学生档案 · ${s.name}】${timeDesc}\n\n` +
          `👤 姓名：${s.name} | 学号：${s.student_id}\n` +
          `🏫 班级：${s.class_name || '-'} | 宿舍：${s.dorm || '-'} | 性别：${s.gender || '-'}\n` +
          `📱 电话：${s.phone || '-'}\n\n` +
          `🏠 近30天查寝情况：\n` +
          `  在寝 **${cst.present||0}** 次 | 未归 **${cst.absent||0}** 次 | 请假 **${cst.leave||0}** 次 | 晚归 **${cst.late||0}** 次\n` +
          `  查寝率 **${cst.attend_rate||0}%**（共${cst.total||0}条记录）\n` +
          `📋 最近查寝记录：\n${checkinRecent || '暂无'}\n\n` +
          `📚 近30天课堂出勤：\n` +
          `  出勤 **${clst.present||0}** 次 | 缺课 **${clst.absent||0}** 次 | 迟到 **${clst.late||0}** 次 | 请假 **${clst.leave||0}** 次\n` +
          `  出勤率 **${clst.attend_rate||0}%**（共${clst.total||0}条记录）\n` +
          `📋 最近课堂记录：\n${classRecent || '暂无'}\n\n` +
          `📝 请假记录：${lvInfo}`;
      }

      case 'dorm_mates': {
        if (data.error) return `【同宿舍其他人】${timeDesc}\n\n${data.error}`;
        const current = data.currentStudent || '该学生';
        const mates = (data.mates || []).filter(m => m.name !== current);
        if (!mates.length) return `【同宿舍其他人】${timeDesc}\n\n${current} 目前住在 ${data.dorm || '-'}，该宿舍暂无其他入住学生。`;
        const list = mates.map(m => `• **${m.name}**（${m.student_id} · ${m.class_name || '-'} · ${m.gender || '-'}）`).join('\n');
        return `【同宿舍其他人】${timeDesc}\n\n${current} 住在 **${data.dorm || '-'}**，同宿舍还有 ${mates.length} 人：\n\n${list}\n\n💡 点击学生姓名可查看其详细档案。`;
      }

      case 'search': {
        if (!data || data.count === 0) return `【学生搜索】${timeDesc}\n\n未找到包含"${data.keyword||''}"的学生。\n\n💡 提示：试试输入完整姓名或学号。`;
        const list = data.students.map(s =>
          `• **${s.name}**（${s.student_id}）${s.class_name?'·'+s.class_name:''}${s.dorm?'·'+s.dorm:''}`
        ).join('\n');
        return `【搜索"${data.keyword}" · 找到 ${data.count} 人】${timeDesc}\n\n${list}\n\n💡 点击学生姓名可查看详细档案。`;
      }

      case 'alerts': {
        const d = data;
        if (!d.recent || d.recent.length === 0) return `【异常告警】${timeDesc}\n\n✅ 当前没有待处理的异常告警。今天已处理 ${d.closed_today||0} 条。`;
        const list = d.recent.map(a =>
          `• **${a.name}**（${a.class_name}）：${a.reason||'未知'} 【${a.status==='open'?'⏳待处理':'✅已关闭'}】`
        ).join('\n');
        return `【异常告警】${timeDesc}\n\n⏳ 待处理 **${d.open}** 条 | ✅ 今日已处理 **${d.closed_today||0}** 条\n\n最近告警：\n${list}`;
      }

      case 'recent_records': {
        if (!data || data.length === 0) return `【最近签到记录】${timeDesc}\n\n暂无签到记录。`;
        const list = data.map(r => {
          const t = r.time || '';
          const tStr = t.includes(' ') ? t.split(' ')[1] : t;
          return `• **${r.name}**（${r.class_name}）：${r.status} @ ${r.date} ${tStr}${r.location?' · '+r.location:''}`;
        }).join('\n');
        return `【最近 ${data.length} 条签到记录】${timeDesc}\n\n${list}`;
      }

      case 'self_intro': {
        const t = data.today || {};
        const rateText = t.attendance_rate ? `\n\n📊 当前概况：今天签到率 **${t.attendance_rate}%**，在寝 ${t.present||0} 人${t.absent > 0 ? `，有 ${t.absent} 人未归` : ''}` : '';
        return `老师你好！我是学工小智 🙋\n\n我可以帮你做这些事：\n\n` +
          `📋 **数据查询** — 今日签到率、未归名单、请假情况、课堂签到\n` +
          `🔍 **学生档案** — 搜索任意学生的详细信息和出勤记录\n` +
          `⚠️ **风险预警** — 高风险学生、缺勤趋势、宿舍异常\n` +
          `📊 **对比分析** — 各班级签到率对比、历史趋势\n` +
          `💡 **智能建议** — 基于数据给出管理建议\n\n` +
          `直接用自然语言问我就行，比如：\n` +
          `• "今天签到率怎么样？"\n` +
          `• "哪些学生没归？"\n` +
          `• "查一下张三的情况"\n` +
          `• "最近缺勤趋势如何？"` +
          `${rateText}\n\n有什么想了解的尽管问我~`;
      }

      case 'explain': {
        const d = data;
        if (!d) {
          return `【指标解释】${timeDesc}\n\n您是想问刚才那条数据的含义吗？我暂时没找到上一条数据，可以重新把问题发我一次~`;
        }
        const prev = intentResult.param || d.intent || 'data';
        // 周期总览：签到率 = 在寝人次 / (学生数 × 天数)
        if (prev === 'period_overview' || (d.start && d.end && d.days)) {
          const totalExpected = d.total_students * d.days;
          return `【指标解释 · 周期签到率】${timeDesc}\n\n` +
            `上一轮回答中的 **周期签到率 ${d.attendance_rate}%** 含义如下：\n\n` +
            `📅 统计周期：${d.start} ~ ${d.end}（共 ${d.days} 天）\n` +
            `👥 统计范围：${d.classFilter && d.classFilter !== '全部' ? d.classFilter : '全校'}，共 ${d.total_students} 名学生\n` +
            `📝 应到人次：${d.total_students} 人 × ${d.days} 天 = **${totalExpected} 人次**\n` +
            `🏠 实际在寝人次：**${d.present} 人次**\n` +
            `📈 计算方式：实际在寝人次 ÷ 应到人次 = ${d.present} ÷ ${totalExpected} ≈ **${d.attendance_rate}%**\n\n` +
            `💡 也就是说，这 ${d.days} 天里平均每天在寝的学生比例约为 ${d.attendance_rate}%。数值越低，说明该周期内查寝未归/请假的情况越多。`;
        }
        // 今日/单日总览：签到率 = 在寝人数 / 应到学生数
        if (prev === 'today' || prev === 'today_with_absent' || (d.date && d.present !== undefined && d.total_students !== undefined)) {
          return `【指标解释 · 今日签到率】${timeDesc}\n\n` +
            `上一轮回答中的 **今日签到率 ${d.attendance_rate}%** 含义如下：\n\n` +
            `📅 统计日期：${d.date}\n` +
            `👥 统计范围：${d.classFilter && d.classFilter !== '全部' ? d.classFilter : '全校'}，应到学生 ${d.total_students} 人\n` +
            `🏠 在寝人数：${d.present} 人\n` +
            `🚶 未归人数：${d.absent || 0} 人\n` +
            `📋 请假人数：${d.leave || 0} 人\n` +
            `📈 计算方式：在寝人数 ÷ 应到学生数 = ${d.present} ÷ ${d.total_students} = **${d.attendance_rate}%**\n\n` +
            `💡 它只反映查寝维度（学生是否在寝），与课堂出勤是不同统计口径。`;
        }
        // 课堂考勤：直接回答"指的是哪个班"，而不是解释指标含义
        if (prev === 'course' || (d.total_records !== undefined && d.recent_7d_attendance_records !== undefined)) {
          const scope = d.classFilter && d.classFilter !== '全部' ? d.classFilter : '全校';
          return `【课堂考勤范围说明】${timeDesc}\n\n` +
            `我刚才说的是 **${scope}** 的课堂考勤情况。\n\n` +
            `📅 统计周期：近 7 天\n` +
            `👥 统计范围：${scope}\n` +
            `📝 考勤记录：${d.recent_7d_attendance_records || 0} 条（涉及 ${d.recent_7d_student_count || 0} 名学生）\n` +
            `📈 出勤率：**${d.attendance_rate !== undefined ? d.attendance_rate + '%' : '—'}**\n\n` +
            `如果你想看具体某个班级或某门课的情况，直接告诉我班级或课程名就行~`;
        }
        // 其他指标通用解释：列出关键字段
        let parts = [];
        if (d.classFilter && d.classFilter !== '全部') parts.push(`统计范围：${d.classFilter}`);
        if (d.start && d.end) parts.push(`统计周期：${d.start} ~ ${d.end}`);
        if (d.date) parts.push(`统计日期：${d.date}`);
        if (d.count !== undefined) parts.push(`数量/人次：${d.count}`);
        if (d.attendance_rate !== undefined) parts.push(`签到率：${d.attendance_rate}%`);
        return `【指标解释】${timeDesc}\n\n` +
          `上一轮回答基于系统真实数据，主要信息如下：\n\n${parts.map(p => `• ${p}`).join('\n')}\n\n` +
          `💡 如果您想知道具体某个数字的含义，可以直接告诉我，比如"这个签到率怎么算的"。`;
      }

      default: {
        // 通用/打招呼类问题 → 友好能力介绍，不堆数据
        const q = (_rawQuestion || '').toLowerCase();
        if (q.includes('能做什么') || q.includes('功能') || q.includes('帮助') || q.includes('你好') || q.includes('hello') || q.includes('hi') || q.includes('嗨') || q.includes('介绍') || q.includes('who')) {
          const t = data.today || {};
          const rateText = t.attendance_rate ? `\n\n📊 当前概况：今天签到率 **${t.attendance_rate}%**，在寝 ${t.present||0} 人${t.absent>0 ? `，有 ${t.absent} 人未归` : ''}` : '';
          return `老师你好！我是学工小智 🙋\n\n我可以帮你做这些事：\n\n` +
            `📋 **数据查询** — 今日签到率、未归名单、请假情况、课堂签到\n` +
            `🔍 **学生档案** — 搜索任意学生的详细信息和出勤记录\n` +
            `⚠️ **风险预警** — 高风险学生、缺勤趋势、宿舍异常\n` +
            `📊 **对比分析** — 各班级签到率对比、历史趋势\n` +
            `💡 **智能建议** — 基于数据给出管理建议\n\n` +
            `直接用自然语言问我就行，比如：\n` +
            `• "今天签到率怎么样？"\n` +
            `• "哪些学生没归？"\n` +
            `• "查一下张三的情况"\n` +
            `• "最近缺勤趋势如何？"\n` +
            `${rateText}\n\n有什么想了解的尽管问我~`;
        }
        // 其他未知问题 → 澄清反问（不瞎答概况）
        return buildClarify(_rawQuestion, timeDesc);
      }
    }
  }

  // ==================== 调用大模型 AI（支持第三方 OpenAI 兼容接口） ====================
  // 运行时配置（优先于环境变量，持久化到文件防重启丢失）
  const AI_CONFIG_FILE = path.join(__dirname, '..', 'data', 'ai_config.json');
  let runtimeConfig = { baseUrl: null, apiKey: null, modelName: null };

  // 启动时加载持久化配置
  try {
    if (fs.existsSync(AI_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
      if (saved) Object.assign(runtimeConfig, saved);
      console.log(`[AI Config] 从文件加载配置: model=${runtimeConfig.modelName||'默认'}, hasKey=${!!runtimeConfig.apiKey}`);
    }
  } catch (e) { console.warn('[AI Config] 加载文件失败:', e.message); }

  function persistAiConfig() {
    try {
      const dir = path.dirname(AI_CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify({
        baseUrl: runtimeConfig.baseUrl,
        apiKey: runtimeConfig.apiKey,
        modelName: runtimeConfig.modelName
      }, null, 2));
    } catch (e) { console.warn('[AI Config] 持久化失败:', e.message); }
  }

  async function askZhipu(question, dataContext, history) {
    // 优先使用运行时配置，其次环境变量
    const cfg = runtimeConfig;
    const apiKey = cfg.apiKey || process.env.ZHIPU_AI_API_KEY;
    const baseUrl = cfg.baseUrl || process.env.ZHIPU_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    const userModel = cfg.modelName || process.env.ZHIPU_AI_MODEL || 'glm-4-flash';

    // 检测占位符和空key
    if (!apiKey || apiKey.trim() === '' || apiKey === '你的_api_key_here') {
      console.log(`[大模型AI] 跳过调用: 无有效APIKey (runtime=${!!cfg.apiKey}, env=${!!process.env.ZHIPU_AI_API_KEY})`);
      return null;
    }

    // 结构化上下文：带意图时保留完整名单，否则用旧摘要
    let contextText = dataContext && typeof dataContext === 'object' && dataContext.intent
      ? buildStructuredContext(dataContext)
      : summarizeDataForLLM(dataContext);

    // 在上下文顶部显式标注当前筛选班级，强化模型过滤意识
    const currentClassFilter = dataContext && typeof dataContext === 'object'
      ? (dataContext.classFilter || dataContext.today?.classFilter || dataContext.absent?.classFilter || '')
      : '';
    if (currentClassFilter && currentClassFilter !== '全部') {
      contextText = `【当前限定班级：${currentClassFilter}，请严格只引用该班级数据】\n` + contextText;
    }

    // 截断历史，避免单条消息过长导致请求体过大/超时
    const trimmedHistory = (history || []).slice(-4).map(m => ({
      role: m.role,
      content: m.content && m.content.length > 400 ? m.content.slice(0, 400) + '\n...(历史消息截断)' : m.content
    }));

    // 尝试用户配置的模型；失败则快速兜底 glm-4-flash
    const modelsToTry = [
      { model: userModel, timeout: 8000, retries: 0 },
      { model: 'glm-4-flash', timeout: 30000, retries: 1 }
    ];
    for (const { model: modelName, timeout: timeoutMs, retries } of modelsToTry) {
      if (!modelName) continue;
      const MAX_RETRIES = retries || 0;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) console.log(`[大模型AI ${modelName}] 第${attempt+1}次重试...`);
          const answer = await callLLM(question, contextText, trimmedHistory, apiKey, baseUrl, modelName, timeoutMs);
          if (answer) {
            // 后处理：拦截模型把示例占位符（X/Y/A/B…）直接输出成"套话模板"的退化回答
            if (/[A-Z]\s*(条|名|人|个|起|分|次|方面|%|位|项|人次)/.test(answer)) {
              console.warn(`[大模型AI ${modelName}] 检测到字母占位套话，已拦截并回退为无数据说明`);
              return { answer: '抱歉，当前查询范围内系统没有可统计的真实数据（例如所选时段暂无签到、考勤或告警记录），因此无法给出具体数字分析。您可以在"数据大屏"或"考勤统计"中查看已有记录，或换个时间范围（如"本月""上周"）再问我~', modelName: modelName + ' ·placeholder-blocked' };
            }
            console.log(`[大模型AI] 最终使用模型: ${modelName}`);
            return { answer, modelName };
          }
          // answer 为空时不重试，直接尝试下一个模型
          break;
        } catch (err) {
          const isTimeout = err.code === 'ECONNABORTED' || (err.message && err.message.includes('timeout'));
          const shouldRetry = attempt < MAX_RETRIES && (isTimeout || (err.response && (err.response.status >= 500 || err.response.status === 422)));
          console.error(`[大模型AI ${modelName}] 第${attempt+1}次失败(${shouldRetry ? '将重试' : '放弃'}):`, err.message?.substring(0, 200));
          if (!shouldRetry) break;
        }
      }
      console.log(`[大模型AI] 模型 ${modelName} 不可用，尝试下一个兜底模型...`);
    }
    return null;
  }

  // 将数据上下文精简为紧凑文本摘要（避免 422 请求体过大）
  function summarizeDataForLLM(data) {
    if (!data || typeof data !== 'object') return '';
    const lines = [];
    try {
      // 今日签到
      if (data.date || data.attendance_rate !== undefined) {
        lines.push(`【今日签到 ${data.date||'今天'}】签到率${data.attendance_rate||0}%，在寝${data.present||0}人，未归${data.absent||0}人，请假${data.leave||0}人，应到${data.total_students||0}人`);
        if (data.classFilter) lines.push(`（筛选班级：${data.classFilter}）`);
      }
      // 未归名单
      if (data.count !== undefined && data.students) {
        const names = (data.students||[]).slice(0,10).map(s=>s.name).join('、');
        lines.push(`【未归学生】共${data.count}人：${names}${data.count>10?' 等':''}`);
      }
      // 高风险
      if (data.count !== undefined && data.students && data.students[0] && data.students[0].absent !== undefined) {
        const names = (data.students||[]).slice(0,8).map(s=>`${s.name}(缺勤${s.absent}天)`).join('、');
        lines.push(`【高风险学生(近30天缺勤≥3)】共${data.count}人：${names}`);
      }
      // 趋势
      if (data.daily && Array.isArray(data.daily)) {
        const pts = data.daily.slice(-7).map(d=>`${d.date.slice(5)}:${d.count}人`).join(' | ');
        lines.push(`【近7天缺勤趋势】${pts}`);
        if (data.avg !== undefined) lines.push(`日均缺勤：${data.avg}人`);
      }
      // 班级对比
      if (Array.isArray(data) && data[0] && data[0].class_name) {
        const top3 = data.slice(0,5).map(c=>`${c.class_name}:${c.rate||c.attendance_rate||0}%`).join(' | ');
        lines.push(`【班级签到率对比（前5）】${top3}`);
      }
      if (data.classes && Array.isArray(data.classes)) {
        const top3 = data.classes.slice(0,5).map(c=>`${c.class_name}:${c.rate||c.attendance_rate||0}%`).join(' | ');
        lines.push(`【班级对比】${top3}`);
      }
      // 请假
      if (data.pending !== undefined || data.today_on_leave !== undefined) {
        lines.push(`【请假】待审批${data.pending||0}条，今日在假${data.today_on_leave||0}人`);
      }
      // 宿舍异常
      if (Array.isArray(data) && data[0] && data[0].dorm && data[0].rate !== undefined) {
        const dms = data.slice(0,5).map(d=>`${d.dorm}:缺勤${d.absent}人(${d.rate}%)`).join(' | ');
        lines.push(`【异常宿舍】${dms}`);
      }
      if (data.dorms && Array.isArray(data.dorms)) {
        const dms = data.dorms.slice(0,5).map(d=>`${d.dorm}:缺勤${d.absent}人(${d.rate}%)`).join(' | ');
        lines.push(`【异常宿舍】${dms}`);
      }
      // 告警
      if (data.open !== undefined) {
        lines.push(`【异常告警】待处理${data.open}条，今日已闭环${data.closed_today||0}条`);
      }
      // 总览
      if (data.overview) {
        const o = data.overview;
        lines.push(`【系统总览】学生${o.totalStudents||0}人，班级${o.totalClasses||0}个，宿舍${o.totalDorms||0}栋，签到记录${o.totalRecords||0}条`);
      }
      // 学生档案
      if (data.name && data.student_id) {
        const st = data.stats_30d || {};
        lines.push(`【学生档案】${data.name}（${data.student_id}）${data.class_name?' / '+data.class_name:''}${data.dorm?' / '+data.dorm:''}`);
        if (st.total) lines.push(`近30天签到：在寝${st.present||0}/未归${st.absent||0}/请假${st.leave||0}/晚归${st.late||0}，共${st.total}次，出勤率${st.attend_rate||0}%`);
      }
      // 搜索结果
      if (data.keyword !== undefined && data.students) {
        const names = (data.students||[]).slice(0,8).map(s=>`${s.name}(${s.class_name||'?'})`).join('、');
        lines.push(`【搜索"${data.keyword}"】找到${data.count}人：${names}`);
      }
      // 签到记录列表
      if (Array.isArray(data) && data[0] && data[0].date && data[0].name && !data[0].class_name) {
        const recs = data.slice(0,10).map(r=>`${r.date} ${r.name}:${r.status}`).join(' | ');
        lines.push(`【最近签到记录】${recs}`);
      }
      // 建议
      if (data.recommendations) {
        const advs = (data.recommendations||[]).map(a=>a.text).join('；');
        lines.push(`【智能建议】${advs}`);
      }
    } catch(e) {
      lines.push('[数据摘要生成失败]');
    }
    const result = lines.join('\n');
    // 截断到 2000 字符以内（agnes 平台对请求体大小有限制，需严格控制）
    const truncated = result.length > 2000 ? result.slice(0, 1960) + '\n...(数据过长已截断)' : result;
    console.log(`[AI 数据摘要] 原始${result.length}字符 → 截后${truncated.length}字符`);
    return truncated;
  }

  // 构建结构化数据上下文(JSON)，保留完整名单，便于 LLM 做具体回答
  function buildStructuredContext(data) {
    if (!data || typeof data !== 'object') return '';
    const intent = data.intent || 'clarify';
    // 兼容：数组型数据经 askZhipu 的 {intent, ...data} 展开后会变成 {intent, 0:row, 1:row, ...}
    // 这种形态下 Array.isArray 为 false，且 data.classes/dorms 不存在，会导致取数落空。
    // 这里把数字键重组回数组，确保 class_compare / dorm 等数组意图能拿到真实数据。
    let _arr = null;
    if (Array.isArray(data)) _arr = data;
    else if ((intent === 'class_compare' || intent === 'dorm') && Object.keys(data).some(k => /^\d+$/.test(k))) {
      _arr = Object.keys(data).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map(k => data[k]);
    }
    const pick = (obj, keys) => {
      const r = {};
      if (!obj) return r;
      for (const k of keys) if (obj[k] !== undefined) r[k] = obj[k];
      return r;
    };
    // 精简学生字段：姓名、班级、宿舍、缺勤/请假天数，避免 JSON 过大导致请求超时
    const slimStudent = (s) => ({ name: s.name, class_name: s.class_name, dorm: s.dorm, absent: s.absent, leaves: s.leaves });
    const slimStudents = (arr, n = 50) => (Array.isArray(arr) ? arr.slice(0, n).map(slimStudent) : []);
    try {
      const currentClassFilter = data.classFilter || data.today?.classFilter || data.absent?.classFilter || '';
      let ctx = { intent, current_class_filter: currentClassFilter };
      switch (intent) {
        case 'today':
          ctx = { ...ctx, today: pick(data, ['date','total_students','present','absent','leave','attendance_rate','classFilter']) };
          break;
        case 'today_with_absent':
          ctx = { ...ctx, today: pick(data.today, ['date','total_students','present','absent','leave','attendance_rate','classFilter']), absent: { count: data.absent?.count, date: data.absent?.date, students: slimStudents(data.absent?.students) } };
          break;
        case 'absent_list':
        case 'absent_range':
          ctx = { ...ctx, absent: { count: data.count, date: data.date, students: slimStudents(data.students) } };
          break;
        case 'high_risk':
          ctx = { ...ctx, risk: { count: data.count, students: slimStudents(data.students) } };
          break;
        case 'class_compare':
          ctx = { ...ctx, classes: (_arr || (Array.isArray(data) ? data : data.classes || [])).slice(0, 20).map(c => pick(c, ['class_name','students','present','absent','leave','attendance_rate','rate','level'])) };
          break;
        case 'trend':
          ctx = { ...ctx, trend: pick(data, ['daily','peak','total','avg','days','studentName']) };
          break;
        case 'dorm':
          ctx = { ...ctx, dorms: (_arr || (Array.isArray(data) ? data : data.dorms || [])).slice(0, 20).map(d => pick(d, ['dorm','total','absent','rate','students'])) };
          break;
        case 'dorm_mates':
          ctx = { ...ctx, currentStudent: data.currentStudent, dorm: data.dorm, students: slimStudents(data.students) };
          break;
        case 'leave':
          ctx = { ...ctx, leave: pick(data, ['pending','today_on_leave','recent_30d_types','count']), recent_leaves: (data.recent_leaves || []).slice(0, 10).map(l => pick(l, ['name','class_name','type','status','start','end'])) };
          break;
        case 'course':
          ctx = {
            ...ctx,
            course: {
              ...pick(data, ['recent_7d_student_count','absenceOnly','courseFilter','analysis','summary',
                'attendance_rate','late_rate','absent_rate','daily_trend','absent_students','late_students']),
              recent_7d_attendance_records: data.recent_7d_attendance_records,
              // 关键区分：records 是「考勤记录条数（人次）」，student_count 是「实际学生数」
              total_records: data.total,
              present_records: data.present,
              late_records: data.late,
              absent_records: data.absent,
              record_count_note: '所有 *_records 字段均为近7天课堂考勤记录条数（人次），recent_7d_student_count 为实际有记录的学生数，严禁把记录条数说成学生人数',
              class_stats: (data.class_stats || []).slice(0, 10).map(c => ({
                class_name: c.class_name,
                total_records: c.total,
                present_records: c.present,
                absent_records: c.absent,
                late_records: c.late,
                attendance_rate: c.attendance_rate
              }))
            },
            recent_records: (data.recent_records || []).slice(0, 15).map(r => pick(r, ['name','class_name','course_name','status','time']))
          };
          break;
        case 'alerts':
          ctx = { ...ctx, alerts: { open: data.open, closed_today: data.closed_today, recent: (data.recent || []).slice(0, 15).map(a => pick(a, ['name','class_name','reason','status','created_at'])) } };
          break;
        case 'advice':
          ctx = { ...ctx, today: pick(data.today, ['date','total_students','present','absent','leave','attendance_rate','classFilter']), absent: { count: data.absent?.count, students: slimStudents(data.absent?.students, 30) }, risk: { count: data.risk?.count, students: slimStudents(data.risk?.students, 30) }, trend: pick(data.trend, ['daily','peak','total','avg']), contactStudentName: data.contactStudentName, contactStudent: data.contactStudent ? slimStudent(data.contactStudent) : null, recommendations: (data.recommendations || []).map(r => r.text || r), periodAdvice: !!data.periodAdvice, period: data.period ? { dateRange: data.dateRange, ...pick(data.period, ['total','present','absent','leave','attendance_rate','classBreak']) } : undefined, class_compare: (data.class_compare ? (Array.isArray(data.class_compare) ? data.class_compare : (data.class_compare.classes || [])) : []).slice(0, 10).map(c => pick(c, ['class_name','present','absent','leave','attendance_rate','rate'])), leave_summary: data.leave ? pick(data.leave, ['pending','today_on_leave','recent_30d_types']) : undefined, course_summary: data.course ? { records: data.course.recent_7d_attendance_records, filter: data.course.courseFilter } : undefined, dorm_summary: data.dorm ? { anomaly_count: (data.dorm.dorms || []).length } : undefined };
          break;
        case 'student_detail':
          ctx = { ...ctx, student: pick(data, ['name','student_id','class_name','dorm','gender','phone','checkin_stats_30d','class_stats_30d','recent_class','recent_leaves','absent','leaves','ambiguous']) };
          break;
        case 'student_period_analysis':
          ctx = { ...ctx, period: { start: data.start, end: data.end, days: data.days }, student: data.student ? pick(data.student, ['name','student_id','class_name','dorm']) : null, stats: data.stats, checkinRecords: (data.checkinRecords || []).slice(0, 15).map(r => pick(r, ['date','status','time'])), courseRecords: (data.courseRecords || []).slice(0, 15).map(r => pick(r, ['date','course_name','status','time'])), leaveRecords: (data.leaveRecords || []).slice(0, 10).map(r => pick(r, ['start','end','type','status'])) };
          break;
        case 'period_overview':
          ctx = { ...ctx, period: pick(data, ['start','end','days','dateRange','total','total_students','present','absent','leave','attendance_rate','classBreak','daily']), class_compare: (data.class_compare || data.classes || data.classBreak || []).slice(0, 10).map(c => pick(c, ['class_name','present','absent','leave','attendance_rate','rate'])), trend: data.trend ? pick(data.trend, ['daily','peak','total','avg']) : undefined };
          break;
        case 'improve_attendance':
          ctx = { ...ctx, classes: (data.comparison || data.classes || []).slice(0, 10).map(c => pick(c, ['class_name','students','present','absent','leave','attendance_rate','rate','level'])), recommendations: (data.recommendations || []).map(r => r.text || r), lowRateThreshold: data.threshold || 85 };
          break;
        case 'reason':
          ctx = { ...ctx, reason: { date: data.date, isWeekend: data.isWeekend, todayAbsent: data.todayAbsent, avgAbsent: data.avgAbsent, onLeave: data.onLeave, rate: data.rate, classBreak: (data.classBreak || []).slice(0, 10) } };
          break;
        case 'stats':
          ctx = { ...ctx, stats: { totalStudents: data.totalStudents, totalClasses: data.totalClasses, totalDorms: data.totalDorms } };
          break;
        case 'recent_records':
          ctx = { ...ctx, recent_records: (Array.isArray(data) ? data : data.records || []).slice(0, 15).map(r => pick(r, ['date','name','class_name','type','status','course_name','time'])) };
          break;
        case 'search':
          ctx = { ...ctx, search: { keyword: data.keyword, count: data.count, students: slimStudents(data.students) } };
          break;
        default:
          ctx = { ...ctx, today: pick(data.today, ['date','total_students','present','absent','leave','attendance_rate','classFilter']), absent: { count: data.absent?.count, students: slimStudents(data.absent?.students, 30) }, risk: { count: data.risk?.count, students: slimStudents(data.risk?.students, 30) } };
      }
      const json = JSON.stringify(ctx, null, 2);
      // 控制整体上下文不超过 2500 字符，避免请求体过大导致超时
      if (json.length > 2500) return json.slice(0, 2460) + '\n...(数据过长已截断)';
      return json;
    } catch (e) {
      return summarizeDataForLLM(data);
    }
  }

  async function callLLM(question, contextText, history, apiKey, baseUrl, modelName, timeoutMs = 30000) {
    console.log(`[大模型AI ${modelName}] 开始调用问题="${question.slice(0,50)}" base=${baseUrl.slice(0,40)}...`);

    try {
      const systemPrompt = `你是一位经验丰富、说话接地气的高校辅导员AI助手"学工小智"。你的用户是**辅导员或老师**，不是学生，所以称呼对方为"老师"而非"同学"。你的风格：

【角色定位】
- 你像一位干了10年的老辅导员，既专业又亲切
- 回答像微信聊天，不是写公文报告
- 偶尔用 emoji 点缀，但不过度

【核心铁律】
1. **所有数据必须来自下方的【系统实时数据】**，绝对禁止编造姓名、班级、人数、比例。**下方【系统实时数据】已经真实加载，你必须直接基于它作答，严禁说"数据没拿到/暂时无法/没查到"之类推脱之词**；只有当【系统实时数据】明确为"（暂无额外数据）"或为空时，才如实说明无数据。只要给了数据，就围绕数据讲，不要绕开它。
1a. **严禁把"考勤记录条数（人次）"说成"学生人数"**。如果系统给的是 'recent_7d_attendance_records'（记录条数）和 'recent_7d_student_count'（实际学生数），必须区分表述："共 X 条考勤记录、涉及 Y 名学生"，禁止说"共有 X 名学生"。
2. **用户追问具体名单时，必须逐条列出完整姓名、班级、宿舍等关键信息**，不能只给汇总数字。例如问"20名同学名单"，就把名单里每位学生列出来。
3. **像真人对话**：开头可以直接回应、感叹、提问，不要总以"根据数据显示..."开头。
4. 关键结论和数据用 **加粗** 标出。
5. 根据数据情况调整语气：数据正常 → 简洁明快；数据有问题 → 温馨提醒但不危言耸听；数据缺失 → 诚实说明。
6. 字数灵活控制（100-500字），该详细时详细，该简短时简短。
7. 可以主动给出建议或追问（如"要不要我帮你查一下XXX的情况？"）。
8. **【班级过滤铁律】如果上下文开头标注了"当前限定班级"，你只能引用该班级的学生；如果上下文数据包含多个班级，必须按限定班级过滤后再回答，严禁把其他班级的学生混入答案。用户追问时如无新班级信息，保持上一轮班级范围。**

9. **自然语言理解（最重要）**：用户说话很口语，要善于"听懂话外音"，而不是只做关键词匹配：
   - 上一轮在聊某学生，本轮说"他/她/该生/这个学生/那个学生"，要**继承**到该学生，不要当成新的人名或反问。
   - 用户纠正范围时（如"我要的是那个学生的不是所有的""只要那个学生不要全班"），要缩小到个人，而不是全校/全班。
   - 用户说"哪29人""那些没归的""都什么情况"这类指代，要回到上一轮给出的名单/数据去回应，别装作没看见。
   - 用户问的是"为什么/什么原因"，要解释**原因和背景**，而不是再甩一遍数据；问"怎么改进/怎么办"，要给出**可落地的措施**。
   - 绝不要回复"我没听懂""请你重新输入"这类废话；哪怕意图略有模糊，也基于已有数据给一个最合理的回应，并自然追问补全。

当前系统业务日期（你口中的"今天/今日"以此为准）：${getEffectiveToday()}
真实墙钟时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}

【系统实时数据】（JSON格式，供你参考与引用）
\`\`\`json
${contextText || '（暂无额外数据）'}
\`\`\``;

      const messages = [{ role: 'system', content: systemPrompt }];

      // 注入对话历史（最近4轮）
      if (history && history.length > 0) {
        const recentHistory = history.slice(-8);
        messages.push(...recentHistory.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })));
      }

      messages.push({ role: 'user', content: question });

      const reqBody = JSON.stringify({ model: modelName, messages, temperature: 0.7, max_tokens: 2000 });
      console.log(`[大模型AI ${modelName}] 请求体大小=${reqBody.length}字符, messages数=${messages.length}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await axios.post(
          `${baseUrl}/chat/completions`,
          {
            model: modelName,
            messages,
            temperature: 0.7,
            max_tokens: 2000
            // 注意：不传 top_p，部分平台（如 agnes-ai）不支持此参数会返回 422
          },
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: controller.signal, timeout: timeoutMs, maxRedirects: 0 }
        );
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
      
      
      const msg = response.data.choices?.[0]?.message || {};
      // 优先取 content；部分推理模型 content 为空时从 reasoning_content 取
      const answer = msg.content || msg.reasoning_content || null;
      if (answer) {
        console.log(`[大模型AI ${modelName}] 回答成功, 长度=${answer.length}, finish=${response.data.choices?.[0]?.finish_reason}`);
      } else {
        console.log(`[大模型AI ${modelName}] 返回空内容, response=`, JSON.stringify(response.data).slice(0,200));
      }
      return answer;
    } catch (err) {
      console.error(`[大模型AI ${modelName}] 调用失败:`, err.message?.substring(0, 300), err.code || '', err.response?.status || '');
      throw err; // 抛出给上层重试
    }
  }

  // ==================== 生成数据分析报告 PDF ====================
  async function generateReportPdf(data) {
    const reportsDir = path.join(ROOT_DIR, 'public', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const scope = data.scope || 'comprehensive';
    const timestamp = Date.now();
    const filename = `${scope === 'course' ? '课堂考勤报告' : scope === 'dorm' ? '查寝报告' : '数据分析报告'}-${timestamp}.pdf`;
    const filepath = path.join(reportsDir, filename);
    const fontPath = path.join('C:\\Windows\\Fonts\\simhei.ttf');

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filepath);
      doc.pipe(stream);

      try {
        doc.registerFont('SimHei', fontPath);
        doc.font('SimHei');
      } catch (e) {
        console.warn('[AI Report] 中文字体注册失败，将使用默认字体:', e.message);
      }

      function addSection(title, contentLines) {
        doc.fontSize(14).text(title, { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(11);
        if (Array.isArray(contentLines)) {
          contentLines.forEach(line => doc.text(line));
        } else {
          doc.text(String(contentLines));
        }
        doc.moveDown(1.5);
      }

      // 封面信息
      const titleMap = { course: '课堂考勤数据分析报告', dorm: '查寝数据分析报告', comprehensive: '学管 SmartEdu 数据分析报告' };
      const cf = data.classFilter || '全部';
      const ccf = data.courseFilter || '';
      const clsLabel = cf !== '全部' ? `（${cf}）` : '';
      const courseLabel = ccf ? `「${ccf}」` : '';
      doc.fontSize(22).text((titleMap[scope] || titleMap.comprehensive) + clsLabel + courseLabel);
      doc.moveDown(0.5);
      doc.fontSize(11).text(`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
      if (scope !== 'comprehensive') doc.fontSize(11).text(`报告维度：${scope === 'course' ? '课堂考勤' : '查寝'}`);
      if (ccf) doc.fontSize(11).text(`统计课程：${ccf}`);
      if (cf !== '全部') doc.fontSize(11).text(`统计班级：${cf}`);
      doc.moveDown(2);

      const t = data.today || {};
      const a = data.absent || {};
      const r = data.risk || {};
      const tr = data.trend || {};
      const cls = data.class_compare || [];
      const dms = data.dorm || [];
      const lv = data.leave || {};
      const co = data.course || {};
      const ccls = data.course_class || [];
      const adv = data.recommendations || [];

      if (scope === 'course') {
        addSection('一、课堂考勤概览', [
          `统计区间：近7天`,
          `课堂签到记录：${co.recent_7d_attendance_records || 0} 条`
        ]);

        if (ccls.length > 0) {
          addSection('二、各班级课堂出勤率', ccls.slice(0, 30).map(c => `• ${c.class_name}：出勤率 ${c.attendance_rate}%（出勤${c.present}/缺课${c.absent}/迟到${c.late}）`));
        } else {
          addSection('二、各班级课堂出勤率', ['暂无课堂出勤数据。']);
        }

        if (co.recent_records && co.recent_records.length > 0) {
          addSection('三、最近课堂签到记录', co.recent_records.slice(0, 50).map(rec => `• ${rec.name}（${rec.class_name}）${rec.course || '课程'} - ${rec.status}（${rec.time}）`));
        } else {
          addSection('三、最近课堂签到记录', ['暂无课堂签到记录。']);
        }

        addSection('四、缺课/迟到名单（近7天）', (co.recent_records || [])
          .filter(rec => rec.status !== '出勤')
          .slice(0, 50)
          .map(rec => `• ${rec.name}（${rec.class_name}）${rec.course || '课程'} - ${rec.status}（${rec.time}）`)
          .length > 0
            ? (co.recent_records || []).filter(rec => rec.status !== '出勤').slice(0, 50).map(rec => `• ${rec.name}（${rec.class_name}）${rec.course || '课程'} - ${rec.status}（${rec.time}）`)
            : ['近7天无缺课/迟到记录。']);
      } else if (scope === 'dorm') {
        addSection('一、今日查寝总览', [
          `统计日期：${t.date || '-'}`,
          `签到率：${t.attendance_rate || 0}%`,
          `在寝：${t.present || 0} 人 / 未归：${t.absent || 0} 人 / 请假：${t.leave || 0} 人`,
          `应到学生总数：${t.total_students || 0} 人`
        ]);

        if (a.count > 0) {
          addSection('二、今日未归学生', a.students.slice(0, 50).map(s => `• ${s.name}（${s.class_name} / ${s.dorm}）`));
        } else {
          addSection('二、今日未归学生', ['今日无未归学生，全员到位。']);
        }

        if (cls.length > 0) {
          addSection('三、各班级签到率对比', cls.slice(0, 30).map(c => `• ${c.class_name}：${c.attendance_rate}%（在寝${c.present}/未归${c.absent}/请假${c.leave}）`));
        }

        if (tr.daily && tr.daily.length > 0) {
          addSection('四、近7天缺勤趋势', [
            `统计区间：${tr.daily[0].date} ~ ${tr.daily[tr.daily.length - 1].date}`,
            `累计缺勤：${tr.total} 人次`,
            `日均：${tr.avg} 人`,
            `峰值：${tr.peak} 人/天`
          ]);
        }

        if (dms.length > 0) {
          addSection('五、异常宿舍（近7天）', dms.slice(0, 30).map(d => `• ${d.dorm}：缺勤 ${d.absent} 人，异常率 ${d.rate}%`));
        } else {
          addSection('五、异常宿舍', ['近7天未发现异常宿舍。']);
        }
      } else {
        addSection('一、今日签到总览', [
          `统计日期：${t.date || '-'}`,
          `签到率：${t.attendance_rate || 0}%`,
          `在寝：${t.present || 0} 人 / 未归：${t.absent || 0} 人 / 请假：${t.leave || 0} 人`,
          `应到学生总数：${t.total_students || 0} 人`
        ]);

        if (a.count > 0) {
          addSection('二、今日未归学生', a.students.slice(0, 50).map(s => `• ${s.name}（${s.class_name} / ${s.dorm}）`));
        } else {
          addSection('二、今日未归学生', ['今日无未归学生，全员到位。']);
        }

        if (cls.length > 0) {
          addSection('三、各班级签到率对比', cls.slice(0, 30).map(c => `• ${c.class_name}：${c.attendance_rate}%（在寝${c.present}/未归${c.absent}/请假${c.leave}）`));
        }

        if (r.count > 0) {
          addSection('四、高风险学生（近30天缺勤≥3次）', r.students.slice(0, 30).map(s => `• ${s.name}（${s.class_name}）缺勤 ${s.absent} 次${s.leaves > 0 ? ` / 请假 ${s.leaves} 天` : ''}`));
        } else {
          addSection('四、高风险学生', ['近30天未发现高风险学生。']);
        }

        if (tr.daily && tr.daily.length > 0) {
          addSection('五、近7天缺勤趋势', [
            `统计区间：${tr.daily[0].date} ~ ${tr.daily[tr.daily.length - 1].date}`,
            `累计缺勤：${tr.total} 人次`,
            `日均：${tr.avg} 人`,
            `峰值：${tr.peak} 人/天`
          ]);
        }

        if (dms.length > 0) {
          addSection('六、异常宿舍（近7天）', dms.slice(0, 30).map(d => `• ${d.dorm}：缺勤 ${d.absent} 人，异常率 ${d.rate}%`));
        } else {
          addSection('六、异常宿舍', ['近7天未发现异常宿舍。']);
        }

        addSection('七、请假情况', [
          `待审批：${lv.pending || 0} 条`,
          `今日在假：${lv.today_on_leave || 0} 人`
        ]);

        addSection('八、课堂出勤（近7天）', [
          `课堂签到记录：${co.recent_7d_attendance_records || 0} 条`,
          ...(co.absentOnly ? ['当前按缺勤模式统计。'] : [])
        ]);
      }

      addSection(scope === 'course' ? '五、课堂管理建议' : scope === 'dorm' ? '六、查寝管理建议' : '九、智能管理建议', adv.length > 0 ? adv.map(x => `• ${x.text || x}`) : ['各项指标正常，暂无特别建议。']);

      doc.end();

      stream.on('finish', () => resolve(`/reports/${filename}`));
      stream.on('error', (err) => {
        try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (e) {}
        reject(err);
      });
    });
  }

  // ==================== GET /ai/chat — 通用聊天（增强版：也注入系统数据） ====================
  // ==================== 统一问答处理器（smart / chat 共用） ====================
  // 核心防幻觉策略：
  //  1) 所有依赖具体数据的意图强制本地格式化（FORCE_LOCAL_INTENTS），答案 100% 来自数据库；
  //  2) 仅 advice 等少量意图允许走大模型，但回答后做 grounding 校验，
  //     一旦出现不在系统数据中的疑似人名/班级，立即回退到本地准确答案。
  async function handleAiQuestion(question, sid) {
    const t0 = Date.now();
    const session = sid ? getSessionHistory(sid) : null;
    const intentResult = routeIntent(question, session || {});
    console.log(`[AI] step1 意图=${intentResult.intent} classFilter=${intentResult.classFilter || '-'} 继承=${intentResult.inherited || false} 日期=${intentResult.dateRef ? intentResult.dateRef.kind : '-'} +${Date.now() - t0}ms`);
    const data = (intentResult.intent === 'explain' && session && session.lastData)
      ? session.lastData
      : loadDataForIntent(intentResult, session || {});
    // 同宿舍其他人：需要知道当前学生是谁，从 session 上一条学生档案补充
    if (intentResult.intent === 'dorm_mates' && session && session.lastData && session.lastData.name && data && !data.currentStudent) {
      data.currentStudent = session.lastData.name;
    }
    const history = session ? session.messages : [];
    if (sid) addMessage(sid, 'user', question);
    if (session) updateSessionContext(sid, {
      lastIntent: intentResult.intent,
      lastClassFilter: intentResult.classFilter || '',
      lastCourseFilter: intentResult.courseFilter || '',
      lastQuestion: question,
      lastData: data,
      lastParam: intentResult.param
    });
    const forceLocal = FORCE_LOCAL_INTENTS.includes(intentResult.intent);
    let llmResult = forceLocal ? null : await askZhipu(question, { intent: intentResult.intent, ...data }, history);
    let aiAnswer = llmResult && llmResult.answer ? llmResult.answer : null;
    // 防幻觉：校验 LLM 回答是否基于系统数据，出现未 grounding 实体则回退本地
    if (aiAnswer && !forceLocal) {
      const allowed = collectAllowed(data);
      if (!verifyGrounded(aiAnswer, allowed)) {
        console.log(`[AI] LLM回答含未 grounding 实体，回退本地准确答案 (intent=${intentResult.intent})`);
        aiAnswer = null; llmResult = null;
      }
    }
    const usedLlmModel = llmResult && llmResult.modelName ? llmResult.modelName : null;
    if (aiAnswer && sid) addMessage(sid, 'ai', aiAnswer);

    // report / PDF 导出：单独生成 PDF 文件并返回下载链接
    let finalAnswer;
    let reportUrl = null;
    if (intentResult.intent === 'report') {
      try {
        reportUrl = await generateReportPdf(data);
        const scope = data.scope || 'comprehensive';
        const cf = data.classFilter || '全部';
        const ccf = data.courseFilter || '';
        const clsLabel = cf !== '全部' ? `（${cf}）` : '';
        const courseLabel = ccf ? `「${ccf}」` : '';
        let scopeLabel = '综合数据分析';
        let scopeIncludes = '今日签到总览、未归学生名单、班级签到率对比、高风险学生、缺勤趋势、宿舍异常、请假情况、课堂出勤及智能管理建议';
        if (scope === 'course') { scopeLabel = '课堂考勤数据分析'; scopeIncludes = '近7天课堂签到记录、各班级课堂出勤率、缺课/迟到明细、课程签到明细及智能管理建议'; }
        if (scope === 'dorm') { scopeLabel = '查寝数据分析'; scopeIncludes = '今日签到率、未归学生名单、各班级签到率对比、异常宿舍、缺勤趋势及智能管理建议'; }
        finalAnswer = `📄 ${scopeLabel}${clsLabel}${courseLabel}报告 PDF 已生成，点击链接下载：\n\n${reportUrl}\n\n报告包含：${scopeIncludes}。`;
      } catch (pdfErr) {
        console.error('[AI] PDF 生成失败:', pdfErr.message);
        finalAnswer = formatLocalAnswer(intentResult, data, question);
      }
    } else {
      finalAnswer = aiAnswer || formatLocalAnswer(intentResult, data, question);
    }

    const configuredModel = runtimeConfig.modelName || process.env.ZHIPU_AI_MODEL || 'glm-4-flash';
    const isAi = !!aiAnswer;
    const baseUrlPreview = runtimeConfig.baseUrl || process.env.ZHIPU_AI_BASE_URL || '';
    const providerLabel = /bigmodel\.cn|zhipu/.test(baseUrlPreview) ? 'zhipu' : 'custom';
    const displayModel = usedLlmModel || configuredModel;
    console.log(`[AI] 总耗时=${Date.now() - t0}ms source=${isAi ? 'ai' : 'local'}`);
    return {
      code: 0,
      data: {
        answer: finalAnswer,
        intent: intentResult.intent,
        source: isAi ? 'ai' : 'local_engine',
        modelInfo: isAi ? { model: displayModel, provider: providerLabel } : null,
        suggestions: getSuggestions(intentResult.intent),
        ...(reportUrl ? { reportUrl } : {})
      }
    };
  }

  // 极端兜底：任何异常都给出本地准确答案，绝不向用户抛出报错
  async function handleAiQuestionFallback(question, sid) {
    const session = sid ? getSessionHistory(sid) : null;
    const intentResult = routeIntent(question, session || {});
    const data = loadDataForIntent(intentResult, session || {});
    return {
      code: 0,
      data: {
        answer: formatLocalAnswer(intentResult, data, question),
        intent: intentResult.intent,
        source: 'local_engine',
        modelInfo: null,
        suggestions: getSuggestions(intentResult.intent)
      }
    };
  }

  router.get('/ai/chat', async (req, res) => {
    const { question, session_id: sid } = req.query;
    if (!question) return res.json({ code: 1, message: '请输入问题' });
    try {
      res.json(await handleAiQuestion(question, sid));
    } catch (err) {
      console.error('[AI Chat] 错误:', err.message?.substring(0, 200));
      try { res.json(await handleAiQuestionFallback(question, sid)); }
      catch (e2) { res.json({ code: 0, data: { answer: '抱歉，AI助手暂时无法连接到模型服务。请检查网络或稍后重试。\n\n你可以试试问："今天签到率怎么样"、"高风险学生有哪些"', source: 'local_engine', suggestions: [] } }); }
    }
  });

  // 增强版关键词回退（带数据上下文）
  function handleKeywordChatEnhanced(question, snapshot) {
    const q = (question || '').toLowerCase();
    const t = snapshot.today || {};

    if (q.includes('你好') || q.includes('hello') || q.includes('hi') || q.includes('嗨')) {
      const rateText = t.attendance_rate ? `今天签到率 ${t.attendance_rate}%` : '';
      return `老师你好！我是学工AI助手 👋\n\n我可以帮你：\n• 查询今日签到率和未归名单\n• 分析高风险学生和缺勤趋势\n• 查看班级对比和宿舍异常\n• 搜索任意学生的详细档案${rateText ? `\n\n当前概况：${rateText}` : ''}\n\n有什么想了解的直接问我就行~`;
    }
    if (q.includes('签到') || q.includes('查寝')) {
      if (t.attendance_rate) {
        return `关于签到查寝：\n\n📊 **${t.date||'今天'}** 签到率 **${t.attendance_rate}%**\n✅ 在寝 ${t.present||0} 人 | ⚠️ 未归 ${t.absent||0} 人 | 📝 请假 ${t.leave||0} 人\n\n${t.absent > 0 ? '有未归学生，需要我帮你查看具体名单吗？' : '今天出勤情况不错！'}`;
      }
      return '签到时间通常是早上7点到晚上11点。想了解今天的具体签到情况吗？';
    }
    if (q.includes('请假')) {
      const lv = snapshot.leave || {};
      return `关于请假：\n\n📋 当前待审批 **${lv.pending||0}** 条\n🏠 今日在假 **${lv.today_on_leave||0}** 人\n\n需要我帮你查看具体的请假记录吗？`;
    }
    if (q.includes('帮助') || q.includes('help') || q.includes('功能') || q.includes('你能')) {
      return `我能帮你做这些事：\n\n📊 **数据查询** — 今日签到率、未归名单、高风险学生\n📈 **趋势分析** — 缺勤走势、班级对比、预测\n🔍 **信息检索** — 查学生档案、搜索学生\n🏠 **宿舍管理** — 异常宿舍检测\n📝 **请假管理** — 审批状态、请假分析\n💡 **智能建议** — 基于数据的管理建议\n\n直接用自然语言提问即可，比如："今天谁没回来？"`;
    }
    return `收到你的问题："${question}"\n\n我是学工AI助手，可以帮你分析查寝数据、查学生信息、看缺勤趋势等。\n你可以试试问：\n• "今天签到率怎么样？"\n• "有哪些高风险学生？"\n• "查一下张三的情况"\n• "给我一些管理建议"`;
  }

  // 大模型在当前数据场景下容易产生幻觉（编造班级、姓名、日期、人数），
  // 所有依赖具体数据查询的意图强制走本地格式化，确保姓名/班级/数字 100% 来自数据库
  // 默认意图均先尝试【精确取数 + 大模型基于真实数据作答】（RAG 思路），
  // 仅以下意图强制本地模板（无数据依赖或需特殊版式）：report(PDF) / explain / clarify / self_intro。
  // 其余数据意图：大模型答非所问或回答未 grounded（出现数据外实体）时，自动回退本地准确模板。
  const FORCE_LOCAL_INTENTS = ['report', 'explain', 'clarify', 'self_intro'];

  // ==================== GET /ai/smart — 强 AI 主入口（v2 重构版） ====================
  router.get('/ai/smart', authMiddleware, async (req, res) => {
    const { question, session_id: sid } = req.query;
    if (!question) return res.json({ code: 1, message: '请输入问题' });
    try {
      res.json(await handleAiQuestion(question, sid));
    } catch (err) {
      console.error('[AI Smart] 错误:', err.message?.substring(0, 200));
      try { res.json(await handleAiQuestionFallback(question, sid)); }
      catch (e2) {
        res.json({ code: 0, data: { answer: '抱歉，AI助手暂时无法连接到模型服务。请检查网络或稍后重试。\n\n你可以试试问："今天签到率怎么样"、"高风险学生有哪些"', source: 'local_engine', suggestions: [] } });
      }
    }
  });

  // ==================== 推荐追问（更丰富多样） ====================
  function getSuggestions(intent) {
    const map = {
      today: ['今天未归学生是谁？', '昨天谁没回来？', '哪些学生是高风险？', '各班级签到率如何？', '最近缺勤趋势'],
      absent_list: ['这些学生该怎么处理？', '昨天也是这些吗？', '缺勤趋势怎么样？', '联系家长确认'],
      absent_range: ['这些学生该怎么处理？', '高风险学生有哪些？', '给我管理建议'],
      period_overview: ['哪些学生没归？', '高风险学生', '各班级对比'],
      high_risk: ['缺勤趋势分析', '班级对比排名', '给我处理建议', '某个学生的详细情况'],
      trend: ['高风险学生', '班级对比', '未来预测', '如何改善'],
      class_compare: ['未归学生详情', '高风险学生', '如何改进低签到率班级'],
      leave: ['待审批列表', '请假趋势', '某位学生的请假记录'],
      dorm: ['这个宿舍住了谁？', '其他异常宿舍', '未归学生'],
      course: ['未到课学生', '课程签到趋势'],
      advice: ['执行细节？', '重点关注谁？', '评估预期效果？'],
      student_detail: ['该生缺勤趋势', '请假记录', '同宿舍其他人'],
      student_period_analysis: ['该生近7天记录', '联系家长确认', '该生高风险吗？'],
      search: ['查看详细档案', '同班级学生', '签到记录'],
      alerts: ['查看未归学生', '生成新告警', '告警处理统计'],
      recent_records: ['今日汇总', '未归名单', '高风险学生'],
      clarify: ['今日签到率？', '高风险学生？', '智能建议', '未归学生是谁？']
    };
    return map[intent] || map.general;
  }

  // ==================== GET /ai/capabilities — 能力列表（前端展示） ====================
  router.get('/ai/capabilities', (req, res) => {
    res.json({
      code: 0,
      data: {
        capabilities: [
          { icon: '📊', label: '今日签到总览', example: '今天签到情况怎么样？' },
          { icon: '⚠️', label: '未归学生分析', example: '现在谁没回来？' },
          { icon: '🔴', label: '高风险学生', example: '哪些学生最近缺勤多？' },
          { icon: '📈', label: '趋势预测', example: '近30天缺勤趋势？' },
          { icon: '🏆', label: '班级对比', example: '各班签到率排名？' },
          { icon: '📝', label: '请假分析', example: '待审批的请假多吗？' },
          { icon: '🏠', label: '宿舍异常', example: '哪些宿舍有异常？' },
          { icon: '📚', label: '课堂到课', example: '最近到课率？' },
          { icon: '💡', label: '智能建议', example: '我该怎么管理？' },
          { icon: '🔍', label: '学生搜索', example: '查一下张三的情况' },
          { icon: '🔔', label: '异常告警', example: '有哪些待处理的告警？' }
        ]
      }
    });
  });

  // ==================== 大模型配置 API ====================
  // POST /api/ai/config — 保存大模型配置
  router.post('/api/ai/config', authMiddleware, (req, res) => {
    try {
      const { baseUrl, apiKey, modelName } = req.body || {};
      runtimeConfig.baseUrl = (baseUrl && baseUrl.trim()) ? baseUrl.trim() : null;
      runtimeConfig.apiKey = (apiKey && apiKey.trim()) ? apiKey.trim() : null;
      runtimeConfig.modelName = (modelName && modelName.trim()) ? modelName.trim() : null;
      console.log(`[AI Config] 已更新: model=${runtimeConfig.modelName||'默认'}, base=${runtimeConfig.baseUrl||'环境变量'}`);
      persistAiConfig();
      res.json({ code: 0, message: '配置已保存（已持久化，重启不丢失）', data: { modelName: runtimeConfig.modelName, hasKey: !!runtimeConfig.apiKey } });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // GET /api/ai/test — 测试大模型连接
  router.get('/api/ai/test', authMiddleware, async (req, res) => {
    const cfg = runtimeConfig;
    const apiKey = cfg.apiKey || process.env.ZHIPU_AI_API_KEY;
    if (!apiKey || apiKey.trim() === '' || apiKey === '你的_api_key_here') {
      return res.json({ code: 1, message: '未配置 API Key，将使用本地分析引擎（效果也不错哦）' });
    }
    const baseUrl = cfg.baseUrl || process.env.ZHIPU_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    const modelName = cfg.modelName || 'glm-4-flash';
    try {
      const r = await axios.post(`${baseUrl}/chat/completions`, {
        model: modelName,
        messages: [{ role: 'user', content: '你好，请用一句话介绍你自己' }],
        temperature: 0.3, max_tokens: 100
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      });
      const reply = r.data.choices?.[0]?.message?.content || '';
      res.json({ code: 0, message: `连接成功！模型 ${modelName} 已就绪。回复: ${reply.substring(0, 80)}` });
    } catch (err) {
      console.error('[AI Test] 失败:', err.message);
      let msg = err.response?.data?.error?.message || err.message;
      if (msg.length > 120) msg = msg.substring(0, 120) + '...';
      res.json({ code: 1, message: `连接失败 (${err.response?.status || '网络'}): ${msg}` });
    }
  });

  // GET /api/ai/config — 获取当前配置状态
  router.get('/api/ai/config', authMiddleware, (req, res) => {
    res.json({
      code: 0,
      data: {
        hasRuntimeConfig: !!(runtimeConfig.baseUrl || runtimeConfig.apiKey || runtimeConfig.modelName),
        modelName: runtimeConfig.modelName || null,
        hasKey: !!runtimeConfig.apiKey,
        baseUrlPreview: runtimeConfig.baseUrl ? runtimeConfig.baseUrl.replace(/\/api\/v\d+$/, '/...') : null
      }
    });
  });

  return router;
}

module.exports = { init };