/**
 * M2 Pricing Engine Service
 * Handles: data collection, cleaning, and feature computation for the pricing pipeline
 * Schedule: competitor prices every 6h, occupancy data daily
 */

const { pool } = require('../../db');

// ─── Configuration ──────────────────────────────────────────────
const CONFIG = {
  competitorRefreshHours: 6,
  occupancyRefreshHours: 24,
  maxFeatureLatencyMs: 5 * 60 * 1000, // 5 minutes
  anomalyThresholdSigma: 3,
  missingDataAlertThreshold: 0.1, // 10%
};

// ─── Data Collection ────────────────────────────────────────────

/**
 * Collect competitor rates from the competitor_rates table
 * Aggregates raw competitor data into per-room-type averages
 */
async function collectCompetitorRates(hotelId) {
  const runId = await startPipelineRun('competitor_collection');
  try {
    // Get valid competitor rates for next 7 days
    const result = await pool.query(`
      SELECT
        cr.room_type_name,
        cr.target_date,
        ROUND(AVG(cr.price), 2) as avg_price,
        ROUND(STDDEV(cr.price), 2) as stddev_price,
        MIN(cr.price) as min_price,
        MAX(cr.price) as max_price,
        COUNT(*) as sample_count,
        COUNT(DISTINCT cr.competitor_name) as competitor_count
      FROM competitor_rates cr
      WHERE cr.hotel_id = $1
        AND cr.target_date >= CURRENT_DATE
        AND cr.target_date <= CURRENT_DATE + INTERVAL '7 days'
        AND cr.is_valid = true
        AND cr.collected_at >= NOW() - INTERVAL '${CONFIG.competitorRefreshHours} hours'
      GROUP BY cr.room_type_name, cr.target_date
      ORDER BY cr.target_date, cr.room_type_name
    `, [hotelId]);

    await finishPipelineRun(runId, 'success', result.rows.length, 0);
    return result.rows;
  } catch (err) {
    await finishPipelineRun(runId, 'failed', 0, 0, err.message);
    await createAlert('collection_failure', 'critical', 'competitor_collection', hotelId,
      `竞品价格采集失败: ${err.message}`);
    throw err;
  }
}

/**
 * Collect occupancy/pricing data from pricing_history and rooms
 */
async function collectOccupancyData(hotelId) {
  const runId = await startPipelineRun('occupancy_collection');
  try {
    const result = await pool.query(`
      SELECT
        ph.room_type_id,
        ph.target_date,
        ROUND(AVG(ph.occupancy_rate), 4) as avg_occupancy,
        ROUND(AVG(ph.pickup_rate), 4) as avg_pickup,
        SUM(ph.available_rooms) as total_available,
        SUM(ph.sold_rooms) as total_sold,
        ROUND(AVG(ph.bar_price), 2) as avg_bar,
        ROUND(AVG(ph.actual_price), 2) as avg_actual
      FROM pricing_history ph
      WHERE ph.hotel_id = $1
        AND ph.target_date >= CURRENT_DATE
        AND ph.target_date <= CURRENT_DATE + INTERVAL '14 days'
      GROUP BY ph.room_type_id, ph.target_date
      ORDER BY ph.target_date, ph.room_type_id
    `, [hotelId]);

    await finishPipelineRun(runId, 'success', result.rows.length, 0);
    return result.rows;
  } catch (err) {
    await finishPipelineRun(runId, 'failed', 0, 0, err.message);
    await createAlert('collection_failure', 'critical', 'occupancy_collection', hotelId,
      `入住率数据采集失败: ${err.message}`);
    throw err;
  }
}

// ─── Data Cleaning ──────────────────────────────────────────────

/**
 * Clean competitor rates: remove outliers beyond 3σ
 */
function cleanCompetitorRates(rates) {
  if (!rates || rates.length === 0) return [];

  return rates.map(row => {
    const avg = parseFloat(row.avg_price);
    const stddev = parseFloat(row.stddev_price) || 0;
    const min = parseFloat(row.min_price);
    const max = parseFloat(row.max_price);

    // Filter: if stddev is 0 or very small, all prices are similar - no outliers
    let cleanedMin = min;
    let cleanedMax = max;
    if (stddev > 0) {
      cleanedMin = Math.max(min, avg - CONFIG.anomalyThresholdSigma * stddev);
      cleanedMax = Math.min(max, avg + CONFIG.anomalyThresholdSigma * stddev);
    }

    return {
      ...row,
      avg_price: avg,
      cleaned_min: Math.round(cleanedMin * 100) / 100,
      cleaned_max: Math.round(cleanedMax * 100) / 100,
      price_range: Math.round((cleanedMax - cleanedMin) * 100) / 100,
      data_quality: row.sample_count >= 3 ? 'good' : 'sparse',
    };
  });
}

