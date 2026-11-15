-- Wellmet core database. Times are epoch milliseconds (UTC) unless named *_date.

CREATE TABLE schedules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  timezone    TEXT NOT NULL,
  weekly      TEXT NOT NULL,          -- JSON, validated by the shared Schedule schema
  updated_at  INTEGER NOT NULL
);

CREATE TABLE event_types (
  slug        TEXT PRIMARY KEY,
  settings    TEXT NOT NULL,          -- JSON, validated by the shared EventTypeSettings schema
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE date_overrides (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,          -- YYYY-MM-DD in the schedule's timezone
  schedule    TEXT NOT NULL,
  scope       TEXT NOT NULL,          -- JSON: "all" or a list of slugs
  kind        TEXT NOT NULL CHECK (kind IN ('closed', 'open')),
  hours       TEXT,                   -- JSON list of ranges when kind = 'open'
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX date_overrides_by_date ON date_overrides (schedule, date);

CREATE TABLE bookings (
  id                TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL,
  length_min        INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'confirmed', 'declined', 'expired', 'cancelled', 'failed')),
  mode_applied      TEXT NOT NULL CHECK (mode_applied IN ('instant', 'approval', 'downgraded', 'held')),
  reason            TEXT,
  start_ms          INTEGER NOT NULL,
  end_ms            INTEGER NOT NULL,
  block_start_ms    INTEGER NOT NULL,   -- start minus this type's buffer before
  block_end_ms      INTEGER NOT NULL,   -- end plus this type's buffer after
  local_date        TEXT NOT NULL,      -- YYYY-MM-DD in the schedule's timezone, for daily caps
  week_key          TEXT NOT NULL,      -- the Monday of local_date's week, for weekly caps
  guest_name        TEXT NOT NULL,
  guest_email       TEXT NOT NULL,
  guest_tz          TEXT NOT NULL,
  answers           TEXT NOT NULL DEFAULT '{}',
  via               TEXT NOT NULL CHECK (via IN ('web', 'api', 'mcp', 'owner')),
  source_hash       TEXT NOT NULL,
  retry_key         TEXT,
  meeting_url       TEXT,
  calendar_event_id TEXT,
  rechecked_at      INTEGER,
  calendar_dirty    TEXT CHECK (calendar_dirty IN ('move', 'cancel')),
  reschedule_count  INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  lease_until       INTEGER,
  alerted_at        INTEGER,
  expires_at        INTEGER,
  decided_by        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX bookings_retry_key ON bookings (retry_key) WHERE retry_key IS NOT NULL;
CREATE INDEX bookings_committed ON bookings (block_start_ms) WHERE status IN ('accepted', 'confirmed');
CREATE INDEX bookings_pending ON bookings (block_start_ms) WHERE status = 'pending';
CREATE INDEX bookings_by_source ON bookings (source_hash, created_at);
CREATE INDEX bookings_by_type_day ON bookings (event_type, local_date);

CREATE TABLE connections (
  provider        TEXT PRIMARY KEY CHECK (provider IN ('microsoft', 'google')),
  account_sub     TEXT NOT NULL,
  account_email   TEXT NOT NULL,
  refresh_enc     TEXT NOT NULL,      -- AES-GCM ciphertext, key held only as a Worker secret
  access_enc      TEXT,
  access_expires  INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'failing', 'broken')),
  failing_since   INTEGER,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  booking_id  TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unsent ON outbox (sent_at, created_at);

CREATE TABLE state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  component   TEXT NOT NULL CHECK (component IN ('core', 'public', 'owner')),
  level       TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  code        TEXT NOT NULL,
  booking_id  TEXT,
  message     TEXT NOT NULL
);
CREATE INDEX log_by_component ON log (component, at);
