# 360°Pixelkiez – Deploy auf Hostinger (Webhosting, PHP)

Gilt für die kostenlose Website-Analyse mit Google-Anmeldung (PXK-153). 360°Pixelkiez ist eine eigenständige Website:
keine Links zu pixelkiez.de, eigenes Impressum (`impressum.html`) und eigene Datenschutzerklärung (`datenschutz.html`).
Ein Deployment braucht eine eigene, aktuelle Freigabe für **genau einen Commit-SHA und ein Hosting-Ziel**.
Platzhalter: `<domain>` (z. B. eine Subdomain), `<user>` (Hostinger-Benutzer `u…`), `<sha>` (freigegebener Commit).

## 0. Vor dem ersten Deploy klären (sonst kein Livegang)

- [ ] Domain festlegen (D-10) und als Website/Subdomain in hPanel anlegen
- [ ] Google-OAuth-Client angelegt (Abschnitt 4)
- [ ] MySQL-Datenbank und Absender-Postfach angelegt (Abschnitte 3 und 5)
- [ ] `public/datenschutz.html` fertigstellen (derzeit „in Vorbereitung“): Google als Anmeldedienst, gespeicherte Daten,
      Speicherdauer, Hosting bei Hostinger, Google Fonts. Danach `privacy.version` auf den Stand der Erklärung setzen.
- [ ] Speicherdauer der Aufträge festlegen (Abschnitt 8)
- [ ] Video aus dem Railway-Bucket ausliefern (Abschnitt 11). Lokal liegt nur eine Testkopie in `public/media/` (git-ignoriert).
- [ ] `noindex` bleibt gesetzt, bis eine eigene Release-Freigabe es aufhebt

## 1. Laufzeit

| Punkt | Wert |
|---|---|
| Hosting | Hostinger Webhosting (LiteSpeed + PHP). Node.js wird nicht benötigt. |
| PHP | **8.3** (Hostinger-Standard; getestet: 8.3.36 und 8.5.12). hPanel → Website → Erweitert → PHP-Konfiguration |
| PHP-Erweiterungen | `pdo_mysql`, `openssl`, `curl`, `intl`, `mbstring` (alle aktiv lassen) |
| Datenbank | MySQL/MariaDB aus hPanel (getestet: MariaDB 11.4) |
| SSH | ab Tarif Premium (für Migration und Kontrolle; ohne SSH: phpMyAdmin und Dateimanager) |
| Build | keiner. Kein Composer, kein npm. PHP führt die Dateien direkt aus. |
| Start | keiner. LiteSpeed liefert `public_html/` aus; Hintergrundarbeit erledigt nur der Cronjob (Abschnitt 6). |

## 2. Artefakt bauen und ablegen

Lokal im Repository, auf dem freigegebenen Commit:

```sh
git archive --format=tar.gz -o pxwa-<sha>.tar.gz <sha> public server bin
tar -tzf pxwa-<sha>.tar.gz | cut -d/ -f1 | sort -u      # erwartet genau: bin public server
```

Das Artefakt enthält nur versionierte Dateien aus `public/`, `server/` und `bin/`. **Nicht enthalten** sind
`vision.html`, `DESIGN.md`, `STRUCTURE.md`, `docs/`, `tests/`, `.gitignore`, `server/config.php` und `var/`.

Auf dem Server (SSH-Zugang laut hPanel → Erweitert → SSH-Zugang):

```sh
cd ~/domains/<domain>
cp -a public_html public_html.vorher-$(date +%Y%m%d%H%M)   # Sicherung für den Rollback
ls -la public_html                                     # vorhandene Dateien prüfen; Hostinger-Platzhalter (z. B. default.php) entfernen
tar -xzf ~/pxwa-<sha>.tar.gz                           # legt public/, server/, bin/ an; server/config.php bleibt erhalten
cp -a public/. public_html/ && rm -rf public
mkdir -p var/sessions && chmod 700 var var/sessions
[ -f server/config.php ] || cp server/config.example.php server/config.php   # nur beim ersten Deploy
chmod 600 server/config.php
```

Zielstruktur: `~/domains/<domain>/{public_html,server,bin,var}`. `server/` und `bin/` liegen **neben** `public_html`.

## 3. Konfiguration `server/config.php` (nur Schlüssel, Werte nie in Git)

Es gibt keine Umgebungsvariablen. `PXWA_CONFIG` ist nur für Tests gedacht und wird in Produktion nicht gesetzt.

