import { hmacHex } from './crypto';
import type { Db } from './db';

/* Feste Zeitfenster je Schlüssel. Schlüssel werden mit HMAC pseudonymisiert,
   IP-Adressen landen daher nie im Klartext in der Datenbank. Alte Fenster löscht der Cron-Lauf. */
export class RateLimiter {
  constructor(private db: Db, private secret: string) {}

  /** rule: [maximale Anzahl, Fenster in Sekunden] */
  async allow(action: string, subject: string, [max, window]: readonly [number, number], now: number): Promise<boolean> {
    const bucket = action + ':' + (await hmacHex(this.secret, subject)).slice(0, 40);
    const start = Math.floor(now / window) * window;
    /* Ein Statement: Zählen und Lesen sind atomar, auch bei parallelen Anfragen */
    const row = await this.db.first<{ hits: number }>(
      'INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?1, ?2, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits',
      [bucket, start]);
    return (row?.hits ?? Infinity) <= max;
  }
}
