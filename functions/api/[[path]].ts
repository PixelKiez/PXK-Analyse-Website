/* 360°Pixelkiez – Pages Function für /api/* (laut public/_routes.json die einzige Function-Route).
   Reicht jede Anfrage über das interne Service Binding API an den privaten Worker pxwa-api weiter – Methode, Pfad,
   Query, Header (inkl. Cookie und CF-Connecting-IP) und Body unverändert – und gibt dessen Antwort unverändert zurück:
   Status, Weiterleitungen (Location) und alle Set-Cookie-Header.
   Keine eigene Logik: Anmeldung, Session, CSRF, Herkunft und Eingaben prüft allein der Worker.
   Fehlt das Binding (Vorschau-Deployments) oder ist der Worker nicht erreichbar: 503, nie statisches HTML.
   Kein Logging: Anfragen enthalten Session-Cookies, E-Mail- und Website-Adressen. */

interface Env {
  API?: Fetcher;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.API) return unavailable();
  try {
    /* redirect: 'manual': Weiterleitungen des Workers (zu Google, zur Bestätigung) gehen an den Browser, statt hier verfolgt zu werden */
    return await env.API.fetch(new Request(request, { redirect: 'manual' }));
  } catch {
    return unavailable();
  }
};

function unavailable(): Response {
  return new Response('Anfragen sind im Moment nicht möglich. Bitte versuchen Sie es später erneut.\n', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '300',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}
