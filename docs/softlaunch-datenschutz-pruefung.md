# Soft-Launch 360°Pixelkiez – Datenschutz-Fix und Prüfung der Rechtstexte

Stand: 03.11.2026. Branch `release/pxwa-soft-launch-privacy`, Basis `c528d96` (Produktion `c6e9a5de`).
**Kein Rechtsgutachten, keine juristische Freigabe.** Die Textvorschläge unten sind Entwürfe zur Prüfung durch eine
Rechtsanwältin oder einen Rechtsanwalt. Markierungen: **[PRÜFEN]** = Tatsache vor Veröffentlichung belegen,
**[ENTSCHEIDUNG]** = rechtliche oder geschäftliche Entscheidung des Verantwortlichen.

## 1. Schriften: technische Änderung in diesem Branch

Vorher luden alle 22 Seiten Archivo und IBM Plex Mono von Google
(`<link rel="preconnect">` zu fonts.googleapis.com und fonts.gstatic.com, Stylesheet von fonts.googleapis.com,
CSP `style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com`). Dabei ging die IP-Adresse
jedes Besuchers an Google.

Jetzt:

- `public/assets/fonts.css` mit den `@font-face`-Regeln von Google Fonts, nur lokale Pfade, `font-display: swap`
- 6 WOFF2-Dateien in `public/assets/fonts/`, bytegleich von Google Fonts übernommen (nicht verändert, nicht neu untergliedert);
  nur die Zeichensätze latin und latin-ext (alle Zeichen der Website liegen in latin; das Pfeilzeichen → hat keine der beiden
  Schriften und kam schon bisher aus der Ersatzschrift)
- Lizenzen: beide Schriften stehen unter der SIL Open Font License 1.1, die Weitergabe und Einbettung erlaubt, wenn Copyright-Vermerk
  und Lizenz beiliegen: `public/assets/fonts/OFL-Archivo.txt`, `public/assets/fonts/OFL-IBM-Plex-Mono.txt` (aus github.com/google/fonts).
  IBM Plex trägt den Reserved Font Name „Plex“. Wir verändern die Dateien nicht; sie sind die Fassung, die Google Fonts unter dem
  Namen „IBM Plex Mono“ verbreitet. Ob schon Googles Untergliederung als „Modified Version“ im Sinne der OFL gilt, ist eine
  Auslegungsfrage [PRÜFEN]; Font-Pakete wie Fontsource verfahren genauso.
- alle 22 Seiten: Google-Links entfernt, `fonts.css` vor `styles.css`, CSP `style-src 'self'; font-src 'self'`
- `styles.css` unverändert (muss dem Design-Vorbild `vision.html` entsprechen)

| Datei | Quelle (fonts.gstatic.com) | SHA-256 |
|---|---|---|
| archivo-latin.woff2 | `/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLydOxKsv4Rn.woff2` | `7150c0ec5ad356453013d11affec1fbab95de0dd2dcecb043b4f1cb7f87c4ba4` |
| archivo-latin-ext.woff2 | `/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLyTOxKsv4RnUPU.woff2` | `a999e009fdcd0f939c138e04043b3b2ad083b26252b644e8f94c083d48b77af0` |
| ibm-plex-mono-400-latin.woff2 | `/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q131nj-o.woff2` | `c36f509c0a8f9f85f29cb44bc8701d8a9e0b14c499e77a884f789ead7093a7ac` |
| ibm-plex-mono-400-latin-ext.woff2 | `/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1iEq131nj-otFQ.woff2` | `f1050dc5317b43434c0aeda599d4624c774ffc162e87a8cf204b949b6a85816d` |
| ibm-plex-mono-500-latin.woff2 | `/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgsAXHNk.woff2` | `a76f53ca6612e7b3828eec2311098675b7f9849ae4169a8bcef6302aec02a6c0` |
| ibm-plex-mono-500-latin-ext.woff2 | `/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3twJwl5FgsAXHNlYzg.woff2` | `77f03e26f981c582bdba3a7abed4baa2d3149211c01366bb3ab3ba7622ec4ae5` |

