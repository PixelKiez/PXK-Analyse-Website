# 360°Pixelkiez – Deploy: Cloudflare Pages, privater Worker mit D1, Resend

Gilt für die kostenlose Website-Analyse mit Google-Anmeldung (PXK-153). Ein Deployment braucht eine eigene, aktuelle
menschliche Freigabe für **genau einen Commit-SHA**. Dieses Dokument nennt nur Schlüsselnamen, nie Werte.
Stand 01.11.2026 (Abschnitt 1 des Launches, je Punkt menschlich freigegeben): Pages-Projekt und D1 sind angelegt,
eine Vorschau läuft. Noch **nicht** eingerichtet: Worker `pxwa-api`, D1-Schema, Custom Domain, DNS-Eintrag,
Google-Client, Resend-Domain, Secrets, Produktions-Deployment.

| Ressource | Name | ID / Adresse | Stand |
|---|---|---|---|
| Cloudflare-Konto | (2FA aktiv) | `4e86c3d78cdde255eb5d084f24162271` | geprüft 01.11.2026 |
| D1 | `pxwa` | `3a5e6c3c-89f4-4b13-83ee-b70e151dc9b0` | Jurisdiktion `eu`, Region EEUR, 0 Tabellen |
| Pages-Projekt | `pxwa` | `b132db8f-1695-4a95-9948-c5d749a46066`, `pxwa.pages.dev` | Direct Upload, Production-Branch `main`, keine Custom Domain |
| Vorschau | Branch `vorschau` | `c76ddf3a-aed8-4f0d-bda4-fff0504b1e6a`, `https://vorschau.pxwa.pages.dev` | aus `d7f8d86`, `noindex`, `/api/*` 503, öffentlich erreichbar |
| Worker | `pxwa-api` | – | nicht angelegt |

```
Browser ──HTTPS──► 360.pixelkiez.de  (CNAME bei Hostinger → <projekt>.pages.dev)
                     │
                     ▼
                Cloudflare Pages „pxwa“ ── /, *.html, /assets/*, Poster ──► statische Dateien aus public/
                     │
                     ├─ drei Videos (public/_routes.json) ──► Pages Function functions/media/[file].ts (Byte-Ranges, 206)
                     │                                          └─ liest nur fünf feste Schlüssel aus R2 „360pixelkiez“ (Binding MEDIA)
                     └─ /api/* (public/_routes.json) ──► Pages Function functions/api/[[path]].ts
                                                            │ Service Binding „API“ (intern, keine öffentliche Adresse)
                                                            ▼
                                                        Worker „pxwa-api“ ──► D1 „pxwa“ (EU-Jurisdiktion)
                                                            ├─► Google OIDC (Token, JWKS)
                                                            ├─► Resend API (nur an 360@pixelkiez.de)
                                                            └─ Cron alle 5 Minuten (Wiederholungen, Aufräumen)
```

## 0. Offene Release-Gates (ohne sie kein Livegang)

- [ ] Cloudflare-Konto mit 2FA; Pages-Projekt und Worker angelegt (Abschnitte 2–3)
- [ ] D1 mit EU-Jurisdiktion angelegt, Schema angewandt (Abschnitt 3)
- [ ] CNAME `360` bei Hostinger auf den von Cloudflare genannten `*.pages.dev`-Namen (Abschnitt 4)
- [ ] Google-OAuth-Client (Webanwendung) mit exakt `https://360.pixelkiez.de/api/auth/callback` (Abschnitt 5)
- [ ] Resend: Domain `notify.pixelkiez.de` verifiziert, API-Key als Secret, `MAIL_FROM` gesetzt (Abschnitt 6)
- [ ] Postfach `360@pixelkiez.de` eingerichtet und Zustellung nachgewiesen (Abschnitt 6); vorher keinen Worker mit
      gesetztem `MAIL_FROM` deployen und keine echte Benachrichtigung auslösen
- [ ] Datenschutzerklärung fertig und rechtlich geprüft; danach `PRIVACY_VERSION` ohne „ENTWURF“ setzen.
      Solange `PRIVACY_VERSION` mit „ENTWURF“ beginnt, nimmt der Worker in Produktion **keine** Aufträge an (503).
- [ ] Aufbewahrungsfrist für Auftragsdaten entschieden (D-5, Abschnitt 8)
- [ ] Auftragsverarbeitungsverträge (Cloudflare, Resend) und Übermittlungsgrundlagen geprüft
- [ ] Videos auf einem echten iPhone/Safari prüfen: Die Video-Function (R2) beantwortet Range-Anfragen mit 206; lokal
      (WebKit, `wrangler pages dev` mit lokalem R2) laufen die eingebundenen Videos. Auf echtem Cloudflare mit R2 und
      auf einem echten iPhone noch offen (Abschnitt 7).
