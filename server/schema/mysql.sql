-- PXWA – Schema für MySQL/MariaDB (Hostinger hPanel). Zeiten in UTC.
-- Gespeichert wird nur, was für den manuellen Auftrag nötig ist: Google-Kennung, bestätigte E-Mail, Website.
CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(20) NOT NULL,
  idempotency_key CHAR(32) NOT NULL,
  google_sub VARCHAR(255) NOT NULL,
  email VARCHAR(254) NOT NULL,
  website_url VARCHAR(300) NOT NULL,
  privacy_version VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'received',
  created_at DATETIME NOT NULL,
  UNIQUE KEY orders_reference (reference),
  UNIQUE KEY orders_idempotency (idempotency_key),
  KEY orders_account_site (google_sub(64), website_url(191), created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL,
  locked_until DATETIME NULL,
  last_error VARCHAR(64) NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY notifications_order (order_id),
  KEY notifications_due (status, next_attempt_at),
  CONSTRAINT notifications_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket VARCHAR(80) NOT NULL,
  window_start BIGINT NOT NULL,
  hits INT NOT NULL,
  PRIMARY KEY (bucket, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=ascii;
