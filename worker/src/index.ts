import { handle } from './app';
import { type Env, loadConfig } from './config';
import { Db, nowSec } from './db';
import { MailApi, Notifier } from './notifier';

/* 360°Pixelkiez – API-Worker (Cloudflare Workers + D1).
   fetch: Anfrageablauf unter /api/*. scheduled (Cron, alle 5 Minuten): fällige interne Benachrichtigungen
   wiederholen und abgelaufene Sessions sowie alte Rate-Limit-Fenster löschen. Aufträge löscht der Lauf nicht
   (Aufbewahrungsfrist ist offen). Das Log nennt nur Anzahlen, keine Adressen. */
export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  async scheduled(_event, env, _ctx) {
    const config = loadConfig(env);
    const db = new Db(config.db);
    const now = nowSec();
    const result = await new Notifier(db, new MailApi(config.mail), config.mail.notifyTo).deliverDue(now);
    const sessions = await db.run('DELETE FROM sessions WHERE expires_at <= ?1', [now]);
    const limits = await db.run('DELETE FROM rate_limits WHERE window_start < ?1', [now - 86400]);
    console.log(`PXWA: ${result.sent} versendet, ${result.failed} fehlgeschlagen. ${sessions} Sessions und ${limits} Rate-Limit-Fenster gelöscht.`);
  },
} satisfies ExportedHandler<Env>;