- [ ] Echte Ende-zu-Ende-Prüfung nach der Aktivierung (Abschnitt 9)
- [ ] `noindex` bleibt gesetzt, bis eine eigene Launch-Freigabe es aufhebt

## 1. Werkzeuge und Prüfung vor jedem Deploy

Node ≥ 22. Auf einem sauberen Checkout des freigegebenen Commits: `npm ci`, `npm run typecheck`, `npm test`
(statisch, Worker in workerd mit lokaler D1, Pages Functions und lokales Pages per `wrangler pages dev`) und
`npm run test:release` (klont das Repository frisch und prüft den Commit: Medien vorhanden und bytegleich, alle
referenzierten Dateien da, keine PHP-/Railway-Reste, keine Schlüssel – lokale oder ignorierte Dateien zählen nicht).
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

**Empfohlen: kontrollierter Direct Upload aus einem frischen Git-Checkout** statt GitHub-Integration. Alles, was
ausgeliefert wird, ist versioniert (auch die drei Poster in `public/media/`; die Videos liegen in R2, Abschnitt 7); der Upload entsteht deshalb aus genau
dem freigegebenen Commit, nie aus einem Arbeitsverzeichnis mit lokalen Dateien. Die GitHub-Integration bleibt
unverbunden, weil sie bei jedem Push automatisch deployt (auch Feature-Branches als Vorschau).

1. Projekt einmalig anlegen (Production-Branch `main`): `npx wrangler pages project create pxwa --production-branch main`.
   Cloudflare vergibt `pxwa.pages.dev` oder bei belegtem Namen eine Variante – den **tatsächlich angezeigten** Namen notieren.
2. Frischen Checkout des freigegebenen Commits anlegen und prüfen:
   `git clone https://github.com/PixelKiez/PXK-Analyse-Website.git pxwa-<sha> && cd pxwa-<sha> && git checkout --detach <sha>`,
   dann `npm ci`, `npm run typecheck`, `npm test`, `npm run test:release`; `git status --porcelain` muss leer sein.
3. Deploy aus genau diesem Checkout:
   `npx wrangler pages deploy --branch main --commit-hash <sha> --commit-message "PXK-153 <sha>"`
   (liest `wrangler.toml`: Ausgabeverzeichnis `./public`, kompiliert `functions/`, nimmt `_routes.json` und `_headers` mit).
   `--branch` mit anderem Namen erzeugt ein Vorschau-Deployment.
4. Vorschau und Produktion: Die Produktion hat das Service Binding `API` → `pxwa-api`. Vorschau-Deployments
   (`[env.preview]`, `services = []`) haben **kein** Binding: `/api/*` antwortet dort mit 503, Vorschau-Code erreicht
   weder den Worker noch die D1-Daten. `*.pages.dev` sendet `X-Robots-Tag: noindex` (`public/_headers`).
5. Falls später doch die GitHub-Integration gewünscht ist: Build-Befehl leer, Ausgabeverzeichnis `public`,
   Root-Verzeichnis `/`, automatische Vorschau-Deployments abschalten. Erst mit eigener Freigabe verbinden.

Was Pages ausliefert: Dateien aus `public/` (ohne `_headers`, `_routes.json`, `.DS_Store`). Functions laufen nur für
`/api/*` und die drei Videos aus R2 (`public/_routes.json`); alle anderen Anfragen, auch die Poster, sind statisch und
verbrauchen kein Function-Kontingent. `*.html` leitet Pages mit 308
auf die Adresse ohne Endung um; unbekannte Adressen bekommen `404.html` mit Status 404 (ohne diese Datei würde Pages
jede unbekannte Adresse mit der Startseite beantworten).

## 3. Privater Worker `pxwa-api` und D1 (alle Befehle in `worker/`)

