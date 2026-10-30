<?php
/* Wiederholt fällige interne Benachrichtigungen (z. B. nach einem SMTP-Ausfall).
   Hostinger-Cronjob, etwa alle 5 Minuten: php /home/BENUTZER/domains/DOMAIN/bin/send-notifications.php
   Gibt nur Anzahlen aus, keine Adressen. */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/server/bootstrap.php';

try {
    $config = pxwa_config();
    $mail = $config->mail();
    $mailer = new Pxwa\SmtpMailer($mail + ['ehlo' => (string) parse_url($config->baseUrl(), PHP_URL_HOST)]);
    $result = (new Pxwa\Notifier(Pxwa\Database::connect($config->db()), $mailer, $mail['notify_to']))->deliverDue();
    fwrite(STDOUT, sprintf("PXWA: %d versendet, %d fehlgeschlagen.\n", $result['sent'], $result['failed']));
    exit($result['failed'] > 0 ? 2 : 0);
} catch (Throwable $e) {
    fwrite(STDERR, 'PXWA: Lauf abgebrochen: ' . get_class($e) . "\n");
    exit(1);
}
