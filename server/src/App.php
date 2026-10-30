<?php
declare(strict_types=1);

namespace Pxwa;

/* Ablauf: URL eingeben (start) → Google-Anmeldung (callback) → bestätigen (confirm) → angenommen.
   Zustand liegt ausschließlich in der serverseitigen Session; Tokens werden nie gespeichert. */
final class App
{
    private ?Database $db = null;

    private function __construct(private Config $config, private View $view)
    {
    }

    public static function run(string $endpoint): void
    {
        try {
            $config = \pxwa_config();
        } catch (ConfigError $e) {
            error_log('PXWA: ' . $e->getMessage());
            self::respond(503, (new View())->error('Gerade nicht verfügbar', 'Anfragen sind im Moment nicht möglich. Bitte versuchen Sie es später erneut.'));
            return;
        }
        $base = rtrim((string) parse_url($config->baseUrl(), PHP_URL_PATH), '/');
        $app = new self($config, new View($base));
        Http::securityHeaders($config);
        /* Session-Cookie (__Host-) und Origin gelten nur für den Host der Basis-URL. Auf Alias-Hosts nicht starten.
           Ziel ist immer ein fester Pfad, nie der eingehende Host oder Pfad. */
        if (strtolower(preg_replace('/:(443|80)$/', '', (string) ($_SERVER['HTTP_HOST'] ?? ''))) !== preg_replace('/:(443|80)$/', '', $config->host())) {
            if (in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD'], true)) {
                header('Location: ' . $config->baseUrl() . '/anfrage.php', true, 301);
                return;
            }
            self::respond(403, $app->view->error('Anfrage abgelehnt', 'Bitte starten Sie die Anfrage direkt auf dieser Website.'));
            return;
        }
        try {
            $endpoint === 'callback' ? $app->callback() : $app->request();
        } catch (StorageError | \PDOException $e) {
            error_log('PXWA: ' . ($e instanceof StorageError ? $e->getMessage() : 'Datenbankfehler (SQLSTATE ' . $e->getCode() . ')'));
            self::respond(503, $app->view->error('Gerade nicht verfügbar', 'Ihre Anfrage konnte nicht verarbeitet werden. Bitte versuchen Sie es später erneut.'));
        } catch (\Throwable $e) {
            /* Nur Klasse und Ort loggen – Nachrichten können Eingaben enthalten */
            error_log('PXWA: Unerwarteter Fehler ' . get_class($e) . ' in ' . basename($e->getFile()) . ':' . $e->getLine());
            self::respond(500, $app->view->error('Fehler', 'Etwas ist schiefgelaufen. Bitte versuchen Sie es später erneut.'));
        }
    }

