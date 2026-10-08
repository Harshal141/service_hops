// Sentry must initialise before express (or anything else it instruments) is
// required, so server.js loads this file first. With no SENTRY_DSN it does nothing.
const Sentry = require('@sentry/node');
const { scrubEvent } = require('./utils/sentry');

// Vercel's deployment environment, not the X-Env database — one production
// deployment serves both stage and prod traffic, so the db is a per-request tag
// (`db_env`, set in middleware/traceContext.js).
const environment = process.env.VERCEL_ENV ?? 'local';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Never from the test suite: route tests load server.js, and .env may carry a real DSN.
  enabled: Boolean(process.env.SENTRY_DSN) && !process.env.VITEST,
  environment,
  sendDefaultPii: false,
  // Errors are always captured; this only samples performance spans. A request the
  // FE already traced keeps the FE's sampling decision.
  tracesSampleRate: environment === 'production' ? 0.1 : 1,
  // Every console.error becomes a Sentry event, so an error logged anywhere is captured
  // without each call site having to know about Sentry.
  integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
});
