require('dotenv').config();
const express = require('express');
const cors = require('cors');
const usersRouter = require('./routes/users');
const earlyAccessRouter = require('./routes/earlyAccess');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;

// Health route
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// Users routes
app.use('/users', usersRouter);

// Early access routes
app.use('/api/early-access', earlyAccessRouter);

// 404 for anything else
app.use((req, res) => {
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
