-- PXWA – Nachweis der Erklärungen je Auftrag und Werbeeinwilligungen (additiv, Rechtstexte Fassung 2026-11-04).
-- Lokal: wrangler d1 migrations apply pxwa --local. Remote nur mit eigener Freigabe.
-- business_confirmed: Pflichtbestätigung „Unternehmer“ (1); marketing_consent: freiwillige Einwilligung in werbliche E-Mails (0/1);
-- declarations: Wortlaut der bestätigten Kästchen (Nachweis, Art. 7 Abs. 1 DSGVO). Bestehende Zeilen behalten 0 bzw. NULL.
ALTER TABLE orders ADD COLUMN business_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN declarations TEXT NULL;
-- Werbeeinwilligungen: gelten bis zum Widerruf und bleiben bestehen, wenn der Auftrag nach vier Monaten gelöscht wird.
-- Keine Website-Adresse; revoked_at wird beim Widerruf gesetzt (Sperrliste), danach Nachweis bis drei Jahre nach Jahresende.
CREATE TABLE IF NOT EXISTS marketing_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  wording TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  given_at TEXT NOT NULL,
  order_reference TEXT NOT NULL,
  revoked_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS marketing_consents_email ON marketing_consents (email);
