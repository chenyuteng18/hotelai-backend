const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');

const router = express.Router();

// POST /onboarding/draft
router.post('/draft', async (req, res) => {
  try {
    const { step, data } = req.body;

    const result = await pool.query(
      `INSERT INTO onboarding_drafts (step, data, status)
       VALUES ($1, $2, 'draft')
       RETURNING *`,
      [step || 0, JSON.stringify(data || {})]
    );

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, details, ip_address)
       VALUES ($1, $2, 'onboarding_draft_saved', 'onboarding', $3, $4, $5)`,
      [req.user.tenant_id, req.user.id, result.rows[0].id, JSON.stringify({ step }), req.ip]
    );

    res.json({ status: 'saved', draft_id: result.rows[0].id });
  } catch (err) {
    console.error('Save draft error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /onboarding/provision
router.post('/provision', async (req, res) => {
  const client = await pool.connect();
  try {
    const { tenant_name, hotel, room_types, admin_user, guardrails, competitors } = req.body;

    await client.query('BEGIN');

    // Create tenant if tenant_name provided
    let tenantId = req.user.tenant_id;
    if (tenant_name) {
      const tenantRes = await client.query(
        `INSERT INTO tenants (name, status) VALUES ($1, 'active') RETURNING id`,
        [tenant_name]
      );
      tenantId = tenantRes.rows[0].id;
    }

    // Create hotel
    const hotelRes = await client.query(
      `INSERT INTO hotels (tenant_id, name, address, total_rooms, pms_type, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
      [tenantId, hotel?.name || 'New Hotel', hotel?.address || '', hotel?.total_rooms || 0, hotel?.pms_type || '']
    );
    const newHotelId = hotelRes.rows[0].id;

    // Create room types
    const roomTypeIds = [];
    const rtList = room_types || [];
    for (const rt of rtList) {
      const rtRes = await client.query(
        `INSERT INTO room_types (hotel_id, name) VALUES ($1, $2) RETURNING id`,
        [newHotelId, rt.name]
      );
      roomTypeIds.push(rtRes.rows[0].id);
    }

    // Create guardrails
    const gr = guardrails || {};
    await client.query(
      `INSERT INTO config_guardrails (hotel_id, min_bar_price, max_bar_price, max_single_adjustment_pct)
       VALUES ($1, $2, $3, $4)`,
      [newHotelId, gr.min_bar_price || 0, gr.max_bar_price || 0, gr.max_single_adjustment_pct || 10]
    );

    // Create feature flags with defaults
    await client.query(
      `INSERT INTO feature_flags (hotel_id, flags) VALUES ($1, $2)`,
      [newHotelId, JSON.stringify({
        auto_execute: false,
        ctrip_agent: !!hotel?.ota_ctrip_url,
        meituan_agent: false,
        pms_sync: true,
        feishu_approval: true,
        wecom_approval: false,
        daily_report: true,
        weekly_report: true,
      })]
    );

    // Create admin user for the hotel
    let tempPasswordEmail = null;
    if (admin_user?.username) {
      const tempPassword = 'Change@123';
      const hashedPassword = await bcrypt.hash(tempPassword, 10);
      await client.query(
        `INSERT INTO users (username, password_hash, email, role, tenant_id, hotel_id, hotel_name, password_must_change, status)
         VALUES ($1, $2, $3, 'hotel_admin', $4, $5, $6, true, 'active')`,
        [admin_user.username, hashedPassword, admin_user.email || '', tenantId, newHotelId, hotel?.name || '']
      );
      tempPasswordEmail = admin_user.email || null;
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, details, ip_address)
       VALUES ($1, $2, 'hotel_provisioned', 'hotel', $3, $4, $5)`,
      [tenantId, req.user.id, newHotelId, JSON.stringify({ hotel_name: hotel?.name, rooms: rtList.length }), req.ip]
    );

    await client.query('COMMIT');

    res.status(201).json({
      status: 'provisioned',
      tenant_id: tenantId,
      hotel_id: newHotelId,
      room_type_ids: roomTypeIds,
      admin_user: {
        username: admin_user?.username || null,
        temporary_password_sent_to: tempPasswordEmail,
      },
      next_steps: [
        '完成房型映射配置',
        '分配采集工作账号',
        '配置飞书审批群',
      ],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Provision error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  } finally {
    client.release();
  }
});

module.exports = router;