1. Worker **vor** dem Pages-Projekt deployen, sonst zeigt das Binding ins Leere.
2. D1 mit EU-Jurisdiktion: `npx wrangler d1 create pxwa --jurisdiction eu` → `database_id` in `wrangler.toml` eintragen.
3. Schema: `npx wrangler d1 migrations apply pxwa --remote` (Migrationen nur additiv).
4. `[vars]` (keine Secrets): `BASE_URL = "https://360.pixelkiez.de"` (fest; andere Werte sperren die API),
   `GOOGLE_CLIENT_ID`, `PRIVACY_VERSION`, `MAIL_API_URL = "https://api.resend.com/emails"`,
   `MAIL_FROM` (Adresse @notify.pixelkiez.de, erst nach Domain-Verifizierung), `MAIL_NOTIFY_TO = "360@pixelkiez.de"`.
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
  `Idempotency-Key: pxwa-<Referenz>`, JSON `{ from, to: ["360@pixelkiez.de"], reply_to, subject, text }`.
  Kein HTML, kein Anhang, keine Mail an Kundinnen und Kunden.
- Empfänger: In Produktion muss `MAIL_NOTIFY_TO` `360@pixelkiez.de` sein (Groß-/Kleinschreibung egal, nur ASCII);
  versendet wird immer an genau diese Adresse. Jeder andere Wert – auch die frühere `kontakt@pixelkiez.de`, zwei
  Adressen oder Unicode-Doppelgänger – sperrt die API (503) und den Cron-Versand. Es gibt keinen Rückfall auf eine
  andere Adresse. Absender (`MAIL_FROM`, Versanddomain `notify.pixelkiez.de`) und Empfänger (Postfach unter
  `pixelkiez.de`) sind getrennt.
- Vorbedingung für die Aktivierung: Das Postfach `360@pixelkiez.de` existiert beim Mail-Anbieter von `pixelkiez.de`, und
  eine von Hand gesendete Testmail ist dort nachweislich angekommen (Absender, Zeitpunkt, Message-ID notieren). Erst
  danach `MAIL_FROM` setzen und den Worker deployen; bis dahin bleibt `MAIL_FROM` leer und der Worker antwortet mit 503.
  Den Nachweis über die Website-Kette erbringt die Ende-zu-Ende-Prüfung (Abschnitt 9).
- Zuverlässigkeit: Auftrag und Benachrichtigung entstehen in einem D1-Batch (Outbox). Fällt Resend aus, bleibt der
  Auftrag angenommen; ein Mailfehler löscht nie einen Auftrag. **Vorübergehende** Fehler (Verbindung, Zeitüberschreitung,
  408/429/5xx, 409 `concurrent_idempotent_requests`) werden wiederholt: 5 min, 15 min, 45 min … höchstens 12 h, nach
  10 Versuchen `failed`. **Dauerhafte** Fehler (z. B. 401 ungültiger API-Key, 403 Domain nicht verifiziert, 422
  Validierung, 409 `invalid_idempotent_request`) werden **nicht** automatisch wiederholt: sofort `status = 'failed'`,
  `last_error = 'permanent:<Status>:<Fehlername>'`, Log „dauerhaft abgelehnt … Konfiguration prüfen“. Nach der
  Korrektur manuell neu einreihen (Abschnitt 8). Gespeichert wird nur der feste Fehlername von Resend, nie dessen Freitext.
- Grenzen: Resend hält Idempotency-Keys **24 Stunden**. Geht eine Antwort verloren (Timeout, Abbruch) oder scheitert
  danach das Speichern in D1, verhindert derselbe Key innerhalb von 24 Stunden eine zweite Mail. Spätere Versuche
  (ab etwa dem 8. Versuch) können in seltenen Fällen eine zweite Mail erzeugen. `status = 'sent'` heißt „von Resend
  angenommen“, nicht „im Postfach angekommen“; die Resend-ID steht im Worker-Log.

## 7. Medien

Die Videos liegen im privaten R2-Bucket `360pixelkiez` (kein öffentlicher Zugriff, keine `r2.dev`-Adresse, keine
Custom Domain; am 03.11.2026 per API gelesen). Pages liest sie über das Binding `MEDIA`, das in den Projekteinstellungen
von Pages hinterlegt ist und in `wrangler.toml` dokumentiert steht. In den Projekteinstellungen hat derzeit auch die
Vorschau `MEDIA` (R2-Bindings erlauben Lesen und Schreiben); `wrangler.toml` sieht für die Vorschau kein Binding vor.
Ob die Vorschau den Bucket behalten soll, ist eine offene Entscheidung. Im Bucket (Stand 03.11.2026,
per API gelesen, Größe und SHA-256 in `tests/pages.test.mjs`; Stand 04.11.2026): `360-pixelkiez-video-1080p-website-look.mp4`
(8,6 MiB, 1920 × 1080, 60 Bilder/s, 48 s; vom Auftraggeber am 04.11.2026 hochgeladen, ersetzt `360-pixelkiez-video-1080p.mp4`),
`report-pdf-de-1x1-lavendel.mp4` (3,4 MiB), `section-bericht-peach-5x4.mp4` (1,2 MiB); H.264 (High), yuv420p, ohne Ton,
`moov` vor `mdat` (Faststart), ohne eingebettete Copyright-Metadaten.

