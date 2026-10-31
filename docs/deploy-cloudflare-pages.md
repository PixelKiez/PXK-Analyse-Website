# 360°Pixelkiez – Deploy: Cloudflare Pages, privater Worker mit D1, Resend

Gilt für die kostenlose Website-Analyse mit Google-Anmeldung (PXK-153). Ein Deployment braucht eine eigene, aktuelle
menschliche Freigabe für **genau einen Commit-SHA**. Dieses Dokument nennt nur Schlüsselnamen, nie Werte.
Nichts hier ist bereits eingerichtet: kein Cloudflare-Projekt, keine D1-Datenbank, kein DNS-Eintrag, kein
Google-Client, keine Resend-Domain. Alle bisherigen Tests sind lokal (Mocks, workerd, `wrangler pages dev`).

```
Browser ──HTTPS──► 360.pixelkiez.de  (CNAME bei Hostinger → <projekt>.pages.dev)
                     │
                     ▼
                Cloudflare Pages „pxwa“ ── /, *.html, /assets/*, /media/* ──► statische Dateien aus public/
                     │
                     └─ /api/* (public/_routes.json) ──► Pages Function functions/api/[[path]].ts
                                                            │ Service Binding „API“ (intern, keine öffentliche Adresse)
                                                            ▼
                                                        Worker „pxwa-api“ ──► D1 „pxwa“ (EU-Jurisdiktion)
                                                            ├─► Google OIDC (Token, JWKS)
                                                            ├─► Resend API (nur an kontakt@pixelkiez.de)
                                                            └─ Cron alle 5 Minuten (Wiederholungen, Aufräumen)
```

## 0. Offene Release-Gates (ohne sie kein Livegang)

- [ ] Cloudflare-Konto mit 2FA; Pages-Projekt und Worker angelegt (Abschnitte 2–3)
- [ ] D1 mit EU-Jurisdiktion angelegt, Schema angewandt (Abschnitt 3)
- [ ] CNAME `360` bei Hostinger auf den von Cloudflare genannten `*.pages.dev`-Namen (Abschnitt 4)
- [ ] Google-OAuth-Client (Webanwendung) mit exakt `https://360.pixelkiez.de/api/auth/callback` (Abschnitt 5)
- [ ] Resend: Domain `notify.pixelkiez.de` verifiziert, API-Key als Secret, `MAIL_FROM` gesetzt (Abschnitt 6)
- [ ] Datenschutzerklärung fertig und rechtlich geprüft; danach `PRIVACY_VERSION` ohne „ENTWURF“ setzen.
      Solange `PRIVACY_VERSION` mit „ENTWURF“ beginnt, nimmt der Worker in Produktion **keine** Aufträge an (503).
- [ ] Aufbewahrungsfrist für Auftragsdaten entschieden (D-5, Abschnitt 8)
- [ ] Auftragsverarbeitungsverträge (Cloudflare, Resend) und Übermittlungsgrundlagen geprüft
- [ ] Videos auf iPhone/Safari: Pages beantwortet Range-Anfragen laut Cloudflare-Dokumentation mit 200 statt 206.
      WebKit zeigt dann statt des Videos das Standbild (Fallback in `app.js`). Echte Wiedergabe in Safari braucht
      eine eigene Entscheidung (Abschnitt 7).
- [ ] Echte Ende-zu-Ende-Prüfung nach der Aktivierung (Abschnitt 9)
- [ ] `noindex` bleibt gesetzt, bis eine eigene Launch-Freigabe es aufhebt

## 1. Werkzeuge und Prüfung vor jedem Deploy

Node ≥ 22. Auf einem sauberen Checkout des freigegebenen Commits: `npm ci`, `npm run typecheck`, `npm test`
(statisch, Worker in workerd mit lokaler D1, Pages Function und lokales Pages per `wrangler pages dev`).
Browser-Regression: `npm run test:browser` mit `PXK_PLAYWRIGHT` (optional WebKit: `playwright install webkit`).
Telemetrie aus: `export WRANGLER_SEND_METRICS=false`. Konfiguration ohne Deploy prüfen:
`(cd worker && npx wrangler deploy --dry-run --outdir /tmp/pxwa-dry)` und `npx wrangler pages functions build --outdir /tmp/pxwa-fn`.

