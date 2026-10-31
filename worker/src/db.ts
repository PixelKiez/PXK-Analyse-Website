import { StorageError } from './errors';

/* D1-Zugriff ausschließlich über vorbereitete Statements. Fehler werden zu StorageError; die Meldung enthält
   höchstens Tabellen- und Spaltennamen (SQLite nennt keine gebundenen Werte). */
export type Param = string | number | null;

export class Db {
  constructor(private d1: D1Database) {}

  async first<T>(sql: string, params: Param[] = []): Promise<T | null> {
    return this.guard(() => this.d1.prepare(sql).bind(...params).first<T>());
  }

  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.guard(async () => (await this.d1.prepare(sql).bind(...params).all<T>()).results);
  }

  /* Anzahl geänderter Zeilen */
  async run(sql: string, params: Param[] = []): Promise<number> {
    return this.guard(async () => (await this.d1.prepare(sql).bind(...params).run()).meta.changes);
  }

  /* Mehrere Statements als eine Transaktion: scheitert eines, wird alles zurückgerollt */
  async batch<T>(statements: [string, Param[]][]): Promise<T[][]> {
    return this.guard(async () => (await this.d1.batch<T>(statements.map(([sql, params]) => this.d1.prepare(sql).bind(...params)))).map(r => r.results));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new StorageError('Datenbankfehler (' + String(e instanceof Error ? e.message : e).replace(/\s+/g, ' ').slice(0, 160) + ')');
    }
  }
}

export const isUniqueViolation = (e: unknown): boolean => e instanceof StorageError && /UNIQUE constraint failed/.test(e.message);

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/* UTC-Text 'YYYY-MM-DD HH:MM:SS' für Aufträge und Benachrichtigungen (lesbar bei der manuellen Bearbeitung) */
export const utcText = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');
