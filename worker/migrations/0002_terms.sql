-- PXWA – AGB-Zustimmung je Auftrag (additiv, PXWA-BE-02). Lokal: wrangler d1 migrations apply pxwa --local
-- Remote nur mit eigener Freigabe. Bestehende Zeilen behalten NULL (vor dem AGB-Gate angelegt); neue Aufträge setzen beide Werte.
-- terms_version: akzeptierte AGB-Version (TERMS_VERSION); terms_accepted_at: Zeitpunkt der Zustimmung laut Server, UTC-Text wie created_at.
ALTER TABLE orders ADD COLUMN terms_version TEXT NULL;
ALTER TABLE orders ADD COLUMN terms_accepted_at TEXT NULL;
