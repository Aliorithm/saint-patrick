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
  cap INTEGER DEFAULT 0,
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
-- ================================================
-- ATOMIC ACCOUNT CLAIMING (PREVENTS RACE CONDITIONS)
-- ================================================
-- This function atomically claims due accounts by updating their times
-- BEFORE returning them, preventing multiple workers from processing the same account

CREATE OR REPLACE FUNCTION claim_due_accounts(
  p_instance_id INTEGER,
  p_now TIMESTAMPTZ,
  p_clicker_delay_min INTEGER,
  p_clicker_delay_max INTEGER,
  p_daily_delay INTEGER
)
RETURNS TABLE (
  id BIGINT,
  instance_id INTEGER,
  user_id BIGINT,
  phone VARCHAR,
  session_string TEXT,
  is_active BOOLEAN,
  next_clicker_time TIMESTAMPTZ,
  next_daily_time TIMESTAMPTZ,
  last_error TEXT,
  error_count INTEGER,
  total_clicks INTEGER,
  total_dailies INTEGER,
  last_click_at TIMESTAMPTZ,
  last_daily_at TIMESTAMPTZ,
  cap INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE accounts
  SET 
    next_clicker_time = CASE 
      WHEN accounts.next_clicker_time <= p_now 
      THEN p_now + ((p_clicker_delay_min + random() * p_clicker_delay_max) || ' minutes')::INTERVAL
      ELSE accounts.next_clicker_time
    END,
    next_daily_time = CASE
      WHEN accounts.next_daily_time <= p_now 
      THEN p_now + (p_daily_delay || ' minutes')::INTERVAL
      ELSE accounts.next_daily_time
    END
  WHERE 
    accounts.instance_id = p_instance_id
    AND accounts.is_active = true
    AND (accounts.next_clicker_time <= p_now OR accounts.next_daily_time <= p_now)
  RETURNING 
    accounts.id,
    accounts.instance_id,
    accounts.user_id,
    accounts.phone,
    accounts.session_string,
    accounts.is_active,
    accounts.next_clicker_time,
    accounts.next_daily_time,
    accounts.last_error,
    accounts.error_count,
    accounts.total_clicks,
    accounts.total_dailies,
    accounts.last_click_at,
    accounts.last_daily_at,
    accounts.cap,
    accounts.created_at,
    accounts.updated_at;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_due_accounts TO anon, authenticated, service_role;

COMMENT ON COLUMN accounts.cap IS 'Click counter that resets every 20 clicks, triggers delay when limit reached';