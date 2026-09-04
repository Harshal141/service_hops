const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const { requireInternalSecret } = require('../middleware/internal');
const { asyncHandler } = require('../utils/asyncHandler');
const { ValidationError } = require('../utils/errors');

// Called by the FE *server* on every sign-in to upsert the user. There is no
// session token yet at this point, so it is gated on the shared internal secret
// rather than requireAuth — see middleware/internal.js for why that matters.
router.post('/upsert', requireInternalSecret, asyncHandler(async (req, res) => {
  const { name, email, icon, referredBy } = req.body ?? {};
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new ValidationError('A valid email is required');
  }

  res.json(await userService.upsert({ name, email, icon, referredBy }, req.env));
}));

module.exports = router;