| Schlüssel | Inhalt |
|---|---|
| `env` | `production` |
| `base_url` | `https://<domain>` ohne `/` am Ende; muss der kanonische Host sein |
| `google.client_id`, `google.client_secret` | aus Abschnitt 4 |
| `db.dsn`, `db.user`, `db.pass` | `mysql:host=localhost;dbname=<db>;charset=utf8mb4` plus Zugang aus hPanel → Datenbanken |
| `mail.host`, `mail.port`, `mail.encryption` | `smtp.hostinger.com`, `465`, `ssl` (Alternative: `587` / `starttls`) |
| `mail.username`, `mail.password`, `mail.from` | Absender-Postfach (volle Adresse als Benutzername) |
| `mail.notify_to` | `kontakt@pixelkiez.de` |
| `data_dir`, `session_dir` | `/home/<user>/domains/<domain>/var` und `…/var/sessions` |
| `secret` | `php -r 'echo bin2hex(random_bytes(32));'` |
| `privacy.version` | Stand von `datenschutz.html` (nicht `ENTWURF-…`); wird je Auftrag gespeichert |

Schema anlegen (idempotent): `php bin/migrate.php` → `PXWA: Schema ist aktuell.`
Ohne SSH: `server/schema/mysql.sql` in phpMyAdmin importieren.
Fehlt ein Wert, antwortet `anfrage.php` mit 503. Das Server-Log nennt nur den Schlüsselnamen.

## 4. Google OAuth (Google Cloud Console → Google Auth Platform)

- Zielgruppe: **Extern**, Status **In Produktion**. Im Testmodus können sich nur eingetragene Testnutzer anmelden.
- Branding: App-Name `360°Pixelkiez`, Support-E-Mail, Startseite `https://<domain>/`, Datenschutz-Link `https://<domain>/datenschutz.html`,
  autorisierte Domain = registrierbare Domain von `<domain>`. Ein Logo löst eine Markenprüfung aus und wird nicht benötigt.
- Datenzugriff: nur `openid` und `…/auth/userinfo.email`. Beide sind nicht sensibel, eine Scope-Prüfung ist nicht nötig.
- Client: Typ **Webanwendung**. Autorisierte Weiterleitungs-URI exakt `https://<domain>/auth/callback.php`.
  JavaScript-Quellen werden nicht benötigt, weil der Code-Austausch serverseitig mit PKCE läuft.

## 5. Interne Benachrichtigung

- Absender: eigenes Hostinger-Postfach (z. B. `analyse@pixelkiez.de`). SPF (`include:_spf.mail.hostinger.com`)
  und DKIM (`hostingermail-a`) sind für pixelkiez.de vorhanden, DMARC steht auf `p=none`.
- Empfänger ist nur `kontakt@pixelkiez.de`. Kundinnen und Kunden erhalten keine Mail, und es wird kein PDF versendet.
  Den PDF-Bericht verschickt Pixelkiez manuell.

## 6. Cronjob (hPanel → Erweitert → Cronjobs)

`*/5 * * * *`  `php /home/<user>/domains/<domain>/bin/send-notifications.php`

Vorher per SSH `php -v` prüfen. Ist die CLI-Version älter als 8.2, den versionierten Pfad aus hPanel verwenden.
Ausgabe: `PXWA: N versendet, M fehlgeschlagen.` Exit-Code 2 bedeutet Fehlversuche, 1 bedeutet Abbruch.

## 7. Domain, HTTPS, Header

1. hPanel → Sicherheit → SSL: Zertifikat für `<domain>` installieren. Erst danach funktionieren die `__Host-`-Session-Cookies.
2. In `public_html/.htaccess` die Regel für den kanonischen Host einkommentieren und `DOMAIN-FEHLT.example` ersetzen.
3. Hostinger-CDN aus lassen oder prüfen, dass `REMOTE_ADDR` die Client-IP ist (sonst greift das Rate-Limit für alle).

## 8. Daten, Backup, Aufbewahrung

- Gespeichert werden je Auftrag: Referenz, Google-Kennung, bestätigte E-Mail, Website, Datenschutz-Version und Zeitpunkt,
  dazu der Zustellstatus. Tokens werden nicht gespeichert. Rate-Limits liegen nur pseudonymisiert vor und werden nach 24 h gelöscht.
- Backup: Hostinger sichert wöchentlich (Business: täglich). Vor jedem Deploy die Datenbank zusätzlich in hPanel → Backups
  oder per `mysqldump` sichern. `var/` (Schlüssel-Cache, Sessions) braucht kein Backup.
- Aufbewahrung: Die Frist ist **offen** (D-5). Eine automatische Löschung gibt es nicht. Nach Festlegung monatlich ausführen:

```sql
DELETE n FROM notifications n JOIN orders o ON o.id = n.order_id WHERE o.created_at < UTC_TIMESTAMP() - INTERVAL <tage> DAY;
DELETE FROM orders WHERE created_at < UTC_TIMESTAMP() - INTERVAL <tage> DAY;
```

- Nicht zugestellte Benachrichtigungen (nach 10 Versuchen über rund 2,5 Tage endgültig `failed`) wöchentlich prüfen:
  `SELECT o.reference, o.created_at, n.status, n.attempts, n.last_error FROM notifications n JOIN orders o ON o.id = n.order_id WHERE n.status <> 'sent';`

## 9. Smoke-Test nach dem Deploy (kontrollierte Testdaten)

```sh
B=https://<domain>
curl -sI "http://<domain>/index.html" | grep -i '^location: https://'                 # HTTP → HTTPS
curl -sI "$B/index.html"  | grep -iE 'strict-transport|x-frame-options|content-security'
curl -s -D - -o /dev/null "$B/anfrage.php" | grep -iE 'set-cookie: __Host-pxwa=.*secure.*httponly.*samesite=lax|content-security|cache-control: no-store'   # GET; HEAD ergibt 405
for p in impressum.html datenschutz.html; do curl -s -o /dev/null -w "%{http_code} $p\n" "$B/$p"; done     # erwartet 200
for p in vision.html DESIGN.md STRUCTURE.md server/config.php .htaccess .git/HEAD tests/server.test.mjs; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "$B/$p"; done                           # erwartet 403 oder 404, nie 200
php ~/domains/<domain>/bin/send-notifications.php                                     # erwartet: 0 versendet, 0 fehlgeschlagen.
```

Danach im Browser mit einem Test-Google-Konto und einer eigenen Website (z. B. `pixelkiez.de`):
URL eingeben → Google → bestätigen. Erwartet werden die Referenz `PXA-…`, genau eine Zeile in `orders`,
`notifications.status = 'sent'` und **genau eine** Mail in kontakt@pixelkiez.de.
Danach Zurück + erneut senden sowie dieselbe URL noch einmal anfragen: Es darf keine zweite Mail entstehen.
Anschließend die Testdaten löschen:
`DELETE FROM notifications WHERE order_id IN (SELECT id FROM orders WHERE reference = 'PXA-…'); DELETE FROM orders WHERE reference = 'PXA-…';`

## 10. Rollback

- **Sofort abschalten**, ohne Datenverlust: `mv server/config.php server/config.php.aus`.
  Die Anfrageseiten antworten dann mit 503 („Anfragen sind im Moment nicht möglich“), die statischen Seiten bleiben erreichbar.
  Rücknahme: Datei zurückbenennen.
- **Vorherige Version**: Artefakt des vorherigen SHA wie in Abschnitt 2 entpacken und `public_html`, `server` und `bin`
  ersetzen. `server/config.php` und `var/` bleiben, die Datenbank bleibt unverändert (das Schema ist nur additiv).
- Erstes Deploy: Den in Abschnitt 2 gesicherten Inhalt von `public_html` zurückkopieren. Aufträge vorher exportieren.

## 11. Video unter dem Hero (Railway)

Railway-Buckets sind privat; es gibt keine öffentlichen Bucket-URLs. Ausgeliefert wird über einen öffentlichen Dienst
im selben Railway-Projekt, der aus dem Bucket liest (z. B. Vorlage „Blob Butler“) und eine feste Domain hat.

1. Bucket anlegen und hochladen: `360-pixelkiez-video-1080p.mp4`, `360-pixelkiez-video-poster.jpg` (unter dem Hero)
   sowie `report-pdf-de-1x1.mp4`, `report-pdf-poster.jpg` (Abschnitt „Ihr Bericht“).
2. Auslieferungsdienst mit Domain `<media-domain>` bereitstellen. Pflicht für iPhone/Safari: Antworten auf
   Range-Anfragen mit `206 Partial Content` und `Accept-Ranges: bytes`. Prüfung:
   `curl -s -o /dev/null -D - -H 'Range: bytes=0-1023' https://<media-domain>/360-pixelkiez-video-1080p.mp4 | head -5`
3. In `public/index.html` bei beiden Videos `poster` und `<source src>` auf `https://<media-domain>/…` setzen und in der Meta-CSP
   `media-src 'self' https://<media-domain>; img-src 'self' https://<media-domain>` ergänzen.
4. Railway als Anbieter in `datenschutz.html` aufnehmen (beim Abruf geht die IP-Adresse an Railway).