Eingebunden sind seit PXK-159 (Entscheidung des Auftraggebers 03.11.2026) das Berichtsvideo (Lavendel) bei
„Ein PDF. Sieben Seiten.“ und das Befund-Video (Peach) bei „Jeder Befund verständlich erklärt.“, seit dem P0-Hotfix außerdem
das Hero-Video direkt unter dem Hero (vor den Partner-Logos, 16:9). Unter den Videos stehen keine Bildunterschriften und keine
Kennzeichnung als alte Fassung (Entscheidung des Auftraggebers 04.11.2026); dass alle gezeigten Werte Beispieldaten sind, steht im
Alternativtext und in den Metadaten der Poster. Das Hero-Video nennt noch „vier Metriken“, simuliert eine laufende Analyse, zeigt
„Jetzt analysieren“ und im Abspann kontakt@pixelkiez.de. Video-Metadaten: `VideoObject` (JSON-LD) je Video auf der Startseite
(Name, Beschreibung gleich Alternativtext, Poster, Video-Adresse unter /media/, Dauer, Maße, Upload-Datum aus R2, Herausgeber).
Auch das Berichtsvideo zeigt noch „Die 4 wichtigsten Metriken“
und „Jetzt analysieren“; so freigegeben. Versioniert in `public/media/` sind nur die drei Poster
(`360-pixelkiez-website-analyse-poster.jpg` – Titelbild bei 3,2 s aus dem R2-Objekt –,
`report-pdf-lavendel-poster.jpg`, `section-bericht-peach-poster.jpg`, mit XMP-Metadaten, SHA-256 in
`tests/release.test.mjs`). Die Titelbilder für soziale Netzwerke liegen unter `public/assets/og/` (1200×630).

Hintergrundbild „Für alle, die eine Website verantworten.“ (Entscheidung des Auftraggebers 04.11.2026): Der Auftraggeber hat
`pictures/Sonnige Designrunde am Tisch.png` (1672×941, 2,6 MB) in den Bucket geladen; laut eingebetteten Content Credentials
(C2PA) mit ChatGPT (gpt-image) erzeugt. Ausgeliefert wird nur die WebP-Fassung `pictures/360-pixelkiez-designrunde-am-tisch.webp`
(q78, 169 KiB, neues Objekt; das Original bleibt unverändert und ist über die Website nicht erreichbar) unter
`/media/360-pixelkiez-designrunde-am-tisch.webp`. XMP: Titel, Beschreibung, Urheber/Credit 360°Pixelkiez, Erstellungswerkzeug und
die KI-Herkunft als IPTC `DigitalSourceType` (trainedAlgorithmicMedia), kein Copyright-Vermerk (rein KI-erzeugt). Auf der Seite
dekorativ (`alt=""`, lazy) mit `ImageObject` im JSON-LD (`digitalSourceType`: TrainedAlgorithmicMediaDigitalSource). Kein
sichtbarer KI-Hinweis (Entscheidung des Auftraggebers); ob Art. 50 KI-VO einen verlangt, gehört zur anwaltlichen Prüfung.

Logo (Entscheidung des Auftraggebers 04.11.2026): „360°“ als Text, daneben das Pixelkiez-Logo, oben und im Footer aller
22 Seiten (und der Worker-Seiten). Quelle `pictures/PK_TRS_logo.png` (2172×724, 232 KiB, laut C2PA mit ChatGPT erzeugt);
ausgeliefert wird die zugeschnittene, verlustfreie WebP-Fassung `pictures/pixelkiez-logo.webp` (518×120, 14 KiB, XMP mit
Urheber/Credit Pixelkiez und KI-Herkunft, kein Copyright-Vermerk) unter `/media/pixelkiez-logo.webp`, `alt="Pixelkiez"`.
Jeder Seitenaufruf fragt das Logo über die Function an (meist 304 dank ETag) – bei 100 000 Function-Anfragen am Tag im
kostenlosen Plan für den Soft-Launch unkritisch.

