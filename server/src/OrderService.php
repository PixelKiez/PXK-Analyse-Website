<?php
declare(strict_types=1);

namespace Pxwa;

use PDOException;

/* Nimmt Aufträge an. Auftrag und ausstehende interne Benachrichtigung werden in EINER Transaktion gespeichert
   (Outbox): Erst nach dem Commit gilt der Auftrag als angenommen. Fällt der Mailversand danach aus,
   bleibt der Auftrag erhalten und die Benachrichtigung wird später erneut versucht. */
final class OrderService
{
    public const CREATED = 'created';
    public const IDEMPOTENT = 'idempotent';   // gleiche Absendung erneut (Doppelklick, Neuladen)
    public const DUPLICATE = 'duplicate';     // gleiches Google-Konto, gleiche Website, innerhalb der Sperrfrist
    public const LIMIT = 'limit';             // zu viele Aufträge dieses Kontos in 24 Stunden

    public function __construct(private Database $db, private int $duplicateDays, private int $maxPerDay)
    {
    }

    /** @return array{result:string, reference:?string, order_id:?int} */
    public function submit(string $sub, string $email, string $websiteUrl, string $idempotencyKey, string $privacyVersion): array
    {
        /* SQLite serialisiert über BEGIN IMMEDIATE. MySQL/InnoDB sperrt bei den SELECTs keine fehlenden Zeilen,
           daher je Google-Konto eine benannte Sperre, damit parallele Bestätigungen Duplikat- und Tageslimit nicht umgehen. */
        $lock = 'pxwa:' . sha1($sub);
        if ($this->db->driver === 'mysql' && (int) ($this->db->one('SELECT GET_LOCK(?, 5) AS l', [$lock])['l'] ?? 0) !== 1) {
            throw new StorageError('Sperre für das Konto nicht erhalten');
        }
        try {
            return $this->submitLocked($sub, $email, $websiteUrl, $idempotencyKey, $privacyVersion);
        } finally {
            if ($this->db->driver === 'mysql') {
                $this->db->one('SELECT RELEASE_LOCK(?) AS l', [$lock]);
            }
        }
    }

    /** @return array{result:string, reference:?string, order_id:?int} */
    private function submitLocked(string $sub, string $email, string $websiteUrl, string $idempotencyKey, string $privacyVersion): array
    {
        try {
            return $this->db->transaction(function (Database $db) use ($sub, $email, $websiteUrl, $idempotencyKey, $privacyVersion): array {
                $now = time();
                $same = $db->one('SELECT id, reference, google_sub FROM orders WHERE idempotency_key = ?', [$idempotencyKey]);
                if ($same !== null) {
                    if (!hash_equals($same['google_sub'], $sub)) {
                        throw new StorageError('Idempotenzschlüssel gehört zu einem anderen Konto');
                    }
                    return ['result' => self::IDEMPOTENT, 'reference' => $same['reference'], 'order_id' => (int) $same['id']];
                }
                $dup = $db->one(
                    'SELECT id, reference FROM orders WHERE google_sub = ? AND website_url = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
                    [$sub, $websiteUrl, Database::time($now - $this->duplicateDays * 86400)]
                );
                if ($dup !== null) {
                    return ['result' => self::DUPLICATE, 'reference' => $dup['reference'], 'order_id' => (int) $dup['id']];
                }
                $count = (int) $db->one('SELECT COUNT(*) AS n FROM orders WHERE google_sub = ? AND created_at >= ?', [$sub, Database::time($now - 86400)])['n'];
                if ($count >= $this->maxPerDay) {
                    return ['result' => self::LIMIT, 'reference' => null, 'order_id' => null];
                }
                $reference = self::newReference();
                $db->run(
                    'INSERT INTO orders (reference, idempotency_key, google_sub, email, website_url, privacy_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [$reference, $idempotencyKey, $sub, $email, $websiteUrl, $privacyVersion, 'received', Database::time($now)]
                );
                $orderId = (int) $db->pdo->lastInsertId();
                $db->run(
                    'INSERT INTO notifications (order_id, status, attempts, next_attempt_at, created_at) VALUES (?, ?, 0, ?, ?)',
                    [$orderId, 'pending', Database::time($now), Database::time($now)]
                );
                return ['result' => self::CREATED, 'reference' => $reference, 'order_id' => $orderId];
            });
        } catch (PDOException $e) {
            /* Gleichzeitige Absendung mit demselben Schlüssel: die andere Anfrage hat gewonnen */
            if (Database::isUniqueViolation($e)) {
                $same = $this->db->one('SELECT id, reference, google_sub FROM orders WHERE idempotency_key = ?', [$idempotencyKey]);
                if ($same !== null && hash_equals($same['google_sub'], $sub)) {
                    return ['result' => self::IDEMPOTENT, 'reference' => $same['reference'], 'order_id' => (int) $same['id']];
                }
            }
            throw new StorageError('Auftrag konnte nicht gespeichert werden (SQLSTATE ' . $e->getCode() . ')');
        }
    }

    /* Referenz wie PXA-7K3M-Q9TD (Crockford-Base32 ohne I, L, O, U) */
    public static function newReference(): string
    {
        $alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        $s = '';
        foreach (str_split(random_bytes(8)) as $byte) {
            $s .= $alphabet[ord($byte) & 31];
        }
        return 'PXA-' . substr($s, 0, 4) . '-' . substr($s, 4, 4);
    }
}
