const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// POST /snapshots/batch
router.post('/batch', async (req, res) => {
  try {
    const { agent_id, batch_id, snapshots } = req.body;

    if (!agent_id || !snapshots || !Array.isArray(snapshots)) {
      return res.status(400).json({ error: 'invalid_request', message: 'agent_id 和 snapshots 为必填' });
    }

    let accepted = 0;
    let rejected = 0;
    const errors = [];

    for (const snap of snapshots) {
      try {
        if (!snap.hotel_id || !snap.channel || !snap.target_date || !snap.price) {
          rejected++;
          errors.push({ room_type_name: snap.room_type_name || 'unknown', error: 'missing_required_fields' });
          continue;
        }

        await pool.query(
          `INSERT INTO forecasts (hotel_id, room_type_id, target_date, predicted_adr, confidence)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [snap.hotel_id, null, snap.target_date, snap.price, 'high']
        );

        // Update agent collection status
        await pool.query(
          `UPDATE agents SET collection_status = jsonb_set(
            COALESCE(collection_status, '{}'),
            '{${snap.source_type || 'self_price'}}',
            '"${snap.data_status || 'fresh'}"'
          ) WHERE agent_id = $1`,
          [agent_id]
        );

        accepted++;
      } catch (snapErr) {
        rejected++;
        errors.push({ room_type_name: snap.room_type_name || 'unknown', error: snapErr.message });
      }
    }

    res.json({ accepted, rejected, errors });
  } catch (err) {
    console.error('Snapshot batch error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
