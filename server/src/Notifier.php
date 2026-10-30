<?php
declare(strict_types=1);

namespace Pxwa;

/* Versendet die interne Benachrichtigung an Pixelkiez (nie an Kundinnen und Kunden, nie mit Anhang).
   Jede Benachrichtigung wird vor dem Versand per bedingtem UPDATE beansprucht. So verschickt bei
   Doppelklick, parallelen Anfragen oder gleichzeitigem Cronjob nur ein Prozess die Mail. */
final class Notifier
{
    private const MAX_ATTEMPTS = 10;
    private const LOCK_SECONDS = 300;

    public function __construct(private Database $db, private SmtpMailer $mailer, private string $notifyTo)
    {
    }

    public function deliver(int $orderId): bool
    {
        $now = time();
        $claimed = $this->db->run(
            "UPDATE notifications SET status = 'sending', attempts = attempts + 1, locked_until = ?
             WHERE order_id = ? AND status IN ('pending', 'sending') AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?)",
            [Database::time($now + self::LOCK_SECONDS), $orderId, Database::time($now), Database::time($now)]
        );
        if ($claimed !== 1) {
            return false;
        }
        $order = $this->db->one('SELECT o.reference, o.email, o.website_url, o.created_at, n.attempts FROM orders o JOIN notifications n ON n.order_id = o.id WHERE o.id = ?', [$orderId]);
        try {
            $this->mailer->send($this->notifyTo, 'Neue Analyse-Anfrage ' . $order['reference'], self::text($order), $order['email']);
        } catch (MailError $e) {
            $attempts = (int) $order['attempts'];
            $final = $attempts >= self::MAX_ATTEMPTS;
            $this->db->run(
                'UPDATE notifications SET status = ?, locked_until = NULL, next_attempt_at = ?, last_error = ? WHERE order_id = ?',
                [$final ? 'failed' : 'pending', Database::time(time() + self::backoff($attempts)), substr($e->kind . ($e->smtpCode ? ':' . $e->smtpCode : ''), 0, 64), $orderId]
            );
            error_log('PXWA: Benachrichtigung zu ' . $order['reference'] . ' fehlgeschlagen (' . $e->kind . ($e->smtpCode ? ' ' . $e->smtpCode : '') . ', Versuch ' . $attempts . ($final ? ', endgültig' : '') . ')');
            return false;
        }
        $this->db->run("UPDATE notifications SET status = 'sent', sent_at = ?, locked_until = NULL, last_error = NULL WHERE order_id = ?", [Database::time(time()), $orderId]);
        return true;
    }

    /** @return array{sent:int, failed:int} */
    public function deliverDue(int $limit = 20): array
    {
        $now = Database::time(time());
        $due = $this->db->all(
            "SELECT order_id FROM notifications WHERE status IN ('pending', 'sending') AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY id LIMIT " . max(1, $limit),
            [$now, $now]
        );
        $result = ['sent' => 0, 'failed' => 0];
        foreach ($due as $row) {
            $this->deliver((int) $row['order_id']) ? $result['sent']++ : $result['failed']++;
        }
        return $result;
    }

    /* 5 min, 15 min, 45 min … höchstens 12 Stunden */
    private static function backoff(int $attempts): int
    {
        return (int) min(43200, 300 * 3 ** max(0, $attempts - 1));
    }

    private static function text(array $o): string
    {
        return "Neue kostenlose Website-Analyse angefragt.\n\n"
            . 'Referenz: ' . $o['reference'] . "\n"
            . 'Eingegangen (UTC): ' . $o['created_at'] . "\n"
            . 'Website: ' . $o['website_url'] . "\n"
            . 'Von Google bestätigte E-Mail-Adresse: ' . $o['email'] . "\n\n"
            . "Nächster Schritt: Website manuell analysieren, den siebenseitigen PDF-Bericht außerhalb der Website erstellen\n"
            . "und manuell an die oben genannte, von Google bestätigte E-Mail-Adresse senden.\n\n"
            . "Achtung: Die Website-Adresse ist eine ungeprüfte Nutzereingabe. Bitte nur in einem isolierten Browserprofil öffnen.\n"
            . "Diese Nachricht wurde automatisch von der Analyse-Website erzeugt. Sie enthält keinen Bericht.\n";
    }
}
