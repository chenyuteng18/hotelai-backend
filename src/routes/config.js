const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// GET /config/guardrails
router.get('/guardrails', async (req, res) => {
  try {
    const hotelId = req.query.hotel_id || req.user.hotel_id;
    const result = await pool.query(
      'SELECT * FROM config_guardrails WHERE hotel_id = $1', [hotelId]
    );

    if (result.rows.length === 0) {
      return res.json({
        hotel_id: parseInt(hotelId),
        min_bar_price: 150.00,
        max_bar_price: 800.00,
        max_single_adjustment_pct: 10.0,
        freshness_threshold_hours: 26,
        ttl_minutes: 120,
      });
    }

    const r = result.rows[0];
    res.json({
      hotel_id: r.hotel_id,
      min_bar_price: parseFloat(r.min_bar_price),
      max_bar_price: parseFloat(r.max_bar_price),
      max_single_adjustment_pct: parseFloat(r.max_single_adjustment_pct),
      freshness_threshold_hours: r.freshness_threshold_hours,
      ttl_minutes: r.ttl_minutes,
    });
  } catch (err) {
    console.error('Get guardrails error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// PUT /config/guardrails
router.put('/guardrails', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const { min_bar_price, max_bar_price, max_single_adjustment_pct, freshness_threshold_hours, ttl_minutes } = req.body;

    // Get current values for change tracking
    const current = await pool.query(
      'SELECT * FROM config_guardrails WHERE hotel_id = $1', [hotelId]
    );
    const old = current.rows[0] || {};
    const changes = [];

    const newMinBar = min_bar_price !== undefined ? min_bar_price : parseFloat(old.min_bar_price || 150);
    const newMaxBar = max_bar_price !== undefined ? max_bar_price : parseFloat(old.max_bar_price || 800);
    const newMaxAdj = max_single_adjustment_pct !== undefined ? max_single_adjustment_pct : parseFloat(old.max_single_adjustment_pct || 10);
    const newFreshness = freshness_threshold_hours !== undefined ? freshness_threshold_hours : (old.freshness_threshold_hours || 26);
    const newTtl = ttl_minutes !== undefined ? ttl_minutes : (old.ttl_minutes || 120);

    if (min_bar_price !== undefined && parseFloat(old.min_bar_price || 0) !== parseFloat(min_bar_price)) {
      changes.push(`min_bar_price: ${old.min_bar_price || 0}→${min_bar_price}`);
    }
    if (max_bar_price !== undefined && parseFloat(old.max_bar_price || 0) !== parseFloat(max_bar_price)) {
      changes.push(`max_bar_price: ${old.max_bar_price || 0}→${max_bar_price}`);
    }
    if (max_single_adjustment_pct !== undefined && parseFloat(old.max_single_adjustment_pct || 0) !== parseFloat(max_single_adjustment_pct)) {
      changes.push(`max_single_adjustment_pct: ${old.max_single_adjustment_pct || 0}→${max_single_adjustment_pct}`);
    }

    await pool.query(
      `INSERT INTO config_guardrails (hotel_id, min_bar_price, max_bar_price, max_single_adjustment_pct, freshness_threshold_hours, ttl_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (hotel_id) DO UPDATE SET
         min_bar_price = $2, max_bar_price = $3, max_single_adjustment_pct = $4,
         freshness_threshold_hours = $5, ttl_minutes = $6, updated_at = NOW()`,
      [hotelId, newMinBar, newMaxBar, newMaxAdj, newFreshness, newTtl]
    );

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, details, ip_address)
       VALUES ($1, $2, 'guardrails_updated', 'config', $3, $4, $5)`,
      [req.user.tenant_id, req.user.id, hotelId, JSON.stringify(req.body), req.ip]
    );

    res.json({ status: 'updated', hotel_id: hotelId, changes });
  } catch (err) {
    console.error('Update guardrails error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// GET /config/feature-flags
router.get('/feature-flags', async (req, res) => {
  try {
    const hotelId = req.query.hotel_id || req.user.hotel_id;
    const result = await pool.query(
      'SELECT * FROM feature_flags WHERE hotel_id = $1', [hotelId]
    );

    if (result.rows.length === 0) {
      return res.json({
        hotel_id: parseInt(hotelId),
        flags: {
          auto_execute: false, ctrip_agent: true, meituan_agent: false,
          pms_sync: true, feishu_approval: true, wecom_approval: false,
          daily_report: true, weekly_report: true,
        },
      });
    }

    const flags = result.rows[0].flags;
    res.json({
      hotel_id: result.rows[0].hotel_id,
      flags: typeof flags === 'string' ? JSON.parse(flags) : flags,
    });
  } catch (err) {
    console.error('Get feature flags error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// PUT /config/feature-flags
router.put('/feature-flags', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const { flags } = req.body;

    if (!flags || typeof flags !== 'object') {
      return res.status(400).json({ error: 'invalid_request', message: 'flags 对象为必填' });
    }

    const current = await pool.query(
      'SELECT flags FROM feature_flags WHERE hotel_id = $1', [hotelId]
    );
    const oldFlags = current.rows.length > 0
      ? (typeof current.rows[0].flags === 'string' ? JSON.parse(current.rows[0].flags) : current.rows[0].flags)
      : {};
    const mergedFlags = { ...oldFlags, ...flags };

    await pool.query(
      `INSERT INTO feature_flags (hotel_id, flags)
       VALUES ($1, $2)
       ON CONFLICT (hotel_id) DO UPDATE SET flags = $2, updated_at = NOW()`,
      [hotelId, JSON.stringify(mergedFlags)]
    );

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, details, ip_address)
       VALUES ($1, $2, 'feature_flags_updated', 'config', $3, $4, $5)`,
      [req.user.tenant_id, req.user.id, hotelId, JSON.stringify({ old: oldFlags, new: mergedFlags }), req.ip]
    );

    res.json({ status: 'updated', hotel_id: hotelId, flags: mergedFlags });
  } catch (err) {
    console.error('Update feature flags error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
