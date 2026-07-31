const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// GET /recommendations
router.get('/', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.per_page) || 20;
    const offset = (page - 1) * perPage;
    const { status, room_type_id, date_from, date_to } = req.query;

    let where = 'WHERE hotel_id = $1';
    const params = [hotelId];
    let paramIdx = 2;

    if (status) {
      where += ` AND status = $${paramIdx++}`;
      params.push(status);
    }
    if (room_type_id) {
      where += ` AND room_type_id = $${paramIdx++}`;
      params.push(parseInt(room_type_id));
    }
    if (date_from) {
      where += ` AND target_date >= $${paramIdx++}`;
      params.push(date_from);
    }
    if (date_to) {
      where += ` AND target_date <= $${paramIdx++}`;
      params.push(date_to);
    }

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM recommendations ${where}`, params
    );
    const total = parseInt(countRes.rows[0].total);

    const dataRes = await pool.query(
      `SELECT * FROM recommendations ${where} ORDER BY target_date DESC, room_type_name ASC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, perPage, offset]
    );

    res.json({
      items: dataRes.rows.map(r => ({
        id: r.id,
        room_type_id: r.room_type_id,
        room_type_name: r.room_type_name,
        target_date: r.target_date,
        current_price: parseFloat(r.current_price),
        target_price: parseFloat(r.target_price),
        status: r.status,
        hold_reason: r.hold_reason,
        confidence: r.confidence,
        reason_cn: r.reason_cn,
        algorithm_version: 'v1-lite',
        created_at: r.created_at,
        approved_by: r.approved_by_name || null,
        approved_at: r.approved_at,
        rejection_reason: r.rejection_reason,
        guardrails: r.guardrails ? (typeof r.guardrails === 'string' ? JSON.parse(r.guardrails) : r.guardrails) : null,
      })),
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: Math.ceil(total / perPage),
      },
    });
  } catch (err) {
    console.error('List recommendations error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// GET /recommendations/:id
router.get('/:id', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const result = await pool.query(
      `SELECT r.*, cg.min_bar_price, cg.max_bar_price, cg.max_single_adjustment_pct
       FROM recommendations r
       LEFT JOIN config_guardrails cg ON cg.hotel_id = r.hotel_id
       WHERE r.id = $1 AND r.hotel_id = $2`,
      [req.params.id, hotelId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '建议不存在' });
    }

    const r = result.rows[0];
    const guardrails = r.guardrails ? (typeof r.guardrails === 'string' ? JSON.parse(r.guardrails) : r.guardrails) : null;

    res.json({
      id: r.id,
      hotel_id: r.hotel_id,
      room_type_id: r.room_type_id,
      room_type_name: r.room_type_name,
      target_date: r.target_date,
      current_price: parseFloat(r.current_price),
      target_price: parseFloat(r.target_price),
      adjustment_pct: parseFloat(r.adjustment_pct),
      status: r.status,
      confidence: r.confidence,
      reason_cn: r.reason_cn,
      hold_reason: r.hold_reason,
      algorithm_version: 'v1-lite',
      metadata: {
        bar_target_price: parseFloat(r.target_price),
        original_customer_price: parseFloat(r.current_price),
        r_value: 0.70,
        data_lineage: 'ctrip_competitor_avg_3hotels + pickup_pms',
        competitor_avg: parseFloat(r.competitor_avg || 0),
        pickup_rate: 0.65,
        lead_time_days: r.target_date ? Math.max(0, Math.round((new Date(r.target_date) - new Date()) / 86400000)) : 0,
      },
      guardrails: {
        min_bar: parseFloat(r.min_bar_price || 0),
        max_bar: parseFloat(r.max_bar_price || 0),
        max_adjustment_pct: parseFloat(r.max_single_adjustment_pct || 10),
        within_range: guardrails ? guardrails.within_range : true,
      },
      ttl_remaining_minutes: r.ttl_remaining_minutes,
      created_at: r.created_at,
      approved_by: r.approved_by_name || null,
      approved_at: r.approved_at,
      rejection_reason: r.rejection_reason,
    });
  } catch (err) {
    console.error('Get recommendation error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /recommendations/:id/approve
router.post('/:id/approve', async (req, res) => {
  try {
    const recommendation_id = req.params.id;
    const hotelId = req.user.hotel_id;

    const current = await pool.query(
      `SELECT r.id, r.status, r.target_price, r.current_price, r.created_at,
              r.ttl_remaining_minutes, r.guardrails,
              cg.min_bar_price, cg.max_bar_price, cg.max_single_adjustment_pct
       FROM recommendations r
       LEFT JOIN config_guardrails cg ON cg.hotel_id = r.hotel_id
       WHERE r.id = $1 AND r.hotel_id = $2`,
      [recommendation_id, hotelId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '建议不存在' });
    }

    const rec = current.rows[0];

    if (rec.status === 'approved') {
      return res.status(200).json({ status: 'idempotent_success', writes_db: false, message: '此建议已被批准，无需重复操作' });
    }
    if (rec.status === 'rejected') {
      return res.status(200).json({ status: 'idempotent_success', writes_db: false, message: '此建议已被拒绝，无法批准' });
    }
    if (rec.status !== 'ready') {
      return res.status(409).json({ error: 'idempotent_hit', message: `该建议当前状态为 ${rec.status}，无法批准` });
    }

    if (rec.ttl_remaining_minutes !== null && rec.ttl_remaining_minutes <= 0) {
      return res.status(422).json({ error: 'recommendation_expired', message: '此建议已过期（超过 2 小时），请等待下一轮建议' });
    }

    if (rec.target_price && rec.min_bar_price) {
      const targetPrice = parseFloat(rec.target_price);
      const minBar = parseFloat(rec.min_bar_price);
      const maxBar = parseFloat(rec.max_bar_price);
      const maxAdjPct = parseFloat(rec.max_single_adjustment_pct || 10);
      const currentPrice = parseFloat(rec.current_price || targetPrice);
      const adjustmentPct = currentPrice > 0 ? Math.abs(((targetPrice - currentPrice) / currentPrice) * 100) : 0;

      if (targetPrice < minBar || targetPrice > maxBar || adjustmentPct > maxAdjPct) {
        return res.status(422).json({ error: 'guardrail_triggered', message: '目标价超出护栏范围，已拦截' });
      }
    }

    await pool.query(
      `UPDATE recommendations SET status = 'approved', approved_by = $1, approved_by_name = $2,
       approved_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [req.user.id, req.user.username, recommendation_id]
    );

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, ip_address)
       VALUES ($1, $2, 'recommendation_approved', 'recommendation', $3, $4)`,
      [req.user.tenant_id, req.user.id, recommendation_id, req.ip]
    );

    res.json({ status: 'approved', recommendation_id: parseInt(recommendation_id), shadow_mode: true, execution_blocked: true, writes_db: true });
  } catch (err) {
    console.error('Approve recommendation error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /recommendations/:id/reject
router.post('/:id/reject', async (req, res) => {
  try {
    const recommendation_id = req.params.id;
    const hotelId = req.user.hotel_id;
    const { reason } = req.body;

    const current = await pool.query(
      'SELECT id, status FROM recommendations WHERE id = $1 AND hotel_id = $2',
      [recommendation_id, hotelId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '建议不存在' });
    }

    if (current.rows[0].status === 'rejected') {
      return res.status(200).json({ status: 'idempotent_success', writes_db: false, message: '此建议已被拒绝，无需重复操作' });
    }
    if (current.rows[0].status === 'approved') {
      return res.status(200).json({ status: 'idempotent_success', writes_db: false, message: '此建议已被批准，无法拒绝' });
    }
    if (current.rows[0].status !== 'ready') {
      return res.status(409).json({ error: 'idempotent_hit', message: `该建议当前状态为 ${current.rows[0].status}，无法拒绝` });
    }

    await pool.query(
      `UPDATE recommendations SET status = 'rejected', approved_by = $1, approved_by_name = $2,
       rejection_reason = $3, approved_at = NOW(), updated_at = NOW() WHERE id = $4`,
      [req.user.id, req.user.username, reason || '', recommendation_id]
    );

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, details, ip_address)
       VALUES ($1, $2, 'recommendation_rejected', 'recommendation', $3, $4, $5)`,
      [req.user.tenant_id, req.user.id, recommendation_id, JSON.stringify({ reason }), req.ip]
    );

    res.json({ status: 'rejected', recommendation_id: parseInt(recommendation_id), reason: reason || '' });
  } catch (err) {
    console.error('Reject recommendation error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
