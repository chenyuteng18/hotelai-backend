const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// GET /dashboard/summary
router.get('/summary', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;

    const suggestionsRes = await pool.query(
      `SELECT r.id, r.room_type_id, r.room_type_name, r.target_date, r.current_price, r.target_price,
              r.adjustment_pct, r.reason_cn, r.status, r.hold_reason, r.confidence,
              r.ttl_remaining_minutes, r.competitor_avg, r.guardrails
       FROM recommendations r
       WHERE r.hotel_id = $1 AND r.target_date >= CURRENT_DATE
       ORDER BY r.target_date, r.room_type_name
       LIMIT 20`,
      [hotelId]
    );

    const agentRes = await pool.query(
      `SELECT collection_status, last_heartbeat FROM agents WHERE hotel_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [hotelId]
    );

    const collectionStatus = agentRes.rows[0]?.collection_status || {};
    const heartbeat = agentRes.rows[0]?.last_heartbeat;
    const ageHours = heartbeat ? Math.round((Date.now() - new Date(heartbeat).getTime()) / 3600000) : 0;

    const health = {
      self_price: { status: collectionStatus.self_price || 'no_data', display: `自采价(${ageHours}h前)`, age_hours: ageHours },
      competitor: { status: collectionStatus.competitor || 'no_data', display: `竞对价(${ageHours}h前)`, age_hours: ageHours },
      bar: { status: collectionStatus.bar || 'no_data', display: `BAR(${ageHours}h前)`, age_hours: ageHours },
      pms: { status: collectionStatus.pms || 'no_data', display: `PMS(${ageHours}h前)`, age_hours: ageHours },
    };

    const approvalsRes = await pool.query(
      `SELECT r.id, r.room_type_name, r.target_date, r.target_price, r.status,
              r.approved_by_name, r.approved_at, r.rejection_reason
       FROM recommendations r
       WHERE r.hotel_id = $1 AND r.status IN ('approved', 'rejected')
       ORDER BY r.approved_at DESC NULLS LAST
       LIMIT 7`,
      [hotelId]
    );

    const trendRes = await pool.query(
      `SELECT target_date, predicted_adr as my_price,
              ROUND(predicted_adr * 1.1, 2) as comp_avg
       FROM forecasts
       WHERE hotel_id = $1 AND target_date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY target_date
       LIMIT 7`,
      [hotelId]
    );

    const myAvg = trendRes.rows.length > 0
      ? Math.round(trendRes.rows.reduce((s, r) => s + parseFloat(r.my_price), 0) / trendRes.rows.length)
      : 0;
    const compAvg = trendRes.rows.length > 0
      ? Math.round(trendRes.rows.reduce((s, r) => s + parseFloat(r.comp_avg), 0) / trendRes.rows.length)
      : 0;

    res.json({
      hotel_id: hotelId,
      hotel_name: req.user.hotel_name,
      today_suggestions: suggestionsRes.rows.map(r => ({
        id: r.id,
        room_type_id: r.room_type_id,
        room_type_name: r.room_type_name,
        target_date: r.target_date,
        current_price: parseFloat(r.current_price),
        target_price: parseFloat(r.target_price),
        adjustment_pct: parseFloat(r.adjustment_pct),
        reason_cn: r.reason_cn,
        status: r.status,
        hold_reason: r.hold_reason,
        confidence: r.confidence,
        ttl_remaining_minutes: r.ttl_remaining_minutes,
        competitor_avg: parseFloat(r.competitor_avg || 0),
        guardrails: r.guardrails ? (typeof r.guardrails === 'string' ? JSON.parse(r.guardrails) : r.guardrails) : null,
      })),
      data_health: health,
      recent_approvals: approvalsRes.rows,
      competitor_comparison: {
        my_avg_price: myAvg,
        competitor_avg_price: compAvg,
        trend_7d: trendRes.rows.map(r => ({
          date: r.target_date,
          my_price: parseFloat(r.my_price),
          comp_avg: parseFloat(r.comp_avg),
        })),
      },
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
