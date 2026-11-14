import { type Config, type Env, LIMITS, loadConfig } from './config';
import { b64url, randomBytes, randomHex, safeEqual } from './crypto';
import { Db, nowSec } from './db';
import { AuthError, ConfigError, StorageError } from './errors';
import { clientIp, readCookie, readForm, sameOrigin, securityHeaders, sessionCookie, cookieName } from './http';
import { MailApi, Notifier } from './notifier';
import { GoogleOidc } from './oidc';
import { OrderService } from './orders';
import { RateLimiter } from './ratelimit';
import { type Session, Sessions } from './session';
import { normalizeWebsite } from './url';
import { View } from './view';

/* Ablauf (PO-Entscheidung 12.11.2026): Website-Adresse im Hero, „Analysieren“ (adresse) → Bestätigungsseite mit genau einem
   Pflichtkästchen, „Mit Google anmelden“ (start) → Google-Anmeldung → Rückkehr (callback) legt den Auftrag an →
   Eingangsbestätigung mit Referenz. adresse prüft die Website und hält sie nur für die Bestätigungsseite in der Session (POST,
   nie in einer URL, nie an Google). start erfasst die Zustimmung serverseitig (Version, Zeitpunkt, normalisierte Website) und
   bindet sie an genau diese Google-Anmeldung (state) in dieser Session. Nur ein gültiger Callback mit gültiger, aktueller
   Zustimmung speichert höchstens einen Auftrag samt Outbox-Eintrag; die Google-Anmeldung allein erzeugt weder Auftrag noch Mail.
   Zustand liegt ausschließlich in der serverseitigen Session (D1); Tokens werden nie gespeichert.
   Routen (über die Pages Function /api/* und das Service Binding): /api/anfrage (GET, POST) und /api/auth/callback (GET).
   Die Anfrage-URL ist die Original-URL der Website (https://360.pixelkiez.de/…); andere Hosts werden abgewiesen. */

const log = (message: string): void => console.error('PXWA: ' + message);
/* Fehlertexte der Formulare (der Hero zeigt mit JavaScript denselben Text zur Adresse) */
const URL_ERROR = 'Bitte geben Sie eine öffentliche Website-Adresse wie beispiel.de ein.';
const CONFIRM_ERROR = 'Bitte bestätigen Sie das Kästchen, um mit Google fortzufahren.';
const SESSION_ERROR = 'Ihre Sitzung ist abgelaufen oder die Website-Adresse hat sich geändert. Bitte geben Sie die Adresse erneut ein.';

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log(e.message);
    const headers = securityHeaders(new URL(request.url).protocol === 'https:', 'https://accounts.google.com');
    return page(503, new View().error('Gerade nicht verfügbar', 'Anfragen sind im Moment nicht möglich. Bitte versuchen Sie es später erneut.'), headers);
  }
  return new App(config, request, ctx).run();
}

class App {
  private readonly view: View;
  private readonly db: Db;
  private readonly sessions: Sessions;
  private readonly headers: Headers;
  private readonly now = nowSec();

  constructor(private config: Config, private request: Request, private ctx: ExecutionContext) {
    this.view = new View(config.basePath);
    this.db = new Db(config.db);
    this.sessions = new Sessions(this.db, LIMITS.sessionTtl);
    this.headers = securityHeaders(config.secure, new URL(config.google.authEndpoint).origin);
  }

  async run(): Promise<Response> {
    const url = new URL(this.request.url);
    /* Session-Cookie (__Host-) und Origin gelten nur für den Host der Basis-URL. Auf Alias-Hosts nicht starten.
       Ziel ist immer ein fester Pfad, nie der eingehende Host oder Pfad. */
    if (url.host !== this.config.host) {
      if (['GET', 'HEAD'].includes(this.request.method)) return this.redirect(this.config.baseUrl + '/api/anfrage', 301);
      return this.respond(403, this.view.error('Anfrage abgelehnt', 'Bitte starten Sie die Anfrage direkt auf dieser Website.'));
    }
    const path = url.pathname.startsWith(this.config.basePath + '/') ? url.pathname.slice(this.config.basePath.length) : url.pathname;
    try {
      if (path === '/api/anfrage') return await this.anfrage();
      if (path === '/api/auth/callback') return await this.callback(url);
      return this.respond(404, this.view.error('Nicht gefunden', 'Diese Seite gibt es nicht.'));
    } catch (e) {
      if (e instanceof StorageError) {
        log(e.message);
        return this.respond(503, this.view.error('Gerade nicht verfügbar', 'Ihre Anfrage konnte nicht verarbeitet werden. Bitte versuchen Sie es später erneut.'));
      }
      /* Nur Klasse loggen – Nachrichten können Eingaben enthalten */
      log('Unerwarteter Fehler ' + (e instanceof Error ? e.name : typeof e));
      return this.respond(500, this.view.error('Fehler', 'Etwas ist schiefgelaufen. Bitte versuchen Sie es später erneut.'));
    }
  }

