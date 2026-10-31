import { ConfigError } from './errors';
import { isEmail } from './http';

/* Lädt und prüft die Konfiguration aus Bindings, Variablen und Secrets des Workers. Fehlerhafte Konfiguration führt zu
   ConfigError, die API antwortet dann mit 503, ohne Details preiszugeben. Das Log nennt nur Schlüsselnamen, nie Werte. */

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

/* Einzige produktive Adresse der Website (Cloudflare Pages, DNS bei Hostinger). Daraus folgt die
   Google-Weiterleitungs-URI https://360.pixelkiez.de/api/auth/callback. */
export const PRODUCTION_BASE_URL = 'https://360.pixelkiez.de';

/* Hosts der HTTPS-Mail-APIs, an die Auftragsdaten (E-Mail-Adresse, Website) gehen dürfen. Freigegeben ist nur Resend
   (Endpunkt /emails). Produktive Mails setzen zusätzlich die verifizierte Absenderdomain, den API-Key als Secret,
   den Auftragsverarbeitungsvertrag und die fertige Datenschutzerklärung voraus. */
export const AUTHORIZED_MAIL_API_HOSTS: readonly string[] = ['api.resend.com'];

/* Absender nur aus der eigenen Versanddomain (bei Resend zu verifizieren, getrennt von den Postfächern unter pixelkiez.de) */
export const AUTHORIZED_MAIL_FROM_DOMAINS: readonly string[] = ['notify.pixelkiez.de'];

/* Einziger Empfänger der internen Benachrichtigung in Produktion. MAIL_NOTIFY_TO muss diese Adresse sein (Groß-/Klein-
   schreibung egal, nur ASCII); versendet wird immer an genau diese Schreibweise. Jede andere Adresse sperrt die API. */
export const PRODUCTION_NOTIFY_TO = 'kontakt@pixelkiez.de';

export const LIMITS = {
  startPerIp: [20, 600],         // Anfragestarts je IP: 20 in 10 Minuten
  callbackPerIp: [30, 600],
  confirmPerIp: [10, 3600],
  ordersPerAccountDay: 5,
  duplicateDays: 30,             // gleiche Website + gleiches Google-Konto gilt so lange als Duplikat
  loginTtl: 1800,                // bestätigte Anmeldung gilt 30 Minuten für die Bestätigung
  stateTtl: 600,
  sessionTtl: 3600,              // Session (Cookie und D1-Zeile) läuft nach einer Stunde ab
} as const;

export interface Env {
  DB?: D1Database;
  ENV?: string;
  BASE_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /* Nur mit ENV=local überschreibbar (Tests mit Mock-Google) */
  GOOGLE_AUTH_ENDPOINT?: string;
  GOOGLE_TOKEN_ENDPOINT?: string;
  GOOGLE_JWKS_URI?: string;
  SECRET?: string;
  PRIVACY_VERSION?: string;
  MAIL_API_URL?: string;
  MAIL_API_TOKEN?: string;
  MAIL_FROM?: string;
  MAIL_NOTIFY_TO?: string;
  /* Löschfrist erledigter Aufträge in Tagen. Nicht gesetzt = keine Löschung (Aufbewahrungsfrist D-5 offen). */
  ORDER_RETENTION_DAYS?: string;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  authEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuers: readonly string[];
}

export interface MailConfig {
  apiUrl: string;
  apiToken: string;
  from: string;
  notifyTo: string;
}

