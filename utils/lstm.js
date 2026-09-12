// ==================== LSTM 时间序列预测（纯 JS 实现，无外部依赖）====================
// 算法：min-max 归一化 → 滑动窗口构造样本 → 单层 LSTM（含 dropout）→ Truncated BPTT + Adam 训练
//        → 递归多步预测 → MC Dropout 估计预测均值与 95% 预测区间 → 反归一化还原。
// 适用于：签到率趋势、请假量趋势等单变量时间序列预测；能捕捉非线性与长程依赖，
//         并给出基于模型不确定性的置信区间（ARIMA 难以提供的不确定性度量）。
//
// 设计约束（与 utils/arima.js 一致）：
//   - 零外部依赖，可在离线 / Docker 环境运行。
//   - 对外接口 forecastSeriesLSTM(series, opts) 返回与 arima.forecastSeries 同构：
//     { forecast[], lower[], upper[], model, order?, look_back, hidden_size, epochs, final_loss, mc_samples }。

// ---------- 基础工具 ----------

/**
 * 可复现伪随机数生成器（mulberry32）
 * 保证训练/MC Dropout 确定性，便于测试
 * @param {number} seed - 随机种子
 * @returns {Function} 随机数生成函数
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 计算数组平均值
 * @param {number[]} arr - 数值数组
 * @returns {number} 平均值
 */
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 计算数组方差
 * @param {number[]} arr - 数值数组
 * @returns {number} 方差值
 */
function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
}

/**
 * 矩阵向量乘法
 * @param {number[][]} W - 权重矩阵
 * @param {number[]} v - 输入向量
 * @returns {number[]} 结果向量
 */
function matVec(W, v) {
  const out = new Array(W.length);
  for (let i = 0; i < W.length; i++) {
    let s = 0;
    const row = W[i];
    for (let j = 0; j < v.length; j++) s += row[j] * v[j];
    out[i] = s;
  }
  return out;
}

/**
 * 三向量相加
 * @param {number[]} a - 向量 A
 * @param {number[]} b - 向量 B
 * @param {number[]} [c] - 可选的向量 C
 * @returns {number[]} 结果向量
 */
function vecAdd(a, b, c) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i] + (c ? c[i] : 0);
  return out;
}

/**
 * 将梯度累加到累加器
 * @param {number[]} acc - 累加器数组
 * @param {number[]} g - 梯度向量
 */
function addVecTo(acc, g) {
  for (let i = 0; i < acc.length; i++) acc[i] += g[i];
}

/**
 * 创建与参数结构相同的零矩阵/向量
 * @param {number[][]|number[]} p - 参数结构
 * @returns {number[][]|number[]} 零矩阵/向量
 */
function zerosLike(p) {
  return Array.isArray(p[0]) ? p.map(r => r.map(() => 0)) : p.map(() => 0);
}

// 激活函数及其在「输出值」处的导数
/**
 * Sigmoid 激活函数
 * @param {number} x - 输入值
 * @returns {number} Sigmoid 输出
 */
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/**
 * Sigmoid 导数（基于输出值）
 * @param {number} y - Sigmoid 输出值
 * @returns {number} 导数值
 */
function sigmoidDerivFromY(y) { return y * (1 - y); }

/**
 * Tanh 导数（基于输出值）
 * @param {number} y - Tanh 输出值
 * @returns {number} 导数值
 */
function tanhDerivFromY(y) { return 1 - y * y; }

// ---------- 参数键 ----------
const PARAM_KEYS = ['Wf', 'Uf', 'bf', 'Wi', 'Ui', 'bi', 'Wc', 'Uc', 'bc', 'Wo', 'Uo', 'bo', 'Wo_out', 'bo_out'];

// ---------- 网络构建 ----------
function createLSTM(inDim, hiddenDim, seed) {
  const rnd = mulberry32(seed);
  const r = () => (rnd() * 2 - 1);
  const initW = (rows, cols) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => r() * Math.sqrt(2 / (cols + rows))));
  return {
    inDim, hiddenDim,
    Wf: initW(hiddenDim, inDim), Uf: initW(hiddenDim, hiddenDim), bf: new Array(hiddenDim).fill(0),
    Wi: initW(hiddenDim, inDim), Ui: initW(hiddenDim, hiddenDim), bi: new Array(hiddenDim).fill(0),
    Wc: initW(hiddenDim, inDim), Uc: initW(hiddenDim, hiddenDim), bc: new Array(hiddenDim).fill(0),
    Wo: initW(hiddenDim, inDim), Uo: initW(hiddenDim, hiddenDim), bo: new Array(hiddenDim).fill(0),
    Wo_out: initW(1, hiddenDim), bo_out: new Array(1).fill(0),
    dropout: 0.2,
  };
}

