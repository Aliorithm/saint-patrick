-- ================================================
-- TELEGRAM BOT FARM - SUPABASE SCHEMA
-- ================================================

CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  instance_id INTEGER NOT NULL CHECK (instance_id BETWEEN 1 AND 12),
  user_id BIGINT NOT NULL,
  phone VARCHAR(20),
  session_string TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  next_clicker_time TIMESTAMPTZ,
  next_daily_time TIMESTAMPTZ,
  last_error TEXT,
  error_count INTEGER DEFAULT 0,
  total_clicks INTEGER DEFAULT 0,
  total_dailies INTEGER DEFAULT 0,
  last_click_at TIMESTAMPTZ,
  last_daily_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_accounts_instance_id ON accounts(instance_id);
CREATE INDEX idx_accounts_instance_active ON accounts(instance_id, is_active) WHERE is_active = true;
CREATE INDEX idx_accounts_next_clicker ON accounts(next_clicker_time) WHERE is_active = true;
CREATE INDEX idx_accounts_next_daily ON accounts(next_daily_time) WHERE is_active = true;

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();