# 360°Pixelkiez – Deploy: Frontend auf Railway, API als Cloudflare Worker mit D1

Gilt für die kostenlose Website-Analyse mit Google-Anmeldung (PXK-153). 360°Pixelkiez ist eine eigenständige Website:
keine Links zu pixelkiez.de, eigenes Impressum (`impressum.html`) und eigene Datenschutzerklärung (`datenschutz.html`).
Ein Deployment braucht eine eigene, aktuelle Freigabe für **genau einen Commit-SHA**. Dieses Dokument nennt nur
Schlüsselnamen, nie Werte. Platzhalter: `<domain>` (z. B. eine Subdomain), `<zone>` (registrierbare Domain), `<sha>`.

```
Browser ──HTTPS──► Cloudflare (Zone <zone>, Proxy an)
                     ├─ <domain>/api/*  ──► Worker „pxwa-api“ (TypeScript) ──► D1 „pxwa“ (EU)
                     │                                                    ├─► Google OIDC (Token, JWKS)
                     │                                                    └─► HTTPS-Mail-API (nur kontakt@pixelkiez.de)
                     └─ alles andere    ──► Railway-Dienst (Caddy, nur public/)
```

## 0. Vor dem ersten Deploy klären (sonst kein Livegang)

- [ ] Domain festlegen (D-10). Die Worker-Route braucht die Zone **in Cloudflare** (Nameserver bei Cloudflare, Eintrag
      für `<domain>` mit Proxy). pixelkiez.de liegt derzeit bei Hostinger: Zonenumzug (MX, SPF, DKIM, DMARC vorher
      vollständig übernehmen) oder eigene Domain für 360°Pixelkiez. Teil-/Subdomain-Setups gibt es bei Cloudflare
      nur in höheren Tarifen – vor der Entscheidung prüfen, keine kostenpflichtigen Dienste ohne Freigabe.
- [ ] Mail-Anbieter mit HTTPS-API freigeben (Abschnitt 5). Bis dahin ist die Produktionskonfiguration absichtlich
      ungültig: Die API antwortet mit 503, es werden keine Aufträge angenommen und keine Daten verschickt.
- [ ] Google-OAuth-Client angelegt (Abschnitt 4)
- [ ] `public/datenschutz.html` fertigstellen (derzeit „in Vorbereitung“): Google als Anmeldedienst, gespeicherte Daten,
      Speicherdauer, Cloudflare (Worker, D1, Proxy), Railway (Frontend, Videos), Mail-Anbieter, Google Fonts.
      Danach `PRIVACY_VERSION` auf den Stand der Erklärung setzen.
- [ ] Speicherdauer der Aufträge festlegen (D-5, Abschnitt 7)
- [ ] Videos aus dem Railway-Bucket ausliefern (Abschnitt 9). Das Artefakt enthält keine Medien.
- [ ] `noindex` bleibt gesetzt, bis eine eigene Release-Freigabe es aufhebt

## 1. Werkzeuge und Prüfung vor dem Deploy

Node ≥ 22. Im Repository auf dem freigegebenen Commit: `npm ci`, dann `npm run typecheck` und `npm test`
(statisch, Worker in workerd mit lokaler D1, Caddy). Browser-Regression: `npm run test:browser` mit `PXK_PLAYWRIGHT`.
Wrangler-Telemetrie abschalten: `export WRANGLER_SEND_METRICS=false`. Alle `wrangler`-Befehle laufen in `worker/`.
Konfiguration ohne Deploy prüfen: `npx wrangler deploy --dry-run --outdir /tmp/pxwa-dry`.

## 2. Frontend auf Railway (statisch, Caddy)

| Punkt | Wert |
|---|---|
| Quelle | GitHub-Repository, Branch bzw. Commit `<sha>`; Konfiguration in `railway.json` |
| Build | `deploy/railway/Dockerfile`: `caddy:2.11.4-alpine` per Digest fixiert, kopiert nur `public/` (ohne `public/media/`) und das Caddyfile |
| Build-Kontext | `.dockerignore` lässt nur `public/` und `deploy/railway/Caddyfile` durch – keine Quellen, Tests, Docs, Secrets |
| Start | `caddy run` als Benutzer `nobody`, Port aus `PORT` (setzt Railway), Admin-API aus, kein Zugriffslog |
| Variablen | keine. Das Frontend enthält keine Secrets und keine Logik. |
| Healthcheck | `/index.html` |
| `/api/*` | antwortet mit 503, falls Anfragen ohne aktive Worker-Route bei Railway ankommen (nichts wird angenommen) |

