import type { MailConfig } from './config';
import { type Db, utcText } from './db';
import { MailError, StorageError } from './errors';
import { isEmail } from './http';

/* Versendet die interne Benachrichtigung an Pixelkiez (nie an Kundinnen und Kunden, nie mit Anhang)
   über die Resend-API. Jede Benachrichtigung wird vor dem Versand per bedingtem UPDATE beansprucht.
   So verschickt bei Doppelklick, parallelen Anfragen oder gleichzeitigem Cron-Lauf nur ein Aufruf die Mail.
   "sent" heißt: Resend hat die Mail angenommen – nicht, dass sie im Postfach angekommen ist. */

const MAX_ATTEMPTS = 10;
const LOCK_SECONDS = 300;
const TIMEOUT_MS = 15000;
/* Resend lehnt Anfragen ohne User-Agent mit 403 ab */
const USER_AGENT = 'pxwa-api/1 (360-pixelkiez)';
/* Resend-Fehler, nach denen ein späterer Versuch sinnvoll ist (zusätzlich zu 408, 429 und 5xx) */
const RETRYABLE = new Set(['concurrent_idempotent_requests', 'resource_locked']);
/* Nur vorübergehende Fehler werden automatisch wiederholt. "permanent" (z. B. 401 ungültiger API-Key, 403 Domain nicht
   verifiziert, 422 Validierung, 409 invalid_idempotent_request) und "protocol" scheitern mit unveränderter Konfiguration
   bei jedem Versuch gleich: sofort "failed", bis die Ursache behoben und die Benachrichtigung manuell neu eingereiht ist. */
const RETRY_KINDS = new Set(['connect', 'timeout', 'temporary']);

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo: string;
  idempotencyKey: string;
}

/* POST https://api.resend.com/emails mit Bearer-Token und JSON { from, to: [..], reply_to, subject, text }.
   Der Idempotency-Key (Resend hält ihn 24 Stunden) verhindert eine zweite Mail, wenn eine Antwort verloren geht oder
   der Status danach nicht gespeichert werden konnte. Später gibt es keine Garantie gegen eine Doppel-Mail.
   Weiterleitungen werden nicht verfolgt. Liefert die ID, unter der Resend die Mail angenommen hat. */
export class MailApi {
  constructor(private cfg: MailConfig) {}

  async send(m: Mail): Promise<string | null> {
    if (![m.to, this.cfg.from, m.replyTo].every(isEmail) || /[\r\n]/.test(m.subject)) throw new MailError('protocol');
    let res: Response;
    try {
      res = await fetch(this.cfg.apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.apiToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
          'idempotency-key': m.idempotencyKey,
        },
        body: JSON.stringify({ from: this.cfg.from, to: [m.to], reply_to: m.replyTo, subject: m.subject, text: m.text }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new MailError(e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'connect');
    }
    const body = parseJson(await res.text().catch(() => ''));
    if (res.status >= 200 && res.status < 300) {
      return typeof body?.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.id) ? body.id : null;
    }
    /* Nur den festen Fehlernamen übernehmen; message kann Adressen enthalten und gelangt nicht ins Log */
    const code = typeof body?.name === 'string' && /^[a-z_]{1,48}$/.test(body.name) ? body.name : '';
    const temporary = res.status === 408 || res.status === 429 || res.status >= 500 || RETRYABLE.has(code);
    throw new MailError(temporary ? 'temporary' : 'permanent', res.status, code);
  }
}

interface OrderRow {
  reference: string;
  email: string;
  website_url: string;
  status: string;
  terms_version: string | null;
  terms_accepted_at: string | null;
  created_at: string;
  attempts: number;
}

/* sent: von Resend angenommen; failed: Versuch gescheitert (vorübergehend: später erneut; dauerhaft: Status "failed" in D1);
   busy: gerade von einem anderen Aufruf beansprucht. Der Auftrag bleibt in jedem Fall unverändert gespeichert. */
export type Delivery = 'sent' | 'failed' | 'busy';

export class Notifier {
  constructor(private db: Db, private mailer: MailApi, private notifyTo: string) {}

