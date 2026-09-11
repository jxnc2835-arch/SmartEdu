// ==================== ARIMA 时间序列预测（纯 JS 实现，无外部依赖）====================
// 算法：差分(d) → 平稳序列上拟合 ARMA(p,q)（Hannan-Rissanen 含截距） → 多步预测 + psi 权重预测区间 → 反差分还原。
// 自动定阶：在 (p,d,q) 网格内按 AIC 选择最优阶数。
// 适用于：签到率趋势、请假量趋势等单变量时间序列预测，能捕捉趋势(差分)与自相关(AR/MA)，优于简单线性回归。

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
 * 一阶差分
 * @param {number[]} s - 原始序列
 * @returns {number[]} 差分序列
 */
function difference(s) {
  const out = [];
  for (let i = 1; i < s.length; i++) out.push(s[i] - s[i - 1]);
  return out;
}

/**
 * 高斯消元法解线性方程组（部分主元）
 * @param {number[][]} A - 系数矩阵 n×n
 * @param {number[]} b - 常数向量
 * @returns {number[]} 解向量
 */
function solve(A, b) {
  const n = A.length;
  if (n === 0) return [];
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) continue; // 近奇异，跳过该列
    if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
    const pivVal = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / pivVal;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (Math.abs(M[i][i]) > 1e-12) x[i] = M[i][n] / M[i][i];
  }
  return x;
}

/**
 * Yule-Walker 方程求解（Levinson-Durbin 递推）
 * @param {number[]} y - 观测序列
 * @param {number} r - AR 阶数
 * @returns {{phi: number[], sigma2: number}} AR 系数和噪声方差
 */
function yuleWalker(y, r) {
  const n = y.length;
  const m = mean(y);
  const acv = new Array(r + 1).fill(0);
  for (let k = 0; k <= r; k++) {
    let s = 0;
    for (let t = 0; t < n - k; t++) s += (y[t] - m) * (y[t + k] - m);
    acv[k] = s / n;
  }
  const phi = new Array(r + 1).fill(0); // phi[1..r] 1-indexed
  let sigma2 = acv[0];
  if (sigma2 <= 1e-12) return { phi: new Array(r).fill(0), sigma2: 1e-12 };
  for (let k = 1; k <= r; k++) {
    let sum = 0;
    for (let j = 1; j < k; j++) sum += phi[j] * acv[k - j];
    const rho = (acv[k] - sum) / sigma2;
    phi[k] = rho;
    for (let j = 1; j <= Math.floor(k / 2); j++) {
      const tmp = phi[j];
      phi[j] = phi[j] - rho * phi[k - j];
      phi[k - j] = phi[k - j] - rho * tmp;
    }
    sigma2 = sigma2 * (1 - rho * rho);
    if (sigma2 <= 1e-12) { sigma2 = 1e-12; break; }
  }
  return { phi: phi.slice(1), sigma2 };
}

