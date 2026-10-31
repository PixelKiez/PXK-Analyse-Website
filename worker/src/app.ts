import { type Config, type Env, LIMITS, loadConfig } from './config';
import { b64url, randomBytes, randomHex, safeEqual } from './crypto';
import { Db, nowSec } from './db';
import { AuthError, ConfigError, StorageError } from './errors';
import { clientIp, readCookie, readForm, sameOrigin, securityHeaders, sessionCookie, cookieName } from './http';
import { MailApi, Notifier } from './notifier';
import { GoogleOidc } from './oidc';
import { OrderService } from './orders';
import { RateLimiter } from './ratelimit';
import { type Identity, type Session, Sessions } from './session';
import { normalizeWebsite } from './url';
import { View } from './view';

/* Ablauf: URL eingeben (start) → Google-Anmeldung (callback) → bestätigen (confirm) → angenommen.
   Zustand liegt ausschließlich in der serverseitigen Session (D1); Tokens werden nie gespeichert.
   Routen (über die Pages Function /api/* und das Service Binding): /api/anfrage (GET, POST) und /api/auth/callback (GET).
   Die Anfrage-URL ist die Original-URL der Website (https://360.pixelkiez.de/…); andere Hosts werden abgewiesen. */

const log = (message: string): void => console.error('PXWA: ' + message);

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
      case 'confirm': return this.confirm(session, form);
      case 'logout': return this.logout(session, form);
      default: return this.start(session, form);
    }
  }

  private async show(session: Session | null, error: string | null = null, status = 200): Promise<Response> {
    const identity = this.identity(session);
    const pending = session?.data.pending;
    const done = session?.data.done;
    if (session && done) return this.respond(200, this.view.accepted(done.reference, done.url, done.email, done.kind));
    if (session && identity && pending) {
      session.data.idem = randomHex(16);
      await this.sessions.save(session);
      return this.respond(status, this.view.confirm(pending.url, identity.email, session.data.csrf, session.data.idem, error));
    }
    return this.respond(status, this.view.input(pending?.url ?? '', null, pending ? 'Bitte melden Sie sich mit Google an, um die Anfrage fortzusetzen.' : null));
  }

  private async start(session: Session | null, form: URLSearchParams): Promise<Response> {
    if (!(await this.limiter().allow('start', clientIp(this.request), LIMITS.startPerIp, this.now))) {
      return this.respond(429, this.view.error('Zu viele Versuche', 'Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.'));
    }
    const raw = form.get('website') ?? '';
    const url = normalizeWebsite(raw);
    if (url === null) {
      return this.respond(422, this.view.input([...raw].slice(0, 300).join(''), 'Bitte geben Sie eine öffentliche Website-Adresse wie beispiel.de ein.'));
    }
    const s = session ?? (await this.newSession());
    delete s.data.done;
    delete s.data.idem;
    s.data.pending = { url, at: this.now };
    if (this.identity(s)) {
      await this.sessions.save(s);
      return this.redirect(this.config.baseUrl + '/api/anfrage');
    }
    const state = randomHex(32);
    const nonce = randomHex(32);
    const verifier = b64url(randomBytes(48));
    s.data.oidc = { state, nonce, verifier, at: this.now };
    await this.sessions.save(s);
    return this.redirect(await this.oidc().authorizationUrl(state, nonce, verifier));
  }

  private async confirm(session: Session | null, form: URLSearchParams): Promise<Response> {
    const csrf = form.get('csrf');
    if (!session || csrf === null || !safeEqual(session.data.csrf, csrf)) {
      return this.respond(403, this.view.error('Sitzung abgelaufen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/api/anfrage'));
    }
    const idem = form.get('idem');
    /* Gleiche Absendung nach Erfolg (Doppelklick, Zurück + erneut senden): gleiche Bestätigung, nichts Neues */
    if (session.data.done && idem !== null && safeEqual(session.data.done.idem, idem)) return this.redirect(this.config.baseUrl + '/api/anfrage');
    const identity = this.identity(session);
    const pending = session.data.pending;
    if (!identity || !pending) {
      return this.respond(403, this.view.input(pending?.url ?? '', null, 'Bitte melden Sie sich zuerst mit Google an.'));
    }
    if (idem === null || session.data.idem === undefined || !safeEqual(session.data.idem, idem)) {
      return this.respond(409, this.view.error('Formular veraltet', 'Bitte bestätigen Sie die Anfrage noch einmal.', 'Zur Bestätigung', '/api/anfrage'));
    }
    if (form.get('zustimmung') !== '1') return this.show(session, 'Bitte bestätigen Sie die Anfrage mit dem Häkchen.', 422);
    if (!(await this.limiter().allow('confirm', clientIp(this.request), LIMITS.confirmPerIp, this.now))) {
      return this.respond(429, this.view.error('Zu viele Versuche', 'Bitte warten Sie und versuchen Sie es später erneut.'));
    }
    const orders = new OrderService(this.db, LIMITS.duplicateDays, LIMITS.ordersPerAccountDay);
    const r = await orders.submit(identity.sub, identity.email, pending.url, idem, this.config.privacyVersion, this.now);
    if (r.result === 'limit') {
      return this.respond(429, this.view.error('Tageslimit erreicht', 'Mit diesem Google-Konto sind heute bereits mehrere Anfragen eingegangen. Bitte versuchen Sie es morgen erneut.'));
    }
    if (r.result === 'created') {
      /* Auftrag ist gespeichert. Mail- oder Datenbankfehler beim Versand ändern daran nichts und dürfen keine
         Fehlerseite auslösen; die Benachrichtigung bleibt in der Outbox und wird vom Cron-Lauf wiederholt. */
      const notifier = new Notifier(this.db, new MailApi(this.config.mail), this.config.mail.notifyTo);
      this.ctx.waitUntil(notifier.deliver(r.orderId, this.now).catch(e => {
        log(`Benachrichtigung zu ${r.reference} nicht sofort abgeschlossen (${e instanceof Error ? e.name : 'Fehler'}), Cron wiederholt`);
      }));
    }
    session.data.done = { reference: r.reference, url: pending.url, email: identity.email, idem, kind: r.result === 'duplicate' ? 'duplicate' : 'created' };
    delete session.data.pending;
    await this.sessions.save(session);
    return this.redirect(this.config.baseUrl + '/api/anfrage');
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
    let flow = session?.data.oidc ?? null;
    if (session && flow) {
      /* state ist nur einmal gültig: Nur der Aufruf, der ihn aus der Session entfernt, darf ihn verwenden */
      delete session.data.oidc;
      if (!(await this.sessions.saveIfUnchanged(session))) flow = null;
    }
    if (!(await this.limiter().allow('callback', clientIp(this.request), LIMITS.callbackPerIp, this.now))) {
      return this.respond(429, this.view.error('Zu viele Versuche', 'Bitte warten Sie einige Minuten und versuchen Sie es dann erneut.'));
    }
    const q = url.searchParams;
    if (q.has('error')) {
      return this.respond(400, this.view.error('Anmeldung abgebrochen', 'Ohne Google-Anmeldung können wir die Anfrage nicht annehmen. Sie können es jederzeit erneut versuchen.', 'Erneut versuchen', '/api/anfrage'));
    }
    const state = q.get('state');
    const code = q.get('code');
    if (!session || !flow || state === null || !safeEqual(flow.state, state) || flow.at < this.now - LIMITS.stateTtl) {
      log('Google-Rückkehr ohne gültigen state');
      return this.respond(400, this.view.error('Anmeldung abgelaufen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/api/anfrage'));
    }
    if (code === null || code === '' || code.length > 2048) {
      return this.respond(400, this.view.error('Anmeldung fehlgeschlagen', 'Bitte starten Sie die Anfrage erneut.', 'Neu starten', '/api/anfrage'));
    }
    let user: { sub: string; email: string };
    try {
      user = await this.oidc().authenticate(code, flow.verifier, flow.nonce);
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      log(e.message);
      return this.respond(401, this.view.error('Anmeldung nicht bestätigt', 'Ihre Google-Anmeldung konnte nicht bestätigt werden. Bitte versuchen Sie es erneut.', 'Erneut versuchen', '/api/anfrage'));
    }
    /* Neue Session-ID nach dem Login (Schutz vor Session-Fixation) */
    const { csrf: _old, ...data } = session.data;
    const fresh = await this.sessions.rotate(session, { ...data, identity: { sub: user.sub, email: user.email, at: this.now } }, this.now);
    this.setSessionCookie(fresh);
    return this.redirect(this.config.baseUrl + '/api/anfrage');
  }

  /* Bestätigte Anmeldung gilt nur, solange sie jünger als loginTtl ist */
  private identity(session: Session | null): Identity | null {
    const i = session?.data.identity;
    return i && i.at >= this.now - LIMITS.loginTtl ? i : null;
  }

  private async newSession(): Promise<Session> {
    const s = await this.sessions.create({}, this.now);
    this.setSessionCookie(s);
    return s;
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