    /* anfrage.php */
    private function request(): void
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (!in_array($method, ['GET', 'POST'], true)) {
            header('Allow: GET, POST');
            self::respond(405, $this->view->error('Nicht erlaubt', 'Diese Aktion ist nicht möglich.'));
            return;
        }
        if ($method === 'POST' && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) {
            self::respond(413, $this->view->error('Anfrage zu groß', 'Bitte geben Sie nur die Adresse Ihrer Website ein.'));
            return;
        }
        if ($method === 'POST' && !Http::sameOrigin($this->config)) {
            self::respond(403, $this->view->error('Anfrage abgelehnt', 'Bitte starten Sie die Anfrage direkt auf dieser Website.'));
            return;
        }
        Http::startSession($this->config);
        if ($method === 'GET') {
            $this->show();
            return;
        }
        match ($_POST['action'] ?? 'start') {
            'confirm' => $this->confirm(),
            'logout' => $this->logout(),
            default => $this->start(),
        };
    }

    private function show(?string $error = null, int $status = 200): void
    {
        $identity = $this->identity();
        $pending = $_SESSION['pending'] ?? null;
        if (isset($_SESSION['done'])) {
            $d = $_SESSION['done'];
            self::respond(200, $this->view->accepted($d['reference'], $d['url'], $d['email'], $d['kind']));
        } elseif ($identity !== null && $pending !== null) {
            $_SESSION['idem'] = bin2hex(random_bytes(16));
            self::respond($status, $this->view->confirm($pending['url'], $identity['email'], $_SESSION['csrf'], $_SESSION['idem'], $error));
        } else {
            self::respond($status, $this->view->input($pending['url'] ?? '', null, $pending !== null ? 'Bitte melden Sie sich mit Google an, um die Anfrage fortzusetzen.' : null));
        }
    }

    private function start(): void
    {
        if (!$this->limiter()->allow('start', Http::clientIp(), $this->config->limit('start_per_ip'))) {
            self::respond(429, $this->view->error('Zu viele Versuche', 'Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.'));
            return;
        }
        $raw = is_string($_POST['website'] ?? null) ? $_POST['website'] : '';
        $url = WebsiteUrl::normalize($raw);
        if ($url === null) {
            self::respond(422, $this->view->input(mb_substr($raw, 0, 300), 'Bitte geben Sie eine öffentliche Website-Adresse wie beispiel.de ein.'));
            return;
        }
        unset($_SESSION['done'], $_SESSION['idem']);
        $_SESSION['pending'] = ['url' => $url, 'at' => time()];
        if ($this->identity() !== null) {
            Http::redirect($this->config->baseUrl() . '/anfrage.php');
        }
        $state = bin2hex(random_bytes(32));
        $nonce = bin2hex(random_bytes(32));
        $verifier = GoogleOidc::b64url(random_bytes(48));
        $_SESSION['oidc'] = ['state' => $state, 'nonce' => $nonce, 'verifier' => $verifier, 'at' => time()];
        Http::redirect($this->oidc()->authorizationUrl($state, $nonce, $verifier));
    }

    private function confirm(): void
    {
        if (!Http::validCsrf($_POST['csrf'] ?? null)) {
            self::respond(403, $this->view->error('Sitzung abgelaufen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/anfrage.php'));
            return;
        }
        /* Gleiche Absendung nach Erfolg (Doppelklick, Zurück + erneut senden): gleiche Bestätigung, nichts Neues */
        if (isset($_SESSION['done']['idem']) && is_string($_POST['idem'] ?? null) && hash_equals($_SESSION['done']['idem'], $_POST['idem'])) {
            Http::redirect($this->config->baseUrl() . '/anfrage.php');
        }
        $identity = $this->identity();
        $pending = $_SESSION['pending'] ?? null;
        if ($identity === null || $pending === null) {
            self::respond(403, $this->view->input($pending['url'] ?? '', null, 'Bitte melden Sie sich zuerst mit Google an.'));
            return;
        }
        if (!is_string($_POST['idem'] ?? null) || !isset($_SESSION['idem']) || !hash_equals($_SESSION['idem'], $_POST['idem'])) {
            self::respond(409, $this->view->error('Formular veraltet', 'Bitte bestätigen Sie die Anfrage noch einmal.', 'Zur Bestätigung', '/anfrage.php'));
            return;
        }
        if (($_POST['zustimmung'] ?? null) !== '1') {
            $this->show('Bitte bestätigen Sie die Anfrage mit dem Häkchen.', 422);
            return;
        }
        if (!$this->limiter()->allow('confirm', Http::clientIp(), $this->config->limit('confirm_per_ip'))) {
            self::respond(429, $this->view->error('Zu viele Versuche', 'Bitte warten Sie und versuchen Sie es später erneut.'));
            return;
        }
        $orders = new OrderService($this->db(), (int) $this->config->limit('duplicate_days'), (int) $this->config->limit('orders_per_account_day'));
        $r = $orders->submit($identity['sub'], $identity['email'], $pending['url'], $_SESSION['idem'], $this->config->privacyVersion());
        if ($r['result'] === OrderService::LIMIT) {
            self::respond(429, $this->view->error('Tageslimit erreicht', 'Mit diesem Google-Konto sind heute bereits mehrere Anfragen eingegangen. Bitte versuchen Sie es morgen erneut.'));
            return;
        }
        if ($r['result'] === OrderService::CREATED) {
            /* Auftrag ist gespeichert. Mail- oder Datenbankfehler beim Versand ändern daran nichts und dürfen keine
               Fehlerseite auslösen; die Benachrichtigung bleibt in der Outbox und wird per Cron wiederholt. */
            try {
                $this->notifier()->deliver($r['order_id']);
            } catch (\Throwable $e) {
                error_log('PXWA: Benachrichtigung zu ' . $r['reference'] . ' nicht sofort versendet (' . get_class($e) . '), Cron wiederholt');
            }
        }
        $_SESSION['done'] = [
            'reference' => $r['reference'], 'url' => $pending['url'], 'email' => $identity['email'], 'idem' => $_SESSION['idem'],
            'kind' => $r['result'] === OrderService::DUPLICATE ? OrderService::DUPLICATE : OrderService::CREATED,
        ];
        unset($_SESSION['pending']);
        Http::redirect($this->config->baseUrl() . '/anfrage.php');
    }

    private function logout(): void
    {
        if (Http::validCsrf($_POST['csrf'] ?? null)) {
            $_SESSION = [];
            session_destroy();
            setcookie(session_name(), '', ['expires' => 1, 'path' => '/', 'secure' => $this->config->secureCookies(), 'httponly' => true, 'samesite' => 'Lax']);
        }
        Http::redirect($this->config->baseUrl() . '/index.html');
    }

    /* auth/callback.php – Rückkehr von Google */
    private function callback(): void
    {
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
            self::respond(405, $this->view->error('Nicht erlaubt', 'Diese Aktion ist nicht möglich.'));
            return;
        }
        Http::startSession($this->config);
        $flow = $_SESSION['oidc'] ?? null;
        unset($_SESSION['oidc']);   // state ist nur einmal gültig
        if (!$this->limiter()->allow('callback', Http::clientIp(), $this->config->limit('callback_per_ip'))) {
            self::respond(429, $this->view->error('Zu viele Versuche', 'Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.'));
            return;
        }
        if (isset($_GET['error'])) {
            self::respond(400, $this->view->error('Anmeldung abgebrochen', 'Ohne Google-Anmeldung können wir die Anfrage nicht annehmen. Sie können es jederzeit erneut versuchen.', 'Erneut versuchen', '/anfrage.php'));
            return;
        }
        $state = $_GET['state'] ?? null;
        $code = $_GET['code'] ?? null;
        if (!is_array($flow) || !is_string($state) || !hash_equals($flow['state'], $state) || $flow['at'] < time() - (int) $this->config->limit('state_ttl')) {
            error_log('PXWA: Google-Rückkehr ohne gültigen state');
            self::respond(400, $this->view->error('Anmeldung abgelaufen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/anfrage.php'));
            return;
        }
        if (!is_string($code) || $code === '' || strlen($code) > 2048) {
            self::respond(400, $this->view->error('Anmeldung fehlgeschlagen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/anfrage.php'));
            return;
        }
        try {
            $user = $this->oidc()->authenticate($code, $flow['verifier'], $flow['nonce']);
        } catch (AuthError $e) {
            error_log('PXWA: ' . $e->getMessage());
            self::respond(401, $this->view->error('Anmeldung nicht bestätigt', 'Ihre Google-Anmeldung konnte nicht bestätigt werden. Bitte versuchen Sie es erneut.', 'Erneut versuchen', '/anfrage.php'));
            return;
        }
        Http::renewSession();   // Schutz vor Session-Fixation
        $_SESSION['identity'] = ['sub' => $user['sub'], 'email' => $user['email'], 'at' => time()];
        Http::redirect($this->config->baseUrl() . '/anfrage.php');
    }

    /** @return array{sub:string,email:string,at:int}|null */
    private function identity(): ?array
    {
        $i = $_SESSION['identity'] ?? null;
        if (is_array($i) && $i['at'] >= time() - (int) $this->config->limit('login_ttl')) {
            return $i;
        }
        unset($_SESSION['identity']);
        return null;
    }

    private function db(): Database
    {
        return $this->db ??= Database::connect($this->config->db());
    }

    private function limiter(): RateLimiter
    {
        return new RateLimiter($this->db(), $this->config->secret());
    }

    private function oidc(): GoogleOidc
    {
        return new GoogleOidc($this->config->google(), $this->config->redirectUri(), $this->config->dataDir() . '/google-jwks.json', new HttpClient());
    }

    private function notifier(): Notifier
    {
        $mail = $this->config->mail();
        return new Notifier($this->db(), new SmtpMailer($mail + ['ehlo' => (string) parse_url($this->config->baseUrl(), PHP_URL_HOST)]), $mail['notify_to']);
    }

    private static function respond(int $status, string $html): void
    {
        http_response_code($status);
        header('Content-Type: text/html; charset=utf-8');
        echo $html;
    }
}