  /* /api/anfrage */
  private async anfrage(): Promise<Response> {
    const method = this.request.method;
    if (method !== 'GET' && method !== 'POST') {
      this.headers.set('Allow', 'GET, POST');
      return this.respond(405, this.view.error('Nicht erlaubt', 'Diese Aktion ist nicht möglich.'));
    }
    if (method === 'POST' && !sameOrigin(this.request, this.config.origin)) {
      return this.respond(403, this.view.error('Anfrage abgelehnt', 'Bitte starten Sie die Anfrage direkt auf dieser Website.'));
    }
    const form = method === 'POST' ? await readForm(this.request) : new URLSearchParams();
    if (form === null) return this.respond(413, this.view.error('Anfrage zu groß', 'Bitte geben Sie nur die Adresse Ihrer Website ein.'));
    /* Ohne Cookie kein Datenbankzugriff: Die Eingabeseite funktioniert auch bei gestörter Datenbank */
    const session = await this.sessions.load(readCookie(this.request, cookieName(this.config.secure)), this.now);
    if (method === 'GET') return this.show(session);
    switch (form.get('action') ?? 'start') {
      case 'adresse': return this.address(session, form);
      case 'start': return this.start(session, form);
      case 'logout': return this.logout(session, form);
      /* Unbekannte Aktionen (auch das frühere „confirm“) legen nie etwas an */
      default: return this.respond(400, this.view.error('Nicht möglich', 'Diese Aktion gibt es nicht. Bitte starten Sie die Anfrage auf der Startseite.'));
    }
  }

  /* GET: Eingangsbestätigung, sonst Bestätigungsseite zur eingegebenen Website, sonst Adresseingabe (z. B. Sitzung abgelaufen) */
  private show(session: Session | null): Response {
    const done = session?.data.done;
    if (done) return this.respond(200, this.view.accepted(done.reference, done.url, done.email));
    const pending = session?.data.pending;
    if (!pending) return this.respond(200, this.view.address());
    return this.respond(200, this.view.confirm(this.config.termsVersion, pending.url, null,
      pending.login ? 'Die Google-Anmeldung wurde nicht abgeschlossen. Es wurde keine Anfrage gespeichert. Bitte bestätigen Sie erneut und fahren Sie mit Google fort.' : null));
  }

  /* „Analysieren“ im Hero: Website prüfen und für die Bestätigungsseite in der Session halten, dann dorthin (POST-Redirect-GET:
     Neuladen und Zurück aus Google senden nichts erneut). Keine Zustimmung, keine Google-Weiterleitung. Ein offener Flow samt
     Zustimmung zu einer früheren Adresse verfällt. */
  private async address(session: Session | null, form: URLSearchParams): Promise<Response> {
    if (!(await this.limiter().allow('adresse', clientIp(this.request), LIMITS.addressPerIp, this.now))) {
      return this.respond(429, this.view.error('Zu viele Versuche', 'Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.'));
    }
    const raw = form.get('website') ?? '';
    const url = normalizeWebsite(raw);
    if (url === null) return this.respond(422, this.view.address([...raw].slice(0, 300).join(''), URL_ERROR));
    const pending = { url, at: this.now };
    if (session) {
      delete session.data.done;
      delete session.data.oidc;
      session.data.pending = pending;
      await this.sessions.save(session);
    } else {
      this.setSessionCookie(await this.sessions.create({ pending }, this.now));
    }
    return this.redirect(this.config.baseUrl + '/api/anfrage');
  }

