const express = require('express');
const router = express.Router();
const profileService = require('../services/profileService');
const { asyncHandler } = require('../utils/asyncHandler');

// Autocomplete — no auth needed. Empty q returns default suggestions.
router.get('/search', asyncHandler(async (req, res) => {
  const q = (req.query.q ?? '').trim().slice(0, 100);
  const skills = q
    ? await profileService.searchSkills(q, req.env)
    : await profileService.getDefaultSkills(req.env);
  res.json(skills);
}));

module.exports = router;
