<?php
declare(strict_types=1);

namespace Pxwa;

/* Feste Zeitfenster je Schlüssel. Schlüssel werden mit HMAC pseudonymisiert,
   IP-Adressen landen daher nie im Klartext in der Datenbank. */
final class RateLimiter
{
    public function __construct(private Database $db, private string $secret)
    {
    }

    /** @param array{0:int,1:int} $rule [maximale Anzahl, Fenster in Sekunden] */
    public function allow(string $action, string $subject, array $rule): bool
    {
        [$max, $window] = $rule;
        $bucket = $action . ':' . substr(hash_hmac('sha256', $subject, $this->secret), 0, 40);
        $start = intdiv(time(), $window) * $window;
        $upsert = $this->db->driver === 'sqlite'
            ? 'INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1'
            : 'INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE hits = hits + 1';
        $this->db->run($upsert, [$bucket, $start]);
        $hits = (int) ($this->db->one('SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?', [$bucket, $start])['hits'] ?? 0);
        if (random_int(1, 100) === 1) {
            $this->db->run('DELETE FROM rate_limits WHERE window_start < ?', [time() - 86400]);
        }
        return $hits <= $max;
    }
}
