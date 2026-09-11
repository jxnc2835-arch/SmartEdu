/**
 * 告警同步工具模块
 * 用于 routes/checkin.js 和 routes/students.js 中同步查寝记录变化后的告警
 */
const { syncAlertsForToday } = require('./alert-generator');

module.exports = { syncAlertsForToday };
