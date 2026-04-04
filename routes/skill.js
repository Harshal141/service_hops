const express = require('express');
const router = express.Router();
const profileService = require('../services/profileService');

const getEnv = (req) => req.headers['x-env'] ?? 'stage';

// Autocomplete — no auth needed. Empty q returns default suggestions.
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) {
      const skills = await profileService.getDefaultSkills(getEnv(req));
      return res.json(skills);
    }
    const skills = await profileService.searchSkills(q, getEnv(req));
    res.json(skills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
