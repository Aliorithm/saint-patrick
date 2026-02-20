-- ================================================
-- TELEGRAM BOT FARM - COMPLETE SUPABASE SCHEMA
-- Includes: base schema, cap, next_leave_time, atomic claiming
-- Run this fresh on a new database
-- ================================================

-- ============================================
-- TABLE
-- ============================================
CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  instance_id INTEGER NOT NULL CHECK (instance_id BETWEEN 1 AND 12),
  user_id BIGINT NOT NULL,
  phone VARCHAR(20),
  session_string TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  next_clicker_time TIMESTAMPTZ,
  next_daily_time TIMESTAMPTZ,
  next_leave_time TIMESTAMPTZ DEFAULT NULL,
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

COMMENT ON COLUMN accounts.cap IS
  'Click counter that resets on cap limit, triggers delay when reached';
COMMENT ON COLUMN accounts.next_leave_time IS
  'When to next leave all broadcast channels. NULL = this account never participates in channel cleanup.';

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX idx_accounts_instance_id ON accounts(instance_id);
CREATE INDEX idx_accounts_instance_active ON accounts(instance_id, is_active) WHERE is_active = true;
CREATE INDEX idx_accounts_next_clicker ON accounts(next_clicker_time) WHERE is_active = true;
CREATE INDEX idx_accounts_next_daily ON accounts(next_daily_time) WHERE is_active = true;
CREATE INDEX idx_accounts_next_leave ON accounts(next_leave_time) WHERE is_active = true;

-- ============================================
-- AUTO-UPDATE TIMESTAMP
-- ============================================
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

-- ============================================
-- ATOMIC ACCOUNT CLAIMING
-- Atomically claims due accounts by bumping their times BEFORE
-- returning them — prevents race conditions across multiple instances.
-- next_leave_time is NOT bumped here; leaveChannels() updates it after completing.
-- ============================================
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
  next_leave_time TIMESTAMPTZ,
  last_error TEXT,
  error_count INTEGER,
  total_clicks INTEGER,
  total_dailies INTEGER,
  last_click_at TIMESTAMPTZ,
  last_daily_at TIMESTAMPTZ,
  cap INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  original_clicker_time TIMESTAMPTZ,
  original_daily_time TIMESTAMPTZ,
  original_leave_time TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT
      accounts.id,
      accounts.instance_id,
      accounts.user_id,
      accounts.phone,
      accounts.session_string,
      accounts.is_active,
      accounts.next_clicker_time AS original_clicker,
      accounts.next_daily_time   AS original_daily,
      accounts.next_leave_time   AS original_leave,
      accounts.last_error,
      accounts.error_count,
      accounts.total_clicks,
      accounts.total_dailies,
      accounts.last_click_at,
      accounts.last_daily_at,
      accounts.cap,
      accounts.created_at,
      accounts.updated_at
    FROM accounts
    WHERE
      accounts.instance_id = p_instance_id
      AND accounts.is_active = true
      AND (
        accounts.next_clicker_time <= p_now
        OR accounts.next_daily_time <= p_now
        OR (accounts.next_leave_time IS NOT NULL AND accounts.next_leave_time <= p_now)
      )
    FOR UPDATE SKIP LOCKED
  )
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
  FROM claimed
  WHERE accounts.id = claimed.id
  RETURNING
    accounts.id,
    accounts.instance_id,
    accounts.user_id,
    accounts.phone,
    accounts.session_string,
    accounts.is_active,
    claimed.original_clicker AS next_clicker_time,
    claimed.original_daily   AS next_daily_time,
    claimed.original_leave   AS next_leave_time,
    accounts.last_error,
    accounts.error_count,
    accounts.total_clicks,
    accounts.total_dailies,
    accounts.last_click_at,
    accounts.last_daily_at,
    accounts.cap,
    accounts.created_at,
    accounts.updated_at,
    claimed.original_clicker AS original_clicker_time,
    claimed.original_daily   AS original_daily_time,
    claimed.original_leave   AS original_leave_time;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_due_accounts TO anon, authenticated, service_role;

-- ============================================
-- To enable leave-channels for ALL existing accounts,
-- set next_leave_time to a random time in the next 24–48h.
-- Run this separately, only once, when you're ready to activate.
-- ============================================
-- UPDATE accounts
-- SET next_leave_time = NOW() + (
--   INTERVAL '1440 minutes' +
--   (random() * 1440)::INTEGER * INTERVAL '1 minute'
-- )
-- WHERE next_leave_time IS NULL;