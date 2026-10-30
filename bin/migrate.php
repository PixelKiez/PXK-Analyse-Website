<?php
/* Legt die Tabellen an (idempotent). Aufruf per SSH: php bin/migrate.php */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/server/bootstrap.php';

try {
    Pxwa\Database::connect(pxwa_config()->db())->migrate();
    fwrite(STDOUT, "PXWA: Schema ist aktuell.\n");
} catch (Throwable $e) {
    fwrite(STDERR, 'PXWA: Migration fehlgeschlagen: ' . get_class($e) . ' ' . ($e instanceof PDOException ? 'SQLSTATE ' . $e->getCode() : $e->getMessage()) . "\n");
    exit(1);
}
