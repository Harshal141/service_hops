const express = require('express');
const multer = require('multer');
const resumeImportService = require('../services/resumeImportService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');
const { validateImportPayload } = require('../utils/profileFields');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

// Exactly one file, in the multipart field `file`. errorHandler maps multer's limit errors.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: resumeImportService.MAX_FILE_BYTES, files: 1, fields: 10, parts: 11 },
});

// requireAuth per route, not router.use: GET /profile/import must still fall through to the
// public profile lookup for a user whose handle is 'import'. Auth runs before multer reads the body.
router.post('/', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  const { file } = req;
  if (!file?.buffer?.length) throw new ValidationError('Attach a PDF file', 'no_file');
  res.json(await resumeImportService.importResume({ userId: req.userId, file, env: req.env }));
}));

// A reviewed draft can exceed the global 32kb JSON cap (15 roles × long descriptions).
router.post('/:id/apply', requireAuth, express.json({ limit: '256kb' }), asyncHandler(async (req, res) => {
  const enrichmentId = Number(req.params.id);
  if (!/^\d{1,9}$/.test(req.params.id) || enrichmentId < 1) {
    throw new ValidationError('id must be a positive integer');
  }
  const payload = validateImportPayload(req.body);
  res.json(await resumeImportService.applyImport({ userId: req.userId, enrichmentId, payload, env: req.env }));
}));

module.exports = router;
