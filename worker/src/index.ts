import { handle } from './app';
import { type Env, loadConfig } from './config';
import { Db, nowSec } from './db';
import { MailApi, Notifier } from './notifier';
import { purgeOrders } from './orders';

/* 360°Pixelkiez – privater API-Worker (Cloudflare Workers + D1), erreichbar nur über das Service Binding der Pages Function.
   fetch: Anfrageablauf unter /api/*. scheduled (Cron, alle 5 Minuten): fällige interne Benachrichtigungen
   wiederholen, abgelaufene Sessions und alte Rate-Limit-Fenster löschen und Aufträge nach der Löschfrist (ORDER_RETENTION_DAYS,
   vier Monate) entfernen. Das Log nennt nur Anzahlen, keine Adressen. */
export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  async scheduled(_event, env, _ctx) {
    const config = loadConfig(env);
    const db = new Db(config.db);
    const now = nowSec();
    const result = await new Notifier(db, new MailApi(config.mail), config.mail.notifyTo).deliverDue(now);
    const sessions = await db.run('DELETE FROM sessions WHERE expires_at <= ?1', [now]);
    const limits = await db.run('DELETE FROM rate_limits WHERE window_start < ?1', [now - 86400]);
    const purged = config.retentionDays === null ? 'Löschfrist nicht aktiv' : `${await purgeOrders(db, config.retentionDays, now)} Aufträge nach Ablauf der Löschfrist gelöscht`;
    console.log(`PXWA: ${result.sent} versendet, ${result.failed} fehlgeschlagen, ${result.busy} übersprungen. ${sessions} Sessions und ${limits} Rate-Limit-Fenster gelöscht. ${purged}.`);
  },
} satisfies ExportedHandler<Env>;
