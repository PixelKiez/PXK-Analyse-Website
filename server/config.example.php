<?php
/* PXWA – Vorlage für server/config.php.
   Kopieren nach server/config.php (liegt außerhalb von public_html, ist per .gitignore ausgeschlossen)
   und auf dem Server mit Dateirechten 0600 ablegen. Echte Zugangsdaten NIE in Git eintragen. */
return [
    'env' => 'production',                       // 'production' | 'local' (nur lokale Tests)

    // Öffentliche Adresse der Website ohne abschließenden Schrägstrich. In Produktion nur https://.
    'base_url' => 'https://DOMAIN-FEHLT.example',

    // Google OAuth-Client (Typ "Webanwendung") aus der Google Cloud Console.
    // Autorisierte Weiterleitungs-URI: <base_url>/auth/callback.php
    'google' => [
        'client_id' => '',
        'client_secret' => '',
    ],

    // Datenbank. Hostinger: MySQL/MariaDB aus hPanel, alternativ SQLite-Datei außerhalb von public_html.
    'db' => [
        'dsn' => 'mysql:host=localhost;dbname=DATENBANK;charset=utf8mb4',
        'user' => '',
        'pass' => '',
    ],

    // Interne Benachrichtigung per SMTP (Hostinger E-Mail: smtp.hostinger.com, Port 465, SSL).
    'mail' => [
        'host' => 'smtp.hostinger.com',
        'port' => 465,
        'encryption' => 'ssl',                   // 'ssl' (implizites TLS) | 'starttls'
        'username' => '',
        'password' => '',
        'from' => '',                            // Absenderadresse des SMTP-Kontos
        'from_name' => 'Pixelkiez Analyse',
        'notify_to' => 'kontakt@pixelkiez.de',
        'timeout' => 15,
    ],

    // Verzeichnis außerhalb von public_html für Schlüssel-Cache (Google-Zertifikate). Muss beschreibbar sein.
    'data_dir' => '/home/BENUTZER/domains/DOMAIN/var',

    // Eigenes Session-Verzeichnis außerhalb von public_html (Sessions enthalten E-Mail-Adresse und Google-Kennung).
    // Muss existieren und beschreibbar sein; weglassen = PHP-Standardpfad des Hosters.
    'session_dir' => '/home/BENUTZER/domains/DOMAIN/var/sessions',

    // Zufallswert mit mindestens 32 Zeichen, z. B. `php -r 'echo bin2hex(random_bytes(32));'`.
    // Dient nur zum Pseudonymisieren von IP-Adressen im Rate-Limiting.
    'secret' => '',

    // Datenschutzhinweise, die auf der Bestätigungsseite verlinkt werden. Version wird je Auftrag gespeichert.
    'privacy' => [
        'url' => 'https://pixelkiez.de/datenschutz.html',
        'version' => 'ENTWURF-2026-10-30',
    ],
];
