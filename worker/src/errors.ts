/* Fehlerklassen. Nachrichten enthalten nie Tokens, E-Mail-Adressen oder Website-Adressen,
   weil sie ins Worker-Log geschrieben werden. */
export class PxwaError extends Error {}

export class ConfigError extends PxwaError {}

/* Google-Anmeldung abgelehnt. reason ist ein kurzer, fester Code (z. B. "signature", "expired"). */
export class AuthError extends PxwaError {
  readonly reason: string;
  constructor(reason: string) {
    super('Google-Anmeldung abgelehnt: ' + reason);
    this.reason = reason;
  }
}

export class StorageError extends PxwaError {}

/* Fehler der Mail-API. kind: connect | timeout | temporary | permanent | protocol; status ist der HTTP-Status (0 ohne Antwort). */
export class MailError extends PxwaError {
  readonly kind: string;
  readonly status: number;
  constructor(kind: string, status = 0) {
    super('Mailversand fehlgeschlagen: ' + kind + (status ? ' ' + status : ''));
    this.kind = kind;
    this.status = status;
  }
}
