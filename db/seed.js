const bcrypt = require('bcryptjs');
const { pool } = require('./init');

async function seed() {
  const client = await pool.connect();
  try {
    // Tenant
    const tenantRes = await client.query(
      `INSERT INTO tenants (name, status) VALUES ('自营店', 'active') ON CONFLICT DO NOTHING RETURNING id`
    );
    const tenantId = tenantRes.rows[0]?.id || 1;

    // Hotel
    const hotelRes = await client.query(
      `INSERT INTO hotels (tenant_id, name, address, total_rooms, pms_type, status)
       VALUES ($1, 'XX酒店', '北京市朝阳区', 200, 'zhongruan', 'active')
       ON CONFLICT DO NOTHING RETURNING id`, [tenantId]
    );
    const hotelId = hotelRes.rows[0]?.id || 1;

    // Super admin user
    const superAdminHash = await bcrypt.hash('Admin@123', 10);
    await client.query(
      `INSERT INTO users (username, password_hash, email, role, tenant_id, password_must_change, status)
       VALUES ('superadmin', $1, 'admin@hotelai.com', 'super_admin', $2, false, 'active')
       ON CONFLICT (username) DO NOTHING`, [superAdminHash, tenantId]
    );

    // Hotel admin user
    const hotelAdminHash = await bcrypt.hash('Hotel@123', 10);
    await client.query(
      `INSERT INTO users (username, password_hash, email, role, tenant_id, hotel_id, hotel_name, password_must_change, status)
       VALUES ('hotel_admin', $1, 'hotel@hotelai.com', 'hotel_admin', $2, $3, 'XX酒店', false, 'active')
       ON CONFLICT (username) DO NOTHING`, [hotelAdminHash, tenantId, hotelId]
    );

    // Room types
    const roomTypes = [
      { name: '标准大床房', count: 50, min: 150, max: 320 },
      { name: '标准双床房', count: 40, min: 150, max: 300 },
      { name: '行政大床房', count: 30, min: 220, max: 380 },
      { name: '豪华套房', count: 10, min: 500, max: 1200 },
    ];
    for (const rt of roomTypes) {
      await client.query(
        `INSERT INTO room_types (hotel_id, name, count, min_price, max_price)
         VALUES ($1, $2, $3, $4, $5)`, [hotelId, rt.name, rt.count, rt.min, rt.max]
      );
    }

    // Recommendations (sample data)
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const recs = [
      { room_type_id: 3, room_type_name: '行政大床房', target_date: today, current_price: 287, target_price: 299, adjustment_pct: 4.2, reason_cn: '竞对均价 ¥315；剩余可售 3 间；近 7 日订单进度偏快', status: 'ready', confidence: 'high', ttl: 105, competitor_avg: 315, guardrails: { min_bar: 220, max_bar: 380, within_range: true } },
      { room_type_id: 1, room_type_name: '标准双床房', target_date: tomorrow, current_price: 188, target_price: 188, adjustment_pct: 0, reason_cn: '', status: 'hold', hold_reason: 'competitor_insufficient', confidence: 'low', ttl: 0, competitor_avg: null, guardrails: null },
      { room_type_id: 2, room_type_name: '标准大床房', target_date: today, current_price: 198, target_price: 209, adjustment_pct: 5.6, reason_cn: '竞对均价 ¥225；pickup 偏快', status: 'ready', confidence: 'medium', ttl: 88, competitor_avg: 225, guardrails: { min_bar: 150, max_bar: 320, within_range: true } },
    ];
    for (const r of recs) {
      await client.query(
        `INSERT INTO recommendations (hotel_id, room_type_id, room_type_name, target_date, current_price, target_price, adjustment_pct, reason_cn, status, hold_reason, confidence, ttl_remaining_minutes, competitor_avg, guardrails)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [hotelId, r.room_type_id, r.room_type_name, r.target_date, r.current_price, r.target_price, r.adjustment_pct, r.reason_cn, r.status, r.hold_reason || null, r.confidence, r.ttl, r.competitor_avg, r.guardrails ? JSON.stringify(r.guardrails) : null]
      );
    }

    // Config guardrails
    await client.query(
      `INSERT INTO config_guardrails (hotel_id, min_bar_price, max_bar_price, max_single_adjustment_pct, freshness_threshold_hours, ttl_minutes)
       VALUES ($1, 150, 800, 10, 26, 120) ON CONFLICT (hotel_id) DO NOTHING`, [hotelId]
    );

    // Feature flags
    await client.query(
      `INSERT INTO feature_flags (hotel_id, flags)
       VALUES ($1, $2) ON CONFLICT (hotel_id) DO NOTHING`,
      [hotelId, JSON.stringify({ auto_execute: false, ctrip_agent: true, meituan_agent: false, pms_sync: true, feishu_approval: true, wecom_approval: false, daily_report: true, weekly_report: true })]
    );

    // Agent
    await client.query(
      `INSERT INTO agents (agent_id, hotel_id, status, last_heartbeat, platform, version, collection_status)
       VALUES ('agent_hotel1_001', $1, 'active', NOW(), 'windows', '1.0.0', $2)
       ON CONFLICT (agent_id) DO NOTHING`,
      [hotelId, JSON.stringify({ self_price: 'fresh', competitor: 'fresh', bar: 'fresh', pms: 'stale' })]
    );

    // Audit log entry
    await client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, resource_type, resource_id, details, ip_address)
       VALUES ($1, 1, 'hotel_provisioned', 'hotel', $2, $3, '10.0.0.1')`,
      [tenantId, hotelId, JSON.stringify({ hotel_name: 'XX酒店' })]
    );

    // Forecasts (28 days)
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.now() + (i + 1) * 86400000);
      const dateStr = d.toISOString().slice(0, 10);
      const occ = 0.55 + Math.sin(i / 4) * 0.25;
      const adr = 260 + Math.cos(i / 5) * 60;
      const conf = i < 7 ? 'high' : i < 14 ? 'medium' : 'low';
      await client.query(
        `INSERT INTO forecasts (hotel_id, target_date, predicted_occ, predicted_adr, predicted_revpar, confidence, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [hotelId, dateStr, Math.round(occ * 100) / 100, Math.round(adr * 100) / 100, Math.round(occ * adr * 100) / 100, conf]
      );
    }

    console.log('Seed data inserted successfully.');
  } catch (err) {
    console.error('Seed error:', err);
    throw err;
  } finally {
    client.release();
  }
}

seed().then(() => process.exit(0)).catch(() => process.exit(1));