// ---------- 前向（支持推理期 MC Dropout） ----------
// Xseq: 长度 T 的数组，每元素为 输入向量（本场景为 [标量]）
// 返回 { T, hs, cs, fs, is, gs, os, tanhcs, xs, h, dropMasks, out }
function forward(net, Xseq, dropoutRate, rng) {
  const H = net.hiddenDim;
  const T = Xseq.length;
  const hs = [], cs = [], fs = [], is = [], gs = [], os = [], tanhcs = [], xs = [];
  const dropMasks = [];
  let h = new Array(H).fill(0);
  let c = new Array(H).fill(0);

  for (let t = 0; t < T; t++) {
    const x = Xseq[t];
    xs.push(x);
    // 对上一时刻隐状态做 dropout（训练/MC 推理期启用）
    let hIn = h;
    let mask = null;
    if (dropoutRate > 0 && rng) {
      mask = new Array(H);
      for (let i = 0; i < H; i++) mask[i] = rng() < dropoutRate ? 0 : 1 / (1 - dropoutRate);
      hIn = h.map((v, i) => v * mask[i]);
    }
    dropMasks.push(mask);

    const af = vecAdd(matVec(net.Wf, x), matVec(net.Uf, hIn), net.bf);
    const ai = vecAdd(matVec(net.Wi, x), matVec(net.Ui, hIn), net.bi);
    const ag = vecAdd(matVec(net.Wc, x), matVec(net.Uc, hIn), net.bc);
    const ao = vecAdd(matVec(net.Wo, x), matVec(net.Uo, hIn), net.bo);
    const f = af.map(sigmoid);
    const i = ai.map(sigmoid);
    const g = ag.map(Math.tanh);
    const o = ao.map(sigmoid);

    const newc = new Array(H);
    for (let k = 0; k < H; k++) newc[k] = f[k] * c[k] + i[k] * g[k];
    const tanh_c = newc.map(Math.tanh);
    const newh = new Array(H);
    for (let k = 0; k < H; k++) newh[k] = o[k] * tanh_c[k];

    fs.push(f); is.push(i); gs.push(g); os.push(o); tanhcs.push(tanh_c);
    cs.push(newc); hs.push(newh);
    h = newh; c = newc;
  }
  const out = vecAdd(matVec(net.Wo_out, h), net.bo_out)[0];
  return { T, hs, cs, fs, is, gs, os, tanhcs, xs, h, dropMasks, out };
}

// ---------- 反向（Truncated BPTT 单序列） ----------
function initGrads(net) {
  const g = {};
  for (const k of PARAM_KEYS) g[k] = zerosLike(net[k]);
  return g;
}

function accGrads(grads, key, dGate, inputVec) {
  const W = grads[key];
  for (let k = 0; k < W.length; k++)
    for (let j = 0; j < inputVec.length; j++)
      W[k][j] += dGate[k] * inputVec[j];
}