Custom Domain `<domain>` im Railway-Dienst hinzufügen und den von Railway genannten CNAME in der Cloudflare-Zone
**mit Proxy** anlegen. SSL/TLS-Modus „Full (strict)“, „Always Use HTTPS“ an. Lässt sich das Railway-Zertifikat
hinter dem Proxy nicht ausstellen, der Railway-Anleitung für Cloudflare folgen. Reproduzierbarkeit lokal prüfen:
`PXK_DOCKER=1 node --test tests/railway.test.mjs` (baut das Image und vergleicht dessen Dateiliste mit dem Artefakt).

## 3. API-Worker auf Cloudflare (`worker/wrangler.toml`)

1. D1 mit EU-Jurisdiktion anlegen: `npx wrangler d1 create pxwa --jurisdiction eu` → `database_id` eintragen.
2. Schema: `npx wrangler d1 migrations apply pxwa --remote` (Migrationen in `worker/migrations/`, nur additiv).
3. Variablen in `[vars]` (keine Secrets): `ENV=production`, `BASE_URL=https://<domain>` (ohne `/` am Ende),
   `GOOGLE_CLIENT_ID`, `PRIVACY_VERSION`, `MAIL_API_URL`, `MAIL_FROM`, `MAIL_NOTIFY_TO=kontakt@pixelkiez.de`.
4. Secrets nur per `npx wrangler secret put <NAME>`: `GOOGLE_CLIENT_SECRET`, `SECRET` (≥ 32 Zeichen, z. B.
   `openssl rand -hex 32`; pseudonymisiert IP-Adressen im Rate-Limit), `MAIL_API_TOKEN`.
5. Route aktivieren (erst nach Freigabe der Domain): `routes = [{ pattern = "<domain>/api/*", zone_name = "<zone>" }]`.
   `workers_dev = false` und `preview_urls = false` bleiben, damit die API nur über `<domain>` erreichbar ist.
6. Cron `*/5 * * * *` (in `wrangler.toml`): wiederholt fällige Benachrichtigungen, löscht abgelaufene Sessions und
   Rate-Limit-Fenster älter als 24 h. Workers Logs (`[observability]`) enthalten nur Anzahlen, Referenzen und Fehlercodes.

Fehlt ein Wert oder ist er ungültig, antwortet `/api/anfrage` mit 503 („Anfragen sind im Moment nicht möglich“);
das Log nennt nur den Schlüsselnamen. In Produktion sind nur die echten Google-Endpunkte erlaubt, `BASE_URL` muss
HTTPS sein und darf kein Platzhalter sein. Zugriff auf D1 und Secrets haben nur Mitglieder des Cloudflare-Kontos:
2FA erzwingen, API-Tokens nur mit den nötigen Rechten (Workers Scripts, D1) und kurzer Laufzeit.

## 4. Google OAuth (Google Cloud Console → Google Auth Platform)

- Zielgruppe **Extern**, Status **In Produktion**. Im Testmodus können sich nur eingetragene Testnutzer anmelden.
- Branding: App-Name `360°Pixelkiez`, Support-E-Mail, Startseite `https://<domain>/`, Datenschutz-Link
  `https://<domain>/datenschutz.html`, autorisierte Domain `<zone>`. Kein Logo (würde eine Markenprüfung auslösen).
- Datenzugriff: nur `openid` und `…/auth/userinfo.email` (nicht sensibel, keine Scope-Prüfung nötig).
- Client Typ **Webanwendung**, autorisierte Weiterleitungs-URI exakt `https://<domain>/api/auth/callback`.
  JavaScript-Quellen werden nicht benötigt: Der Code-Austausch läuft serverseitig im Worker mit PKCE, state und nonce.

## 5. Interne Benachrichtigung (HTTPS-Mail-API)

- Der Worker sendet je Auftrag genau eine Nachricht an `MAIL_NOTIFY_TO` (nie an Kundinnen und Kunden, nie ein PDF):
  `POST MAIL_API_URL` mit `Authorization: Bearer <MAIL_API_TOKEN>`, `Idempotency-Key: pxwa-<Referenz>` und JSON
  `{ from, to: [..], reply_to, subject, text }`. Weiterleitungen werden nicht verfolgt.
- **Freigabe-Gate:** Der Host von `MAIL_API_URL` muss in `AUTHORIZED_MAIL_API_HOSTS` (`worker/src/config.ts`) stehen.
  Die Liste ist leer. Ein Eintrag braucht die menschliche Freigabe des Anbieters (Vertrag zur Auftragsverarbeitung,
  Datenschutzerklärung) und einen eigenen Commit. Weicht das JSON-Format des Anbieters ab, wird `MailApi` angepasst.
