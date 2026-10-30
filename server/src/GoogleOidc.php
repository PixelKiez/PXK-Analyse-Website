<?php
declare(strict_types=1);

namespace Pxwa;

/* Google-Anmeldung über OpenID Connect (Authorization Code Flow mit PKCE, state und nonce).
   Scope nur "openid email": keine Gmail-Rechte, kein Profil, kein Zugriff auf das Postfach.
   Das ID-Token kommt ausschließlich über den Server-zu-Server-Aufruf am Token-Endpunkt an,
   wird trotzdem vollständig geprüft (Signatur, Issuer, Audience, Ablauf, nonce, bestätigte E-Mail)
   und danach verworfen. Access- und ID-Token werden weder gespeichert noch geloggt. */
final class GoogleOidc
{
    private const LEEWAY = 60;

    public function __construct(
        private array $google,
        private string $redirectUri,
        private string $cacheFile,
        private HttpClient $http,
    ) {
    }

    public function authorizationUrl(string $state, string $nonce, string $verifier): string
    {
        $query = http_build_query([
            'client_id' => $this->google['client_id'],
            'redirect_uri' => $this->redirectUri,
            'response_type' => 'code',
            'scope' => 'openid email',
            'state' => $state,
            'nonce' => $nonce,
            'code_challenge' => self::b64url(hash('sha256', $verifier, true)),
            'code_challenge_method' => 'S256',
            'prompt' => 'select_account',
        ], '', '&', PHP_QUERY_RFC3986);
        return $this->google['auth_endpoint'] . '?' . $query;
    }

    /** @return array{sub:string, email:string} */
    public function authenticate(string $code, string $verifier, string $nonce): array
    {
        $res = $this->http->postForm($this->google['token_endpoint'], [
            'code' => $code,
            'client_id' => $this->google['client_id'],
            'client_secret' => $this->google['client_secret'],
            'redirect_uri' => $this->redirectUri,
            'grant_type' => 'authorization_code',
            'code_verifier' => $verifier,
        ]);
        if ($res['status'] !== 200) {
            throw new AuthError('token_exchange');
        }
        $json = json_decode($res['body'], true);
        if (!is_array($json) || !isset($json['id_token']) || !is_string($json['id_token'])) {
            throw new AuthError('token_response');
        }
        return $this->verifyIdToken($json['id_token'], $nonce, time());
    }

