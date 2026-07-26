const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const { generateToken, authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'invalid_request', message: '用户名和密码不能为空' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND status = $2',
      [username, 'active']
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'invalid_credentials', message: '用户名或密码错误' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'invalid_credentials', message: '用户名或密码错误' });
    }

    const token = generateToken(user);

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, ip_address)
       VALUES ($1, $2, 'user_login', 'user', $2, $3)`,
      [user.tenant_id, user.id, req.ip]
    );

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 86400,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenant_id: user.tenant_id,
        hotel_id: user.hotel_id,
        hotel_name: user.hotel_name,
        password_must_change: user.password_must_change,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { old_password, new_password, confirm_password } = req.body;

    if (!old_password || !new_password || !confirm_password) {
      return res.status(400).json({ error: 'invalid_request', message: '所有密码字段均为必填' });
    }

    if (new_password !== confirm_password) {
      return res.status(422).json({ error: 'password_mismatch', message: '两次输入的密码不一致' });
    }

    if (new_password.length < 8) {
      return res.status(422).json({ error: 'password_too_weak', message: '密码需至少8位，含大小写和特殊字符' });
    }

    const userId = req.user.id;
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '用户不存在' });
    }

    const validOldPassword = await bcrypt.compare(old_password, result.rows[0].password_hash);
    if (!validOldPassword) {
      return res.status(400).json({ error: 'invalid_request', message: '当前密码不正确' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, password_must_change = false, updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    await pool.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, ip_address)
       VALUES ($1, $2, 'password_changed', 'user', $2, $3)`,
      [req.user.tenant_id, userId, req.ip]
    );

    res.json({ status: 'password_changed', message: '密码已更新，请重新登录', access_token: null });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
