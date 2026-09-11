const express = require('express');
const { formatDate } = require('../utils/helpers');

/**
 * 初始化导出路由模块
 * @param {Object} opts - 依赖注入对象
 * @returns {Express.Router}
 */
module.exports = {
  /**
   * 初始化导出路由
   * @param {Object} opts - 依赖注入对象
   * @param {object} opts.db - sql.js Database 实例
   * @param {Function} opts.scheduleSave - 延迟保存函数
   * @param {Function} opts.authMiddleware - 认证中间件
   * @param {object} opts.XLSX - XLSX 库
   * @param {object} opts.PDFDocument - PDFKit 文档创建类
   * @param {Function} opts.addLog - 日志记录函数
   * @returns {Express.Router}
   */
  init: function(opts) {
    const { db, scheduleSave, authMiddleware, PDFDocument, addLog } = opts;
    const ExcelJS = require('exceljs');
    const router = express.Router();

    // Export students as Excel
    router.get('/api/export/students', authMiddleware, async (req, res) => {
      const { class_name, grade, dorm, search } = req.query;
      const where = ['1=1'];
      const params = [];
      if (class_name) { where.push('class_name=?'); params.push(class_name); }
      if (grade) { where.push('grade=?'); params.push(grade); }
      if (dorm) { where.push('dorm LIKE ?'); params.push(`%${dorm}%`); }
      if (search) {
        where.push('(name LIKE ? OR student_id LIKE ? OR phone LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      const sql = `SELECT student_id AS 学号, name AS 姓名, gender AS 性别, dorm AS 宿舍, class_name AS 班级, phone AS 电话 FROM students WHERE ${where.join(' AND ')}`;
      const rows = db.exec(sql, params)[0]?.values || [];
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('学生列表');
      // Header row
      worksheet.addRow(['学号','姓名','性别','宿舍','班级','电话']);
      // Data rows
      rows.forEach(row => worksheet.addRow(row));
      const buf = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="students.xlsx"');
      res.end(buf);
    });

    // Export attendance as PDF
    router.get('/api/export/attendance', authMiddleware, (req, res) => {
      const { date, class_name } = req.query;
      const where = ['1=1'];
      const params = [];
      if (date) { where.push('r.date=?'); params.push(date); }
      if (class_name) { where.push('s.class_name=?'); params.push(class_name); }
      const sql = `SELECT r.date, r.time, s.name, s.student_id, r.type, r.status FROM records r LEFT JOIN students s ON r.student_id = s.student_id WHERE ${where.join(' AND ')}`;
      const rows = db.exec(sql, params)[0]?.values || [];
      const doc = new PDFDocument({margin:30});
      doc.registerFont('Chinese','C:/Windows/Fonts/simhei.ttf');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="attendance.pdf"');
      doc.pipe(res);
      doc.font('Chinese').fontSize(18).text('考勤记录', {align:'center'});
      doc.moveDown();
      rows.forEach(row => {
        const [d,t,name,sid,type,status] = row;
        doc.font('Chinese').fontSize(12).text(`${d} ${t} | ${name} (${sid}) | ${type} | ${status}`);
      });
      doc.end();
    });

    // 综合性查寝报告（日报/周报/月报）PDF
    router.get('/api/export/report', authMiddleware, (req, res) => {
      try {
        const { type = 'month', date } = req.query;
        const ref = date ? new Date(date) : new Date();
        
        // 使用统一的日期格式化函数
        let start, end, title;
        end = formatDate(ref);
        if (type === 'day') { start = end; title = `查寝日报（${end}）`; }
        else if (type === 'week') { 
          const s = new Date(ref); 
          s.setDate(s.getDate() - 6); 
          start = formatDate(s); 
          title = `查寝周报（${start} ~ ${end}）`; 
        }
        else { 
          const s = new Date(ref.getFullYear(), ref.getMonth(), 1); 
          start = formatDate(s); 
          title = `查寝月报（${start} ~ ${end}）`; 
        }

        // KPI
        const rec = db.exec(`SELECT status, COUNT(*) FROM records WHERE type='checkin' AND date>=? AND date<=? GROUP BY status`, [start, end])[0]?.values || [];
        let total = 0, checkedIn = 0, absent = 0;
        rec.forEach(([st, c]) => { total += c; if (st === '在寝') checkedIn += c; else if (st === '未归' || st === '不在寝') absent += c; });
        const rate = total > 0 ? (checkedIn / total * 100) : 0;
        const leaveCnt = db.exec(`SELECT COUNT(*) FROM leaves WHERE status IN ('approved','已批准') AND start_date>=? AND start_date<=?`, [start, end])[0]?.values[0]?.[0] || 0;

        // 未归/不在寝名单
        const absentRows = db.exec(
          `SELECT DISTINCT r.student_id, s.name, s.class_name FROM records r LEFT JOIN students s ON r.student_id=s.student_id WHERE r.type='checkin' AND r.date>=? AND r.date<=? AND r.status IN ('未归','不在寝')`,
          [start, end]
        )[0]?.values || [];

        // 班级签到率
        const classRows = db.exec(
          `SELECT s.class_name, COUNT(CASE WHEN r.status='在寝' THEN 1 END), COUNT(*) FROM records r LEFT JOIN students s ON r.student_id=s.student_id WHERE r.type='checkin' AND r.date>=? AND r.date<=? GROUP BY s.class_name ORDER BY (CAST(COUNT(CASE WHEN r.status='在寝' THEN 1 END) AS REAL)/COUNT(*)) DESC`,
          [start, end]
        )[0]?.values || [];

        // 每日签到率（趋势柱状图）
        const daily = db.exec(
          `SELECT date, COUNT(CASE WHEN status='在寝' THEN 1 END), COUNT(*) FROM records WHERE type='checkin' AND date>=? AND date<=? GROUP BY date ORDER BY date`,
          [start, end]
        )[0]?.values || [];

        // ===== 生成 PDF =====
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        doc.registerFont('Chinese','C:/Windows/Fonts/simhei.ttf');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="chamber_report_${type}_${end}.pdf"`);
        doc.pipe(res);

        doc.font('Chinese').fontSize(20).text('学生查寝管理系统', { align: 'center' });
        doc.font('Chinese').fontSize(14).text(title, { align: 'center' });
        doc.moveDown();
        doc.font('Chinese').fontSize(10).fillColor('#64748b').text(`生成时间：${formatDate(new Date())} ${new Date().toTimeString().slice(0, 8)}`, { align: 'center' });
        doc.moveDown();
        doc.fillColor('#000000');

        // KPI 卡片
        doc.font('Chinese').fontSize(12).text(`统计周期：${start} ~ ${end}`);
        doc.font('Chinese').text(`签到总人次：${total}    在寝：${checkedIn}    未归：${absent}`);
        doc.font('Chinese').text(`签到率：${rate.toFixed(1)}%    请假人数：${leaveCnt}`);
        doc.moveDown();

        // 未归名单
        doc.font('Chinese').fontSize(14).text('一、未归 / 不在寝名单', { underline: true });
        if (absentRows.length === 0) doc.font('Chinese').fontSize(11).text('（本周期无未归记录）');
        else absentRows.slice(0, 60).forEach(([sid, name, cls]) => doc.font('Chinese').fontSize(11).text(`· ${name || sid}（${cls || '未分配班级'}） 学号：${sid}`));
        doc.moveDown();

        // 班级签到率 + 柱状图
        doc.font('Chinese').fontSize(14).text('二、各班级签到率', { underline: true });
        if (classRows.length === 0) doc.font('Chinese').fontSize(11).text('（无数据）');
        else classRows.forEach(([cls, ci, tot]) => {
          const r = tot > 0 ? ci / tot * 100 : 0;
          doc.font('Chinese').fontSize(11).text(`${cls || '未知班级'}：${r.toFixed(1)}%（${ci}/${tot}）`);
          const barW = Math.max(2, (r / 100) * 320);
          doc.save().rect(doc.x, doc.y, barW, 7).fill('#3b82f6');
          doc.restore();
          doc.moveDown(0.6);
        });
        doc.moveDown();

        // 每日签到率趋势
        doc.font('Chinese').fontSize(14).text('三、每日签到率趋势', { underline: true });
        if (daily.length === 0) doc.font('Chinese').fontSize(11).text('（无数据）');
        else daily.forEach(([d, ci, tot]) => {
          const r = tot > 0 ? ci / tot * 100 : 0;
          doc.font('Chinese').fontSize(10).text(`${d.slice(5)}：${r.toFixed(1)}%`);
          const barW = Math.max(2, (r / 100) * 320);
          doc.save().rect(doc.x, doc.y, barW, 5).fill('#22c55e');
          doc.restore();
          doc.moveDown(0.4);
        });

        doc.end();
      } catch (e) {
        console.error('PDF 报告生成失败:', e);
        if (!res.headersSent) res.json({ code: 1, message: e.message });
        else try { res.end(); } catch (_) {}
      }
    });

    return router;
  }
};