Nicht in diesem Branch (nicht Teil des statischen Artefakts, später nachziehen): `main` lädt weiterhin Google Fonts;
`worker/src/view.ts` (Seiten des Workers) und `worker/src/http.ts` (CSP des Workers) ebenso; `vision.html` (Design-Vorbild,
wird nicht ausgeliefert). Vor jedem Release von `main` muss dieselbe Umstellung dort erfolgen.

## 2. Befunde in den Rechtstexten (Stand der Produktion `c6e9a5de`)

Der statische Betrieb verarbeitet tatsächlich nur: Verbindungsdaten bei der Auslieferung durch Cloudflare Pages,
bis zum Deploy dieses Branches die Übermittlung an Google Fonts, und E-Mails, die jemand an 360@pixelkiez.de schickt.
Es gibt kein Formular, keine Anmeldung, keine Cookies, keinen lokalen Speicher, kein Tracking, keinen Worker, keine D1-Daten
und keinen Resend-Versand.

### 2.1 Datenschutzerklärung (`public/datenschutz.html`)

Platzhalter (öffentlich sichtbar):

| ID | Abschnitt | Platzhalter |
|---|---|---|
| D-P1 | Bereitstellung | „[Vertragspartner und Anschrift laut Auftragsverarbeitungsvertrag ergänzen]“ |
| D-P2 | Bereitstellung | „[Rechtsgrundlage, Speicherdauer der Verbindungsdaten bei Cloudflare und Grundlage der Übermittlung in die USA ergänzen.]“ |
| D-P3 | Schriftarten | „[Entscheiden: Schriftarten künftig selbst ausliefern oder Rechtsgrundlage und Übermittlung ergänzen.]“ |
| D-P4 | Gespeicherte Daten | „[Rechtsgrundlage ergänzen, voraussichtlich Art. 6 Abs. 1 lit. b DS-GVO.]“ |
| D-P5 | Sitzung | „[Rechtsgrundlagen ergänzen, voraussichtlich § 25 Abs. 2 Nr. 2 TDDDG und Art. 6 Abs. 1 lit. f DS-GVO.]“ |
| D-P6 | Interne Benachrichtigung | „[Anschrift, Auftragsverarbeitungsvertrag und Grundlage der Übermittlung in die USA ergänzen]“ |
| D-P7 | Bericht | „[Anbieter des Postfachs 360@pixelkiez.de ergänzen.]“ |
| D-P8 | Speicherdauer | „[Frist noch nicht festgelegt – vor dem Start ergänzen]“ |

Unzutreffend für den statischen Betrieb:

| ID | Stelle | Problem |
|---|---|---|
| D-U1 | Kopf | „… fertiggestellt, bevor 360°Pixelkiez öffentlich startet“ – die Website ist seit 03.11.2026 öffentlich. |
| D-U2 | Überblick | „Daten, die für Ihre Anfrage … nötig sind“ und „außer dem Sitzungs-Cookie für die Anfrage keine Cookies“ – es gibt weder Anfragen noch Cookies. |
| D-U3 | Bereitstellung | „Videos und Bilder kommen von dieser Website selbst“ – es gibt derzeit keine Videos. |
| D-U4 | Schriftarten | Nach dem Deploy dieses Branches falsch (Schriften kommen nicht mehr von Google). Bis dahin zutreffend, aber ohne Rechtsgrundlage. |
| D-U5 | Anmeldung mit Google, Gespeicherte Daten, Sitzung und Schutz vor Missbrauch, Interne Benachrichtigung (Resend), Bericht, Speicherdauer der Anfragedaten | Beschreiben Verarbeitungen, die derzeit nicht stattfinden. |

Fehlende Pflichtangaben für die tatsächliche Verarbeitung (Art. 13 DSGVO):

