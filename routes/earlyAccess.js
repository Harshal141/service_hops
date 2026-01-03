const express = require('express');
const router = express.Router();
const earlyAccessService = require('../services/earlyAccessService');

router.post('/', async (req, res) => {
  try {
    const { email, curiosityReason, useCase, canEmailForFeedback, submittedAt, tracking } = req.body;

    if (!email || !curiosityReason) {
      return res.status(400).json({ error: 'email and curiosityReason are required' });
    }

    const earlyAccessData = {
      email,
      curiosity_reason: curiosityReason,
      use_case: useCase || null,
      notification_preference: canEmailForFeedback ?? null,
      submated_at: submittedAt || null,
      metadata: tracking || null
    };

    await earlyAccessService.create(earlyAccessData);

    res.status(201).json({
      success: true,
      message: 'Early access request received'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
