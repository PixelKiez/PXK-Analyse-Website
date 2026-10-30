<?php
declare(strict_types=1);

namespace Pxwa;

/* Fehlerklassen. Nachrichten enthalten nie Tokens, E-Mail-Adressen oder Website-Adressen,
   weil sie ins Server-Log geschrieben werden. */
class PxwaError extends \RuntimeException
{
}

final class ConfigError extends PxwaError
{
}

/* Google-Anmeldung abgelehnt. $reason ist ein kurzer, fester Code (z. B. "signature", "expired"). */
final class AuthError extends PxwaError
{
    public function __construct(public readonly string $reason)
    {
        parent::__construct('Google-Anmeldung abgelehnt: ' . $reason);
    }
}

final class StorageError extends PxwaError
{
}

/* SMTP-Fehler. $kind: connect | tls | auth | temporary | permanent | protocol */
final class MailError extends PxwaError
{
    public function __construct(public readonly string $kind, public readonly int $smtpCode = 0)
    {
        parent::__construct('Mailversand fehlgeschlagen: ' . $kind . ($smtpCode ? ' ' . $smtpCode : ''));
    }
}
