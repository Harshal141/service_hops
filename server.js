require('dotenv').config();
const express = require('express');
const cors = require('cors');
const usersRouter = require('./routes/users');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profile');
const skillRouter = require('./routes/skill');
const connectionRouter = require('./routes/connection');
const { requireAuth } = require('./middleware/auth');
const { testDBConnection } = require('./config/db');

const app = express();

// Only the FE may call this API from a browser. FE_ORIGINS is a comma-separated
// allowlist; localhost stays permitted so `npm run dev` works out of the box.
const allowedOrigins = [
  ...(process.env.FE_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  'http://localhost:3000',
  'http://localhost:3001',
];

// Reject disallowed browser origins with a clean JSON 403. Throwing inside the
// cors() origin callback instead yields a 500 HTML error page.
// A missing Origin header means curl or a server-to-server call, which is fine —
// identity still requires a verified Bearer token, never a cookie.
app.use((req, res, next) => {
  const { origin } = req.headers;
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});

app.use(cors({ origin: allowedOrigins, credentials: true }));

app.use(express.json());

testDBConnection('stage');
testDBConnection('prod');

const PORT = process.env.PORT || 8080;

// Health route
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// Auth routes (no auth middleware — called during sign-in)
app.use('/auth', authRouter);

// Users routes (requires auth)
app.use('/users', requireAuth, usersRouter);

// Profile routes (mixed — GET /:userId is public, writes require auth)
app.use('/profile', profileRouter);

// Skill routes (public)
app.use('/skill', skillRouter);

// Connection routes (requires auth — handled inside the router)
app.use('/connection', connectionRouter);

// 404 for anything else
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Only start server if not in Vercel environment
if (process.env.VERCEL !== '1') {
  const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`${signal} received. Closing server...`);
    server.close(() => {
      console.log('Server closed. Exiting process.');
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
