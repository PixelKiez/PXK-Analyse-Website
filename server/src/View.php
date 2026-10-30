<?php
declare(strict_types=1);

namespace Pxwa;

/* Serverseitig gerenderte Seiten des Anfrageablaufs. Nutzt das bestehende Design (assets/styles.css)
   plus assets/anfrage.css. Kein JavaScript. Alle variablen Werte laufen durch Http::h(). */
final class View
{
    public function __construct(private string $base = '', private string $privacyUrl = 'https://pixelkiez.de/datenschutz.html')
    {
    }

    public function input(string $value = '', ?string $error = null, ?string $notice = null): string
    {
        $h = Http::h(...);
        $invalid = $error !== null ? ' aria-invalid="true" aria-describedby="url-error"' : '';
        $body = '<div class="section-head"><p class="eyebrow">Kostenlose Website-Analyse</p><h1 class="h2">Welche Website sollen wir analysieren?</h1>'
            . '<p class="text">Nach der Eingabe melden Sie sich mit Google an und bestätigen die Anfrage. Pixelkiez erstellt die Analyse danach persönlich.</p></div>'
            . ($notice !== null ? '<p class="request-notice" role="status">' . $h($notice) . '</p>' : '')
            . '<form class="analyze request-form" method="post" action="' . $h($this->base) . '/anfrage.php">'
            . '<input type="hidden" name="action" value="start">'
            . '<label class="sr-only" for="url">Adresse Ihrer Website</label>'
            . '<div class="url-field"><input id="url" name="website" type="text" inputmode="url" autocomplete="url" maxlength="2048" placeholder="ihre-website.de" value="' . $h($value) . '"' . $invalid . '>'
            . '<button class="btn btn--accent" type="submit">Weiter mit Google</button></div>'
            . ($error !== null ? '<p class="form-error" id="url-error" role="alert">' . $h($error) . '</p>' : '')
            . '</form>';
        return $this->page('Website eingeben', $body);
    }

    public function confirm(string $url, string $email, string $csrf, string $idem, ?string $error = null): string
    {
        $h = Http::h(...);
        $base = $h($this->base);
        $body = '<div class="section-head"><p class="eyebrow">Letzter Schritt</p><h1 class="h2">Anfrage bestätigen.</h1>'
            . '<p class="text">Bitte prüfen Sie die Angaben. Gespeichert wird der Auftrag erst, wenn Sie unten bestätigen.</p></div>'
            . '<div class="request-grid">'
            . '<article class="card detail" aria-label="Ihre Angaben"><div class="detail-top"><span>Kostenlose Website-Analyse</span><span class="tag">0 €</span></div><dl>'
            . '<div><dt>Website</dt><dd class="mono request-break">' . $h(WebsiteUrl::display($url)) . '</dd></div>'
            . '<div><dt>E-Mail</dt><dd class="request-break">' . $h($email) . '<small class="request-meta">von Google bestätigt</small></dd></div>'
            . '<div><dt>Leistung</dt><dd>Persönliche Analyse in vier Bereichen. Bericht als PDF mit sieben Seiten per E-Mail.</dd></div>'
            . '<div><dt>Kosten</dt><dd>0 €, kein Abo, keine Folgekosten</dd></div>'
            . '</dl></article>'
            . '<div class="request-side"><h2 class="request-h">Hinweise zur Datenverarbeitung</h2><ul class="request-notes">'
            . '<li>Wir speichern Ihre Website-Adresse, Ihre von Google bestätigte E-Mail-Adresse, die Kennung Ihres Google-Kontos und den Zeitpunkt der Anfrage.</li>'
            . '<li>Zweck: Pixelkiez erstellt damit Ihre Analyse und schickt Ihnen den PDF-Bericht an diese E-Mail-Adresse.</li>'
            . '<li>Die Anmeldung läuft über Google. Wir erhalten nur Konto-Kennung und bestätigte E-Mail-Adresse, keinen Zugriff auf Ihr Postfach.</li>'
            . '<li>Pixelkiez wird intern per E-Mail über Ihre Anfrage informiert.</li>'
            . '<li>Ihre Website wird von dieser Seite nicht automatisch abgerufen oder gescannt.</li>'
            . '</ul><p class="request-small"><a class="request-link" href="' . $h($this->privacyUrl) . '">Datenschutzerklärung von Pixelkiez</a></p>'
            . '<form class="request-confirm" method="post" action="' . $base . '/anfrage.php">'
            . '<input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="' . $h($csrf) . '"><input type="hidden" name="idem" value="' . $h($idem) . '">'
            . '<label class="consent"><input type="checkbox" name="zustimmung" value="1" required' . ($error !== null ? ' aria-invalid="true" aria-describedby="confirm-error"' : '') . '>'
            . '<span>Ich möchte die kostenlose Website-Analyse für die oben genannte Website erhalten und habe die Hinweise zur Datenverarbeitung gelesen.</span></label>'
            . ($error !== null ? '<p class="form-error" id="confirm-error" role="alert">' . $h($error) . '</p>' : '')
            . '<button class="btn btn--accent" type="submit">Kostenlos anfragen</button></form>'
            . '<form class="request-logout" method="post" action="' . $base . '/anfrage.php"><input type="hidden" name="action" value="logout"><input type="hidden" name="csrf" value="' . $h($csrf) . '">'
            . '<button class="btn btn--ghost btn--sm" type="submit">Abbrechen und abmelden</button></form>'
            . '</div></div>';
        return $this->page('Anfrage bestätigen', $body);
    }

