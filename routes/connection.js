const express = require('express');
const router = express.Router();
const connectionService = require('../services/connectionService');
const { requireAuth } = require('../middleware/auth');

const getEnv = (req) => req.headers['x-env'] ?? 'stage';

const MAX_HOPS_CEILING = 6;   // "six degrees of separation" — the whole premise
const LIMIT_CEILING = 200;

// Coerce to an int and clamp into range. Returns null for non-numeric input so
// the caller can 400 on garbage, while out-of-range values clamp silently.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clampParam = (raw, fallback, min, max) => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return Math.min(Math.max(n, min), max);
};

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

// N-degree traversal — everyone reachable through your network, excluding
// yourself and your existing 1st-degree connections.
router.get('/reachable', async (req, res) => {
  try {
    const maxHops = clampParam(req.query.maxHops, 3, 1, MAX_HOPS_CEILING);
    if (maxHops === null) return res.status(400).json({ error: 'maxHops must be an integer' });

    const limit = clampParam(req.query.limit, 50, 1, LIMIT_CEILING);
    if (limit === null) return res.status(400).json({ error: 'limit must be an integer' });

    const rows = await connectionService.getReachable(req.userId, maxHops, limit, getEnv(req));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Shortest chain of people between you and one target — powers the path view.
// Defaults to the full 6 degrees, since you are asking about a specific person.
router.get('/path/:targetId', async (req, res) => {
  try {
    const { targetId } = req.params;
    if (!UUID_RE.test(targetId)) return res.status(400).json({ error: 'targetId must be a UUID' });
    if (targetId === req.userId) return res.status(400).json({ error: 'That is you' });

    const maxHops = clampParam(req.query.maxHops, MAX_HOPS_CEILING, 1, MAX_HOPS_CEILING);
    if (maxHops === null) return res.status(400).json({ error: 'maxHops must be an integer' });

    const result = await connectionService.getPathTo(req.userId, targetId, maxHops, getEnv(req));
    if (!result) return res.status(404).json({ error: 'No path found within ' + maxHops + ' hops' });

    res.json(result);
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
