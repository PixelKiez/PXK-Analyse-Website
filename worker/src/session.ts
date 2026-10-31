import { b64url, randomBytes, randomHex, sha256Hex } from './crypto';
import type { Db } from './db';

/* Serverseitige Sessions in D1. Das Cookie trägt nur eine zufällige ID (256 Bit); gespeichert wird ihr SHA-256-Hash,
   die ID selbst steht nirgends in der Datenbank. Unbekannte oder abgelaufene IDs werden nie übernommen.
   Tokens von Google landen nie in der Session. Abgelaufene Zeilen löscht der Cron-Lauf. */

/* AGB-Zustimmung aus dem Hero: serverseitig vor der Google-Anmeldung erfasst. url ist die normalisierte Website,
   version die beim Absenden gültige AGB-Version, at der Zeitpunkt laut Server (nie aus dem Formular). */
export interface Consent {
  url: string;
  version: string;
  at: number;
}

/* Eine laufende Google-Anmeldung. Zustimmung und Idempotenzschlüssel hängen an genau diesem state: Der Callback, der den
   Flow aus der Session entfernt, legt damit höchstens einen Auftrag an. */
export interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
  at: number;
  idem: string;
  consent: Consent;
}

export interface SessionData {
  csrf: string;
  oidc?: OidcFlow;
  /* Zuletzt eingegebene Website, nur zum Vorausfüllen, falls die Anmeldung abgebrochen wird */
  pending?: { url: string; at: number };
  done?: { reference: string; url: string; email: string; kind: 'created' | 'duplicate' };
}

export interface Session {
  id: string;
  idHash: string;
  data: SessionData;
  version: number;
}

export class Sessions {
  constructor(private db: Db, private ttl: number) {}

  async load(id: string | null, now: number): Promise<Session | null> {
    if (id === null || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const idHash = await sha256Hex(id);
    const row = await this.db.first<{ data: string; version: number }>(
      'SELECT data, version FROM sessions WHERE id_hash = ?1 AND expires_at > ?2', [idHash, now]);
    if (row === null) return null;
    let data: SessionData;
    try {
      data = JSON.parse(row.data) as SessionData;
    } catch {
      return null;
    }
    return typeof data?.csrf === 'string' ? { id, idHash, data, version: row.version } : null;
  }

  async create(data: Omit<SessionData, 'csrf'>, now: number): Promise<Session> {
    const s = await this.fresh(data);
    await this.db.run('INSERT INTO sessions (id_hash, data, version, created_at, expires_at) VALUES (?1, ?2, 0, ?3, ?4)',
      [s.idHash, JSON.stringify(s.data), now, now + this.ttl]);
    return s;
  }

  async save(s: Session): Promise<void> {
    await this.db.run('UPDATE sessions SET data = ?1, version = version + 1 WHERE id_hash = ?2', [JSON.stringify(s.data), s.idHash]);
    s.version++;
  }

  /* Speichert nur, wenn niemand die Session seit dem Laden geändert hat (z. B. state nur einmal einlösbar) */
  async saveIfUnchanged(s: Session): Promise<boolean> {
    const changed = await this.db.run('UPDATE sessions SET data = ?1, version = version + 1 WHERE id_hash = ?2 AND version = ?3',
      [JSON.stringify(s.data), s.idHash, s.version]);
    s.version++;
    return changed === 1;
  }

  /* Neue ID nach dem Login (Schutz vor Session-Fixation); alte Zeile wird in derselben Transaktion gelöscht */
  async rotate(old: Session, data: Omit<SessionData, 'csrf'>, now: number): Promise<Session> {
    const s = await this.fresh(data);
    await this.db.batch([
      ['INSERT INTO sessions (id_hash, data, version, created_at, expires_at) VALUES (?1, ?2, 0, ?3, ?4)', [s.idHash, JSON.stringify(s.data), now, now + this.ttl]],
      ['DELETE FROM sessions WHERE id_hash = ?1', [old.idHash]],
    ]);
    return s;
  }

  async destroy(s: Session): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE id_hash = ?1', [s.idHash]);
  }

  private async fresh(data: Omit<SessionData, 'csrf'>): Promise<Session> {
    const id = b64url(randomBytes(32));
    return { id, idHash: await sha256Hex(id), data: { ...data, csrf: randomHex(32) }, version: 0 };
  }
}
