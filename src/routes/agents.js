const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// POST /agents/register
router.post('/register', async (req, res) => {
  try {
    const { agent_key, hotel_id, platform, version } = req.body;

    if (!agent_key || !hotel_id) {
      return res.status(400).json({ error: 'invalid_request', message: 'agent_key 和 hotel_id 为必填' });
    }

    const agentId = `agent_hotel${hotel_id}_${Date.now().toString(36)}`;

    await pool.query(
      `INSERT INTO agents (agent_id, hotel_id, platform, version, status, last_heartbeat)
       VALUES ($1, $2, $3, $4, 'active', NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         platform = $3, version = $4, status = 'active', last_heartbeat = NOW(), updated_at = NOW()`,
      [agentId, hotel_id, platform || 'unknown', version || '1.0.0']
    );

    res.status(201).json({
      agent_id: agentId,
      config_version: 1,
    });
  } catch (err) {
    console.error('Agent register error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

// POST /agents/:agent_id/heartbeat
router.post('/:agent_id/heartbeat', async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { status, metrics } = req.body;

    const collectionStatus = metrics ? {
      self_price: 'fresh',
      competitor: metrics.last_collect_time ? 'fresh' : 'no_data',
      bar: 'fresh',
      pms: 'fresh',
    } : {};

    await pool.query(
      `UPDATE agents SET last_heartbeat = NOW(), status = $2, collection_status = $3, updated_at = NOW()
       WHERE agent_id = $1`,
      [agent_id, status || 'alive', JSON.stringify(collectionStatus)]
    );

    res.json({ config_updated: false });
  } catch (err) {
    console.error('Agent heartbeat error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
