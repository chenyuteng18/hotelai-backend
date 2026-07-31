const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// GET /calendar/monthly
router.get('/monthly', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

    const recsRes = await pool.query(
      `SELECT target_date, status, COUNT(*) as count,
              ROUND(AVG(target_price), 2) as avg_price
       FROM recommendations
       WHERE hotel_id = $1 AND target_date >= $2 AND target_date < $3
       GROUP BY target_date, status
       ORDER BY target_date`,
      [hotelId, startDate, endDate]
    );

    const forecastsRes = await pool.query(
      `SELECT target_date, ROUND(AVG(predicted_occ), 4) as avg_occ,
              ROUND(AVG(predicted_adr), 2) as avg_adr,
              ROUND(AVG(predicted_revpar), 2) as avg_revpar
       FROM forecasts
       WHERE hotel_id = $1 AND target_date >= $2 AND target_date < $3
       GROUP BY target_date
       ORDER BY target_date`,
      [hotelId, startDate, endDate]
    );

    const days = {};
    for (const row of recsRes.rows) {
      const dateKey = row.target_date.toISOString ? row.target_date.toISOString().slice(0, 10) : String(row.target_date).slice(0, 10);
      if (!days[dateKey]) {
        days[dateKey] = { date: dateKey, recommendations: {}, forecast: null };
      }
      days[dateKey].recommendations[row.status] = {
        count: parseInt(row.count),
        avg_price: parseFloat(row.avg_price) || null,
      };
    }

    for (const row of forecastsRes.rows) {
      const dateKey = row.target_date.toISOString ? row.target_date.toISOString().slice(0, 10) : String(row.target_date).slice(0, 10);
      if (!days[dateKey]) {
        days[dateKey] = { date: dateKey, recommendations: {}, forecast: null };
      }
      days[dateKey].forecast = {
        avg_occ: parseFloat(row.avg_occ) || null,
        avg_adr: parseFloat(row.avg_adr) || null,
        avg_revpar: parseFloat(row.avg_revpar) || null,
      };
    }

    res.json({
      hotel_id: hotelId,
      year,
      month,
      days: Object.values(days),
    });
  } catch (err) {
    console.error('Calendar monthly error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// GET /calendar/day-detail
router.get('/day-detail', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'invalid_request', message: 'date 参数为必填（格式 YYYY-MM-DD）' });
    }

    const recsRes = await pool.query(
      `SELECT id, room_type_id, room_type_name, current_price, target_price,
              adjustment_pct, reason_cn, status, hold_reason, confidence,
              approved_by_name, approved_at, rejection_reason
       FROM recommendations
       WHERE hotel_id = $1 AND target_date = $2
       ORDER BY room_type_name`,
      [hotelId, date]
    );

    const forecastRes = await pool.query(
      `SELECT f.room_type_id, rt.name as room_type_name,
              f.predicted_occ, f.predicted_adr, f.predicted_revpar, f.confidence
       FROM forecasts f
       LEFT JOIN room_types rt ON rt.id = f.room_type_id
       WHERE f.hotel_id = $1 AND f.target_date = $2
       ORDER BY rt.name`,
      [hotelId, date]
    );

    res.json({
      hotel_id: hotelId,
      date,
      recommendations: recsRes.rows.map(r => ({
        id: r.id,
        room_type_id: r.room_type_id,
        room_type_name: r.room_type_name,
        current_price: parseFloat(r.current_price) || null,
        target_price: parseFloat(r.target_price) || null,
        adjustment_pct: parseFloat(r.adjustment_pct) || null,
        reason_cn: r.reason_cn,
        status: r.status,
        hold_reason: r.hold_reason,
        confidence: r.confidence,
        approved_by_name: r.approved_by_name,
        approved_at: r.approved_at,
        rejection_reason: r.rejection_reason,
      })),
      forecasts: forecastRes.rows.map(r => ({
        room_type_id: r.room_type_id,
        room_type_name: r.room_type_name || '全部房型',
        predicted_occ: parseFloat(r.predicted_occ) || null,
        predicted_adr: parseFloat(r.predicted_adr) || null,
        predicted_revpar: parseFloat(r.predicted_revpar) || null,
        confidence: r.confidence,
      })),
    });
  } catch (err) {
    console.error('Calendar day-detail error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
