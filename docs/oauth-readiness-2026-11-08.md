# PXWA Google OAuth / Launch Readiness – 2026-11-08

**Update 09.11.2026:** Der echte Google-OIDC-Erfolgsfall wurde mit dem freigegebenen Testkonto und `http://localhost:8787/api/auth/callback` in der isolierten lokalen Umgebung erfolgreich durchgeführt. Ein lokaler Testauftrag und eine Mock-Benachrichtigung wurden gezählt; kein echter Mailversand oder Produktions-D1-Binding. Der Testserver wurde beendet. Frühere Angaben in diesem Bericht, dass ein echter Google-Test noch aussteht, sind historisch. Die produktive Anmeldung bleibt deaktiviert und nicht freigegeben.

**Update – isolierter OIDC-Test:** Der vorhandene Webclient wurde direkt geprüft: Die Produktions-Weiterleitung `https://360.pixelkiez.de/api/auth/callback` ist gespeichert. Audience ist extern, Veröffentlichungsstatus Test und das angemeldete Konto als Testnutzer eingetragen. Nach ausdrücklicher Freigabe wurde `http://localhost:8787/api/auth/callback` zusätzlich gespeichert; der Produktionswert blieb erhalten. Das Überprüfungscenter zeigt, dass im Testmodus keine Überprüfung erforderlich ist. Ein durchgehender echter Google-Login ist dadurch noch nicht nachgewiesen. Die folgenden ursprünglichen `UNVERIFIED`-Einträge zu diesen Punkten sind historisch.

**Project:** 360°Pixelkiez · Jira PXK-153/PXK-155 · Repo `PixelKiez/PXK-Analyse-Website`  
**Mode:** PREPARE ONLY. Derived technical audit; not a release authorization or legal approval.  
**Frozen website base:** `e9b523572ca62abd4e0686ad14311895630beb2b`, Cloudflare Pages deployment `49f35efe-3294-4419-a93e-6800d0a703a8` (independently observed 2026-11-08).  
**New branch:** `pxwa/oauth-client-prep-20261108`; do not deploy or merge this branch.  
**Local previous report:** `outputs/360-pixelkiez-oauth-readiness.md` was referenced by the operator but was **NOT FOUND** among accessible repository/project sources. Do not replace/overwrite that local file. Reconcile before combining findings.

## Google project and OAuth Client

| Item | Status | Grounding |
|---|---|---|
| Project name | VERIFIED | Authenticated Google Cloud browser tab displays `360 Pixelkiez OAuth Production` |
| Google project ID | VERIFIED | Browser URL `project=pixelkiez-oauth-production` |
| OAuth Web Client | VERIFIED | Google Auth Platform lists `360 Pixelkiez Web` as a Web application, created 2026-11-08 |
| Public OAuth client ID | VERIFIED | `992953187599-gabq9k5shdu02qd0r4ldqa3dh7ib0c1o.apps.googleusercontent.com` |
| Authorized redirect in Google Cloud | USER_REPORTED / UNVERIFIED | `https://360.pixelkiez.de/api/auth/callback`; Google client **detail** page has not been directly read |
| OAuth audience external/testing | USER_REPORTED / UNVERIFIED | Google Auth Platform Audience page for this exact project not yet read |
| Google branding verification | MISSING | Branding/Verification Center state not yet observed |
| Billing disabled | USER_REPORTED | Do not enable billing |
| Google sign-in test user | USER_REPORTED | Testing account reportedly included; do not expose email or test credentials |
| Email contact `360@pixelkiez.de` | USER_REPORTED | User states it shares the `kontakt@pixelkiez.de` Hostinger inbox, delivery test unverified |

No Google project/client creation, OAuth submission, Google publication or secret extraction was performed.

## Verified code and deployed runtime

- Existing Worker code under `worker/src/oidc.ts` implements authorization-code + PKCE, state, nonce and JWT/JWKS validation, with exact scopes `openid email`. It rejects `email_verified=false`. **Static-code verification only**; no live Google exchange.
- `worker/src/config.ts` constructs callback `BASE_URL + /api/auth/callback`; production `BASE_URL` is hard-bound to `https://360.pixelkiez.de`.
- The prepared `worker/wrangler.toml` now contains the PUBLIC Google client ID and **no Google client secret**. `workers_dev=false`, `preview_urls=false` protect the private API Worker.
- Production Cloudflare Pages `pxwa` serves the static site with `MEDIA -> 360pixelkiez` R2 binding. No `pxwa-api` Worker scripts exist and no Pages `API` service binding exists (Cloudflare read 2026-11-08).
- Existing production D1 `pxwa` database ID `3a5e6c3c-89f4-4b13-83ee-b70e151dc9b0` currently has only `_cf_KV`, `d1_migrations`, `sqlite_sequence` plus a metadata index; **NO application tables**. Read-only `sqlite_master` query performed 2026-11-08.
- Migration files `worker/migrations/0001_init.sql`, `0002_terms.sql`, `0003_consent.sql` exist and must be checked in order before remote apply. No migration executed.
- Published site is a **static soft launch**: Hero form absent, Pages API fail-closed (503), no live login, no customer requests.
- Worker requires secrets `GOOGLE_CLIENT_SECRET`, `SECRET` (session/HMAC), `MAIL_API_TOKEN`, valid `MAIL_FROM`, validated `PRIVACY_VERSION`, `TERMS_VERSION`, `DB`, and Google public client ID before config can load. Current templates intentionally retain `PRIVACY_VERSION=ENTWURF-2026-10-31`, `TERMS_VERSION=ENTWURF-2026-10-31`, and `MAIL_FROM=""`, so deployment must not be misrepresented as ready.
- **Config drift:** production Worker allowlist in `worker/src/config.ts` currently accepts sender domain `notify.pixelkiez.de`, while draft PR #5 prepares `360.pixelkiez.de`. Do not silently choose one, merge PR #5, or send mail until a bound explicit sender decision and verified Resend domain evidence are obtained.
- **Repository drift:** `main@c69cd1b3...` is behind deployed `e9b52357...` and several feature/release branches; avoid base=main for a production-aware hotfix. The current preparation branch starts at the actually deployed SHA.

