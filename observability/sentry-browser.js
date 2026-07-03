// Sentry init for the Phase-3 Vite hub front end. No-op until a DSN is configured.
// PII policy (CLAUDE.md): error monitoring must NEVER capture child PII.
// Usage (Phase 3):  import { initSentry } from '../observability/sentry-browser.js';
//                   initSentry(import.meta.env.VITE_SENTRY_DSN);
export function initSentry(dsn, Sentry) {
  if (!dsn || !Sentry) return false;      // placeholder DSN empty -> fully disabled
  Sentry.init({
    dsn,
    sendDefaultPii: false,                 // no IPs/cookies/headers by default
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,           // NO session replay in a children's product
    replaysOnErrorSampleRate: 0,
    beforeSend(event) {
      return scrubEvent(event);
    },
  });
  return true;
}

// Strip anything that could carry a child's data before the event leaves the browser.
export function scrubEvent(event) {
  if (!event) return event;
  delete event.user;                                   // never user identifiers
  if (event.request) { delete event.request.cookies; delete event.request.data; }
  const SCRUB_KEYS = /nickname|pilot|name|email|child|answer|problem|jwt|token|authorization|pin/i;
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (SCRUB_KEYS.test(k)) obj[k] = '[scrubbed]';
      else walk(obj[k]);
    }
  };
  walk(event.extra); walk(event.contexts); walk(event.tags); walk(event.breadcrumbs);
  // free-text fields too: an error string can interpolate a nickname/email/token
  if (event.message) event.message = scrubString(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubString(ex.value);
  }
  return event;
}

// Redact email-like, JWT-like and long-token-like substrings inside a string.
export function scrubString(s) {
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[token]');
}