Pages beantwortet Range-Anfragen statischer Dateien mit 200 statt 206; Safari/iOS spielt Videos dann nicht ab. Die Pages
Function `functions/media/[file].ts` (`public/_routes.json` nennt genau die fünf Pfade) liest nur fünf feste Schlüssel aus
`MEDIA` (`head` und `get`, nie `list`, `put` oder `delete`) und antwortet mit 200 (ohne Range), 206 mit
`Content-Range`/`Content-Length`/`Accept-Ranges` (gültiger Bereich), 416 (ungültiger oder nicht erfüllbarer Bereich),
304 (`If-None-Match`), 404 (Objekt fehlt im Bucket), 405 (andere Methoden als GET/HEAD) und 503 (kein Binding,
R2-Fehler). `Content-Type` ist fest nach Dateiendung (`video/mp4`, `image/webp`), unabhängig von den Metadaten im Bucket. Andere Pfade unter `/media/`
(Poster, unbekannte Dateien) bleiben statisch. Die Sicherheits-Header setzt die Function selbst (`_headers` gilt nicht für
Functions; ein Test vergleicht beide), dazu `Cross-Origin-Resource-Policy: same-origin` und `X-Robots-Tag: noindex`.
Lokal geprüft (`wrangler pages dev` mit lokalem R2, Playwright): Chromium und WebKit spielen alle drei eingebundenen Videos mit 206.

Wiedergabe (Entscheidungen des Auftraggebers 04.11.2026: niemals Play-/Pause-Schaltflächen, keine Bedienelemente): `<video muted
loop playsinline preload="metadata">`, bewusst ohne `autoplay` und ohne `controls`. Grund: Für `autoplay`-Videos, die nicht laufen
dürfen, blendet WebKit im Stromsparmodus (iOS, macOS) eigene Play-/Pause-Bedienelemente ein (lokal mit Playwright-WebKit auf macOS im
Stromsparmodus beobachtet); ohne `autoplay` tut es das nicht. Gestartet wird nur per Skript: `app.js` sichert stumm/inline/Schleife ab,
startet ein Video, sobald es zu mindestens 20 % im Bild ist (WebKit mobil lehnt `play()` für ein Video am Bildschirmrand ab), hält es
erst ganz außerhalb an und versucht es nach Tabwechsel (`visibilitychange`), Zurück-Navigation (`pageshow`) und wiederkehrendem Netz
(`online`) erneut. Der Zustand steht zur Diagnose in `data-wiedergabe` (läuft, angehalten, `abgelehnt: <Grund>`, Ladefehler,
Bewegung reduziert). Browser-Regeln werden nicht umgangen: Lehnt der Browser ab (iOS-Stromsparmodus, Autoplay-Sperre) oder ist
„Bewegung reduzieren“ eingestellt, bleibt das Standbild – ohne Bedienelemente. Ersatz durch animierte Bilder (WebP, 640 px,
12 Bilder/s: 1,1 / 3,1 / 1,7 MB) wurde geprüft und nicht eingebaut: sichtbar unschärfer (kleine Schrift), ruckeliger, Verhalten im
iOS-Stromsparmodus unbelegt.

Kosten und Grenzen (Free-Plan): Jede Video-Anfrage ist ein Function-Aufruf (Workers-Kontingent, 100 000 Anfragen pro
Tag; Safari stellt je Video etwa zwei Anfragen) und zwei R2-Lesevorgänge (`head`, `get`). Ist das Kontingent erschöpft
oder R2 gestört, bleibt das Standbild (Poster) ohne Schaltfläche stehen (nie eine schwarze Fläche); kommt das Netz zurück oder
wird das Video wieder sichtbar, startet es von selbst. Nach dem Deploy
prüfen: `curl -s -D - -o /dev/null -H 'Range: bytes=0-1' https://360.pixelkiez.de/media/report-pdf-de-1x1-lavendel.mp4`
(erwartet 206, `Content-Range: bytes 0-1/3519956`), dieselbe Anfrage mit `-X POST` (405) und mit `bytes=9999999-` (416),
im Workers-Log die CPU-Zeit der Function, und auf einem echten iPhone (auch im Stromsparmodus) und Android-Gerät alle drei
eingebundenen Videos.

## 8. Daten, Backup, Aufbewahrung

- Je Auftrag: Referenz, Google-Kennung, bestätigte E-Mail, Website, Datenschutz- und AGB-Version, Zeitpunkte, Unternehmer-Bestätigung,
  Werbeeinwilligung (ja/nein), Wortlaut der bestätigten Kästchen (Migration 0003), Bearbeitungs- und Zustellstatus. Werbeeinwilligungen
  zusätzlich in `marketing_consents` (ohne Website-Adresse; bis zum Widerruf, dann `revoked_at` setzen – Sperrliste).
  Sessions (Hash der Cookie-ID, Ablauf nach 1 h) und pseudonymisierte Rate-Limits löscht der Cron. Keine Tokens.
