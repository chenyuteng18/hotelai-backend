/**
 * M2 Token Service - Pipeline Scheduler
 * Manages scheduled execution of data collection and feature engineering
 * Uses in-process interval scheduling with configurable refresh tokens
 */

const pricingEngine = require('./pricingEngine');
const { pool } = require('../../db');

// ─── Scheduler State ────────────────────────────────────────────
const state = {
  running: false,
  competitorTimer: null,
  occupancyTimer: null,
  lastCompetitorRun: null,
  lastOccupancyRun: null,
  lastFeatureRun: null,
};

// ─── Scheduler Configuration ────────────────────────────────────
const SCHEDULE = {
  competitorIntervalMs: 6 * 60 * 60 * 1000,   // 6 hours
  occupancyIntervalMs: 24 * 60 * 60 * 1000,    // 24 hours
  featureIntervalMs: 6 * 60 * 60 * 1000,       // 6 hours (after competitor refresh)
  startupDelayMs: 30 * 1000,                    // 30s after startup
  retryDelayMs: 5 * 60 * 1000,                 // 5 min retry on failure
};

// ─── Scheduler Control ──────────────────────────────────────────

/**
 * Start the pipeline scheduler
 */
function start() {
  if (state.running) {
    console.log('[TokenService] Scheduler already running');
    return;
  }

  state.running = true;
  console.log('[TokenService] Starting M2 pipeline scheduler');

  // Initial run after startup delay
  setTimeout(() => {
    runCompetitorRefresh().catch(err =>
      console.error('[TokenService] Initial competitor refresh failed:', err.message)
    );
  }, SCHEDULE.startupDelayMs);

  setTimeout(() => {
    runFullPipeline().catch(err =>
      console.error('[TokenService] Initial full pipeline failed:', err.message)
    );
  }, SCHEDULE.startupDelayMs + 10000);

  // Recurring schedules
  state.competitorTimer = setInterval(() => {
    runCompetitorRefresh().catch(err =>
      console.error('[TokenService] Scheduled competitor refresh failed:', err.message)
    );
  }, SCHEDULE.competitorIntervalMs);

  state.occupancyTimer = setInterval(() => {
    runFullPipeline().catch(err =>
      console.error('[TokenService] Scheduled full pipeline failed:', err.message)
    );
  }, SCHEDULE.occupancyIntervalMs);

  console.log(`[TokenService] Scheduler started - competitor every ${SCHEDULE.competitorIntervalMs / 3600000}h, full pipeline every ${SCHEDULE.occupancyIntervalMs / 3600000}h`);
}

/**
 * Stop the pipeline scheduler
 */
function stop() {
  if (!state.running) return;

  state.running = false;
  if (state.competitorTimer) clearInterval(state.competitorTimer);
  if (state.occupancyTimer) clearInterval(state.occupancyTimer);
  state.competitorTimer = null;
  state.occupancyTimer = null;

  console.log('[TokenService] Scheduler stopped');
}

// ─── Pipeline Execution ─────────────────────────────────────────

async function runCompetitorRefresh() {
  console.log('[TokenService] Running competitor data refresh...');
  const startTime = Date.now();

  try {
    const results = await pricingEngine.scheduledCompetitorCollection();
    state.lastCompetitorRun = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      results,
      status: 'success',
    };

    const totalCollected = results.reduce((sum, r) => sum + (r.collected || 0), 0);
    const errors = results.filter(r => r.status === 'error');

    console.log(`[TokenService] Competitor refresh complete: ${totalCollected} records, ${errors.length} hotel errors, ${Date.now() - startTime}ms`);

    if (errors.length > 0) {
      await pricingEngine.createAlert('collection_failure', 'warning', 'competitor_refresh', null,
        `竞品刷新完成，${errors.length} 个酒店采集失败`, { errors: errors.map(e => ({ hotel_id: e.hotel_id, error: e.error })) });
    }
  } catch (err) {
    state.lastCompetitorRun = {
      at: new Date().toISOString(),
      status: 'failed',
      error: err.message,
    };
    await pricingEngine.createAlert('collection_failure', 'critical', 'competitor_refresh', null,
      `竞品刷新全局失败: ${err.message}`);
    throw err;
  }
}

async function runFullPipeline() {
  console.log('[TokenService] Running full pipeline (collect + clean + features)...');
  const startTime = Date.now();

  try {
    const results = await pricingEngine.scheduledFullPipeline();
    state.lastFeatureRun = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      results,
      status: 'success',
    };

    const totalWritten = results.reduce((sum, r) => sum + (r.written || 0), 0);
    const totalFailed = results.reduce((sum, r) => sum + (r.failed || 0), 0);
    const errors = results.filter(r => r.status === 'error');

    console.log(`[TokenService] Full pipeline complete: ${totalWritten} features written, ${totalFailed} failed, ${errors.length} hotel errors, ${Date.now() - startTime}ms`);

    if (errors.length > 0) {
      await pricingEngine.createAlert('collection_failure', 'warning', 'full_pipeline', null,
        `全量管道完成，${errors.length} 个酒店处理失败`, { errors: errors.map(e => ({ hotel_id: e.hotel_id, error: e.error })) });
    }
  } catch (err) {
    state.lastFeatureRun = {
      at: new Date().toISOString(),
      status: 'failed',
      error: err.message,
    };
    await pricingEngine.createAlert('collection_failure', 'critical', 'full_pipeline', null,
      `全量管道全局失败: ${err.message}`);
    throw err;
  }
}

// ─── Manual Triggers ────────────────────────────────────────────

/**
 * Manually trigger competitor refresh (for API endpoint)
 */
async function triggerCompetitorRefresh() {
  return runCompetitorRefresh();
}

/**
 * Manually trigger full pipeline (for API endpoint)
 */
async function triggerFullPipeline() {
  return runFullPipeline();
}

/**
 * Get scheduler status
 */
function getStatus() {
  return {
    running: state.running,
    lastCompetitorRun: state.lastCompetitorRun,
    lastOccupancyRun: state.lastOccupancyRun,
    lastFeatureRun: state.lastFeatureRun,
    schedule: {
      competitor_interval_hours: SCHEDULE.competitorIntervalMs / 3600000,
      occupancy_interval_hours: SCHEDULE.occupancyIntervalMs / 3600000,
      feature_interval_hours: SCHEDULE.featureIntervalMs / 3600000,
    },
  };
}

// ─── Health Check ───────────────────────────────────────────────

/**
 * Check if features are fresh enough
 */
async function checkFeatureFreshness(hotelId) {
  const result = await pool.query(`
    SELECT
      feature_group,
      MAX(computed_at) as last_computed,
      MIN(computed_at) as earliest_computed,
      COUNT(*) as feature_count,
      COUNT(CASE WHEN valid_until < NOW() THEN 1 END) as expired_count
    FROM features
    WHERE hotel_id = $1 AND target_date >= CURRENT_DATE
    GROUP BY feature_group
    ORDER BY feature_group
  `, [hotelId]);

  const freshness = result.rows.map(row => ({
    group: row.feature_group,
    last_computed: row.last_computed,
    age_minutes: Math.round((Date.now() - new Date(row.last_computed).getTime()) / 60000),
    feature_count: parseInt(row.feature_count),
    expired_count: parseInt(row.expired_count),
    is_fresh: new Date(row.last_computed) > new Date(Date.now() - pricingEngine.CONFIG.maxFeatureLatencyMs),
  }));

  return freshness;
}

module.exports = {
  start,
  stop,
  getStatus,
  triggerCompetitorRefresh,
  triggerFullPipeline,
  checkFeatureFreshness,
  SCHEDULE,
};