| ID | Fehlt |
|---|---|
| D-F1 | Rechtsgrundlage, Speicherdauer, Empfänger (Auftragsverarbeiter) und Drittlandgrundlage für die Verbindungsdaten bei Cloudflare (Art. 13 Abs. 1 lit. c, e, f, Abs. 2 lit. a) |
| D-F2 | Verarbeitung bei Kontakt per E-Mail an 360@pixelkiez.de: Zweck, Rechtsgrundlage, Postfachanbieter, Speicherdauer |
| D-F3 | Gesondert hervorgehobener Hinweis auf das Widerspruchsrecht nach Art. 21 DSGVO (nötig, sobald Art. 6 Abs. 1 lit. f die Grundlage ist; Art. 21 Abs. 4) |
| D-F4 | Hinweis, ob die Bereitstellung der Daten erforderlich ist, und dass keine automatisierte Entscheidung stattfindet (Art. 13 Abs. 2 lit. e, f) |
| D-F5 | Anschrift der genannten Aufsichtsbehörde (empfohlen, nicht zwingend) |

### 2.2 Impressum (`public/impressum.html`)

Vorhanden: Name, Geschäftsbezeichnung, ladungsfähige Anschrift, E-Mail, Verantwortlicher nach § 18 Abs. 2 MStV,
Erklärung zur Verbraucherstreitbeilegung. Keine Platzhalter. Keine Entwurfskennzeichnung (das Impressum ist als endgültig gemeint).

| ID | Befund |
|---|---|
| I-1 | **Zustellbarkeit von 360@pixelkiez.de ist nicht belegt.** MX von pixelkiez.de liegt bei Hostinger; der Hostinger-Zugang zeigt nur das Postfach kontakt@pixelkiez.de (geprüft 03.11.2026). Ist 360@ weder Postfach noch Weiterleitung, fehlt die nach § 5 Abs. 1 Nr. 2 DDG nötige Möglichkeit der schnellen elektronischen Kontaktaufnahme, und Betroffenenanfragen gehen ins Leere. |
| I-2 | Zweiter unmittelbarer Kommunikationsweg neben E-Mail (z. B. Telefon) fehlt. Nach EuGH C-298/07 genügt E-Mail allein nicht in jedem Fall; auf Anfrage muss ein weiterer Weg angeboten werden. [ENTSCHEIDUNG] |
| I-3 | Umsatzsteuer-Identifikationsnummer bzw. Wirtschafts-Identifikationsnummer: Pflichtangabe, **falls vorhanden** (§ 5 Abs. 1 Nr. 6 DDG). [PRÜFEN] |
| I-4 | Handelsregister: nur bei Eintragung anzugeben. [PRÜFEN] |
| I-5 | Link zur EU-OS-Plattform: nicht mehr nötig (ODR-Verordnung zum 20.07.2025 aufgehoben); korrekt, dass er fehlt. [PRÜFEN] |

### 2.3 AGB (`public/agb.html`)

Als „ENTWURF – nicht rechtlich freigegeben“ gekennzeichnet, ohne Vertragsklauseln, mit der Aussage
„Bis dahin nimmt diese Website keine Aufträge an.“ Das trifft auf den statischen Betrieb zu. Die Seite ist nur noch über ihre
Adresse erreichbar (kein Link von anderen Seiten). **Für den statischen Betrieb keine Änderung nötig.** Vor dem Start der
Anfragefunktion braucht es freigegebene AGB (bereits bekanntes Gate).

## 3. Textvorschlag: Datenschutzerklärung für den statischen Betrieb

Ersetzt den gesamten Inhalt unterhalb der Überschrift. Die Abschnitte zur Anfragefunktion (D-U5) entfallen, bis diese startet;
ihr Entwurf bleibt auf `main` erhalten. Wird erst zusammen mit oder nach dem Deploy dieses Branches veröffentlicht
(sonst wäre der Abschnitt „Schriftarten“ falsch).

