<?php
declare(strict_types=1);

namespace Pxwa;

/* Lädt und prüft die Serverkonfiguration. Fehlerhafte Konfiguration führt zu ConfigError,
   der Web-Einstieg antwortet dann mit 503, ohne Details preiszugeben. */
final class Config
{
    public const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
    public const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
    public const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
    public const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

    private const LIMIT_DEFAULTS = [
        'start_per_ip' => [20, 600],      // Anfragestarts je IP: 20 in 10 Minuten
        'callback_per_ip' => [30, 600],
        'confirm_per_ip' => [10, 3600],
        'orders_per_account_day' => 5,
        'duplicate_days' => 30,           // gleiche Website + gleiches Google-Konto gilt so lange als Duplikat
        'login_ttl' => 1800,              // bestätigte Anmeldung gilt 30 Minuten für die Bestätigung
        'state_ttl' => 600,
    ];

    private function __construct(private array $c)
    {
    }

    public static function load(string $path): self
    {
        if (!is_file($path)) {
            throw new ConfigError('Konfigurationsdatei fehlt');
        }
        $c = require $path;
        if (!is_array($c)) {
            throw new ConfigError('Konfiguration ist kein Array');
        }
        $c['limits'] = ($c['limits'] ?? []) + self::LIMIT_DEFAULTS;
        $c['google'] = ($c['google'] ?? []) + [
            'auth_endpoint' => self::GOOGLE_AUTH,
            'token_endpoint' => self::GOOGLE_TOKEN,
            'jwks_uri' => self::GOOGLE_JWKS,
        ];
        $config = new self($c);
        $config->validate();
        return $config;
    }

    private function validate(): void
    {
        $missing = [];
        $env = $this->c['env'] ?? '';
        if (!in_array($env, ['production', 'local'], true)) {
            $missing[] = 'env';
        }
        $base = (string) ($this->c['base_url'] ?? '');
        $scheme = parse_url($base, PHP_URL_SCHEME);
        if (!filter_var($base, FILTER_VALIDATE_URL) || str_ends_with($base, '/') || ($scheme !== 'https' && !($env === 'local' && $scheme === 'http'))) {
            $missing[] = 'base_url';
        }
        foreach (['client_id', 'client_secret'] as $k) {
            if (trim((string) ($this->c['google'][$k] ?? '')) === '') {
                $missing[] = "google.$k";
            }
        }
        if ($env === 'production') {
            /* In Produktion nur die echten Google-Endpunkte – verhindert, dass Codes an Dritte gehen. */
            foreach (['auth_endpoint' => self::GOOGLE_AUTH, 'token_endpoint' => self::GOOGLE_TOKEN, 'jwks_uri' => self::GOOGLE_JWKS] as $k => $v) {
                if ($this->c['google'][$k] !== $v) {
                    $missing[] = "google.$k";
                }
            }
        }
        if (trim((string) ($this->c['db']['dsn'] ?? '')) === '') {
            $missing[] = 'db.dsn';
        }
        $m = $this->c['mail'] ?? [];
        $enc = $m['encryption'] ?? '';
        if (!in_array($enc, ['ssl', 'starttls'], true) && !($env === 'local' && $enc === 'none')) {
            $missing[] = 'mail.encryption';
        }
        foreach (['host', 'port'] as $k) {
            if (empty($m[$k])) {
                $missing[] = "mail.$k";
            }
        }
        foreach (['from', 'notify_to'] as $k) {
            if (!filter_var($m[$k] ?? '', FILTER_VALIDATE_EMAIL)) {
                $missing[] = "mail.$k";
            }
        }
        if ($env === 'production' && (trim((string) ($m['username'] ?? '')) === '' || (string) ($m['password'] ?? '') === '')) {
            $missing[] = 'mail.username/password';
        }
        $dir = (string) ($this->c['data_dir'] ?? '');
        if ($dir === '' || !is_dir($dir) || !is_writable($dir)) {
            $missing[] = 'data_dir';
        }
        /* Ein konfiguriertes, aber fehlendes Session-Verzeichnis würde jede Anmeldung still verlieren */
        $sessionDir = $this->c['session_dir'] ?? null;
        if ($sessionDir !== null && (!is_string($sessionDir) || !is_dir($sessionDir) || !is_writable($sessionDir))) {
            $missing[] = 'session_dir';
        }
        if (strlen((string) ($this->c['secret'] ?? '')) < 32) {
            $missing[] = 'secret';
        }
        if (trim((string) ($this->c['privacy']['version'] ?? '')) === '') {
            $missing[] = 'privacy';
        }
        if ($missing) {
            /* Nur Schlüsselnamen, nie Werte */
            throw new ConfigError('Ungültige oder fehlende Werte: ' . implode(', ', $missing));
        }
    }

    public function isProduction(): bool
    {
        return $this->c['env'] === 'production';
    }

    public function baseUrl(): string
    {
        return $this->c['base_url'];
    }

    public function origin(): string
    {
        return self::originOf($this->c['base_url']);
    }

    public static function originOf(string $url): string
    {
        $p = parse_url($url);
        $scheme = strtolower($p['scheme']);
        $port = isset($p['port']) && !in_array([$scheme, $p['port']], [['https', 443], ['http', 80]], true) ? ':' . $p['port'] : '';
        return $scheme . '://' . strtolower($p['host']) . $port;
    }

    /* Host[:Port] der Basis-URL, so wie ihn ein Browser im Host-Header sendet */
    public function host(): string
    {
        return substr($this->origin(), strpos($this->origin(), '://') + 3);
    }

    public function secureCookies(): bool
    {
        return str_starts_with($this->c['base_url'], 'https://');
    }

    public function google(): array
    {
        return $this->c['google'] + ['issuers' => self::GOOGLE_ISSUERS];
    }

    public function redirectUri(): string
    {
        return $this->c['base_url'] . '/auth/callback.php';
    }

    public function db(): array
    {
        return $this->c['db'] + ['user' => null, 'pass' => null];
    }

    public function mail(): array
    {
        return $this->c['mail'] + ['username' => '', 'password' => '', 'from_name' => '360°Pixelkiez', 'timeout' => 15];
    }

    public function dataDir(): string
    {
        return rtrim($this->c['data_dir'], '/');
    }

    public function sessionDir(): ?string
    {
        return $this->c['session_dir'] ?? null;
    }

    public function secret(): string
    {
        return $this->c['secret'];
    }

    public function privacyVersion(): string
    {
        return $this->c['privacy']['version'];
    }

    public function limit(string $key): mixed
    {
        return $this->c['limits'][$key];
    }
}