  /* „Mit Google anmelden“ auf der Bestätigungsseite */
  private async start(session: Session | null, form: URLSearchParams): Promise<Response> {
    if (!(await this.limiter().allow('start', clientIp(this.request), LIMITS.startPerIp, this.now))) {
      return this.respond(429, this.view.error('Zu viele Versuche', 'Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.'));
    }
    const raw = form.get('website') ?? '';
    const url = normalizeWebsite(raw);
    if (url === null) return this.respond(422, this.view.address([...raw].slice(0, 300).join(''), URL_ERROR));
    /* Nur die Website, die „Analysieren“ in dieser Session abgelegt und die Bestätigungsseite angezeigt hat. Ohne passende Session
       (keine, abgelaufen, andere Website im Formular) weder Zustimmung noch Google noch eine neue Session: Adresse neu eingeben. */
    const pending = session?.data.pending;
    if (!session || !pending || typeof pending.url !== 'string' || !safeEqual(pending.url, url)) {
      return this.respond(409, this.view.address('', SESSION_ERROR));
    }
    /* Das eine Kästchen genau "1", und die abgeschickte Seite muss die aktuelle AGB-Version gezeigt haben. Ohne das weder
       Zustimmung noch Weiterleitung zu Google – die Website-Adresse verlässt den Server nicht. Andere Felder (frühere Kästchen,
       eine Werbeeinwilligung) werden nicht ausgewertet: Eine Werbeeinwilligung entsteht hier nie. */
    const confirmed = form.get('bestaetigung') === '1';
    const shown = form.get('agb_version');
    const current = shown !== null && safeEqual(shown, this.config.termsVersion);
    if (!confirmed || !current) {
      const error = !confirmed ? CONFIRM_ERROR : 'Die AGB wurden aktualisiert. Bitte lesen Sie die aktuelle Fassung und bestätigen Sie sie erneut.';
      return this.respond(confirmed ? 409 : 422, this.view.confirm(this.config.termsVersion, url, error));
    }
    delete session.data.done;
    session.data.pending = { url, at: this.now, login: true };
    const state = randomHex(32);
    const nonce = randomHex(32);
    const verifier = b64url(randomBytes(48));
    /* Ein neuer Start ersetzt einen offenen Flow samt Zustimmung: dessen state wird damit ungültig */
    session.data.oidc = { state, nonce, verifier, at: this.now, idem: randomHex(16), consent: { url, version: this.config.termsVersion, at: this.now, business: true } };
    await this.sessions.save(session);
    return this.redirect(await this.oidc().authorizationUrl(state, nonce, verifier));
  }

  private async logout(session: Session | null, form: URLSearchParams): Promise<Response> {
    const csrf = form.get('csrf');
    if (session && csrf !== null && safeEqual(session.data.csrf, csrf)) {
      await this.sessions.destroy(session);
      this.headers.append('Set-Cookie', sessionCookie(this.config.secure, null, 0));
    }
    return this.redirect(this.config.baseUrl + '/index.html');
  }