export interface Config {
  production: boolean;
  baseUrl: string;
  basePath: string;
  origin: string;
  host: string;
  secure: boolean;
  google: GoogleConfig;
  redirectUri: string;
  secret: string;
  privacyVersion: string;
  mail: MailConfig;
  retentionDays: number | null;
  db: D1Database;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const parseUrl = (v: string): URL | null => {
  try {
    return new URL(v);
  } catch {
    return null;
  }
};

export function loadConfig(env: Env): Config {
  const missing: string[] = [];
  const mode = str(env.ENV);
  if (mode !== 'production' && mode !== 'local') missing.push('ENV');
  const production = mode === 'production';
  const local = mode === 'local';

  const baseUrl = str(env.BASE_URL);
  const base = parseUrl(baseUrl);
  if (!base || baseUrl.endsWith('/') || base.search || base.hash || base.username || base.password
    || !(base.protocol === 'https:' || (local && base.protocol === 'http:'))
    || (production && baseUrl !== PRODUCTION_BASE_URL)) {
    missing.push('BASE_URL');
  }

  const google: GoogleConfig = {
    clientId: str(env.GOOGLE_CLIENT_ID),
    clientSecret: str(env.GOOGLE_CLIENT_SECRET),
    authEndpoint: str(env.GOOGLE_AUTH_ENDPOINT) || GOOGLE_AUTH,
    tokenEndpoint: str(env.GOOGLE_TOKEN_ENDPOINT) || GOOGLE_TOKEN,
    jwksUri: str(env.GOOGLE_JWKS_URI) || GOOGLE_JWKS,
    issuers: GOOGLE_ISSUERS,
  };
  if (!google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  /* In Produktion nur die echten Google-Endpunkte – verhindert, dass Codes und Client-Secret an Dritte gehen */
  for (const [key, value, real] of [['GOOGLE_AUTH_ENDPOINT', google.authEndpoint, GOOGLE_AUTH], ['GOOGLE_TOKEN_ENDPOINT', google.tokenEndpoint, GOOGLE_TOKEN], ['GOOGLE_JWKS_URI', google.jwksUri, GOOGLE_JWKS]] as const) {
    if (production ? value !== real : !parseUrl(value)) missing.push(key);
  }

  const secret = typeof env.SECRET === 'string' ? env.SECRET : '';
  if (secret.length < 32) missing.push('SECRET');
  const privacyVersion = str(env.PRIVACY_VERSION);
  /* Jeder Auftrag speichert die Version der Datenschutzerklärung. Ein Entwurf ist keine Grundlage für echte Aufträge. */
  if (!privacyVersion || (production && /^entwurf/i.test(privacyVersion))) missing.push('PRIVACY_VERSION');

  const mail: MailConfig = {
    apiUrl: str(env.MAIL_API_URL),
    apiToken: str(env.MAIL_API_TOKEN),
    from: str(env.MAIL_FROM),
    notifyTo: str(env.MAIL_NOTIFY_TO),
  };
  const mailUrl = parseUrl(mail.apiUrl);
  if (!mailUrl || mailUrl.username || mailUrl.password || !(mailUrl.protocol === 'https:' || (local && mailUrl.protocol === 'http:'))
    || (production && (!AUTHORIZED_MAIL_API_HOSTS.includes(mailUrl.hostname) || mailUrl.port || mailUrl.pathname !== '/emails' || mailUrl.search))) {
    missing.push('MAIL_API_URL');
  }
  if (!mail.apiToken) missing.push('MAIL_API_TOKEN');
  const fromDomain = mail.from.slice(mail.from.lastIndexOf('@') + 1).toLowerCase();
  if (!isEmail(mail.from) || (production && !AUTHORIZED_MAIL_FROM_DOMAINS.includes(fromDomain))) missing.push('MAIL_FROM');
  /* Nur ASCII vergleichen: toLowerCase() bildet sonst z. B. das Kelvin-Zeichen (U+212A) auf „k“ ab */
  const notifyTo = /^[\x21-\x7e]+$/.test(mail.notifyTo) ? mail.notifyTo.toLowerCase() : '';
  if (!isEmail(mail.notifyTo) || (production && notifyTo !== PRODUCTION_NOTIFY_TO)) missing.push('MAIL_NOTIFY_TO');
  if (production) mail.notifyTo = PRODUCTION_NOTIFY_TO;

  const retention = str(env.ORDER_RETENTION_DAYS);
  const retentionDays = retention === '' ? null : Number(retention);
  if (retentionDays !== null && !(/^\d{1,4}$/.test(retention) && retentionDays >= 1)) missing.push('ORDER_RETENTION_DAYS');

  if (!env.DB) missing.push('DB');

  if (missing.length || !base || !env.DB) {
    throw new ConfigError('Ungültige oder fehlende Werte: ' + missing.join(', '));
  }
  return {
    production,
    baseUrl,
    basePath: base.pathname === '/' ? '' : base.pathname,
    origin: base.origin,
    host: base.host,
    secure: base.protocol === 'https:',
    google,
    redirectUri: baseUrl + '/api/auth/callback',
    secret,
    privacyVersion,
    mail,
    retentionDays,
    db: env.DB,
  };
}