- Backup: D1 Time Travel; vor jeder Schemaänderung zusätzlich `npx wrangler d1 export pxwa --remote --output pxwa-<datum>.sql`
  (enthält personenbezogene Daten: verschlüsselt ablegen, nie ins Repository).
- Aufbewahrung (Entscheidung des Auftraggebers 04.11.2026): `ORDER_RETENTION_DAYS = "120"` – der Cron löscht jeden Auftrag samt
  Benachrichtigung vier Monate nach Eingang, unabhängig vom Status (Datenschutzerklärung Abschnitte 8 und 16). Bericht und Mails
  dazu im Postfach 360@pixelkiez.de nach derselben Frist löschen, soweit keine Aufbewahrungspflicht besteht. Werbeeinwilligungen
  bleiben bis zum Widerruf; Widerruf eintragen:
  `npx wrangler d1 execute pxwa --remote --command "UPDATE marketing_consents SET revoked_at = datetime('now') WHERE email = '…' AND revoked_at IS NULL"`.
- Betriebsprotokoll: Workers Logs ohne Aufrufprotokolle (`[observability.logs] invocation_logs = false`), nur eigene Meldungen
  ohne IP-, E-Mail- und Website-Adressen; Aufbewahrung bei Cloudflare 3 Tage (Free) bzw. 7 Tage (Paid).
- Nicht zugestellte Benachrichtigungen wöchentlich prüfen:
  `npx wrangler d1 execute pxwa --remote --command "SELECT o.reference, n.status, n.attempts, n.last_error FROM orders o JOIN notifications n ON n.order_id = o.id WHERE n.status <> 'sent'"`.
- Nach Korrektur eines dauerhaften Fehlers (Abschnitt 6) erneut einreihen; der nächste Cron-Lauf versendet einmal:
  `npx wrangler d1 execute pxwa --remote --command "UPDATE notifications SET status = 'pending', next_attempt_at = '2000-01-01 00:00:00' WHERE status = 'failed' AND last_error LIKE 'permanent:%'"`.

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
360@pixelkiez.de (Absender @notify.pixelkiez.de, SPF/DKIM „pass“ im Mail-Header). Zurück + erneut senden und
dieselbe URL erneut anfragen: keine zweite Mail. Auf einem iPhone: alle drei Videos laufen von selbst, stumm und
inline (im Stromsparmodus: Standbild bzw. die Systemsteuerung von iOS, siehe Abschnitt 7). Danach Testdaten löschen:
`DELETE FROM notifications WHERE order_id IN (SELECT id FROM orders WHERE reference = 'PXA-…'); DELETE FROM orders WHERE reference = 'PXA-…'`.

## 10. Release und Rollback

- Code und Deployment verbinden: Worker `npx wrangler deploy --tag <sha> --message "PXK-153 <sha>"` (Version trägt
  den SHA), Pages `npx wrangler pages deploy … --commit-hash <sha>` (Abschnitt 2). Beides im Freigabe-Protokoll notieren.
- **API sofort abschalten** ohne Datenverlust: Service Binding im Pages-Projekt entfernen (bzw. `[[services]]` aus
  `wrangler.toml` nehmen) und neu deployen → `/api/*` antwortet mit 503, die Website bleibt erreichbar. Alternativ
  `MAIL_FROM` oder `BASE_URL` leeren und den Worker deployen → der Worker antwortet mit 503 (fail closed).
- **Vorheriger Worker:** `npx wrangler rollback` (Liste: `npx wrangler deployments list`). D1 bleibt unverändert.
- **Vorherige Website:** im Pages-Projekt unter „Deployments“ ein früheres Deployment „Rollback“ (oder per API
  `POST /accounts/<konto>/pages/projects/pxwa/deployments/<deployment-id>/rollback`). Für den Soft-Launch ist das
  Rückfallziel das Produktions-Deployment `c6e9a5de-6a9f-404c-9de1-3513e5f3e86c` (Stand `c528d96`): ohne Videos,
  Functions nur für `/api/*` (503). Danach per `curl` prüfen, dass `/media/…mp4` wieder 404 liefert.
- Datenbank: keine destruktiven Migrationen; nie `DROP` oder `DELETE` ohne Export (Abschnitt 8).
