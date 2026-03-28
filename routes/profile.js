const express = require('express');
const router = express.Router();
const profileService = require('../services/profileService');
const { requireAuth } = require('../middleware/auth');

const getEnv = (req) => req.headers['x-env'] ?? 'stage';

// ── View any profile (no auth required) ───────────────────
router.get('/:userId', async (req, res) => {
  try {
    const profile = await profileService.getByUserId(req.params.userId, getEnv(req));
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (profile.status === 'private' && req.userId !== req.params.userId) {
      return res.status(403).json({ error: 'This profile is private' });
    }
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// All routes below require auth
router.use(requireAuth);

// ── Own profile ────────────────────────────────────────────
router.put('/', async (req, res) => {
  try {
    const profile = await profileService.upsert(req.userId, req.body, getEnv(req));
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── Links ──────────────────────────────────────────────────
router.post('/link', async (req, res) => {
  try {
    const link = await profileService.addLink(req.userId, req.body, getEnv(req));
    res.status(201).json(link);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/link/:id', async (req, res) => {
  try {
    const link = await profileService.updateLink(req.userId, req.params.id, req.body, getEnv(req));
    res.json(link);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/link/:id', async (req, res) => {
  try {
    await profileService.deleteLink(req.userId, req.params.id, getEnv(req));
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── Experience ─────────────────────────────────────────────
router.post('/experience', async (req, res) => {
  try {
    const row = await profileService.addExperience(req.userId, req.body, getEnv(req));
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/experience/:id', async (req, res) => {
  try {
    const row = await profileService.updateExperience(req.userId, req.params.id, req.body, getEnv(req));
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/experience/:id', async (req, res) => {
  try {
    await profileService.deleteExperience(req.userId, req.params.id, getEnv(req));
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── Education ──────────────────────────────────────────────
router.post('/education', async (req, res) => {
  try {
    const row = await profileService.addEducation(req.userId, req.body, getEnv(req));
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/education/:id', async (req, res) => {
  try {
    const row = await profileService.updateEducation(req.userId, req.params.id, req.body, getEnv(req));
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/education/:id', async (req, res) => {
  try {
    await profileService.deleteEducation(req.userId, req.params.id, getEnv(req));
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── Skills ─────────────────────────────────────────────────
router.post('/skill', async (req, res) => {
  try {
    const row = await profileService.addSkill(req.userId, req.body.skill_id, getEnv(req));
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/skill/:skillId', async (req, res) => {
  try {
    await profileService.removeSkill(req.userId, req.params.skillId, getEnv(req));
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