function backward(net, fwd, yTarget) {
  const H = net.hiddenDim;
  const T = fwd.T;
  const grads = initGrads(net);
  const { hs, cs, fs, is, gs, os, tanhcs, xs, dropMasks } = fwd;

  const dOut = (fwd.out - yTarget); // 线性输出层，导数为 1
  for (let k = 0; k < H; k++) grads.Wo_out[0][k] += dOut * hs[T - 1][k];
  grads.bo_out[0] += dOut;

  const dh_next = new Array(H).fill(0);
  let dc_next = new Array(H).fill(0);

  for (let t = T - 1; t >= 0; t--) {
    const hPrev = t > 0 ? cs[t - 1] : new Array(H).fill(0);
    const hIn = dropMasks[t] ? hs[t].map((v, i) => v * dropMasks[t][i]) : hs[t];
    const f = fwd.fs[t], i = fwd.is[t], g = fwd.gs[t], o = fwd.os[t], tanh_c = fwd.tanhcs[t];

    const dh = new Array(H);
    for (let k = 0; k < H; k++) dh[k] = (t === T - 1 ? net.Wo_out[0][k] * dOut : 0) + dh_next[k];

    // h = o * tanh(c)
    const doGate = new Array(H), dtanh_c = new Array(H), dc = new Array(H);
    for (let k = 0; k < H; k++) {
      doGate[k] = dh[k] * tanh_c[k];
      dtanh_c[k] = dh[k] * o[k];
      dc[k] = dc_next[k] + dtanh_c[k] * tanhDerivFromY(tanh_c[k]);
    }
    // c = f * c_prev + i * g
    const df = new Array(H), di = new Array(H), dg = new Array(H);
    for (let k = 0; k < H; k++) {
      df[k] = dc[k] * hPrev[k];
      di[k] = dc[k] * g[k];
      dg[k] = dc[k] * i[k];
    }
    const dc_next_new = new Array(H);
    for (let k = 0; k < H; k++) dc_next_new[k] = dc[k] * f[k];
    dc_next = dc_next_new;

    // 门控预激活梯度
    const daf = new Array(H), dai = new Array(H), dag = new Array(H), dao = new Array(H);
    for (let k = 0; k < H; k++) {
      daf[k] = df[k] * sigmoidDerivFromY(f[k]);
      dai[k] = di[k] * sigmoidDerivFromY(i[k]);
      dag[k] = dg[k] * tanhDerivFromY(g[k]);
      dao[k] = doGate[k] * sigmoidDerivFromY(o[k]);
    }

    const x = xs[t];
    accGrads(grads, 'Wf', daf, x); accGrads(grads, 'Uf', daf, hIn); addVecTo(grads.bf, daf);
    accGrads(grads, 'Wi', dai, x); accGrads(grads, 'Ui', dai, hIn); addVecTo(grads.bi, dai);
    accGrads(grads, 'Wc', dag, x); accGrads(grads, 'Uc', dag, hIn); addVecTo(grads.bc, dag);
    accGrads(grads, 'Wo', dao, x); accGrads(grads, 'Uo', dao, hIn); addVecTo(grads.bo, dao);

    // 经由 U 权重流向「上一时刻隐状态」的梯度（即 hIn 的梯度）
    const dh_next_new = new Array(H).fill(0);
    for (let k = 0; k < H; k++) {
      for (let j = 0; j < H; j++) {
        dh_next_new[j] += net.Uf[k][j] * daf[k] + net.Ui[k][j] * dai[k] + net.Uc[k][j] * dag[k] + net.Uo[k][j] * dao[k];
      }
    }
    for (let k = 0; k < H; k++) dh_next[k] = dropMasks[t] ? dh_next_new[k] * dropMasks[t][k] : dh_next_new[k];
  }
  return grads;
}

// ---------- Adam 优化器 ----------
function applyAdam(net, grads, lr, t) {
  if (!net._m) {
    net._m = {}; net._v = {};
    for (const k of PARAM_KEYS) { net._m[k] = zerosLike(net[k]); net._v[k] = zerosLike(net[k]); }
  }
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (const k of PARAM_KEYS) {
    const p = net[k], g = grads[k], m = net._m[k], v = net._v[k];
    const isMatrix = Array.isArray(p[0]);
    if (isMatrix) {
      for (let i = 0; i < p.length; i++)
        for (let j = 0; j < p[i].length; j++) {
          m[i][j] = b1 * m[i][j] + (1 - b1) * g[i][j];
          v[i][j] = b2 * v[i][j] + (1 - b2) * g[i][j] * g[i][j];
          const mhat = m[i][j] / (1 - Math.pow(b1, t));
          const vhat = v[i][j] / (1 - Math.pow(b2, t));
          p[i][j] -= lr * mhat / (Math.sqrt(vhat) + eps);
        }
    } else {
      for (let i = 0; i < p.length; i++) {
        m[i] = b1 * m[i] + (1 - b1) * g[i];
        v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
        const mhat = m[i] / (1 - Math.pow(b1, t));
        const vhat = v[i] / (1 - Math.pow(b2, t));
        p[i] -= lr * mhat / (Math.sqrt(vhat) + eps);
      }
    }
  }
}

// ---------- 训练 ----------
function train(net, X, Y, epochs, lr, rng) {
  const n = X.length;
  let lastLoss = 0;
  for (let e = 0; e < epochs; e++) {
    // 随机打乱样本
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let loss = 0;
    for (const idx of order) {
      const fwd = forward(net, X[idx], net.dropout, rng);
      const grads = backward(net, fwd, Y[idx]);
      applyAdam(net, grads, lr, e * n + idx + 1);
      loss += (fwd.out - Y[idx]) * (fwd.out - Y[idx]);
    }
    lastLoss = loss / n;
  }
  return lastLoss;
}

