import type { MailConfig } from './config';
import { type Db, utcText } from './db';
import { MailError } from './errors';
import { isEmail } from './http';

/* Versendet die interne Benachrichtigung an Pixelkiez (nie an Kundinnen und Kunden, nie mit Anhang)
   über eine HTTPS-Mail-API. Jede Benachrichtigung wird vor dem Versand per bedingtem UPDATE beansprucht.
   So verschickt bei Doppelklick, parallelen Anfragen oder gleichzeitigem Cron-Lauf nur ein Aufruf die Mail. */

const MAX_ATTEMPTS = 10;
const LOCK_SECONDS = 300;
const TIMEOUT_MS = 15000;

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo: string;
  idempotencyKey: string;
}

/* JSON-Aufruf mit Bearer-Token: { from, to: [..], reply_to, subject, text }. Der Idempotency-Key verhindert beim Anbieter
   Doppel-Mails, wenn eine Antwort verloren geht. Weiterleitungen werden nicht verfolgt. */
export class MailApi {
  constructor(private cfg: MailConfig) {}

  async send(m: Mail): Promise<void> {
    if (![m.to, this.cfg.from, m.replyTo].every(isEmail) || /[\r\n]/.test(m.subject)) throw new MailError('protocol');
    let res: Response;
    try {
      res = await fetch(this.cfg.apiUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiToken}`, 'content-type': 'application/json', 'idempotency-key': m.idempotencyKey },
        body: JSON.stringify({ from: this.cfg.from, to: [m.to], reply_to: m.replyTo, subject: m.subject, text: m.text }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new MailError(e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'connect');
    }
    await res.text().catch(() => '');
    if (res.status >= 200 && res.status < 300) return;
    throw new MailError(res.status === 408 || res.status === 429 || res.status >= 500 ? 'temporary' : 'permanent', res.status);
  }
}

interface OrderRow {
  reference: string;
  email: string;
  website_url: string;
  created_at: string;
  attempts: number;
}

export class Notifier {
  constructor(private db: Db, private mailer: MailApi, private notifyTo: string) {}

  async deliver(orderId: number, now: number): Promise<boolean> {
    const claimed = await this.db.run(
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1, locked_until = ?1
       WHERE order_id = ?2 AND status IN ('pending', 'sending') AND next_attempt_at <= ?3 AND (locked_until IS NULL OR locked_until < ?3)`,
      [utcText(now + LOCK_SECONDS), orderId, utcText(now)]);
    if (claimed !== 1) return false;
    const order = await this.db.first<OrderRow>(
      'SELECT o.reference, o.email, o.website_url, o.created_at, n.attempts FROM orders o JOIN notifications n ON n.order_id = o.id WHERE o.id = ?1', [orderId]);
    if (order === null) return false;
    try {
      await this.mailer.send({ to: this.notifyTo, subject: 'Neue Analyse-Anfrage ' + order.reference, text: text(order), replyTo: order.email, idempotencyKey: 'pxwa-' + order.reference });
    } catch (e) {
      if (!(e instanceof MailError)) throw e;
      const final = order.attempts >= MAX_ATTEMPTS;
      const code = (e.kind + (e.status ? ':' + e.status : '')).slice(0, 64);
      await this.db.run('UPDATE notifications SET status = ?1, locked_until = NULL, next_attempt_at = ?2, last_error = ?3 WHERE order_id = ?4',
        [final ? 'failed' : 'pending', utcText(Math.floor(Date.now() / 1000) + backoff(order.attempts)), code, orderId]);
      console.error(`PXWA: Benachrichtigung zu ${order.reference} fehlgeschlagen (${e.kind}${e.status ? ' ' + e.status : ''}, Versuch ${order.attempts}${final ? ', endgültig' : ''})`);
      return false;
    }
    await this.db.run("UPDATE notifications SET status = 'sent', sent_at = ?1, locked_until = NULL, last_error = NULL WHERE order_id = ?2",
      [utcText(Math.floor(Date.now() / 1000)), orderId]);
    return true;
  }

  async deliverDue(now: number, limit = 20): Promise<{ sent: number; failed: number }> {
    const due = await this.db.all<{ order_id: number }>(
      `SELECT order_id FROM notifications WHERE status IN ('pending', 'sending') AND next_attempt_at <= ?1 AND (locked_until IS NULL OR locked_until < ?1)
       ORDER BY id LIMIT ?2`, [utcText(now), Math.max(1, limit)]);
    const result = { sent: 0, failed: 0 };
    for (const row of due) {
      if (await this.deliver(row.order_id, now)) result.sent++;
      else result.failed++;
    }
    return result;
  }
}

/* 5 min, 15 min, 45 min … höchstens 12 Stunden */
const backoff = (attempts: number): number => Math.min(43200, 300 * 3 ** Math.max(0, attempts - 1));

const text = (o: OrderRow): string =>
  'Neue kostenlose Website-Analyse angefragt.\n\n'
  + `Referenz: ${o.reference}\n`
  + `Eingegangen (UTC): ${o.created_at}\n`
  + `Website: ${o.website_url}\n`
  + `Von Google bestätigte E-Mail-Adresse: ${o.email}\n\n`
  + 'Nächster Schritt: Website manuell analysieren, den siebenseitigen PDF-Bericht außerhalb der Website erstellen\n'
  + 'und manuell an die oben genannte, von Google bestätigte E-Mail-Adresse senden.\n\n'
  + 'Achtung: Die Website-Adresse ist eine ungeprüfte Nutzereingabe. Bitte nur in einem isolierten Browserprofil öffnen.\n'
  + 'Diese Nachricht wurde automatisch von der Analyse-Website erzeugt. Sie enthält keinen Bericht.\n';
