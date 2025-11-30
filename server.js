const express = require('express');

const app = express();
const PORT = process.env.PORT || 8080;

// Health route
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// 404 for anything else
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

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

module.exports = app;
