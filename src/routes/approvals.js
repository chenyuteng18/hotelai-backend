const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// POST /approvals/approve
router.post('/approve', async (req, res) => {
  try {
    const { recommendation_id, hotel_id } = req.body;

    if (!recommendation_id) {
      return res.status(400).json({ error: 'invalid_request', message: 'recommendation_id 为必填' });
    }

    const effectiveHotelId = hotel_id || req.user.hotel_id;

    const current = await pool.query(
      `SELECT r.id, r.status, r.target_price, r.current_price, r.created_at,
              r.ttl_remaining_minutes, r.guardrails,
              cg.min_bar_price, cg.max_bar_price, cg.max_single_adjustment_pct
       FROM recommendations r
       LEFT JOIN config_guardrails cg ON cg.hotel_id = r.hotel_id
       WHERE r.id = $1 AND r.hotel_id = $2`,
      [recommendation_id, effectiveHotelId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '建议不存在' });
    }

    const rec = current.rows[0];

    // Idempotent: already approved
    if (rec.status === 'approved') {
      return res.status(200).json({
        status: 'idempotent_success',
        writes_db: false,
        original_command_id: recommendation_id,
        message: '此建议已被批准，无需重复操作',
      });
    }

    // Idempotent: already rejected
    if (rec.status === 'rejected') {
      return res.status(200).json({
        status: 'idempotent_success',
        writes_db: false,
        original_command_id: recommendation_id,
        message: '此建议已被拒绝，无法批准',
      });
    }

    if (rec.status !== 'ready') {
      return res.status(409).json({ error: 'idempotent_hit', message: `该建议当前状态为 ${rec.status}，无法批准` });
    }

    // TTL check
    if (rec.ttl_remaining_minutes !== null && rec.ttl_remaining_minutes <= 0) {
      return res.status(422).json({
        error: 'recommendation_expired',
        message: '此建议已过期（超过 2 小时），请等待下一轮建议',
        ttl_minutes: 120,
        created_at: rec.created_at,
      });
    }

    // Guardrail check
    if (rec.target_price && rec.min_bar_price) {
      const targetPrice = parseFloat(rec.target_price);
      const minBar = parseFloat(rec.min_bar_price);
      const maxBar = parseFloat(rec.max_bar_price);
      const maxAdjPct = parseFloat(rec.max_single_adjustment_pct || 10);
      const currentPrice = parseFloat(rec.current_price || targetPrice);
      const adjustmentPct = currentPrice > 0 ? Math.abs(((targetPrice - currentPrice) / currentPrice) * 100) : 0;

      if (targetPrice < minBar || targetPrice > maxBar || adjustmentPct > maxAdjPct) {
        return res.status(422).json({
          error: 'guardrail_triggered',
          message: '目标价超出护栏范围，已拦截',
          calculation: {
            target_bar: targetPrice,
            current_bar: currentPrice,
            min_bar: minBar,
            max_bar: maxBar,
            max_adjustment_pct: maxAdjPct,
            adjustment_pct: Math.round(adjustmentPct * 10) / 10,
          },
        });
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

    res.json({
      status: 'approved',
      recommendation_id,
      command_id: recommendation_id,
      shadow_mode: true,
      execution_blocked: true,
      writes_db: true,
    });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /approvals/reject
router.post('/reject', async (req, res) => {
  try {
    const { recommendation_id, hotel_id, reason } = req.body;

    if (!recommendation_id) {
      return res.status(400).json({ error: 'invalid_request', message: 'recommendation_id 为必填' });
    }

    const effectiveHotelId = hotel_id || req.user.hotel_id;

    const current = await pool.query(
      'SELECT id, status FROM recommendations WHERE id = $1 AND hotel_id = $2',
      [recommendation_id, effectiveHotelId]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '建议不存在' });
    }

    // Idempotent: already rejected
    if (current.rows[0].status === 'rejected') {
      return res.status(200).json({
        status: 'idempotent_success',
        writes_db: false,
        original_command_id: recommendation_id,
        message: '此建议已被拒绝，无需重复操作',
      });
    }

    // Idempotent: already approved
    if (current.rows[0].status === 'approved') {
      return res.status(200).json({
        status: 'idempotent_success',
        writes_db: false,
        original_command_id: recommendation_id,
        message: '此建议已被批准，无法拒绝',
      });
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

    res.json({
      status: 'rejected',
      recommendation_id,
      reason: reason || '',
    });
  } catch (err) {
    console.error('Reject error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