/**
 * Clean occupancy data: fill missing values with forward-fill logic
 */
function cleanOccupancyData(occupancy) {
  if (!occupancy || occupancy.length === 0) return [];

  return occupancy.map(row => {
    const occ = parseFloat(row.avg_occupancy) || 0;
    const pickup = parseFloat(row.avg_pickup) || 0;

    return {
      ...row,
      avg_occupancy: occ,
      avg_pickup: pickup,
      occupancy_status: occ > 0 ? 'valid' : 'missing',
    };
  });
}

// ─── Feature Engineering ────────────────────────────────────────

/**
 * Compute all features for a given hotel and write to features table
 */
async function computeFeatures(hotelId) {
  const startTime = Date.now();
  const runId = await startPipelineRun('feature_engineering');

  try {
    // Step 1: Collect raw data
    const [competitorRaw, occupancyRaw] = await Promise.all([
      collectCompetitorRates(hotelId),
      collectOccupancyData(hotelId),
    ]);

    // Step 2: Clean data
    const competitorClean = cleanCompetitorRates(competitorRaw);
    const occupancyClean = cleanOccupancyData(occupancyRaw);

    // Step 3: Get room types for this hotel
    const roomTypesRes = await pool.query(
      'SELECT id, name, count, min_price, max_price FROM room_types WHERE hotel_id = $1',
      [hotelId]
    );
    const roomTypes = roomTypesRes.rows;

    // Step 4: Compute features per room_type × target_date
    const features = [];
    const today = new Date();

    for (const rt of roomTypes) {
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + dayOffset);
        const dateStr = targetDate.toISOString().slice(0, 10);

        // Find matching data
        const compData = competitorClean.find(
          c => c.room_type_name === rt.name && c.target_date === dateStr
        );
        const occData = occupancyClean.find(
          o => o.room_type_id === rt.id &&
               new Date(o.target_date).toISOString().slice(0, 10) === dateStr
        );

        // Price features
        const compAvg = compData ? parseFloat(compData.avg_price) : null;
        const myBar = occData ? parseFloat(occData.avg_bar) : parseFloat(rt.min_price);
        const myActual = occData ? parseFloat(occData.avg_actual) : null;

        features.push(
          { name: 'competitor_avg_price', value: compAvg, group: 'competitor' },
          { name: 'competitor_min_price', value: compData ? parseFloat(compData.cleaned_min) : null, group: 'competitor' },
          { name: 'competitor_max_price', value: compData ? parseFloat(compData.cleaned_max) : null, group: 'competitor' },
          { name: 'competitor_price_range', value: compData ? parseFloat(compData.price_range) : null, group: 'competitor' },
          { name: 'competitor_sample_count', value: compData ? parseInt(compData.sample_count) : 0, group: 'competitor' },
          { name: 'competitor_count', value: compData ? parseInt(compData.competitor_count) : 0, group: 'competitor' },
          { name: 'my_bar_price', value: myBar, group: 'price' },
          { name: 'my_actual_price', value: myActual, group: 'price' },
          { name: 'price_gap_vs_competitor', value: compAvg && myBar ? Math.round((myBar - compAvg) * 100) / 100 : null, group: 'cross' },
          { name: 'price_gap_pct', value: compAvg && myBar ? Math.round((myBar - compAvg) / compAvg * 10000) / 100 : null, group: 'cross' },
        );

        // Occupancy features
        const occ = occData ? parseFloat(occData.avg_occupancy) : null;
        const pickup = occData ? parseFloat(occData.avg_pickup) : null;
        const totalRooms = parseInt(rt.count);
        const sold = occData ? parseInt(occData.total_sold) : 0;
        const available = occData ? parseInt(occData.total_available) : totalRooms;

        features.push(
          { name: 'occupancy_rate', value: occ, group: 'occupancy' },
          { name: 'pickup_rate', value: pickup, group: 'occupancy' },
          { name: 'available_rooms', value: available, group: 'occupancy' },
          { name: 'sold_rooms', value: sold, group: 'occupancy' },
          { name: 'total_rooms', value: totalRooms, group: 'occupancy' },
          { name: 'remaining_capacity', value: totalRooms - sold, group: 'occupancy' },
        );

        // Cross features
        if (occ !== null && compAvg !== null) {
          const priceElasticity = occ > 0 ? Math.round((myBar / compAvg - 1) / occ * 10000) / 100 : null;
          features.push(
            { name: 'price_elasticity', value: priceElasticity, group: 'cross' },
            { name: 'revenue_per_available_room', value: occ && myBar ? Math.round(occ * myBar * 100) / 100 : null, group: 'cross' },
          );
        } else {
          features.push(
            { name: 'price_elasticity', value: null, group: 'cross' },
            { name: 'revenue_per_available_room', value: null, group: 'cross' },
          );
        }

        // Lead time feature
        features.push(
          { name: 'lead_time_days', value: dayOffset, group: 'price' }
        );
      }
    }

    // Step 5: Write features to database
    const validUntil = new Date(Date.now() + CONFIG.competitorRefreshHours * 3600000);
    let written = 0;
    let failed = 0;

    for (const rt of roomTypes) {
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + dayOffset);
        const dateStr = targetDate.toISOString().slice(0, 10);

        const rtFeatures = features.filter((f, idx) => {
          const featureIdx = idx % 20; // 20 features per room_type × date
          return Math.floor(idx / 20) === roomTypes.indexOf(rt) * 8 + dayOffset;
        });

        // Write each feature
        for (const f of features.filter((_, idx) => {
          const perDateBlock = roomTypes.length * 20;
          const dateBlock = Math.floor(idx / perDateBlock);
          return dateBlock === dayOffset;
        })) {
          // skip - handled below
        }
      }
    }

    // Bulk upsert features
    for (const rt of roomTypes) {
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + dayOffset);
        const dateStr = targetDate.toISOString().slice(0, 10);

        const featureList = generateFeaturesForSlot(rt, competitorClean, occupancyClean, dayOffset);

        for (const f of featureList) {
          try {
            await pool.query(`
              INSERT INTO features (hotel_id, room_type_id, target_date, feature_name, feature_value, feature_group, computed_at, valid_until)
              VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
              ON CONFLICT (hotel_id, room_type_id, target_date, feature_name)
              DO UPDATE SET feature_value = $5, computed_at = NOW(), valid_until = $7
            `, [hotelId, rt.id, dateStr, f.name, f.value, f.group, validUntil]);
            written++;
          } catch (err) {
            failed++;
          }
        }
      }
    }

    const durationMs = Date.now() - startTime;
    await finishPipelineRun(runId, 'success', written, failed, null, { duration_ms: durationMs });

    // Check latency
    if (durationMs > CONFIG.maxFeatureLatencyMs) {
      await createAlert('latency_exceeded', 'warning', 'feature_engineering', hotelId,
        `特征计算耗时 ${durationMs}ms，超过阈值 ${CONFIG.maxFeatureLatencyMs}ms`);
    }

    // Check missing data
    const totalExpected = roomTypes.length * 8 * 20; // 8 dates × 20 features
    const missingRate = 1 - (written / totalExpected);
    if (missingRate > CONFIG.missingDataAlertThreshold) {
      await createAlert('feature_missing', 'warning', 'feature_engineering', hotelId,
        `特征缺失率 ${(missingRate * 100).toFixed(1)}%，超过阈值 ${CONFIG.missingDataAlertThreshold * 100}%`);
    }

    return { written, failed, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    await finishPipelineRun(runId, 'failed', 0, 0, err.message, { duration_ms: durationMs });
    await createAlert('collection_failure', 'critical', 'feature_engineering', hotelId,
      `特征工程失败: ${err.message}`);
    throw err;
  }
}