  /* /api/auth/callback – Rückkehr von Google */
  private async callback(url: URL): Promise<Response> {
    if (this.request.method !== 'GET') {
      this.headers.set('Allow', 'GET');
      return this.respond(405, this.view.error('Nicht erlaubt', 'Diese Aktion ist nicht möglich.'));
    }
    const session = await this.sessions.load(readCookie(this.request, cookieName(this.config.secure)), this.now);
    const q = url.searchParams;
    const state = q.get('state');
    let flow = session?.data.oidc ?? null;
    if (session && flow && state !== null && safeEqual(flow.state, state)) {
      /* state ist nur einmal gültig: Nur der Aufruf, der ihn aus der Session entfernt, darf ihn verwenden (auch bei parallelen
         Rücksprüngen). Ein Rücksprung mit anderem state (z. B. veralteter Tab nach Doppelklick) lässt den laufenden Flow unberührt. */
      delete session.data.oidc;
      if (!(await this.sessions.saveIfUnchanged(session))) flow = null;
    } else {
      flow = null;
    }
    if (!(await this.limiter().allow('callback', clientIp(this.request), LIMITS.callbackPerIp, this.now))) {
      return this.respond(429, this.view.error('Zu viele Versuche', 'Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.'));
    }
    if (q.has('error')) {
      return this.respond(400, this.view.error('Anmeldung abgebrochen', 'Ohne Google-Anmeldung können wir die Anfrage nicht annehmen. Es wurde keine Anfrage gespeichert. Sie können es jederzeit erneut versuchen.', 'Erneut versuchen', '/api/anfrage'));
    }
    const code = q.get('code');
    if (!session || !flow || flow.at < this.now - LIMITS.stateTtl) {
      log('Google-Rückkehr ohne gültigen state');
      return this.respond(400, this.view.error('Anmeldung abgelaufen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/api/anfrage'));
    }
    if (code === null || code === '' || code.length > 2048) {
      return this.respond(400, this.view.error('Anmeldung fehlgeschlagen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/api/anfrage'));
    }
    /* AGB-Zustimmung dieses Flows: vorhanden, aktuelle Version, nicht abgelaufen. Vor dem Code-Austausch geprüft –
       ohne gültige Zustimmung wird der Google-Code gar nicht erst eingelöst. */
    const consent = flow.consent;
    if (!consent || typeof consent.url !== 'string' || normalizeWebsite(consent.url) !== consent.url
      || typeof consent.version !== 'string' || !safeEqual(consent.version, this.config.termsVersion)
      || !Number.isInteger(consent.at) || consent.at < this.now - LIMITS.consentTtl
      || consent.business !== true
      || typeof flow.idem !== 'string' || !/^[0-9a-f]{32}$/.test(flow.idem)) {
      log('Google-Rückkehr ohne gültige AGB-Zustimmung');
      return this.respond(409, this.view.error('Zustimmung nicht mehr gültig', 'Ihre Zustimmung zu den AGB ist abgelaufen oder die AGB wurden geändert. Es wurde keine Anfrage gespeichert. Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/api/anfrage'));
    }
    let user: { sub: string; email: string };
    try {
      user = await this.oidc().authenticate(code, flow.verifier, flow.nonce);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      log(e.message);
      return this.respond(401, this.view.error('Anmeldung nicht bestätigt', 'Ihre Google-Anmeldung konnte nicht bestätigt werden. Es wurde keine Anfrage gespeichert. Bitte versuchen Sie es erneut.', 'Erneut versuchen', '/api/anfrage'));
    }
    /* Kontrollierter Test: nur freigeschaltete Konten legen Aufträge an – nicht allein über den geschlossenen Hero */
    if (this.config.access.mode === 'testnutzer' && !this.config.access.allowlist.has(user.email)) {
      log('Google-Anmeldung ohne Freischaltung (Testbetrieb), kein Auftrag');
      return this.respond(403, this.view.error('Noch nicht freigeschaltet', 'Anfragen sind im Moment nur für freigeschaltete Testkonten möglich. Es wurde keine Anfrage gespeichert.'));
    }
    if (!(await this.limiter().allow('order', clientIp(this.request), LIMITS.orderPerIp, this.now))) {
      return this.respond(429, this.view.error('Zu viele Versuche', 'Bitte warten Sie und versuchen Sie es später erneut.'));
    }
    const orders = new OrderService(this.db, LIMITS.ordersPerAccountDay, LIMITS.ordersPerDay);
    const r = await orders.submit(user.sub, user.email, consent.url, flow.idem, this.config.privacyVersion, { version: consent.version, at: consent.at }, this.now);
    if (r.result === 'limit') {
      return this.respond(429, this.view.error('Tageslimit erreicht', 'Mit diesem Google-Konto sind heute bereits mehrere Anfragen eingegangen. Bitte versuchen Sie es morgen erneut.'));
    }
    if (r.result === 'capacity') {
      log('Tagesgrenze aller Aufträge erreicht, kein Auftrag');
      return this.respond(429, this.view.error('Gerade keine Anfragen möglich', 'Heute sind bereits sehr viele Anfragen eingegangen. Es wurde keine Anfrage gespeichert. Bitte versuchen Sie es morgen erneut.'));
    }
    if (r.result === 'created') {
      /* Auftrag ist gespeichert. Mail- oder Datenbankfehler beim Versand ändern daran nichts und dürfen keine
         Fehlerseite auslösen; die Benachrichtigung bleibt in der Outbox und wird vom Cron-Lauf wiederholt. */
      const notifier = new Notifier(this.db, new MailApi(this.config.mail), this.config.mail.notifyTo);
      this.ctx.waitUntil(notifier.deliver(r.orderId, this.now).catch(e => {
        log(`Benachrichtigung zu ${r.reference} nicht sofort abgeschlossen (${e instanceof Error ? e.name : 'Fehler'}), Cron wiederholt`);
      }));
    }
    /* Neue Session-ID nach der Anmeldung (Schutz vor Session-Fixation); sie trägt nur noch die Eingangsbestätigung */
    const done = { reference: r.reference, url: consent.url, email: user.email };
    const fresh = await this.sessions.rotate(session, { done }, this.now);
    this.setSessionCookie(fresh);
    return this.redirect(this.config.baseUrl + '/api/anfrage');
  }

  private setSessionCookie(s: Session): void {
    this.headers.append('Set-Cookie', sessionCookie(this.config.secure, s.id, LIMITS.sessionTtl));
  }

  private limiter(): RateLimiter {
    return new RateLimiter(this.db, this.config.secret);
  }

  private oidc(): GoogleOidc {
    return new GoogleOidc(this.config.google, this.config.redirectUri);
  }

  /* Weiterleitung nur auf fest konfigurierte Ziele (eigene Basis-URL oder Google-Autorisierung), nie auf Nutzereingaben */
  private redirect(location: string, status = 303): Response {
    this.headers.set('Location', location);
    return new Response(null, { status, headers: this.headers });
  }

  private respond(status: number, html: string): Response {
    return page(status, html, this.headers);
  }
}

function page(status: number, html: string, headers: Headers): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(html, { status, headers });
}