// ---------- 多步递归预测（MC Dropout 不确定性） ----------
function forecast(net, norm, steps, lookBack, mcSamples, rng) {
  let window = norm.slice(-lookBack);
  const preds = [];
  const band = [];
  for (let s = 0; s < steps; s++) {
    const samples = [];
    for (let m = 0; m < mcSamples; m++) {
      const fwd = forward(net, window.map(v => [v]), net.dropout, rng); // dropout 保持激活；每时间步输入需为向量
      samples.push(fwd.out);
    }
    const mu = mean(samples);
    const sd = Math.sqrt(variance(samples));
    preds.push(mu);
    band.push({ lower: mu - 1.96 * sd, upper: mu + 1.96 * sd });
    window = window.slice(1).concat(mu); // 以均值推进窗口
  }
  return { preds, band };
}

// ---------- 主入口 ----------
// series: number[]；opts: { steps, lookBack, hiddenSize, epochs, lr, dropout, mcSamples, seed }
// 返回 { forecast[], lower[], upper[], model, order, look_back, hidden_size, epochs, final_loss, mc_samples }
function forecastSeriesLSTM(series, opts = {}) {
  const steps = opts.steps || 7;
  const hiddenSize = opts.hiddenSize || 16;
  const epochs = opts.epochs || 150;
  const lr = opts.lr || 0.01;
  const dropout = opts.dropout != null ? opts.dropout : 0.2;
  const mcSamples = opts.mcSamples || 30;
  const seed = opts.seed != null ? opts.seed : 12345;
  const lookBack = Math.max(2, Math.min(opts.lookBack || 7, Math.floor((series ? series.length : 0) / 2)));

  const fallback = (v) => ({
    forecast: Array(steps).fill(v), lower: Array(steps).fill(v), upper: Array(steps).fill(v),
    model: 'LSTM(fallback)', order: null, look_back: lookBack, hidden_size: hiddenSize, epochs: 0, final_loss: null, mc_samples: 0
  });

  if (!series || series.length < lookBack + 2) {
    const v = series && series.length ? series[series.length - 1] : 0;
    return fallback(v);
  }

  // min-max 归一化到 [0,1]
  const mn = Math.min(...series);
  const mx = Math.max(...series);
  const range = (mx - mn) || 1;
  const norm = series.map(v => (v - mn) / range);

  const X = [], Y = [];
  for (let i = 0; i + lookBack < norm.length; i++) {
    X.push(norm.slice(i, i + lookBack).map(v => [v])); // 每时间步输入 [标量]
    Y.push(norm[i + lookBack]);
  }
  if (X.length === 0) return fallback(series[series.length - 1]);

  const net = createLSTM(1, hiddenSize, seed);
  net.dropout = dropout;
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);

  const finalLoss = train(net, X, Y, epochs, lr, rng);
  const { preds, band } = forecast(net, norm, steps, lookBack, mcSamples, rng);

  const denorm = v => mn + v * range;
  let fc = preds.map(denorm);
  const lo = band.map(b => denorm(b.lower));
  const up = band.map(b => denorm(b.upper));

  // 后处理：递归多步预测容易放大误差，做轻度平滑并限制偏离历史最后值
  const lastVal = series[series.length - 1];
  const historicalMean = mean(series);
  const historicalStd = Math.sqrt(variance(series));
  const maxDeviation = Math.max(10, 1.8 * historicalStd); // 至少 ±10%，或 1.8 倍标准差
  const smoothed = [];
  for (let i = 0; i < fc.length; i++) {
    const prev = i === 0 ? lastVal : smoothed[i - 1];
    // 指数平滑：当前预测值 65% + 上一值 35%，抑制突变
    const alpha = 0.65;
    const blended = fc[i] * alpha + prev * (1 - alpha);
    // 限制偏离历史最后值
    const clamped = Math.max(lastVal - maxDeviation, Math.min(lastVal + maxDeviation, blended));
    smoothed.push(Math.max(0, Math.min(100, clamped)));
  }
  fc = smoothed;

  return {
    forecast: fc, lower: lo, upper: up,
    model: 'LSTM', order: null,
    look_back: lookBack, hidden_size: hiddenSize, epochs,
    final_loss: Number(finalLoss.toFixed(4)), mc_samples: mcSamples
  };
}

module.exports = {
  mulberry32,
  createLSTM,
  forward,
  backward,
  train,
  forecast,
  forecastSeriesLSTM,
};
