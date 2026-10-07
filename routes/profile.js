const express = require('express');
const router = express.Router();
const profileService = require('../services/profileService');
const userService = require('../services/userService');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireHandle } = require('../utils/validate');
const { validateProfilePatch } = require('../utils/profileFields');
const { NotFoundError, ForbiddenError } = require('../utils/errors');

// ── View any profile (no auth required) ───────────────────
// optionalAuth so the private-profile check below can recognise the owner, and so
// email can be returned to the owner only.
router.get('/:handle', optionalAuth, asyncHandler(async (req, res) => {
  const handle = requireHandle(req.params.handle, 'handle');

  const target = await userService.findByHandle(handle, req.env);
  if (!target) throw new NotFoundError('Profile not found');

  const profile = await profileService.getByUserId(target.id, req.userId ?? null, req.env);
  if (!profile) throw new NotFoundError('Profile not found');
  if (profile.status === 'private' && req.userId !== target.id) {
    throw new ForbiddenError('This profile is private');
  }
  res.json(profile);
}));

// All routes below require auth. Identity is never a parameter — it is req.userId.
router.use(requireAuth);

// ── Own profile: the one write endpoint for the editor ─────
// The whole edit lands atomically or not at all; see validateProfilePatch for the body.
router.patch('/', asyncHandler(async (req, res) => {
  const patch = validateProfilePatch(req.body);
  res.json(await profileService.savePatch(req.userId, patch, req.env));
}));

// ── Skills ─────────────────────────────────────────────────
router.post('/skill', asyncHandler(async (req, res) => {
  res.status(201).json(await profileService.addSkill(req.userId, req.body?.skill_id, req.env));
}));

router.delete('/skill/:skillId', asyncHandler(async (req, res) => {
  await profileService.removeSkill(req.userId, req.params.skillId, req.env);
  res.status(204).send();
}));

module.exports = router;