// 含截距的 ARMA(p,q) 拟合（Hannan-Rissanen 两步法，含 1 次精化）
// y: 平稳序列（长度 n）。返回 { c, phi[], theta[], residuals[], sigma2, y }
function fitARMA(y, p, q) {
  const n = y.length;
  const r = p + q;
  if (r === 0) {
    const m = mean(y);
    const res = y.map(v => v - m);
    return { c: m, phi: [], theta: [], residuals: res, sigma2: Math.max(variance(res), 1e-12), y };
  }
  // Step 1: 高阶 AR 估计残差
  const highR = Math.min(r + 2, Math.max(p, 1), n - 2);
  const arHi = highR > 0 ? yuleWalker(y, highR).phi : [];
  const arRes = new Array(n).fill(0);
  for (let t = highR; t < n; t++) {
    let pred = 0;
    for (let i = 1; i <= highR; i++) pred += (arHi[i - 1] || 0) * y[t - i];
    arRes[t] = y[t] - pred;
  }
  // Step 2: 以 [1, y_{t-1..t-p}, arRes_{t-1..t-q}] 为特征的线性回归
  const dims = 1 + p + q;
  const A = [], bvec = [];
  for (let t = Math.max(p, q); t < n; t++) {
    const row = [1];
    for (let i = 1; i <= p; i++) row.push(y[t - i]);
    for (let j = 1; j <= q; j++) row.push(arRes[t - j]);
    A.push(row);
    bvec.push(y[t]);
  }
  let coeffs;
  if (A.length < dims) {
    coeffs = new Array(dims).fill(0);
  } else {
    const AtA = Array.from({ length: dims }, () => new Array(dims).fill(0));
    const Atb = new Array(dims).fill(0);
    for (let a = 0; a < A.length; a++) {
      for (let i = 0; i < dims; i++) {
        Atb[i] += A[a][i] * bvec[a];
        for (let j = 0; j < dims; j++) AtA[i][j] += A[a][i] * A[a][j];
      }
    }
    coeffs = solve(AtA, Atb);
  }
  const c = coeffs[0] || 0;
  const phi = coeffs.slice(1, 1 + p);
  const theta = coeffs.slice(1 + p, 1 + p + q);
  // 用 ARMA 递推计算残差
  const res = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    let pred = c;
    for (let i = 1; i <= p; i++) if (t - i >= 0) pred += phi[i - 1] * y[t - i];
    for (let j = 1; j <= q; j++) if (t - j >= 0) pred += theta[j - 1] * res[t - j];
    res[t] = y[t] - pred;
  }
  // 精化：用新残差再做一次同样的回归（提升 MA 系数估计）
  const A2 = [], b2 = [];
  for (let t = Math.max(p, q); t < n; t++) {
    const row = [1];
    for (let i = 1; i <= p; i++) row.push(y[t - i]);
    for (let j = 1; j <= q; j++) row.push(res[t - j]);
    A2.push(row);
    b2.push(y[t]);
  }
  let coeffs2;
  if (A2.length >= dims) {
    const AtA = Array.from({ length: dims }, () => new Array(dims).fill(0));
    const Atb = new Array(dims).fill(0);
    for (let a = 0; a < A2.length; a++) {
      for (let i = 0; i < dims; i++) {
        Atb[i] += A2[a][i] * b2[a];
        for (let j = 0; j < dims; j++) AtA[i][j] += A2[a][i] * A2[a][j];
      }
    }
    coeffs2 = solve(AtA, Atb);
    const c2 = coeffs2[0] || 0;
    const phi2 = coeffs2.slice(1, 1 + p);
    const theta2 = coeffs2.slice(1 + p, 1 + p + q);
    const res2 = new Array(n).fill(0);
    for (let t = 0; t < n; t++) {
      let pred = c2;
      for (let i = 1; i <= p; i++) if (t - i >= 0) pred += phi2[i - 1] * y[t - i];
      for (let j = 1; j <= q; j++) if (t - j >= 0) pred += theta2[j - 1] * res2[t - j];
      res2[t] = y[t] - pred;
    }
    return { c: c2, phi: phi2, theta: theta2, residuals: res2, sigma2: Math.max(variance(res2), 1e-12), y };
  }
  return { c, phi, theta, residuals: res, sigma2: Math.max(variance(res), 1e-12), y };
}

// psi 权重（MA(∞) 表示系数），用于计算预测区间
function psiWeights(phi, theta, h) {
  const p = phi.length, q = theta.length;
  const psi = new Array(h).fill(0);
  psi[0] = 1;
  for (let j = 1; j < h; j++) {
    let s = 0;
    for (let i = 1; i <= p; i++) if (j - i >= 0) s += phi[i - 1] * psi[j - i];
    for (let k = 1; k <= q; k++) if (j - k >= 0) s += theta[k - 1] * psi[j - k];
    psi[j] = s;
  }
  return psi;
}

