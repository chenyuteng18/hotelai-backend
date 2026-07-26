const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// GET /admin/tenants
router.get('/tenants', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.status, t.created_at,
              COUNT(DISTINCT h.id) as hotel_count
       FROM tenants t
       LEFT JOIN hotels h ON h.tenant_id = t.id
       GROUP BY t.id, t.name, t.status, t.created_at
       ORDER BY t.id`
    );

    res.json({
      items: result.rows.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        hotel_count: parseInt(r.hotel_count),
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('Get tenants error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// GET /admin/agents
router.get('/agents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.agent_id, a.hotel_id, h.name as hotel_name, a.status,
              a.last_heartbeat, a.platform, a.version, a.collection_status,
              EXTRACT(EPOCH FROM (NOW() - a.last_heartbeat)) / 60 as heartbeat_age_minutes
       FROM agents a
       JOIN hotels h ON h.id = a.hotel_id
       ORDER BY a.hotel_id`
    );

    res.json({
      agents: result.rows.map(r => ({
        agent_id: r.agent_id,
        hotel_id: r.hotel_id,
        hotel_name: r.hotel_name,
        status: r.status,
        last_heartbeat: r.last_heartbeat,
        heartbeat_age_minutes: Math.round(r.heartbeat_age_minutes || 0),
        platform: r.platform,
        version: r.version,
        collection_status: typeof r.collection_status === 'string'
          ? JSON.parse(r.collection_status) : r.collection_status,
      })),
    });
  } catch (err) {
    console.error('Get agents error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// GET /admin/audit-log
router.get('/audit-log', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.per_page) || 50;
    const offset = (page - 1) * perPage;
    const { action } = req.query;

    let where = '';
    const params = [];
    let paramIdx = 1;

    if (action) {
      where = `WHERE al.action = $${paramIdx++}`;
      params.push(action);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM audit_log al ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await pool.query(
      `SELECT al.*, u.username as actor_username
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, perPage, offset]
    );

    res.json({
      items: result.rows.map(r => ({
        id: r.id,
        tenant_id: r.tenant_id,
        actor_user_id: r.actor_user_id,
        actor_username: r.actor_username,
        action: r.action,
        resource_type: r.resource_type,
        resource_id: r.resource_id,
        details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
        ip_address: r.ip_address,
        created_at: r.created_at,
      })),
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: Math.ceil(total / perPage),
      },
    });
  } catch (err) {
    console.error('Get audit log error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
