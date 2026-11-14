import { randomBytes, safeEqual } from './crypto';
import { type Db, isUniqueViolation, utcText } from './db';
import { StorageError } from './errors';
import { DECLARATIONS } from './view';

/* Nimmt Aufträge an. Auftrag und ausstehende interne Benachrichtigung werden in EINER Transaktion (D1-Batch)
   gespeichert (Outbox): Erst danach gilt der Auftrag als angenommen. Fällt der Mailversand danach aus,
   bleibt der Auftrag erhalten und die Benachrichtigung wird später erneut versucht.
   D1 führt Schreibzugriffe nacheinander aus; Tageslimit und Tagesgrenze stehen deshalb als Bedingung im INSERT selbst,
   parallele Anmeldungen können sie nicht umgehen. Jeder Auftrag speichert die akzeptierte AGB-Version und den
   serverseitigen Zeitpunkt der Zustimmung (Migration 0002) sowie die Unternehmer-Bestätigung und den Wortlaut des bestätigten
   Kästchens (Migration 0003). Seit der Bestätigungsseite mit genau einem Kästchen (PO-Entscheidung 12.11.2026) wird keine
   Werbeeinwilligung abgefragt: marketing_consent ist immer 0, marketing_consents bekommt keine neuen Zeilen. Bestehende
   Aufträge und Nachweise bleiben unverändert. */

export interface AcceptedTerms {
  version: string;
  at: number;
}

/* Gespeicherter Wortlaut: genau das eine Pflichtkästchen der Bestätigungsseite */
export const declarationsText = (): string => DECLARATIONS.confirmation;

/* limit: Tageslimit des Google-Kontos; capacity: Tagesgrenze aller Aufträge zusammen erreicht. Keine Duplikatsperre (PO-Entscheidung
   14.11.2026): Dieselbe Website darf erneut angefragt werden; nur dieselbe Absendung (Idempotenzschlüssel) legt nichts Neues an. */
export type OrderResult =
  | { result: 'created' | 'idempotent'; reference: string; orderId: number }
  | { result: 'limit'; reference: null; orderId: null }
  | { result: 'capacity'; reference: null; orderId: null };

interface Row {
  id: number;
  reference: string;
  google_sub: string;
}

export class OrderService {
  constructor(private db: Db, private maxPerDay: number, private maxTotalPerDay: number) {}

  async submit(sub: string, email: string, websiteUrl: string, idempotencyKey: string, privacyVersion: string, terms: AcceptedTerms, now: number): Promise<OrderResult> {
    const same = await this.byKey(idempotencyKey, sub);
    if (same !== null) return same;
    const daySince = utcText(now - 86400);
    for (let attempt = 0; ; attempt++) {
      const reference = newReference();
      try {
        const [inserted] = await this.db.batch<{ id: number }>([
          [`INSERT INTO orders (reference, idempotency_key, google_sub, email, website_url, privacy_version, terms_version, terms_accepted_at, status, created_at,
              business_confirmed, marketing_consent, declarations)
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?10, ?11, 'received', ?7, 1, 0, ?12
            WHERE NOT EXISTS (SELECT 1 FROM orders WHERE idempotency_key = ?2)
              AND (SELECT COUNT(*) FROM orders WHERE google_sub = ?3 AND created_at >= ?8) < ?9
              AND (SELECT COUNT(*) FROM orders WHERE created_at >= ?8) < ?13
            RETURNING id`,
          [reference, idempotencyKey, sub, email, websiteUrl, privacyVersion, utcText(now), daySince, this.maxPerDay, terms.version, utcText(terms.at),
            declarationsText(), this.maxTotalPerDay]],
          [`INSERT INTO notifications (order_id, status, attempts, next_attempt_at, created_at)
            SELECT id, 'pending', 0, ?2, ?2 FROM orders WHERE reference = ?1`, [reference, utcText(now)]],
        ]);
        const id = inserted?.[0]?.id;
        if (id !== undefined) return { result: 'created', reference, orderId: id };
        break;
      } catch (e) {
        /* Referenz zufällig schon vergeben (40 Bit): einmal mit neuer Referenz wiederholen */
        if (attempt === 0 && isUniqueViolation(e) && /orders\.reference/.test((e as Error).message)) continue;
        throw e;
      }
    }
    /* Nicht angelegt: gleiche Absendung (parallel), Tageslimit des Kontos oder Tagesgrenze insgesamt */
    const raced = await this.byKey(idempotencyKey, sub);
    if (raced !== null) return raced;
    const own = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM orders WHERE google_sub = ?1 AND created_at >= ?2', [sub, daySince]);
    if ((own?.n ?? 0) >= this.maxPerDay) return { result: 'limit', reference: null, orderId: null };
    return { result: 'capacity', reference: null, orderId: null };
  }

  /* Gleiche Absendung erneut (Doppelklick, Neuladen): gleiche Referenz, nichts Neues */
  private async byKey(idempotencyKey: string, sub: string): Promise<OrderResult | null> {
    const row = await this.db.first<Row>('SELECT id, reference, google_sub FROM orders WHERE idempotency_key = ?1', [idempotencyKey]);
    if (row === null) return null;
    if (!safeEqual(row.google_sub, sub)) throw new StorageError('Idempotenzschlüssel gehört zu einem anderen Konto');
    return { result: 'idempotent', reference: row.reference, orderId: row.id };
  }
}

/* Löschung nach Frist (Entscheidung des Auftraggebers 04.11.2026: vier Monate, ORDER_RETENTION_DAYS = 120): Jeder Auftrag wird
   samt interner Benachrichtigung gelöscht, wenn sein Eingang länger als die Frist zurückliegt – unabhängig vom Bearbeitungsstand
   (Bearbeitung und Versand des Berichts dauern laut AGB höchstens Wochen). Werbeeinwilligungen (marketing_consents) bleiben bis
   zum Widerruf; sie enthalten keine Website-Adresse. Läuft im Cron (alle fünf Minuten). */
export async function purgeOrders(db: Db, days: number, now: number): Promise<number> {
  const before = utcText(now - days * 86400);
  const [, deleted] = await db.batch<{ id: number }>([
    ['DELETE FROM notifications WHERE order_id IN (SELECT id FROM orders WHERE created_at < ?1)', [before]],
    ['DELETE FROM orders WHERE created_at < ?1 RETURNING id', [before]],
  ]);
  return deleted?.length ?? 0;
}

/* Referenz wie PXA-7K3M-Q9TD (Crockford-Base32 ohne I, L, O, U) */
export function newReference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const s = [...randomBytes(8)].map(b => alphabet[b & 31]).join('');
  return `PXA-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}
