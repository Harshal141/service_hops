require('dotenv').config();
const express = require('express');
const cors = require('cors');
const usersRouter = require('./routes/users');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profile');
const skillRouter = require('./routes/skill');
const { requireAuth } = require('./middleware/auth');
const { testDBConnection } = require('./config/db');

const app = express();
app.use(cors());
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