    /** @return array{sub:string, email:string} */
    public function verifyIdToken(string $jwt, string $expectedNonce, int $now): array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) {
            throw new AuthError('format');
        }
        [$h64, $p64, $s64] = $parts;
        $header = json_decode((string) self::b64urlDecode($h64), true);
        $claims = json_decode((string) self::b64urlDecode($p64), true);
        $signature = self::b64urlDecode($s64);
        if (!is_array($header) || !is_array($claims) || $signature === null || $signature === '') {
            throw new AuthError('format');
        }
        /* Nur RS256 – verhindert "alg: none" und HS256-Verwechslung mit dem öffentlichen Schlüssel */
        if (($header['alg'] ?? null) !== 'RS256') {
            throw new AuthError('alg');
        }
        $kid = $header['kid'] ?? null;
        $pem = is_string($kid) && $kid !== '' ? $this->publicKey($kid) : null;
        if ($pem === null) {
            throw new AuthError('kid');
        }
        if (openssl_verify($h64 . '.' . $p64, $signature, $pem, OPENSSL_ALGO_SHA256) !== 1) {
            throw new AuthError('signature');
        }
        if (!in_array($claims['iss'] ?? null, $this->google['issuers'], true)) {
            throw new AuthError('issuer');
        }
        $clientId = $this->google['client_id'];
        $aud = $claims['aud'] ?? null;
        $audOk = is_string($aud) ? hash_equals($clientId, $aud) : (is_array($aud) && in_array($clientId, $aud, true) && ($claims['azp'] ?? null) === $clientId);
        if (!$audOk || (isset($claims['azp']) && $claims['azp'] !== $clientId)) {
            throw new AuthError('audience');
        }
        if (!is_int($claims['exp'] ?? null) || $now >= $claims['exp'] + self::LEEWAY) {
            throw new AuthError('expired');
        }
        if (!is_int($claims['iat'] ?? null) || $claims['iat'] > $now + self::LEEWAY) {
            throw new AuthError('iat');
        }
        if (!is_string($claims['nonce'] ?? null) || !hash_equals($expectedNonce, $claims['nonce'])) {
            throw new AuthError('nonce');
        }
        $verified = $claims['email_verified'] ?? null;
        if ($verified !== true && $verified !== 'true') {
            throw new AuthError('email_unverified');
        }
        $email = $claims['email'] ?? null;
        if (!is_string($email) || strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new AuthError('email');
        }
        $sub = $claims['sub'] ?? null;
        if (!is_string($sub) || $sub === '' || strlen($sub) > 255 || preg_match('/[^\x21-\x7e]/', $sub)) {
            throw new AuthError('sub');
        }
        return ['sub' => $sub, 'email' => strtolower($email)];
    }

    /* Öffentlicher Schlüssel zur kid aus dem Google-JWKS; unbekannte kid löst höchstens einen Neuabruf pro Minute aus. */
    private function publicKey(string $kid): ?string
    {
        $cache = $this->readCache();
        if (isset($cache['keys'][$kid]) && $cache['expires_at'] > time()) {
            return $cache['keys'][$kid];
        }
        if (($cache['fetched_at'] ?? 0) < time() - 60 || ($cache['expires_at'] ?? 0) <= time()) {
            $fresh = $this->fetchKeys();
            if ($fresh !== null) {
                $cache = $fresh;
            } elseif ($cache['expires_at'] < time() - 86400) {
                return null;   // Neuabruf gescheitert und Cache mehr als einen Tag abgelaufen
            }
        }
        return $cache['keys'][$kid] ?? null;
    }

    private function readCache(): array
    {
        $raw = is_file($this->cacheFile) ? file_get_contents($this->cacheFile) : false;
        $data = $raw !== false ? json_decode($raw, true) : null;
        return is_array($data) && isset($data['keys'], $data['expires_at']) ? $data : ['keys' => [], 'expires_at' => 0, 'fetched_at' => 0];
    }

    private function fetchKeys(): ?array
    {
        $res = $this->http->get($this->google['jwks_uri']);
        $json = $res['status'] === 200 ? json_decode($res['body'], true) : null;
        if (!is_array($json) || !isset($json['keys']) || !is_array($json['keys'])) {
            error_log('PXWA: Google-Schlüssel konnten nicht geladen werden (HTTP ' . $res['status'] . ')');
            return null;
        }
        $keys = [];
        foreach ($json['keys'] as $k) {
            if (is_array($k) && ($k['kty'] ?? '') === 'RSA' && in_array($k['alg'] ?? 'RS256', ['RS256'], true)
                && in_array($k['use'] ?? 'sig', ['sig'], true) && is_string($k['kid'] ?? null) && is_string($k['n'] ?? null) && is_string($k['e'] ?? null)) {
                $pem = self::rsaPem($k['n'], $k['e']);
                if ($pem !== null) {
                    $keys[$k['kid']] = $pem;
                }
            }
        }
        $maxAge = preg_match('/max-age=(\d+)/', $res['headers']['cache-control'] ?? '', $m) ? (int) $m[1] : 3600;
        $data = ['keys' => $keys, 'fetched_at' => time(), 'expires_at' => time() + max(300, min($maxAge, 86400))];
        $tmp = $this->cacheFile . '.' . bin2hex(random_bytes(4));
        if (file_put_contents($tmp, json_encode($data)) !== false) {
            @chmod($tmp, 0600);
            rename($tmp, $this->cacheFile);
        }
        return $data;
    }

    /* JWK (Modulus n, Exponent e) → PEM "PUBLIC KEY" (SubjectPublicKeyInfo, DER) */
    public static function rsaPem(string $n, string $e): ?string
    {
        $n = self::b64urlDecode($n);
        $e = self::b64urlDecode($e);
        if ($n === null || $e === null || strlen($n) < 256) {
            return null;
        }
        $int = static fn(string $b): string => self::der(0x02, ord($b[0]) > 0x7f ? "\x00" . $b : $b);
        $rsaKey = self::der(0x30, $int($n) . $int($e));
        $algorithm = hex2bin('300d06092a864886f70d0101010500');
        $spki = self::der(0x30, $algorithm . self::der(0x03, "\x00" . $rsaKey));
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    private static function der(int $tag, string $data): string
    {
        $len = strlen($data);
        $l = $len < 0x80 ? chr($len) : (static function (int $len): string {
            $b = ltrim(pack('N', $len), "\x00");
            return chr(0x80 | strlen($b)) . $b;
        })($len);
        return chr($tag) . $l . $data;
    }

    public static function b64url(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    public static function b64urlDecode(string $s): ?string
    {
        if ($s === '' || preg_match('/[^A-Za-z0-9_-]/', $s)) {
            return null;
        }
        $bin = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        return $bin === false ? null : $bin;
    }
}
