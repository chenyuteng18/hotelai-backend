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

// POST /admin/tenants
router.post('/tenants', async (req, res) => {
  try {
    const { name, status } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'invalid_request', message: 'name 为必填' });
    }
    const result = await pool.query(
      `INSERT INTO tenants (name, status) VALUES ($1, $2) RETURNING *`,
      [name, status || 'active']
    );
    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, ip_address)
       VALUES ($1, $2, 'tenant_created', 'tenant', $3, $4)`,
      [result.rows[0].id, req.user.id, result.rows[0].id, req.ip]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create tenant error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// PUT /admin/tenants/:id
router.put('/tenants/:id', async (req, res) => {
  try {
    const { name, status } = req.body;
    const result = await pool.query(
      `UPDATE tenants SET name = COALESCE($2, name), status = COALESCE($3, status), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name || null, status || null]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '租户不存在' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update tenant error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// DELETE /admin/tenants/:id
router.delete('/tenants/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tenants WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '租户不存在' });
    }
    res.json({ status: 'deleted', id: parseInt(req.params.id) });
  } catch (err) {
    console.error('Delete tenant error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// GET /admin/hotels
router.get('/hotels', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT h.*, t.name as tenant_name FROM hotels h
       LEFT JOIN tenants t ON t.id = h.tenant_id ORDER BY h.id`
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error('Get hotels error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /admin/hotels
router.post('/hotels', async (req, res) => {
  try {
    const { tenant_id, name, address, total_rooms, pms_type } = req.body;
    if (!tenant_id || !name) {
      return res.status(400).json({ error: 'invalid_request', message: 'tenant_id 和 name 为必填' });
    }
    const result = await pool.query(
      `INSERT INTO hotels (tenant_id, name, address, total_rooms, pms_type, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [tenant_id, name, address || '', total_rooms || 0, pms_type || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create hotel error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// PUT /admin/hotels/:id
router.put('/hotels/:id', async (req, res) => {
  try {
    const { name, address, total_rooms, pms_type, status } = req.body;
    const result = await pool.query(
      `UPDATE hotels SET name = COALESCE($2, name), address = COALESCE($3, address),
       total_rooms = COALESCE($4, total_rooms), pms_type = COALESCE($5, pms_type),
       status = COALESCE($6, status), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name || null, address || null, total_rooms || null, pms_type || null, status || null]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '酒店不存在' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update hotel error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// DELETE /admin/hotels/:id
router.delete('/hotels/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM hotels WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '酒店不存在' });
    }
    res.json({ status: 'deleted', id: parseInt(req.params.id) });
  } catch (err) {
    console.error('Delete hotel error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// GET /admin/users
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, role, tenant_id, hotel_id, hotel_name, status, created_at
       FROM users ORDER BY id`
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /admin/users
router.post('/users', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { username, password, email, role, tenant_id, hotel_id, hotel_name } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'invalid_request', message: 'username 和 password 为必填' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, email, role, tenant_id, hotel_id, hotel_name, password_must_change, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'active') RETURNING id, username, email, role, tenant_id, hotel_id, status`,
      [username, hashedPassword, email || '', role || 'hotel_admin', tenant_id || null, hotel_id || null, hotel_name || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: '用户名已存在' });
    }
    console.error('Create user error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// PUT /admin/users/:id
router.put('/users/:id', async (req, res) => {
  try {
    const { email, role, status, hotel_id, hotel_name } = req.body;
    const result = await pool.query(
      `UPDATE users SET email = COALESCE($2, email), role = COALESCE($3, role),
       status = COALESCE($4, status), hotel_id = COALESCE($5, hotel_id),
       hotel_name = COALESCE($6, hotel_name), updated_at = NOW()
       WHERE id = $1 RETURNING id, username, email, role, tenant_id, hotel_id, status`,
      [req.params.id, email || null, role || null, status || null, hotel_id || null, hotel_name || null]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '用户不存在' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// DELETE /admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '用户不存在' });
    }
    res.json({ status: 'deleted', id: parseInt(req.params.id) });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
