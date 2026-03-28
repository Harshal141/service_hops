const express = require('express');
const router = express.Router();
const userService = require('../services/userService');

const getEnv = (req) => req.headers['x-env'] ?? 'stage';

// Called by FE on every LinkedIn sign-in to upsert the user
router.post('/upsert', async (req, res) => {
  try {
    const user = await userService.upsert(req.body, getEnv(req));
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