## Security and data-truth gate

`email_verified=true` alone does **not** establish continuing control of an external third-party mailbox. Google is authoritative for `@gmail.com` and for hosted mailboxes (`hd` claim) in eligible Google Workspace cases, but a user with a third-party email on a consumer Google account could have lost control of that mailbox after initial Google verification. See Google's OpenID Connect guidance on when Google is authoritative for a user's email address. The existing privacy claim `So stellen wir sicher, dass die E-Mail-Adresse, an die wir den Bericht senden, tatsächlich Ihnen gehört` is overstated.

**Proposed privacy wording for legal review (NOT published here):**
> „Für die Anmeldung erhalten wir von Google die Kennung Ihres Google-Kontos und die E-Mail-Adresse, die Google für das Konto als bestätigt kennzeichnet. Dies belegt nicht in jedem Fall, dass Sie aktuell Zugriff auf das zugehörige E-Mail-Postfach haben. Wir erhalten keinen Zugriff auf Ihr Postfach.“

**Human product decision before live launch:** (A) permit all `email_verified=true` accounts with a documented residual misdelivery risk, or (B) require a fresh independent mailbox-confirmation step before PDF dispatch, or (C) restrict eligible email types and document tradeoffs. A Gmail/Workspace-only policy must not be introduced without approval.

The current live privacy page describes Google sign-in, D1 and Resend although the live API is still disabled; legal copy must be revalidated at the actual release boundary. The operator's legal approval is not inferred from file content, document version, CI, or publication date.

## Controlled migration and integration plan (NO remote writes yet)

1. **Reconcile exact branch/PR and production revisions**; identify frozen release candidate containing all currently live pages, fonts, video fixes, partner links, SEO adjustments and legal copy. Avoid resetting or overwriting other local worktrees.
2. **Confirm Google Auth Platform details** with a browser having project access: Client Details must store exactly `https://360.pixelkiez.de/api/auth/callback`; Audience External/Testing with a controlled test account, Branding and Verification Center statuses. Publishing and verification are distinct. Do not submit redundant brand verification with `openid email` until Google confirms requirement.
3. **Review technical contracts** for authenticated request semantics: no order before explicit URL/business/terms consent and successful callback; PKCE/state/nonce/replay/expiry/session rotation; secure HttpOnly/SameSite `__Host-` cookie; OAuth identity semantics; no mail to customer automatically.
4. **Review migrations `0001` → `0002` → `0003` against current D1 schema**; run on a new LOCAL D1 database first, verify tables/columns/indexes, upgrade path, rollback/recovery strategy and 120-day retention behavior. Take and verify a restorable backup before any separate authorized remote migration. Avoid destructive down-migrations.
5. **Isolated test environment**: separate test D1 and non-sending notification adapter or mail mock. Google real OAuth requires its own properly registered HTTPS callback and a controlled test account; the production callback cannot be silently reused for a preview origin. Obtain the specific user approval if an additional test redirect is required.
6. **Credential setup**: only through interactive authorized secret management; never download/print an existing client secret into logs/chat/repo. If it is unavailable, request a secure re-issue via the Google Console under a separate scoped operator approval. No credential import here.
7. **Integrate worker in an isolated release candidate** using exact dependency lock, reconcile Pages `functions/api/[[path]].ts` and Worker `API` binding. Keep `/api/*` fail-closed on production until all gates pass.
8. **Tests**: typecheck, unit, exact-head CI, local Pages+Worker+D1+mock-Google and negative paths (unknown/expired/replayed/wrong state, nonce, issuer, audience, signature, unverified email, cancelled consent, CSRF, session expiry/rotation, database error and delivery failure); isolated real Google authorization/callback with the controlled user only. Explicitly verify **zero production orders and zero production mail messages** during pre-launch.
9. **Release gate**: operator approval separately for (a) production D1 migration/backup (b) private Worker deploy, secret injection and production API binding (c) controlled Resend test (d) public Hero-form activation with tested E2E and legal/privacy acceptance. Each gate binds exact candidate SHA + runtime readback + rollback. No combined implicit approval.

## Current verdict

**GOOGLE_CLIENT_PREPARED / AUTHENTICATION_NOT_LIVE.** Project and client exist; callback in Google details, Audience, Branding/Verification status, credentials availability, real Google test, private Worker, D1 schema, legal/email authority decision and provider readiness remain open. No production mutation, no mail, no merge.