// 对拟合模型做 h 步预测，返回 [{value, lower, upper}]（95% 区间）
function forecastARMA(model, h) {
  const { c, phi, theta, residuals, sigma2, y } = model;
  const n = y.length;
  const work = y.slice();
  const eps = residuals.slice();
  const fc = [];
  for (let t = n; t < n + h; t++) {
    let pred = c;
    for (let i = 1; i <= phi.length; i++) pred += phi[i - 1] * work[t - i];
    for (let j = 1; j <= theta.length; j++) pred += theta[j - 1] * eps[t - j];
    work.push(pred);
    eps.push(0);
    fc.push(pred);
  }
  const psi = psiWeights(phi, theta, h);
  const out = [];
  for (let i = 0; i < h; i++) {
    let sumSq = 0;
    for (let j = 0; j <= i; j++) sumSq += psi[j] * psi[j];
    const se = Math.sqrt(sigma2 * sumSq);
    out.push({ value: fc[i], lower: fc[i] - 1.96 * se, upper: fc[i] + 1.96 * se });
  }
  return out;
}

// 将最差分层的预测 fDeep 反差分，还原到原始序列尺度的未来值
function integrateForecast(origin, d, fDeep) {
  const depths = [origin];
  let cur = origin;
  for (let k = 0; k < d; k++) { cur = difference(cur); depths.push(cur); }
  const lastVals = depths.map(s => s[s.length - 1]);
  let f = fDeep;
  for (let k = d - 1; k >= 0; k--) {
    const anchor = lastVals[k];
    const out = new Array(f.length);
    out[0] = anchor + f[0];
    for (let i = 1; i < f.length; i++) out[i] = out[i - 1] + f[i];
    f = out;
  }
  return f;
}

// 自动定阶 + 预测主入口
// series: number[]；opts: { steps, maxP, maxD, maxQ }
// 返回 { forecast[], lower[], upper[], order:[p,d,q], aic, method }
function forecastSeries(series, opts = {}) {
  const steps = opts.steps || 7;
  const maxP = opts.maxP != null ? opts.maxP : 3;
  const maxD = opts.maxD != null ? opts.maxD : 2;
  const maxQ = opts.maxQ != null ? opts.maxQ : 3;

  if (!series || series.length < 2) {
    const v = series && series.length ? series[series.length - 1] : 0;
    return { forecast: Array(steps).fill(v), lower: Array(steps).fill(v), upper: Array(steps).fill(v), order: [0, 0, 0], aic: null, method: 'ARIMA(fallback)' };
  }

  let best = null;
  for (let d = 0; d <= maxD; d++) {
    const diffed = d === 0 ? series : difference(series);
    if (diffed.length < 4) continue;
    for (let p = 0; p <= maxP; p++) {
      for (let q = 0; q <= maxQ; q++) {
        if (p + q === 0 && d === 0) continue; // 需至少含一种成分
        if (p + q > diffed.length - 3) continue;
        try {
          const model = fitARMA(diffed, p, q);
          const aic = diffed.length * Math.log(model.sigma2) + 2 * (1 + p + q);
          if (!best || aic < best.aic) best = { model, d, p, q, aic };
        } catch (e) { /* 该阶数不可拟合，跳过 */ }
      }
    }
  }

  if (!best) {
    const v = series[series.length - 1];
    return { forecast: Array(steps).fill(v), lower: Array(steps).fill(v), upper: Array(steps).fill(v), order: [0, 0, 0], aic: null, method: 'ARIMA(fallback)' };
  }

  const fc = forecastARMA(best.model, steps);
  const f = integrateForecast(series, best.d, fc.map(o => o.value));
  const lo = integrateForecast(series, best.d, fc.map(o => o.lower));
  const up = integrateForecast(series, best.d, fc.map(o => o.upper));
  return { forecast: f, lower: lo, upper: up, order: [best.p, best.d, best.q], aic: best.aic, method: 'ARIMA' };
}

module.exports = {
  difference,
  mean,
  variance,
  solve,
  yuleWalker,
  fitARMA,
  psiWeights,
  forecastARMA,
  integrateForecast,
  forecastSeries,
};