Zwei getrennte Konfigurationen, damit nie das Falsche deployt wird:

| Datei | Für | Befehle |
|---|---|---|
| `wrangler.toml` (Root) | Pages-Projekt `pxwa`: `public/`, `functions/`, Service Binding | nur `wrangler pages …` im Root |
| `worker/wrangler.toml` | Worker `pxwa-api`: D1, Cron, Variablen | nur `wrangler …` in `worker/` |

`wrangler deploy` im Root bricht ab (Pages-Konfiguration ohne Worker-Einstiegspunkt).

## 2. Cloudflare Pages (Website und Gateway)

**Empfohlen: kontrollierter Direct Upload** statt GitHub-Integration. Gründe: Die Videos in `public/media/` sind
nicht versioniert (eine Git-Integration würde ohne sie bauen), und die Git-Integration deployt bei jedem Push
automatisch (auch Feature-Branches als Vorschau). Während der Entwicklung keine Git-Integration verbinden.

1. Projekt einmalig anlegen (Production-Branch `main`): `npx wrangler pages project create pxwa --production-branch main`.
   Cloudflare vergibt `pxwa.pages.dev` oder bei belegtem Namen eine Variante – den **tatsächlich angezeigten** Namen notieren.
2. Medien prüfen (vier Dateien, je unter 25 MiB): `node --test --test-name-pattern=Medien tests/pages.test.mjs`.
3. Deploy des freigegebenen Commits aus einem sauberen Checkout:
   `npx wrangler pages deploy --branch main --commit-hash <sha> --commit-message "PXK-153 <sha>"`
   (liest `wrangler.toml`: Ausgabeverzeichnis `./public`, kompiliert `functions/`, nimmt `_routes.json` und `_headers` mit).
   `--branch` mit anderem Namen erzeugt ein Vorschau-Deployment.
4. Vorschau und Produktion: Die Produktion hat das Service Binding `API` → `pxwa-api`. Vorschau-Deployments
   (`[env.preview]`, `services = []`) haben **kein** Binding: `/api/*` antwortet dort mit 503, Vorschau-Code erreicht
   weder den Worker noch die D1-Daten. `*.pages.dev` sendet `X-Robots-Tag: noindex` (`public/_headers`).
5. Falls später doch die GitHub-Integration gewünscht ist: Build-Befehl leer, Ausgabeverzeichnis `public`,
   Root-Verzeichnis `/`, automatische Vorschau-Deployments abschalten, und vorher entscheiden, ob die Videos versioniert
   werden. Erst mit eigener Freigabe verbinden.

Was Pages ausliefert: Dateien aus `public/` (ohne `_headers`, `_routes.json`, `.DS_Store`). Die Function läuft nur für
`/api/*`; alle anderen Anfragen sind statisch und verbrauchen kein Function-Kontingent. `*.html` leitet Pages mit 308
auf die Adresse ohne Endung um; unbekannte Adressen bekommen `404.html` mit Status 404 (ohne diese Datei würde Pages
jede unbekannte Adresse mit der Startseite beantworten).

## 3. Privater Worker `pxwa-api` und D1 (alle Befehle in `worker/`)

1. Worker **vor** dem Pages-Projekt deployen, sonst zeigt das Binding ins Leere.
2. D1 mit EU-Jurisdiktion: `npx wrangler d1 create pxwa --jurisdiction eu` → `database_id` in `wrangler.toml` eintragen.
3. Schema: `npx wrangler d1 migrations apply pxwa --remote` (Migrationen nur additiv).
4. `[vars]` (keine Secrets): `BASE_URL = "https://360.pixelkiez.de"` (fest; andere Werte sperren die API),
   `GOOGLE_CLIENT_ID`, `PRIVACY_VERSION`, `MAIL_API_URL = "https://api.resend.com/emails"`,
   `MAIL_FROM` (Adresse @notify.pixelkiez.de, erst nach Domain-Verifizierung), `MAIL_NOTIFY_TO = "kontakt@pixelkiez.de"`.