  async deliver(orderId: number, now: number): Promise<Delivery> {
    const claimed = await this.db.run(
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1, locked_until = ?1
       WHERE order_id = ?2 AND status IN ('pending', 'sending') AND next_attempt_at <= ?3 AND (locked_until IS NULL OR locked_until < ?3)`,
      [utcText(now + LOCK_SECONDS), orderId, utcText(now)]);
    if (claimed !== 1) return 'busy';
    const order = await this.db.first<OrderRow>(
      `SELECT o.reference, o.email, o.website_url, o.status, o.terms_version, o.terms_accepted_at, o.created_at, n.attempts
       FROM orders o JOIN notifications n ON n.order_id = o.id WHERE o.id = ?1`, [orderId]);
    if (order === null) return 'busy';
    let id: string | null;
    try {
      id = await this.mailer.send({ to: this.notifyTo, subject: 'Neue Analyse-Anfrage ' + order.reference, text: text(order), replyTo: order.email, idempotencyKey: 'pxwa-' + order.reference });
    } catch (e) {
      if (!(e instanceof MailError)) throw e;
      const permanent = !RETRY_KINDS.has(e.kind);
      const final = permanent || order.attempts >= MAX_ATTEMPTS;
      const reason = [e.kind, e.status || '', e.code].filter(Boolean).join(':').slice(0, 64);
      await this.db.run('UPDATE notifications SET status = ?1, locked_until = NULL, next_attempt_at = ?2, last_error = ?3 WHERE order_id = ?4',
        [final ? 'failed' : 'pending', utcText(Math.floor(Date.now() / 1000) + backoff(order.attempts)), reason, orderId]);
      const outcome = permanent ? ', dauerhaft abgelehnt – keine automatische Wiederholung, Konfiguration prüfen' : final ? ', endgültig' : '';
      console.error(`PXWA: Benachrichtigung zu ${order.reference} fehlgeschlagen (${reason.replace(/:/g, ' ')}, Versuch ${order.attempts}${outcome})`);
      return 'failed';
    }
    /* Resend hat angenommen. Scheitert jetzt das Speichern, bleibt die Zeile "sending" und wird nach Ablauf der Sperre
       erneut beansprucht; derselbe Idempotency-Key verhindert bei Resend dann innerhalb von 24 Stunden eine zweite Mail. */
    await this.db.run("UPDATE notifications SET status = 'sent', sent_at = ?1, locked_until = NULL, last_error = NULL WHERE order_id = ?2",
      [utcText(Math.floor(Date.now() / 1000)), orderId]);
    console.log(`PXWA: Benachrichtigung zu ${order.reference} von der Mail-API angenommen (ID ${id ?? 'unbekannt'})`);
    return 'sent';
  }

  async deliverDue(now: number, limit = 20): Promise<Record<Delivery, number>> {
    const due = await this.db.all<{ order_id: number }>(
      `SELECT order_id FROM notifications WHERE status IN ('pending', 'sending') AND next_attempt_at <= ?1 AND (locked_until IS NULL OR locked_until < ?1)
       ORDER BY id LIMIT ?2`, [utcText(now), Math.max(1, limit)]);
    const result = { sent: 0, failed: 0, busy: 0 };
    for (const row of due) {
      /* Ein Datenbankfehler bei einer Benachrichtigung hält die übrigen nicht auf */
      try {
        result[await this.deliver(row.order_id, now)]++;
      } catch (e) {
        if (!(e instanceof StorageError)) throw e;
        console.error(`PXWA: Zustellung der Benachrichtigung ${row.order_id} unterbrochen (${e.message}), nächster Cron-Lauf wiederholt`);
        result.failed++;
      }
    }
    return result;
  }
}

function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* 5 min, 15 min, 45 min … höchstens 12 Stunden */
const backoff = (attempts: number): number => Math.min(43200, 300 * 3 ** Math.max(0, attempts - 1));

const text = (o: OrderRow): string =>
  'Neue kostenlose Website-Analyse angefragt.\n\n'
  + `Referenz: ${o.reference}\n`
  + `Eingegangen (UTC): ${o.created_at}\n`
  + `Website: ${o.website_url}\n`
  + `Von Google bestätigte E-Mail-Adresse: ${o.email}\n`
  + `Auftrag: Free (0 €), Status ${o.status}\n`
  + `AGB: Version ${o.terms_version ?? 'nicht erfasst'}, akzeptiert (UTC) ${o.terms_accepted_at ?? 'nicht erfasst'}\n\n`
  + 'Nächster Schritt: Website manuell analysieren, den siebenseitigen PDF-Bericht außerhalb der Website erstellen\n'
  + 'und manuell an die oben genannte, von Google bestätigte E-Mail-Adresse senden.\n\n'
  + 'Achtung: Die Website-Adresse ist eine ungeprüfte Nutzereingabe. Bitte nur in einem isolierten Browserprofil öffnen.\n'
  + 'Diese Nachricht wurde automatisch von der Analyse-Website erzeugt. Sie enthält keinen Bericht.\n';