- Outbox: Auftrag und Benachrichtigung entstehen in einem D1-Batch. Der erste Versand läuft direkt nach der Antwort,
  Wiederholungen per Cron: 5 min, 15 min, 45 min … höchstens 12 h, nach 10 Versuchen `failed`.

## 6. Smoke-Test nach dem Deploy (kontrollierte Testdaten)

```sh
B=https://<domain>
curl -sI "http://<domain>/" | grep -i '^location: https://'                                  # HTTP → HTTPS
curl -sI "$B/index.html" | grep -iE 'strict-transport|x-frame-options|content-security'
curl -s -D - -o /dev/null "$B/api/anfrage" | grep -iE '^HTTP|content-security|cache-control: no-store'   # 200 vom Worker
for p in vision.html DESIGN.md package.json worker/wrangler.toml .git/HEAD tests/worker.test.mjs; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "$B/$p"; done                                   # erwartet 404, nie 200
```

Danach im Browser mit einem Test-Google-Konto und einer eigenen Website: URL eingeben → Google → bestätigen.
Erwartet: Referenz `PXA-…`, genau eine Zeile in `orders`, `notifications.status = 'sent'`, **genau eine** Mail.
Zurück + erneut senden und dieselbe URL erneut anfragen: keine zweite Mail. Prüfen und Testdaten löschen:

```sh
npx wrangler d1 execute pxwa --remote --command "SELECT o.reference, n.status, n.attempts, n.last_error FROM orders o JOIN notifications n ON n.order_id = o.id ORDER BY o.id DESC LIMIT 5"
npx wrangler d1 execute pxwa --remote --command "DELETE FROM notifications WHERE order_id IN (SELECT id FROM orders WHERE reference = 'PXA-…'); DELETE FROM orders WHERE reference = 'PXA-…'"
```

## 7. Daten, Backup, Aufbewahrung

- Je Auftrag: Referenz, Google-Kennung, bestätigte E-Mail, Website, Datenschutz-Version, Zeitpunkt, Zustellstatus.
  Sessions (Hash der Cookie-ID, Ablauf nach 1 h) und pseudonymisierte Rate-Limits löscht der Cron. Keine Tokens.
- Backup: D1 Time Travel (Wiederherstellung auf einen Zeitpunkt der letzten Tage) – vor jedem Deploy mit
  Schemaänderung zusätzlich `npx wrangler d1 export pxwa --remote --output pxwa-<datum>.sql` (Datei enthält
  personenbezogene Daten: verschlüsselt ablegen, nicht ins Repository).
- Aufbewahrung: Frist **offen** (D-5). Es gibt keine automatische Löschung von Aufträgen. Nach Festlegung z. B. monatlich:
  `DELETE FROM notifications WHERE order_id IN (SELECT id FROM orders WHERE created_at < datetime('now', '-<tage> days'))`
  und danach `DELETE FROM orders WHERE created_at < datetime('now', '-<tage> days')`.
- Nicht zugestellte Benachrichtigungen wöchentlich prüfen: `… WHERE n.status <> 'sent'` (Abfrage wie in Abschnitt 6).

## 8. Rollback

- **API sofort abschalten**, ohne Datenverlust: Route in `wrangler.toml` auskommentieren und deployen oder im Dashboard
  entfernen. `/api/*` landet dann bei Railway und antwortet mit 503; die statischen Seiten bleiben erreichbar.
- **Vorherige Worker-Version:** `npx wrangler rollback` (bzw. `npx wrangler deployments list`). D1 bleibt unverändert.
- **Vorheriges Frontend:** in Railway das vorherige Deployment erneut ausrollen („Redeploy“).

## 9. Videos (Railway-Bucket)

Railway-Buckets sind privat; ausgeliefert wird über einen öffentlichen Dienst im selben Railway-Projekt, der aus dem
Bucket liest, mit Domain `<media-domain>`. Hochladen: `360-pixelkiez-video-1080p.mp4`, `360-pixelkiez-video-poster.jpg`,
`report-pdf-de-1x1.mp4`, `report-pdf-poster.jpg`. Pflicht für iPhone/Safari: `206 Partial Content` auf Range-Anfragen.
Danach in `public/index.html` `poster` und `<source src>` auf `https://<media-domain>/…` setzen und in der Meta-CSP
`media-src 'self' https://<media-domain>; img-src 'self' https://<media-domain>` ergänzen.
