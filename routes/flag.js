const express = require('express');
const router = express.Router();
const flagService = require('../services/flagService');
const { asyncHandler } = require('../utils/asyncHandler');
const { ValidationError } = require('../utils/errors');

// Mounted with requireAuth in server.js — req.userId is always the caller's own id.

router.get('/', asyncHandler(async (req, res) => {
  const data = await flagService.getAll(req.userId, req.env);
  res.json(data);
}));

router.patch('/:flow', asyncHandler(async (req, res) => {
  const patch = req.body;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Body must be an object');
  }
  const data = await flagService.patchFlow(req.userId, req.params.flow, patch, req.env);
  res.json(data);
}));

module.exports = router;
