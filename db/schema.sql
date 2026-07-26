-- HotelAI Database Schema

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Hotels
CREATE TABLE IF NOT EXISTS hotels (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  address TEXT,
  total_rooms INTEGER DEFAULT 0,
  pms_type VARCHAR(100),
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  role VARCHAR(50) NOT NULL DEFAULT 'hotel_admin',
  tenant_id INTEGER REFERENCES tenants(id),
  hotel_id INTEGER REFERENCES hotels(id),
  hotel_name VARCHAR(255),
  password_must_change BOOLEAN DEFAULT false,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Room Types
CREATE TABLE IF NOT EXISTS room_types (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  name VARCHAR(255) NOT NULL,
  count INTEGER DEFAULT 1,
  min_price DECIMAL(10,2) DEFAULT 0,
  max_price DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Recommendations
CREATE TABLE IF NOT EXISTS recommendations (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  room_type_id INTEGER REFERENCES room_types(id),
  room_type_name VARCHAR(255) NOT NULL,
  target_date DATE NOT NULL,
  current_price DECIMAL(10,2),
  target_price DECIMAL(10,2),
  adjustment_pct DECIMAL(5,2),
  reason_cn TEXT,
  status VARCHAR(50) DEFAULT 'ready',
  hold_reason VARCHAR(100),
  confidence VARCHAR(50),
  ttl_remaining_minutes INTEGER DEFAULT 0,
  competitor_avg DECIMAL(10,2),
  guardrails JSONB,
  approved_by INTEGER REFERENCES users(id),
  approved_by_name VARCHAR(255),
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Forecasts
CREATE TABLE IF NOT EXISTS forecasts (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  room_type_id INTEGER REFERENCES room_types(id),
  target_date DATE NOT NULL,
  predicted_occ DECIMAL(5,4),
  predicted_adr DECIMAL(10,2),
  predicted_revpar DECIMAL(10,2),
  confidence VARCHAR(50),
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Config Guardrails
CREATE TABLE IF NOT EXISTS config_guardrails (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) UNIQUE,
  min_bar_price DECIMAL(10,2) DEFAULT 0,
  max_bar_price DECIMAL(10,2) DEFAULT 0,
  max_single_adjustment_pct DECIMAL(5,2) DEFAULT 10,
  freshness_threshold_hours INTEGER DEFAULT 26,
  ttl_minutes INTEGER DEFAULT 120,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Feature Flags
CREATE TABLE IF NOT EXISTS feature_flags (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id) UNIQUE,
  flags JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id),
  actor_user_id INTEGER REFERENCES users(id),
  action VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100),
  resource_id INTEGER,
  details JSONB,
  ip_address VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(255) UNIQUE NOT NULL,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  status VARCHAR(50) DEFAULT 'active',
  last_heartbeat TIMESTAMPTZ,
  platform VARCHAR(100),
  version VARCHAR(100),
  collection_status JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Onboarding Drafts
CREATE TABLE IF NOT EXISTS onboarding_drafts (
  id SERIAL PRIMARY KEY,
  hotel_id INTEGER REFERENCES hotels(id),
  step INTEGER DEFAULT 0,
  data JSONB DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_recommendations_hotel_status ON recommendations(hotel_id, status);
CREATE INDEX IF NOT EXISTS idx_recommendations_target_date ON recommendations(target_date);
CREATE INDEX IF NOT EXISTS idx_forecasts_hotel_date ON forecasts(hotel_id, target_date);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_hotel ON agents(hotel_id);
