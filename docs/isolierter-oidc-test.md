# Isolierter Google-OIDC-Test

Diese Anleitung ist ausschließlich für den lokalen Test. Der bestehende Webclient bleibt im Google-Testmodus; die Produktions-Weiterleitung bleibt unverändert. Zusätzlich wurde nach ausdrücklicher Freigabe `http://localhost:8787/api/auth/callback` eingetragen. Die öffentliche Produktionsanmeldung bleibt deaktiviert.

## Schutzgrenzen

- `tests/local-google-oidc.mjs` verwendet `ENV=local`, `BASE_URL=http://localhost:8787` und eine flüchtige Miniflare-D1-Datenbank. Alle vorhandenen Migrationen werden über den Test-Harness in dieser lokalen Datenbank ausgeführt. Sie hat keine Verbindung zur Produktions-D1.
- Nur der Token-Endpunkt `https://oauth2.googleapis.com/token` und der öffentliche Google-JWKS-Endpunkt `https://www.googleapis.com/oauth2/v3/certs` dürfen exakt mit der jeweils erwarteten HTTP-Methode aus dem Worker hinaus. Andere Ziele werden abgelehnt; Umleitungen der zugelassenen Anfragen werden nicht verfolgt.
- Der Mail-Endpunkt ist ein durch die Netzwerkschranke beantworteter Mock. Auch eine Anfrage an die echte Resend-Adresse wird abgewiesen. `tests/oidc-isolation.test.mjs` prüft die Schranke direkt und innerhalb von workerd.
- Der HTTP-Listener bindet ausschließlich an `127.0.0.1:8787` und akzeptiert nur den Host `localhost:8787`. Er verwendet ausschließlich Testkonfiguration und zeigt unter `/__test/status` nur lokale Zähler. Nach Prozessende ist die In-Memory-Datenbank weg.
- Der Secret-Wert wird ausschließlich über stdin entgegengenommen und als Worker-Binding im Speicher verwendet; er wird nicht in einer Datei, Betriebssystem-Umgebungsvariable, Kommandozeile oder Anwendungsausgabe abgelegt. Der Start ist gesperrt, wenn Miniflare-Config-Debugging die Konfiguration auf Platte schreiben würde. Keine Shell-Ablaufverfolgung, Bildschirmaufnahme oder Ausgabe von Token/Callback-URLs aktivieren.

## Start mit interaktivem Schlüsselbundzugriff

Die ausführende Person muss den exakten Namen des freigegebenen Eintrags kennen und die macOS-Zugriffsabfrage selbst bestätigen. Aus dem Repository-Verzeichnis:

```sh
security find-generic-password -s 'NAME-DES-FREIGEGEBENEN-EINTRAGS' -w | node tests/local-google-oidc.mjs
```

Den Platzhalter nur durch den Eintragsnamen ersetzen, nie durch den Secret-Wert. Bei verweigertem Zugriff, leerem oder nicht passendem Secret wird kein erfolgreicher Google-Test behauptet. Keine Secret-Rotation aus diesem Vorgang ableiten.

Der Schalter `-s` sucht das Dienst-Attribut eines generischen Schlüsselbundeintrags; sein sichtbarer Name kann davon abweichen. Am 09.11.2026 wurde der Eintrag `360 Pixelkiez OAuth` im Anmeldeschlüsselbund bestätigt und für den isolierten Test interaktiv verwendet.

Anschließend `http://localhost:8787/api/anfrage` im Browser öffnen und ausschließlich mit dem freigegebenen Testkonto und einer Beispieldomain testen. Der bestehende Callback erzeugt nach gültiger Zustimmung lokal einen Testauftrag und eine Mock-Benachrichtigung. Der Zähler `/__test/status` enthält keine Identitätsdaten. Den Prozess anschließend beenden.

## Ergebnis des echten lokalen Tests – 09.11.2026

Mit dem freigegebenen Google-Testkonto erfolgte ein echter Google-OIDC-Login über den vorhandenen Client und den Localhost-Callback. Die lokale Anwendung zeigte danach ihre Bestätigungsseite. Die lokale Statusabfrage ergab einen Testauftrag, einen lokalen Benachrichtigungseintrag und eine vom Mail-Mock verarbeitete Benachrichtigung. Es gab keinen echten Mailversand; das D1-Binding war ausschließlich flüchtig und lokal. Der Testserver wurde danach beendet.

Der reale Test bestätigt den erfolgreichen Loginpfad, nicht alle Fehlerfälle gegenüber Google oder eine produktive Freigabe. Negative OAuth-, Zustimmungs-, Session- und Wiederholungsfälle wurden in der bestehenden automatisierten Suite mit Mocks getestet; die vollständige Browser-Suite war auf dem lokalen System durch die Chromium-Sandbox blockiert. Es wurden keine Schlüssel, Token oder Accountdaten in diesen Bericht übernommen.

## Datenschutz-Faktencheck (Vorschlag, keine Rechtsfreigabe)

Bei Gmail-Adressen sowie bei bestätigten Google-Workspace-Adressen mit entsprechendem `hd`-Claim ist Google für die jeweilige Mailadresse autoritativ. Bei Drittanbieter-Adressen ohne solchen Nachweis kann `email_verified=true` auf eine frühere Prüfung zurückgehen, obwohl der aktuelle Zugriff auf das Postfach inzwischen gewechselt hat. [Google: Authenticate with a backend server](https://developers.google.com/identity/sign-in/web/backend-auth)

Textvorschlag zur juristischen Prüfung: „Für die Anmeldung erhalten wir von Google die Kennung Ihres Google-Kontos und die E-Mail-Adresse, die Google für das Konto als bestätigt kennzeichnet. Dies belegt nicht in jedem Fall, dass Sie aktuell Zugriff auf das zugehörige E-Mail-Postfach haben. Wir erhalten keinen Zugriff auf Ihr Postfach.“

Vor einem echten Versand ist zusätzlich eine fachliche Entscheidung nötig, wie der aktuelle Zugriff auf externe Postfächer nachgewiesen oder welches Restrisiko ausdrücklich akzeptiert wird. Dieser Text wurde nicht veröffentlicht.