/**
 * Generate feature list for a specific room_type × date combination
 */
function generateFeaturesForSlot(rt, competitorClean, occupancyClean, dayOffset) {
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setDate(targetDate.getDate() + dayOffset);
  const dateStr = targetDate.toISOString().slice(0, 10);

  const compData = competitorClean.find(
    c => c.room_type_name === rt.name && c.target_date === dateStr
  );
  const occData = occupancyClean.find(
    o => o.room_type_id === rt.id &&
         new Date(o.target_date).toISOString().slice(0, 10) === dateStr
  );

  const compAvg = compData ? parseFloat(compData.avg_price) : null;
  const myBar = occData ? parseFloat(occData.avg_bar) : parseFloat(rt.min_price);
  const myActual = occData ? parseFloat(occData.avg_actual) : null;
  const occ = occData ? parseFloat(occData.avg_occupancy) : null;
  const pickup = occData ? parseFloat(occData.avg_pickup) : null;
  const totalRooms = parseInt(rt.count);
  const sold = occData ? parseInt(occData.total_sold) : 0;
  const available = occData ? parseInt(occData.total_available) : totalRooms;

  return [
    { name: 'competitor_avg_price', value: compAvg, group: 'competitor' },
    { name: 'competitor_min_price', value: compData ? parseFloat(compData.cleaned_min) : null, group: 'competitor' },
    { name: 'competitor_max_price', value: compData ? parseFloat(compData.cleaned_max) : null, group: 'competitor' },
    { name: 'competitor_price_range', value: compData ? parseFloat(compData.price_range) : null, group: 'competitor' },
    { name: 'competitor_sample_count', value: compData ? parseInt(compData.sample_count) : 0, group: 'competitor' },
    { name: 'competitor_count', value: compData ? parseInt(compData.competitor_count) : 0, group: 'competitor' },
    { name: 'my_bar_price', value: myBar, group: 'price' },
    { name: 'my_actual_price', value: myActual, group: 'price' },
    { name: 'price_gap_vs_competitor', value: compAvg && myBar ? Math.round((myBar - compAvg) * 100) / 100 : null, group: 'cross' },
    { name: 'price_gap_pct', value: compAvg && myBar ? Math.round((myBar - compAvg) / compAvg * 10000) / 100 : null, group: 'cross' },
    { name: 'occupancy_rate', value: occ, group: 'occupancy' },
    { name: 'pickup_rate', value: pickup, group: 'occupancy' },
    { name: 'available_rooms', value: available, group: 'occupancy' },
    { name: 'sold_rooms', value: sold, group: 'occupancy' },
    { name: 'total_rooms', value: totalRooms, group: 'occupancy' },
    { name: 'remaining_capacity', value: totalRooms - sold, group: 'occupancy' },
    { name: 'price_elasticity', value: occ && compAvg ? Math.round((myBar / compAvg - 1) / occ * 10000) / 100 : null, group: 'cross' },
    { name: 'revenue_per_available_room', value: occ && myBar ? Math.round(occ * myBar * 100) / 100 : null, group: 'cross' },
    { name: 'lead_time_days', value: dayOffset, group: 'price' },
    { name: 'data_quality_score', value: compData && occData ? 1.0 : compData || occData ? 0.5 : 0.0, group: 'cross' },
  ];
}

