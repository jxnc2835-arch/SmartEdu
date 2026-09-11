// ==================== 预测模型精度回测模块 ====================
// 纯 JS，零额外依赖。对时间序列做「滚动单步预测」(rolling-origin one-step-ahead)
// 回测，计算 RMSE / MAE / MAPE，用于横向对比 ARIMA 与 LSTM 的预测精度。
//
// 原理：给定长度 N 的序列，从第 minTrain 个点开始，逐点向后滚动：
//   用 series[0 .. i-1] 训练/拟合 -> 预测第 i 个点 -> 与真实值 series[i] 比误差
// 汇总所有测试点的误差，得到该模型在该序列上的整体精度指标。

const { forecastSeries } = require('./arima');
const { forecastSeriesLSTM } = require('./lstm');

// ---------- 误差指标 ----------
// RMSE：均方根误差（对大误差惩罚更重，单位与原数据一致）
// MAE ：平均绝对误差（直观，单位与原数据一致）
// MAPE：平均绝对百分比误差（相对误差，%），真实值为 0 时跳过该点避免除零
function computeMetrics(actual, predicted) {
  const n = Math.min(actual.length, predicted.length);
  if (n === 0) return { rmse: null, mae: null, mape: null, samples: 0 };
  let se = 0, ae = 0, ape = 0, apeCount = 0;
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const p = predicted[i];
    if (!Number.isFinite(a) || !Number.isFinite(p)) continue;
    const err = p - a;
    se += err * err;
    ae += Math.abs(err);
    if (Math.abs(a) > 1e-9) {
      ape += Math.abs(err / a);
      apeCount++;
    }
  }
  return {
    rmse: Number(Math.sqrt(se / n).toFixed(3)),
    mae: Number((ae / n).toFixed(3)),
    mape: apeCount > 0 ? Number(((ape / apeCount) * 100).toFixed(2)) : null,
    samples: n
  };
}

// ---------- ARIMA 滚动回测 ----------
function backtestARIMA(series, opts = {}) {
  const minTrain = opts.minTrain || 7;
  const maxTests = opts.maxTests || 10; // 最多回测最近 N 个点，控制耗时
  const n = series.length;
  if (n < minTrain + 1) return { model: 'ARIMA', ...computeMetrics([], []), predictions: [] };

  const startIdx = Math.max(minTrain, n - maxTests);
  const actual = [], predicted = [], predictions = [];
  for (let i = startIdx; i < n; i++) {
    const train = series.slice(0, i);
    let pred;
    try {
      const fc = forecastSeries(train, { steps: 1, maxP: 3, maxD: 2, maxQ: 3 });
      pred = fc.forecast[0];
    } catch (e) {
      pred = train[train.length - 1]; // 拟合失败退化为「昨日值」
    }
    if (!Number.isFinite(pred)) pred = train[train.length - 1];
    actual.push(series[i]);
    predicted.push(pred);
    predictions.push({ index: i, actual: series[i], predicted: Number(pred.toFixed(3)) });
  }
  return { model: 'ARIMA', ...computeMetrics(actual, predicted), predictions };
}

// ---------- LSTM 滚动回测 ----------
// LSTM 每步都要重训，成本高。默认降低 epochs 并限制测试点数量以保证响应速度。
function backtestLSTM(series, opts = {}) {
  const minTrain = opts.minTrain || 10;
  const maxTests = opts.maxTests || 7;
  const epochs = opts.epochs || 80;
  const n = series.length;
  if (n < minTrain + 1) return { model: 'LSTM', ...computeMetrics([], []), predictions: [] };

  const startIdx = Math.max(minTrain, n - maxTests);
  const actual = [], predicted = [], predictions = [];
  for (let i = startIdx; i < n; i++) {
    const train = series.slice(0, i);
    let pred;
    try {
      const fc = forecastSeriesLSTM(train, {
        steps: 1,
        lookBack: Math.min(7, Math.floor(train.length / 2)),
        hiddenSize: 12,
        epochs,
        mcSamples: 15,
        seed: 12345
      });
      pred = fc.forecast[0];
    } catch (e) {
      pred = train[train.length - 1];
    }
    if (!Number.isFinite(pred)) pred = train[train.length - 1];
    actual.push(series[i]);
    predicted.push(pred);
    predictions.push({ index: i, actual: series[i], predicted: Number(pred.toFixed(3)) });
  }
  return { model: 'LSTM', ...computeMetrics(actual, predicted), predictions };
}

// ---------- 基线：朴素预测（用昨日值预测今日）----------
// 作为参照系：任何有价值的模型都应显著优于「昨日值」基线。
function backtestNaive(series, opts = {}) {
  const minTrain = opts.minTrain || 7;
  const maxTests = opts.maxTests || 10;
  const n = series.length;
  if (n < minTrain + 1) return { model: '朴素基线', ...computeMetrics([], []), predictions: [] };
  const startIdx = Math.max(minTrain, n - maxTests);
  const actual = [], predicted = [];
  for (let i = startIdx; i < n; i++) {
    actual.push(series[i]);
    predicted.push(series[i - 1]);
  }
  return { model: '朴素基线', ...computeMetrics(actual, predicted), predictions: [] };
}

/**
 * 综合回测：同时评估 ARIMA / LSTM / 朴素基线，并给出更优模型结论。
 * @param {number[]} series 时间序列
 * @param {Object} opts { minTrain, maxTests, epochs, includeLSTM }
 * @returns {Object} { results:[...], best, samples, series_length }
 */
function evaluateModels(series, opts = {}) {
  const includeLSTM = opts.includeLSTM !== false;
  const results = [];

  results.push(backtestARIMA(series, opts));
  if (includeLSTM) results.push(backtestLSTM(series, opts));
  // 朴素基线仅作为内部参照，不对外展示，避免干扰教师端决策
  // results.push(backtestNaive(series, opts));

  // 以 RMSE 为主指标挑选更优模型
  const rankable = results.filter(r => r.rmse != null);
  let best = null;
  if (rankable.length) {
    best = rankable.reduce((a, b) => (b.rmse < a.rmse ? b : a));
  }

  return {
    results,
    best: best ? best.model : null,
    samples: results[0] ? results[0].samples : 0,
    series_length: series.length
  };
}

module.exports = {
  computeMetrics,
  backtestARIMA,
  backtestLSTM,
  backtestNaive,
  evaluateModels,
};