    public function accepted(string $reference, string $url, string $email, string $kind): string
    {
        $h = Http::h(...);
        if ($kind === OrderService::DUPLICATE) {
            $head = '<p class="eyebrow">Bereits angefragt</p><h1 class="h2">Diese Website ist schon angefragt.</h1>'
                . '<p class="text">Für <span class="mono request-break">' . $h(WebsiteUrl::display($url)) . '</span> liegt mit Ihrem Google-Konto bereits eine Anfrage vor. Wir haben keine zweite Anfrage angelegt.</p>';
        } else {
            $head = '<p class="eyebrow">Anfrage gespeichert</p><h1 class="h2">Ihre Anfrage liegt bei uns.</h1>'
                . '<p class="text">Pixelkiez analysiert <span class="mono request-break">' . $h(WebsiteUrl::display($url)) . '</span> persönlich und schickt Ihnen den PDF-Bericht mit sieben Seiten an <b class="request-break">' . $h($email) . '</b>. Eine feste Bearbeitungszeit sagen wir nicht zu.</p>';
        }
        $body = '<div class="section-head">' . $head
            . '<p class="request-ref">Referenz <b class="mono" id="reference">' . $h($reference) . '</b></p>'
            . '<p><a class="btn btn--ghost btn--sm" href="' . $h($this->base) . '/index.html">Zur Startseite</a></p></div>';
        return $this->page($kind === OrderService::DUPLICATE ? 'Bereits angefragt' : 'Anfrage gespeichert', $body);
    }

    public function error(string $title, string $message, string $action = 'Zur Startseite', string $href = '/index.html'): string
    {
        $h = Http::h(...);
        $body = '<div class="section-head"><p class="eyebrow">Hinweis</p><h1 class="h2">' . $h($title) . '</h1><p class="text">' . $h($message) . '</p>'
            . '<p><a class="btn btn--ghost btn--sm" href="' . $h($this->base . $href) . '">' . $h($action) . '</a></p></div>';
        return $this->page($title, $body);
    }

    private function page(string $title, string $main): string
    {
        $h = Http::h(...);
        $b = $h($this->base);
        return '<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>' . $h($title) . ' | Pixelkiez Analyse</title>
<meta name="description" content="Kostenlose Website-Analyse von Pixelkiez: Anfrage mit Google-Anmeldung.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap">
<link rel="stylesheet" href="' . $b . '/assets/styles.css">
<link rel="stylesheet" href="' . $b . '/assets/anfrage.css">
</head>
<body>
<header class="nav-wrap" id="nav">
  <nav class="nav" aria-label="Hauptnavigation">
    <a class="logo" href="' . $b . '/index.html#top">Pixelkiez<span>Analyse</span></a>
    <div class="nav-links"><a href="' . $b . '/index.html#bereiche">Bereiche</a><a href="' . $b . '/index.html#bericht">Bericht</a><a href="' . $b . '/index.html#faq">FAQ</a></div>
    <a class="btn btn--ghost btn--sm" href="' . $b . '/index.html">Start</a>
  </nav>
</header>
<main class="frame" id="top">
  <section class="section request">' . $main . '</section>
  <footer class="cw-lilac">
    <div class="footer">
      <span>© 2026 Pixelkiez · Webdesign Berlin</span>
      <nav aria-label="Rechtliches"><a href="https://pixelkiez.de/impressum.html">Impressum</a><a href="' . $h($this->privacyUrl) . '">Datenschutz</a><a href="mailto:kontakt@pixelkiez.de">Kontakt</a></nav>
    </div>
  </footer>
</main>
</body>
</html>';
    }
}
