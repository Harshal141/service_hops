const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireUuid, requireHandle } = require('../utils/validate');
const { NotFoundError, ForbiddenError } = require('../utils/errors');

// GET / (list every user) and POST / (create a user) were removed:
//   - the list had no caller and was `SELECT * FROM users`, i.e. an email dump
//   - the create was unreachable anyway (it omitted user_id, which is NOT NULL
//     with no default), and user rows must only ever come from /auth/upsert

router.get('/search', asyncHandler(async (req, res) => {
  const query = (req.query.q ?? '').trim();
  if (!query) return res.json([]);
  res.json(await userService.searchByName(query.slice(0, 100), req.userId, req.env));
}));

// Accepts the public slug or (for links already shared as a UUID) the raw id —
// see userService.findByHandle. Distinct from the routes below, which are the
// caller acting on their own account and always pass their own UUID.
router.get('/:handle', asyncHandler(async (req, res) => {
  const handle = requireHandle(req.params.handle, 'handle');
  const user = await userService.findByHandle(handle, req.env);
  if (!user) throw new NotFoundError('User not found');
  res.json(user);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id, 'id');
  if (id !== req.userId) throw new ForbiddenError('You can only update your own account');

  const user = await userService.update(id, req.body, req.env);
  if (!user) throw new NotFoundError('User not found');
  res.json(user);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id, 'id');
  if (id !== req.userId) throw new ForbiddenError('You can only delete your own account');

  const deleted = await userService.remove(id, req.env);
  if (!deleted) throw new NotFoundError('User not found');
  res.status(204).send();
}));

module.exports = router;
