const express = require('express');
const router = express.Router();
const connectionService = require('../services/connectionService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireUuid, requireText, clampInt } = require('../utils/validate');
const { ValidationError } = require('../utils/errors');

const MAX_HOPS_CEILING = 6;   // "six degrees of separation" — the whole premise
const LIMIT_CEILING = 200;
const NOTE_MAX = 500;

// Identity is never a parameter — it comes from the verified token via requireAuth.
router.use(requireAuth);

// ── Requests ──────────────────────────────────────────────

router.post('/request', asyncHandler(async (req, res) => {
  const addresseeId = requireUuid(req.body?.addresseeId, 'addresseeId');
  const note = requireText(req.body?.note, 'note', { max: NOTE_MAX });

  const row = await connectionService.sendRequest(req.userId, addresseeId, note, req.env);
  res.status(201).json(row);
}));

router.put('/request/:id/accept', asyncHandler(async (req, res) => {
  const requestId = requireUuid(req.params.id, 'request id');
  const note = requireText(req.body?.note, 'note', { max: NOTE_MAX });

  const connection = await connectionService.acceptRequest(requestId, req.userId, note, req.env);
  res.json(connection);
}));

router.put('/request/:id/decline', asyncHandler(async (req, res) => {
  const requestId = requireUuid(req.params.id, 'request id');
  const row = await connectionService.declineRequest(requestId, req.userId, req.env);
  res.json(row);
}));

router.put('/request/:id/withdraw', asyncHandler(async (req, res) => {
  const requestId = requireUuid(req.params.id, 'request id');
  const row = await connectionService.withdrawRequest(requestId, req.userId, req.env);
  res.json(row);
}));

router.get('/request/pending', asyncHandler(async (req, res) => {
  res.json(await connectionService.getPending(req.userId, req.env));
}));

router.get('/request/sent', asyncHandler(async (req, res) => {
  res.json(await connectionService.getSent(req.userId, req.env));
}));

// Both directions in one array, each row tagged with `direction`.
router.get('/requests', asyncHandler(async (req, res) => {
  res.json(await connectionService.getRequests(req.userId, req.env));
}));

// ── Connections ───────────────────────────────────────────

router.get('/list', asyncHandler(async (req, res) => {
  res.json(await connectionService.getConnections(req.userId, req.env));
}));

// N-degree traversal — everyone reachable through your network, excluding
// yourself and your existing 1st-degree connections.
router.get('/reachable', asyncHandler(async (req, res) => {
  const maxHops = clampInt(req.query.maxHops, {
    fallback: 3, min: 1, max: MAX_HOPS_CEILING, field: 'maxHops',
  });
  const limit = clampInt(req.query.limit, {
    fallback: 50, min: 1, max: LIMIT_CEILING, field: 'limit',
  });

  res.json(await connectionService.getReachable(req.userId, maxHops, limit, req.env));
}));

// Shortest chain of people between you and one target — powers the path view.
// Defaults to the full 6 degrees, since you are asking about a specific person.
router.get('/path/:targetId', asyncHandler(async (req, res) => {
  const targetId = requireUuid(req.params.targetId, 'targetId');
  if (targetId === req.userId) throw new ValidationError('That is you');

  const maxHops = clampInt(req.query.maxHops, {
    fallback: MAX_HOPS_CEILING, min: 1, max: MAX_HOPS_CEILING, field: 'maxHops',
  });

  const result = await connectionService.getPathTo(req.userId, targetId, maxHops, req.env);
  if (!result) return res.status(404).json({ error: `No path found within ${maxHops} hops` });

  res.json(result);
}));

router.put('/:id/disconnect', asyncHandler(async (req, res) => {
  const connectionId = requireUuid(req.params.id, 'connection id');
  res.json(await connectionService.disconnect(connectionId, req.userId, req.env));
}));

module.exports = router;
