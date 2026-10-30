<?php
declare(strict_types=1);

namespace Pxwa;

use PDO;
use PDOException;

/* PDO-Zugriff für SQLite und MySQL/MariaDB. Ausschließlich vorbereitete Statements. */
final class Database
{
    private function __construct(public readonly PDO $pdo, public readonly string $driver)
    {
    }

    public static function connect(array $cfg): self
    {
        try {
            $pdo = new PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_TIMEOUT => 5,
            ]);
        } catch (PDOException) {
            throw new StorageError('Datenbankverbindung fehlgeschlagen');
        }
        $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
        if ($driver === 'sqlite') {
            $pdo->exec('PRAGMA foreign_keys = ON');
            $pdo->exec('PRAGMA busy_timeout = 5000');
        } elseif ($driver === 'mysql') {
            $pdo->exec("SET time_zone = '+00:00'");
        } else {
            throw new StorageError('Nicht unterstützter Datenbanktreiber');
        }
        return new self($pdo, $driver);
    }

    public function migrate(): void
    {
        $sql = file_get_contents(PXWA_ROOT . '/schema/' . $this->driver . '.sql');
        $sql = preg_replace('/^\s*--.*$/m', '', $sql);
        foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
            $this->pdo->exec($statement);
        }
    }

    /* Schreibtransaktion. SQLite sperrt mit BEGIN IMMEDIATE sofort, damit parallele Bestätigungen serialisiert werden. */
    public function transaction(callable $fn): mixed
    {
        $sqlite = $this->driver === 'sqlite';
        $sqlite ? $this->pdo->exec('BEGIN IMMEDIATE') : $this->pdo->beginTransaction();
        try {
            $result = $fn($this);
            $sqlite ? $this->pdo->exec('COMMIT') : $this->pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            try {
                $sqlite ? $this->pdo->exec('ROLLBACK') : $this->pdo->rollBack();
            } catch (PDOException) {
                /* Transaktion war bereits beendet */
            }
            throw $e;
        }
    }

    public function one(string $sql, array $params = []): ?array
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    public function all(string $sql, array $params = []): array
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    }

    public function run(string $sql, array $params = []): int
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    public static function time(int $ts): string
    {
        return gmdate('Y-m-d H:i:s', $ts);
    }

    public static function isUniqueViolation(PDOException $e): bool
    {
        return in_array((string) $e->getCode(), ['23000', '23505'], true) || str_contains($e->getMessage(), 'UNIQUE');
    }
}