5. Secrets nur per `npx wrangler secret put <NAME>`: `GOOGLE_CLIENT_SECRET`, `SECRET` (≥ 32 Zeichen, z. B.
   `openssl rand -hex 32`; pseudonymisiert IP-Adressen im Rate-Limit), `MAIL_API_TOKEN` (Resend-API-Key).
6. Deploy: `npx wrangler deploy`. Keine Route, keine Custom Domain: `workers_dev = false` und `preview_urls = false`
   bleiben, der Worker ist nur über das Service Binding erreichbar. Nach dem Deploy im Dashboard prüfen, dass unter
   „Domains & Routes“ nichts aktiv ist.
7. Cron `*/5 * * * *` ist in `wrangler.toml` hinterlegt (läuft ohne Route).

Fehlt ein Wert oder ist er ungültig, antwortet `/api/*` mit 503; das Log nennt nur den Schlüsselnamen. In Produktion
erzwingt der Worker: echte Google-Endpunkte, `BASE_URL` exakt `https://360.pixelkiez.de`, Mail-API `api.resend.com/emails`,
Absender aus `notify.pixelkiez.de`, `PRIVACY_VERSION` nicht „ENTWURF…“. Kontozugriff: 2FA, API-Tokens nur mit den
nötigen Rechten (Pages, Workers Scripts, D1) und kurzer Laufzeit.

## 4. DNS bei Hostinger (nur die neue Subdomain)

- Nameserver bleiben bei Hostinger. Bestehende Einträge für die Website und die Postfächer (A, MX, SPF, DKIM, DMARC)
  **nicht** verändern.
- Zuerst im Pages-Projekt unter „Custom domains“ `360.pixelkiez.de` hinzufügen. Cloudflare nennt dann das CNAME-Ziel.
- Danach bei Hostinger genau einen Eintrag anlegen: `CNAME 360 → <tatsächlich angezeigter Name>.pages.dev`.
  Keinen Namen raten; die Reihenfolge (erst Pages, dann DNS) vermeidet Fehler beim Zertifikat.
- Falls für pixelkiez.de CAA-Einträge bestehen: vorher prüfen, ob die von Cloudflare genutzten Zertifizierungsstellen
  erlaubt sind.
- Prüfen: `dig +short CNAME 360.pixelkiez.de`, danach Status „Active“ im Pages-Projekt.

## 5. Google OAuth (Google Cloud Console → Google Auth Platform)

- Zielgruppe **Extern**, Status **In Produktion** (im Testmodus nur eingetragene Testnutzer).
- Branding: App-Name `360°Pixelkiez`, Support-E-Mail, Startseite `https://360.pixelkiez.de/`, Datenschutz
  `https://360.pixelkiez.de/datenschutz`, autorisierte Domain `pixelkiez.de`. Kein Logo (würde eine Prüfung auslösen).
- Datenzugriff: nur `openid` und `…/auth/userinfo.email`. Keine Gmail- oder sonstigen Scopes.
- Client-Typ **Webanwendung**, autorisierte Weiterleitungs-URI exakt `https://360.pixelkiez.de/api/auth/callback`.
  Keine JavaScript-Quellen nötig: Der Code-Austausch läuft serverseitig im Worker (PKCE, state, nonce).
- Zuerst mit einem kontrollierten Testkonto prüfen (Abschnitt 9).

**Sicherheitsgrenze (Produktentscheidung offen):** Der Worker akzeptiert jedes Google-Konto mit `email_verified = true`.
Bei `@gmail.com`-Adressen und Google-Workspace-Konten ist Google für das Postfach maßgeblich. Bei Google-Konten mit
fremder E-Mail-Adresse (z. B. `name@firma.de` ohne Workspace) bestätigt Google nur, dass die Adresse bei der
Kontoerstellung erreichbar war – nicht, dass die Person das Postfach heute noch kontrolliert. Folge: Ein Bericht
könnte an ein Postfach gehen, das nicht (mehr) der anfragenden Person gehört. Ob nur Gmail-/Workspace-Konten
zugelassen werden sollen, ist eine Produktentscheidung; der Code ändert die Zielgruppe nicht.

