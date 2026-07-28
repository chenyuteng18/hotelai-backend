-- M2 Data Pipeline: New Tables
-- Run after initial schema.sql

-- Rooms (actual room inventory & occupancy tracking)
CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  room_number VARCHAR(50) NOT NULL,
  floor INTEGER,
  status VARCHAR(50) DEFAULT 'available',  -- available, occupied, maintenance, ooo
  last_cleaned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hotel_id, room_number)
);

-- Pricing History (historical price snapshots)
CREATE TABLE IF NOT EXISTS pricing_history (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  target_date DATE NOT NULL,
  bar_price DECIMAL(10,2),
  actual_price DECIMAL(10,2),
  occupancy_rate DECIMAL(5,4),
  available_rooms INTEGER,
  sold_rooms INTEGER,
  pickup_rate DECIMAL(5,4),
  snapshot_hour INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hotel_id, room_type_id, target_date, snapshot_hour)
);

-- Competitor Rates (competitor price collection)
CREATE TABLE IF NOT EXISTS competitor_rates (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  competitor_name VARCHAR(255) NOT NULL,
  room_type_name VARCHAR(255) NOT NULL,
  target_date DATE NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  breakfast_included BOOLEAN DEFAULT false,
  source VARCHAR(100),  -- ctrip, meituan, fliggy, manual
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  is_valid BOOLEAN DEFAULT true,
  invalid_reason VARCHAR(255),
  UNIQUE(hotel_id, competitor_name, room_type_name, target_date, collected_at)
);

-- Features (output of the pipeline)
CREATE TABLE IF NOT EXISTS features (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  target_date DATE NOT NULL,
  feature_name VARCHAR(255) NOT NULL,
  feature_value DECIMAL(12,4),
  feature_group VARCHAR(100),  -- price, occupancy, competitor, cross
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  UNIQUE(hotel_id, room_type_id, target_date, feature_name)
);

-- Pipeline Run Log (for monitoring & alerting)
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id SERIAL PRIMARY KEY,
  pipeline_name VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL,  -- running, success, failed
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  rows_processed INTEGER DEFAULT 0,
  rows_failed INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'
);

-- Pipeline Alerts
CREATE TABLE IF NOT EXISTS pipeline_alerts (
  id SERIAL PRIMARY KEY,
  alert_type VARCHAR(100) NOT NULL,  -- collection_failure, feature_missing, latency_exceeded, data_anomaly
  severity VARCHAR(50) DEFAULT 'warning',  -- info, warning, critical
  pipeline_name VARCHAR(100),
  hotel_id INTEGER REFERENCES hotels(id),
  message TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  acknowledged BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rooms_hotel ON rooms(hotel_id);
CREATE INDEX IF NOT EXISTS idx_pricing_history_hotel_date ON pricing_history(hotel_id, target_date);
CREATE INDEX IF NOT EXISTS idx_competitor_rates_hotel_date ON competitor_rates(hotel_id, target_date);
CREATE INDEX IF NOT EXISTS idx_competitor_rates_collected ON competitor_rates(hotel_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_features_hotel_date ON features(hotel_id, target_date);
CREATE INDEX IF NOT EXISTS idx_features_lookup ON features(hotel_id, room_type_id, target_date, feature_name);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_name ON pipeline_runs(pipeline_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_alerts_active ON pipeline_alerts(created_at DESC) WHERE acknowledged = false;
