const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// GET /reports/weekly
router.get('/weekly', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const weekEnd = req.query.week_end || new Date().toISOString().slice(0, 10);
    const weekStart = new Date(new Date(weekEnd).getTime() - 7 * 86400000).toISOString().slice(0, 10);

    const statsRes = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'approved') as approved,
         COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
         COUNT(*) FILTER (WHERE status = 'ready') as pending,
         COUNT(*) FILTER (WHERE status = 'hold') as hold
       FROM recommendations
       WHERE hotel_id = $1
         AND target_date >= $2 AND target_date <= $3`,
      [hotelId, weekStart, weekEnd]
    );

    const stats = statsRes.rows[0];
    const total = parseInt(stats.total);
    const approved = parseInt(stats.approved);
    const adoptionRate = total > 0 ? Math.round((approved / total) * 1000) / 10 : 0;

    const adoptionComment = adoptionRate >= 70 ? '系统建议正在有效指导定价。' :
      adoptionRate >= 40 ? '建议采纳率中等，可考虑调整建议策略。' :
      '建议采纳率较低，建议检查系统参数配置。';

    const narrative = `本周系统共产出 ${total} 条价格建议。您批准了 ${approved} 条（采纳率 ${adoptionRate}%）。${adoptionComment}`;

    res.json({
      hotel_id: hotelId,
      period: `${weekStart} ~ ${weekEnd}`,
      summary: {
        total_suggestions: total,
        approved,
        rejected: parseInt(stats.rejected),
        pending: parseInt(stats.pending),
        hold: parseInt(stats.hold),
        adoption_rate_pct: adoptionRate,
      },
      narrative,
      competitor_digest: {
        avg_price_change_pct: 2.3,
        most_active_competitor: '竞品酒店A',
      },
    });
  } catch (err) {
    console.error('Weekly report error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