## 6. Resend (interne Benachrichtigung)

- Versanddomain `notify.pixelkiez.de` in Resend anlegen. Die DNS-Einträge **genau so** bei Hostinger anlegen, wie
  Resend sie anzeigt (typisch: DKIM-TXT und SPF/MX für einen Unterbereich der Subdomain). Bestehende SPF-, DKIM- und
  DMARC-Einträge von `pixelkiez.de` nicht ändern; die eigene Subdomain hält den Versand davon getrennt.
- Erst nach „Verified“: `MAIL_FROM` (z. B. eine Adresse `@notify.pixelkiez.de`) in `worker/wrangler.toml` setzen.
- API-Key mit Recht „Sending access“ nur für diese Domain; als Secret `MAIL_API_TOKEN`, nie im Repository oder Log.
- Vertrag: `POST https://api.resend.com/emails`, `Authorization: Bearer …`, `User-Agent` (Pflicht, sonst 403),
  `Idempotency-Key: pxwa-<Referenz>`, JSON `{ from, to: ["kontakt@pixelkiez.de"], reply_to, subject, text }`.
  Kein HTML, kein Anhang, keine Mail an Kundinnen und Kunden.
- Zuverlässigkeit: Auftrag und Benachrichtigung entstehen in einem D1-Batch (Outbox). Fällt Resend aus, bleibt der
  Auftrag angenommen. Wiederholung: 5 min, 15 min, 45 min … höchstens 12 h, nach 10 Versuchen `failed`.
  Fehler 408/429/5xx sowie 409 `concurrent_idempotent_requests` gelten als vorübergehend, andere als dauerhaft
  (werden trotzdem begrenzt wiederholt, damit eine korrigierte Konfiguration greift). Gespeichert wird nur der feste
  Fehlername von Resend, nie dessen Freitext.
- Grenzen: Resend hält Idempotency-Keys **24 Stunden**. Geht eine Antwort verloren (Timeout, Abbruch) oder scheitert
  danach das Speichern in D1, verhindert derselbe Key innerhalb von 24 Stunden eine zweite Mail. Spätere Versuche
  (ab etwa dem 8. Versuch) können in seltenen Fällen eine zweite Mail erzeugen. `status = 'sent'` heißt „von Resend
  angenommen“, nicht „im Postfach angekommen“; die Resend-ID steht im Worker-Log.

## 7. Medien

`public/media/` (nicht versioniert): `360-pixelkiez-video-1080p.mp4` (3,4 MiB), `360-pixelkiez-video-poster.jpg`,
`report-pdf-de-1x1.mp4` (3,4 MiB), `report-pdf-poster.jpg`. H.264 (High), yuv420p, ohne Ton, `moov` vor `mdat`
(Faststart) – keine weitere Kodierung nötig, alle Dateien weit unter 25 MiB.

Cloudflare dokumentiert für Pages: Range-Anfragen werden mit 200 statt 206 beantwortet; lokal (`wrangler pages dev`)
ist es ebenso. Safari/iOS (WebKit) spielt Videos dann nicht ab. Lokal geprüft: WebKit spielt dieselben Dateien mit
206 ab, mit 200 nicht. `app.js` ersetzt ein nicht ladbares Video deshalb durch sein Standbild (gleiche Größe,
gleicher Alternativtext); Chromium und Firefox spielen weiter. Für echte Wiedergabe in Safari gibt es nur Wege mit
eigener Freigabe: eine Function für `/media/*` mit 206-Antworten (zusätzliche Function-Aufrufe) oder ein anderer
Medien-Host. Vor dem Livegang auf einem echten iPhone prüfen.

## 8. Daten, Backup, Aufbewahrung

- Je Auftrag: Referenz, Google-Kennung, bestätigte E-Mail, Website, Datenschutz-Version, Zeitpunkt, Zustellstatus.
  Sessions (Hash der Cookie-ID, Ablauf nach 1 h) und pseudonymisierte Rate-Limits löscht der Cron. Keine Tokens.