> **ENTWURF – nicht rechtlich freigegeben.** Diese Datenschutzerklärung beschreibt den derzeitigen Betrieb: 360°Pixelkiez ist
> eine reine Informationswebsite und nimmt noch keine Analyse-Anfragen an. Bevor Anfragen möglich sind, ergänzen wir sie.
>
> **Verantwortlich**
> Vincent Schnetzer, Edelhofdamm 74, 13465 Berlin, Deutschland, E-Mail: 360@pixelkiez.de
>
> **Überblick**
> Auf dieser Website gibt es kein Formular, keine Anmeldung, kein Tracking und keine Analyse- oder Werbedienste. Sie setzt keine
> Cookies und nutzt keinen lokalen Speicher Ihres Browsers. Schriftarten, Bilder und Skripte kommen ausschließlich von dieser Website.
>
> **Bereitstellung der Website**
> Die Website wird über Cloudflare Pages ausgeliefert. Anbieter ist [PRÜFEN: Vertragspartner und Anschrift laut Cloudflare-Vertrag,
> voraussichtlich Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA]. Beim Aufruf jeder Seite verarbeitet Cloudflare
> technisch notwendige Verbindungsdaten: IP-Adresse, Datum und Uhrzeit, aufgerufene Adresse, übertragene Datenmenge, Browserkennung
> und gegebenenfalls die zuvor besuchte Seite. Zweck ist, die Seiten auszuliefern und die Website vor Angriffen und Missbrauch zu
> schützen. Rechtsgrundlage ist unser berechtigtes Interesse an einer sicheren und funktionsfähigen Website (Art. 6 Abs. 1 lit. f DSGVO)
> [ENTSCHEIDUNG]. Wir selbst werten diese Daten nicht aus und speichern keine Zugriffsprotokolle [PRÜFEN: keine Logpush-/Analytics-
> Funktion im Cloudflare-Konto aktiv]. Cloudflare verarbeitet die Daten in unserem Auftrag auf Grundlage eines Vertrags zur
> Auftragsverarbeitung (Art. 28 DSGVO) [PRÜFEN: Cloudflare-Datenverarbeitungsvertrag gilt für das Konto]. Dabei können Daten in die USA
> übermittelt werden. Grundlage ist [PRÜFEN/ENTSCHEIDUNG: Angemessenheitsbeschluss zum EU-US Data Privacy Framework, sofern der
> Vertragspartner zertifiziert ist; ergänzend die Standardvertragsklauseln im Datenverarbeitungsvertrag]. Cloudflare speichert
> Verbindungsdaten [PRÜFEN: Speicherdauer laut Cloudflare].
>
> **Schriftarten**
> Die Schriftarten Archivo und IBM Plex Mono liefert diese Website selbst aus. Beim Laden der Seiten besteht keine Verbindung zu
> Servern von Google oder anderen Schriftanbietern.
>
> **Kontakt per E-Mail**
> Wenn Sie an 360@pixelkiez.de schreiben, verarbeiten wir Ihre E-Mail-Adresse, gegebenenfalls Ihren Namen und den Inhalt Ihrer
> Nachricht, um Ihr Anliegen zu beantworten. Rechtsgrundlage ist unser berechtigtes Interesse an der Beantwortung von Anfragen
> (Art. 6 Abs. 1 lit. f DSGVO) oder, wenn Ihre Nachricht auf einen Vertrag zielt, Art. 6 Abs. 1 lit. b DSGVO [ENTSCHEIDUNG]. Das Postfach
> betreibt [PRÜFEN: Anbieter und Anschrift; laut DNS Hostinger, voraussichtlich Hostinger International Ltd., Zypern] in unserem Auftrag.
> Wir löschen Nachrichten, sobald Ihr Anliegen erledigt ist und keine gesetzlichen Aufbewahrungspflichten entgegenstehen
> [ENTSCHEIDUNG: konkrete Frist].
>
> **Links zu anderen Websites**
> Die Wissens- und Analysebeiträge verlinken Quellen auf anderen Websites. Erst wenn Sie einem solchen Link folgen, ruft Ihr Browser
> die andere Website auf; dort gelten deren Datenschutzbestimmungen.
>
> **Pflicht zur Bereitstellung, keine automatisierte Entscheidung**
> Die Verbindungsdaten sind technisch nötig, um die Website anzuzeigen. Eine automatisierte Entscheidungsfindung einschließlich
> Profiling findet nicht statt.
>
> **Ihre Rechte**
> Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung
> (Art. 18) und Datenübertragbarkeit (Art. 20). Schreiben Sie dazu an 360@pixelkiez.de. Sie können sich außerdem bei einer
> Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO), zum Beispiel bei der Berliner Beauftragten für Datenschutz und
> Informationsfreiheit [PRÜFEN: Anschrift ergänzen].
>
> **Widerspruchsrecht**
> Soweit wir Daten auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO verarbeiten, können Sie dieser Verarbeitung aus Gründen, die sich aus
> Ihrer besonderen Situation ergeben, jederzeit widersprechen (Art. 21 DSGVO).
>
> **Stand**
> Entwurf vom [Datum] (Version [ENTSCHEIDUNG: z. B. ENTWURF-2026-11-03-STATISCH]).