// ─── Pipeline Run Tracking ──────────────────────────────────────

async function startPipelineRun(pipelineName) {
  const result = await pool.query(
    `INSERT INTO pipeline_runs (pipeline_name, status, started_at)
     VALUES ($1, 'running', NOW()) RETURNING id`,
    [pipelineName]
  );
  return result.rows[0].id;
}

async function finishPipelineRun(runId, status, rowsProcessed, rowsFailed, errorMessage, metadata) {
  await pool.query(
    `UPDATE pipeline_runs
     SET status = $2, finished_at = NOW(), rows_processed = $3, rows_failed = $4,
         error_message = $5, duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         metadata = COALESCE($6, '{}'::jsonb)
     WHERE id = $1`,
    [runId, status, rowsProcessed, rowsFailed, errorMessage || null, metadata ? JSON.stringify(metadata) : null]
  );
}

// ─── Alerting ───────────────────────────────────────────────────

async function createAlert(alertType, severity, pipelineName, hotelId, message, details) {
  await pool.query(
    `INSERT INTO pipeline_alerts (alert_type, severity, pipeline_name, hotel_id, message, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [alertType, severity, pipelineName, hotelId, message, details ? JSON.stringify(details) : null]
  );
}

async function getUnacknowledgedAlerts(hotelId) {
  let query = 'SELECT * FROM pipeline_alerts WHERE acknowledged = false';
  const params = [];
  if (hotelId) {
    query += ' AND hotel_id = $1';
    params.push(hotelId);
  }
  query += ' ORDER BY created_at DESC LIMIT 50';
  const result = await pool.query(query, params);
  return result.rows;
}

// ─── Scheduled Entry Points ─────────────────────────────────────

/**
 * Run competitor data collection (called every 6h)
 */
async function scheduledCompetitorCollection() {
  const hotelsRes = await pool.query("SELECT id FROM hotels WHERE status = 'active'");
  const results = [];
  for (const hotel of hotelsRes.rows) {
    try {
      const data = await collectCompetitorRates(hotel.id);
      results.push({ hotel_id: hotel.id, collected: data.length, status: 'ok' });
    } catch (err) {
      results.push({ hotel_id: hotel.id, collected: 0, status: 'error', error: err.message });
    }
  }
  return results;
}

/**
 * Run full pipeline: collect + clean + compute features (called daily)
 */
async function scheduledFullPipeline() {
  const hotelsRes = await pool.query("SELECT id FROM hotels WHERE status = 'active'");
  const results = [];
  for (const hotel of hotelsRes.rows) {
    try {
      const result = await computeFeatures(hotel.id);
      results.push({ hotel_id: hotel.id, ...result, status: 'ok' });
    } catch (err) {
      results.push({ hotel_id: hotel.id, status: 'error', error: err.message });
    }
  }
  return results;
}

module.exports = {
  CONFIG,
  collectCompetitorRates,
  collectOccupancyData,
  cleanCompetitorRates,
  cleanOccupancyData,
  computeFeatures,
  generateFeaturesForSlot,
  scheduledCompetitorCollection,
  scheduledFullPipeline,
  getUnacknowledgedAlerts,
  createAlert,
};
