const express = require('express');
const router = express.Router();
const connectionService = require('../services/connectionService');
const { requireAuth } = require('../middleware/auth');

const getEnv = (req) => req.headers['x-env'] ?? 'stage';

// All connection routes require auth
router.use(requireAuth);

// ── Requests ──────────────────────────────────────────────

router.post('/request', async (req, res) => {
  try {
    const { addresseeId, note } = req.body;
    if (!addresseeId || !note) return res.status(400).json({ error: 'addresseeId and note are required' });
    const row = await connectionService.sendRequest(req.userId, addresseeId, note, getEnv(req));
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/request/:id/accept', async (req, res) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'note is required' });
    const connection = await connectionService.acceptRequest(req.params.id, req.userId, note, getEnv(req));
    res.json(connection);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/request/:id/decline', async (req, res) => {
  try {
    const row = await connectionService.declineRequest(req.params.id, req.userId, getEnv(req));
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/request/:id/withdraw', async (req, res) => {
  try {
    const row = await connectionService.withdrawRequest(req.params.id, req.userId, getEnv(req));
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/request/pending', async (req, res) => {
  try {
    const rows = await connectionService.getPending(req.userId, getEnv(req));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/request/sent', async (req, res) => {
  try {
    const rows = await connectionService.getSent(req.userId, getEnv(req));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Connections ───────────────────────────────────────────

router.get('/list', async (req, res) => {
  try {
    const rows = await connectionService.getConnections(req.userId, getEnv(req));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/disconnect', async (req, res) => {
  try {
    const row = await connectionService.disconnect(req.params.id, req.userId, getEnv(req));
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
