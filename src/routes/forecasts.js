const express = require('express');
const { pool } = require('../../db');

const router = express.Router();

// GET /forecasts
router.get('/', async (req, res) => {
  try {
    const hotelId = req.user.hotel_id;
    const roomTypeId = req.query.room_type_id || null;

    let query = `SELECT f.*, rt.name as room_type_name FROM forecasts f
                 LEFT JOIN room_types rt ON rt.id = f.room_type_id
                 WHERE f.hotel_id = $1`;
    const params = [hotelId];

    if (roomTypeId) {
      query += ' AND f.room_type_id = $2';
      params.push(roomTypeId);
    }

    query += ' ORDER BY f.target_date ASC';

    const result = await pool.query(query, params);

    const generatedAt = result.rows.length > 0 ? result.rows[0].generated_at : new Date().toISOString();
    const roomTypeName = result.rows.length > 0 && result.rows[0].room_type_name
      ? result.rows[0].room_type_name : '全部房型';

    res.json({
      hotel_id: hotelId,
      room_type_id: roomTypeId ? parseInt(roomTypeId) : null,
      room_type_name: roomTypeName,
      forecasts: result.rows.map(r => ({
        target_date: r.target_date,
        predicted_occ: r.predicted_occ != null ? parseFloat(r.predicted_occ) : null,
        predicted_adr: r.predicted_adr != null ? parseFloat(r.predicted_adr) : null,
        predicted_revpar: r.predicted_revpar != null ? parseFloat(r.predicted_revpar) : null,
        confidence: r.confidence,
      })),
      generated_at: generatedAt,
      mape_baseline: 0.12,
    });
  } catch (err) {
    console.error('Forecasts error:', err);
    res.status(500).json({ error: 'internal_error', message: '系统异常，请稍后重试' });
  }
});

module.exports = router;
