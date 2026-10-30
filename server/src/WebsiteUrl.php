<?php
declare(strict_types=1);

namespace Pxwa;

/* Prüft und normalisiert die eingegebene Website-Adresse.
   Die Adresse wird nur gespeichert, nie serverseitig abgerufen (kein Scan, daher keine SSRF-Fläche).
   Gespeichert werden Schema, Host und Pfad; Query-String und Fragment werden verworfen (Datensparsamkeit). */
final class WebsiteUrl
{
    public const MAX_INPUT = 2048;
    public const MAX_STORED = 300;

    /* Nicht öffentliche bzw. reservierte Endungen (RFC 2606, RFC 6761, RFC 6762, übliche interne Namen) */
    private const RESERVED_TLDS = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'example', 'invalid', 'onion', 'arpa'];

    public static function normalize(string $input): ?string
    {
        $v = trim($input);
        if ($v === '' || strlen($v) > self::MAX_INPUT || preg_match('/[\x00-\x20\x7f\\\\<>"`{}|^]/u', $v) !== 0) {
            return null;
        }
        if (!preg_match('#^[a-z][a-z0-9+.-]*://#i', $v)) {
            /* "javascript:…", "mailto:…" usw. ablehnen; "host:port" bleibt erlaubt und wird unten geprüft */
            if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $v) && !preg_match('~^[^/:]+:\d+(?:[/?#]|$)~', $v)) {
                return null;
            }
            $v = 'https://' . $v;
        }
        $p = parse_url($v);
        if (!is_array($p) || !isset($p['scheme'], $p['host'])) {
            return null;
        }
        $scheme = strtolower($p['scheme']);
        if (!in_array($scheme, ['http', 'https'], true) || isset($p['user']) || isset($p['pass'])) {
            return null;
        }
        if (isset($p['port']) && !in_array($p['port'], [80, 443], true)) {
            return null;
        }
        $host = self::host($p['host']);
        if ($host === null) {
            return null;
        }
        $path = self::path($p['path'] ?? '');
        if ($path === null) {
            return null;
        }
        $url = $scheme . '://' . $host . $path;
        return strlen($url) <= self::MAX_STORED ? $url : null;
    }

    /* Anzeigeform: Umlaut-Domains und -Pfade wieder lesbar machen (nur zur Anzeige, Ausgabe wird escaped) */
    public static function display(string $url): string
    {
        $host = (string) parse_url($url, PHP_URL_HOST);
        $path = (string) parse_url($url, PHP_URL_PATH);
        $scheme = (string) parse_url($url, PHP_URL_SCHEME);
        if (str_contains($host, 'xn--') && function_exists('idn_to_utf8')) {
            $u = idn_to_utf8($host, IDNA_NONTRANSITIONAL_TO_UNICODE, INTL_IDNA_VARIANT_UTS46);
            $host = is_string($u) ? $u : $host;
        }
        $decoded = rawurldecode($path);
        if (mb_check_encoding($decoded, 'UTF-8') && !preg_match('/[\x00-\x20\x7f]/', $decoded)) {
            $path = $decoded;
        }
        return $scheme . '://' . $host . $path;
    }

    private static function host(string $h): ?string
    {
        $h = strtolower(rtrim($h, '.'));
        if ($h === '' || str_starts_with($h, '[') || filter_var($h, FILTER_VALIDATE_IP)) {
            return null;
        }
        if (preg_match('/[^\x00-\x7f]/', $h)) {
            if (!function_exists('idn_to_ascii')) {
                return null;
            }
            $h = idn_to_ascii($h, IDNA_NONTRANSITIONAL_TO_ASCII, INTL_IDNA_VARIANT_UTS46);
            if (!is_string($h)) {
                return null;
            }
        }
        if (strlen($h) > 253) {
            return null;
        }
        $labels = explode('.', $h);
        if (count($labels) < 2) {
            return null;
        }
        foreach ($labels as $label) {
            if (!preg_match('/^(?!-)[a-z0-9-]{1,63}(?<!-)$/', $label)) {
                return null;
            }
        }
        $tld = end($labels);
        if (!preg_match('/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/', $tld) || in_array($tld, self::RESERVED_TLDS, true)) {
            return null;
        }
        if (preg_match('/(?:^|\.)example\.(?:com|net|org)$/', $h)) {
            return null;
        }
        return $h;
    }

    private static function path(string $path): ?string
    {
        if ($path === '' || $path === '/') {
            return '';
        }
        $path = preg_replace_callback('/[^\x21-\x7e]/', static fn(array $m) => rawurlencode($m[0]), $path);
        if (!preg_match('#^(?:/(?:[A-Za-z0-9\-._~!$&\'()*+,;=:@]|%[0-9A-Fa-f]{2})*)+$#', $path)) {
            return null;
        }
        return $path;
    }
}
