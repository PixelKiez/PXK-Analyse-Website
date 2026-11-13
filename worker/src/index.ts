import { handle } from './app';
import { type Config, type Env, loadConfig, parseRetentionDays } from './config';
import { Db, nowSec } from './db';
import { ConfigError } from './errors';
import { MailApi, Notifier } from './notifier';
import { purgeOrders } from './orders';

/* 360°Pixelkiez – privater API-Worker (Cloudflare Workers + D1), erreichbar nur über das Service Binding der Pages Function.
   fetch: Anfrageablauf unter /api/*. scheduled (Cron, alle 5 Minuten): fällige interne Benachrichtigungen
   wiederholen, abgelaufene Sessions und alte Rate-Limit-Fenster löschen und Aufträge nach der Löschfrist (ORDER_RETENTION_DAYS,
   vier Monate) entfernen. Das Log nennt nur Anzahlen, keine Adressen. */
export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  /* Aufräumen und Löschfrist brauchen nur D1 und ORDER_RETENTION_DAYS: Sie laufen auch bei sonst ungültiger Konfiguration
     (API gesperrt, z. B. Rückfallversion mit ENTWURF), damit kein Auftrag länger als zugesagt gespeichert bleibt. Mails gehen nur mit
     gültiger Konfiguration hinaus; deren Fehler beendet den Lauf danach weiter als Ausnahme (sichtbar im Cron-Status). */
  async scheduled(_event, env, _ctx) {
    if (!env.DB) throw new ConfigError('Ungültige oder fehlende Werte: DB');
    let config: Config | null = null;
    let configError: ConfigError | null = null;
    try {
      config = loadConfig(env);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      configError = e;
    }
    const db = new Db(env.DB);
    const now = nowSec();
    const result = config ? await new Notifier(db, new MailApi(config.mail), config.mail.notifyTo).deliverDue(now) : null;
    const sessions = await db.run('DELETE FROM sessions WHERE expires_at <= ?1', [now]);
    const limits = await db.run('DELETE FROM rate_limits WHERE window_start < ?1', [now - 86400]);
    const retentionDays = config ? config.retentionDays : parseRetentionDays(env.ORDER_RETENTION_DAYS);
    const purged = retentionDays === null ? 'Löschfrist nicht aktiv'
      : Number.isNaN(retentionDays) ? 'Löschfrist ungültig, nichts gelöscht'
      : `${await purgeOrders(db, retentionDays, now)} Aufträge nach Ablauf der Löschfrist gelöscht`;
    const delivery = result ? `${result.sent} versendet, ${result.failed} fehlgeschlagen, ${result.busy} übersprungen` : 'Versand pausiert (Konfiguration ungültig)';
    console.log(`PXWA: ${delivery}. ${sessions} Sessions und ${limits} Rate-Limit-Fenster gelöscht. ${purged}.`);
    if (configError) throw configError;
  },
} satisfies ExportedHandler<Env>;