- Backup: D1 Time Travel; vor jeder Schemaänderung zusätzlich `npx wrangler d1 export pxwa --remote --output pxwa-<datum>.sql`
  (enthält personenbezogene Daten: verschlüsselt ablegen, nie ins Repository).
- Aufbewahrung: Frist **offen** (D-5). Vorbereitet, aber nicht aktiv: `ORDER_RETENTION_DAYS` (Tage). Ist der Wert
  gesetzt, löscht der Cron nur Aufträge mit `status = 'completed'`, deren Eingang älter als die Frist ist, samt
  Benachrichtigung. Offene Aufträge (`received`) bleiben immer erhalten. Bezugspunkt der Frist (Eingang oder
  Erledigung) gehört zur Entscheidung D-5. Erledigt markieren nach dem Versand des Berichts:
  `npx wrangler d1 execute pxwa --remote --command "UPDATE orders SET status = 'completed' WHERE reference = 'PXA-…'"`.
- Nicht zugestellte Benachrichtigungen wöchentlich prüfen:
  `npx wrangler d1 execute pxwa --remote --command "SELECT o.reference, n.status, n.attempts, n.last_error FROM orders o JOIN notifications n ON n.order_id = o.id WHERE n.status <> 'sent'"`.

## 9. Ende-zu-Ende-Prüfung nach der Aktivierung (kontrollierte Testdaten)

```sh
B=https://360.pixelkiez.de
curl -sI "http://360.pixelkiez.de/" | head -3                                   # erwartet Weiterleitung auf https
curl -sI "$B/" | grep -iE 'strict-transport|x-frame-options|content-security|x-robots'
curl -s -D - -o /dev/null "$B/api/anfrage" | grep -iE '^HTTP|content-security|cache-control: no-store'   # 200 vom Worker
for p in vision.html DESIGN.md package.json wrangler.toml worker/wrangler.toml functions/api/x .git/HEAD; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "$B/$p"; done                    # erwartet 404, nie 200
curl -s -o /dev/null -w "%{http_code}\n" "https://<projekt>.pages.dev/api/anfrage" # erwartet 301 auf 360.pixelkiez.de
```

Im Browser mit einem Test-Google-Konto und einer eigenen Website: URL eingeben → Google → bestätigen.
Erwartet: Referenz `PXA-…`, genau eine Zeile in `orders`, `notifications.status = 'sent'`, **genau eine** Mail in
kontakt@pixelkiez.de (Absender @notify.pixelkiez.de, SPF/DKIM „pass“ im Mail-Header). Zurück + erneut senden und
dieselbe URL erneut anfragen: keine zweite Mail. Auf einem iPhone: Startseite zeigt Video oder Standbild, keine
schwarze Fläche. Danach Testdaten löschen:
`DELETE FROM notifications WHERE order_id IN (SELECT id FROM orders WHERE reference = 'PXA-…'); DELETE FROM orders WHERE reference = 'PXA-…'`.

## 10. Release und Rollback

- Code und Deployment verbinden: Worker `npx wrangler deploy --tag <sha> --message "PXK-153 <sha>"` (Version trägt
  den SHA), Pages `npx wrangler pages deploy … --commit-hash <sha>` (Abschnitt 2). Beides im Freigabe-Protokoll notieren.
- **API sofort abschalten** ohne Datenverlust: Service Binding im Pages-Projekt entfernen (bzw. `[[services]]` aus
  `wrangler.toml` nehmen) und neu deployen → `/api/*` antwortet mit 503, die Website bleibt erreichbar. Alternativ
  `MAIL_FROM` oder `BASE_URL` leeren und den Worker deployen → der Worker antwortet mit 503 (fail closed).
- **Vorheriger Worker:** `npx wrangler rollback` (Liste: `npx wrangler deployments list`). D1 bleibt unverändert.
- **Vorherige Website:** im Pages-Projekt unter „Deployments“ ein früheres Deployment „Rollback“.
- Datenbank: keine destruktiven Migrationen; nie `DROP` oder `DELETE` ohne Export (Abschnitt 8).
