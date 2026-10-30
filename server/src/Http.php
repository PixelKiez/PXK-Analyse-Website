<?php
declare(strict_types=1);

namespace Pxwa;

/* Sicherheitsrelevante HTTP-Helfer: Header, Session, CSRF, Same-Origin-Prüfung, Redirects. */
final class Http
{
    public static function securityHeaders(Config $config): void
    {
        header_remove('X-Powered-By');
        $authOrigin = Config::originOf($config->google()['auth_endpoint']);
        header("Content-Security-Policy: default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self' $authOrigin; frame-ancestors 'none'; base-uri 'none'");
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        /* same-origin statt no-referrer: Bei no-referrer sendet Chrome für Formular-POSTs "Origin: null", die Same-Origin-Prüfung schlüge fehl */
        header('Referrer-Policy: same-origin');
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()');
        header('Cache-Control: no-store');
        if ($config->secureCookies()) {
            header('Strict-Transport-Security: max-age=31536000');
        }
    }

    public static function startSession(Config $config): void
    {
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');
        ini_set('session.gc_maxlifetime', '7200');
        ini_set('session.gc_probability', '1');   // manche Hoster setzen 0; Sessions enthalten E-Mail und Google-Kennung
        ini_set('session.gc_divisor', '100');
        if ($config->sessionDir()) {
            session_save_path($config->sessionDir());
        }
        $secure = $config->secureCookies();
        /* __Host- erzwingt Secure, Path=/ und keine Domain; nur über HTTPS möglich */
        session_name($secure ? '__Host-pxwa' : 'pxwa');
        session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax']);
        session_cache_limiter('');
        session_start();
        $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
    }

    public static function renewSession(): void
    {
        session_regenerate_id(true);
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    public static function validCsrf(mixed $token): bool
    {
        return is_string($token) && isset($_SESSION['csrf']) && hash_equals($_SESSION['csrf'], $token);
    }

    /* Lehnt Cross-Site-POSTs ab. Origin wird von aktuellen Browsern bei POST immer gesendet. */
    public static function sameOrigin(Config $config): bool
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        if ($origin !== null) {
            return hash_equals($config->origin(), $origin);
        }
        $site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null;
        return $site === null || in_array($site, ['same-origin', 'none'], true);
    }

    /* Für das Rate-Limiting: IPv4 vollständig, IPv6 als /64-Präfix (sonst reicht Adresswechsel im eigenen Netz).
       Hinter einem CDN wäre REMOTE_ADDR die CDN-Adresse – vor Livegang auf Hostinger prüfen. */
    public static function clientIp(): string
    {
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        $bin = @inet_pton($ip);
        return $bin !== false && strlen($bin) === 16 ? bin2hex(substr($bin, 0, 8)) . '::/64' : $ip;
    }

    /* Redirect nur auf fest konfigurierte Ziele (eigene Basis-URL oder Google-Autorisierung), nie auf Nutzereingaben. */
    public static function redirect(string $url): never
    {
        header('Location: ' . $url, true, 303);
        exit;
    }

    public static function h(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }
}
