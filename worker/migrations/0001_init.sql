-- PXWA – D1-Schema (SQLite). Anwenden: npx wrangler d1 migrations apply pxwa --remote (aus worker/)
-- Gespeichert wird nur, was für den manuellen Auftrag nötig ist: Google-Kennung, bestätigte E-Mail, Website.
-- Zeiten in orders/notifications als UTC-Text 'YYYY-MM-DD HH:MM:SS', in sessions/rate_limits als Unix-Sekunden.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  website_url TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_account_site ON orders (google_sub, website_url, created_at);

-- Outbox der internen Benachrichtigung; enthält keine personenbezogenen Daten, nur Zustellstatus
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders (id),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT NULL,
  last_error TEXT NULL,
  sent_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_due ON notifications (status, next_attempt_at);

-- Schlüssel sind HMAC-pseudonymisiert, keine IP-Adressen im Klartext
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

-- Serverseitige Sessions; id_hash ist der SHA-256 der Cookie-ID, die ID selbst wird nicht gespeichert
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
