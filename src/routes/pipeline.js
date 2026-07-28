const express = require('express');
const { pool } = require('../../db');
const pricingEngine = require('../services/pricingEngine');
const tokenService = require('../services/tokenService');

const router = express.Router();

// GET /pipeline/status - Get scheduler and pipeline status
router.get('/status', async (req, res) => {
  try {
    const hotelId = req.user?.hotel_id || null;
    const schedulerStatus = tokenService.getStatus();
    const freshness = hotelId ? await tokenService.checkFeatureFreshness(hotelId) : null;

    res.json({
      scheduler: schedulerStatus,
      features_freshness: freshness,
    });
  } catch (err) {
    console.error('Pipeline status error:', err);
    res.status(500).json({ error: 'internal_error', message: '获取管道状态失败' });
  }
});

// POST /pipeline/run/competitor - Manually trigger competitor refresh
router.post('/run/competitor', async (req, res) => {
  try {
    res.json({ status: 'started', message: '竞品数据刷新已触发' });
    // Run async, don't block response
    tokenService.triggerCompetitorRefresh().catch(err =>
      console.error('[Pipeline API] Competitor refresh error:', err.message)
    );
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: '触发刷新失败' });
  }
});

// POST /pipeline/run/full - Manually trigger full pipeline
router.post('/run/full', async (req, res) => {
  try {
    res.json({ status: 'started', message: '全量管道已触发' });
    tokenService.triggerFullPipeline().catch(err =>
      console.error('[Pipeline API] Full pipeline error:', err.message)
    );
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: '触发管道失败' });
  }
});

// GET /pipeline/alerts - Get unacknowledged alerts
router.get('/alerts', async (req, res) => {
  try {
    const hotelId = req.user?.hotel_id || null;
    const alerts = await pricingEngine.getUnacknowledgedAlerts(hotelId);
    res.json({ alerts });
  } catch (err) {
    console.error('Pipeline alerts error:', err);
    res.status(500).json({ error: 'internal_error', message: '获取告警失败' });
  }
});

// POST /pipeline/alerts/:id/acknowledge - Acknowledge an alert
router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    await pool.query(
      'UPDATE pipeline_alerts SET acknowledged = true WHERE id = $1',
      [req.params.id]
    );
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: '确认告警失败' });
  }
});

// GET /pipeline/runs - Get recent pipeline runs
router.get('/runs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await pool.query(
      `SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ runs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: '获取运行记录失败' });
  }
});

// GET /pipeline/features - Get computed features for a hotel/date
router.get('/features', async (req, res) => {
  try {
    const hotelId = req.user?.hotel_id;
    const { room_type_id, target_date } = req.query;

    let query = 'SELECT * FROM features WHERE hotel_id = $1';
    const params = [hotelId];
    let paramIdx = 2;

    if (room_type_id) {
      query += ` AND room_type_id = $${paramIdx++}`;
      params.push(parseInt(room_type_id));
    }
    if (target_date) {
      query += ` AND target_date = $${paramIdx++}`;
      params.push(target_date);
    } else {
      query += ` AND target_date >= CURRENT_DATE`;
    }

    query += ' ORDER BY target_date, room_type_id, feature_group, feature_name';

    const result = await pool.query(query, params);

    // Group by room_type and date
    const grouped = {};
    for (const row of result.rows) {
      const key = `${row.room_type_id}_${row.target_date}`;
      if (!grouped[key]) {
        grouped[key] = {
          room_type_id: row.room_type_id,
          target_date: row.target_date,
          features: {},
        };
      }
      grouped[key].features[row.feature_name] = {
        value: row.feature_value !== null ? parseFloat(row.feature_value) : null,
        group: row.feature_group,
        computed_at: row.computed_at,
      };
    }

    res.json({ features: Object.values(grouped) });
  } catch (err) {
    console.error('Pipeline features error:', err);
    res.status(500).json({ error: 'internal_error', message: '获取特征数据失败' });
  }
});

module.exports = router;