## 4. Textvorschläge: Impressum

Nur Ergänzungen, je nach Entscheidung; der übrige Text bleibt.

> **Kontakt**
> E-Mail: 360@pixelkiez.de
> Telefon: [ENTSCHEIDUNG: Nummer angeben oder weglassen, siehe I-2]
>
> **Umsatzsteuer-Identifikationsnummer** gemäß § 27a Umsatzsteuergesetz: [nur falls vorhanden, siehe I-3]

## 5. Offene rechtliche Entscheidungen

1. Freigabe eines Datenschutztextes für den statischen Betrieb (Vorschlag Abschnitt 3) – oder ein anderer Text; inklusive
   Rechtsgrundlagen (Art. 6 Abs. 1 lit. f für Hosting und E-Mail), Speicherfrist für E-Mails und Versionskennung.
2. Ob die Abschnitte zur Anfragefunktion bis zu deren Start aus der veröffentlichten Erklärung entfallen (Vorschlag) oder als
   „künftig“ markiert stehen bleiben.
3. Ob für den Zeitraum mit Google Fonts (Produktion seit 03.11.2026, etwa 17:00 UTC, bis zum Deploy dieses Branches) etwas zu
   veranlassen ist.
4. Impressum: zweiter Kommunikationsweg (I-2), USt-IdNr./W-IdNr. (I-3), Handelsregister (I-4).
5. Ob das Impressum, wie bisher, ohne Entwurfskennzeichnung veröffentlicht bleibt.

## 6. Konkrete Blocker für die Launchfreigabe

| ID | Blocker | Wer |
|---|---|---|
| B-1 | Datenschutzerklärung öffentlich mit 8 Platzhaltern, unzutreffenden Aussagen und fehlenden Pflichtangaben (2.1) | Mensch + Rechtsberatung |
| B-2 | Google Fonts in Produktion bis zum Deploy dieses Branches | Deploy-Freigabe des Menschen |
| B-3 | Vorschau `c76ddf3a` (vorschau.pxwa.pages.dev, Stand d7f8d86) ist öffentlich: lädt Google Fonts, zeigt das alte Formular und die veralteten Videos | Entscheidung des Menschen (Löschen ist nicht umkehrbar) |
| B-4 | Zustellbarkeit 360@pixelkiez.de unbelegt (I-1) | Mensch (Hostinger) |
| B-5 | Impressum: offene Angaben I-2 bis I-4 | Mensch + Rechtsberatung |
| B-6 | Vor einem Release von `main`: Google Fonts in `public/`, `worker/src/view.ts`, `worker/src/http.ts` ersetzen; AGB und vollständige Datenschutzerklärung für die Anfragefunktion | späterer Slice |

noindex bleibt; aus diesem Branch folgt keine SEO-Freigabe.
