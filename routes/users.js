const express = require('express');
const router = express.Router();
const userService = require('../services/userService');

const getEnv = (req) => req.headers['x-env'] ?? 'stage';

router.get('/', async (req, res) => {
  try {
    const users = await userService.findAll(getEnv(req));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/search', async (req, res) => {
  try {
    const query = req.query.q ?? '';
    if (!query.trim()) return res.json([]);
    const users = await userService.searchByName(query, getEnv(req));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const user = await userService.findById(req.params.id, getEnv(req));
    res.json(user);
  } catch (error) {
    res.status(404).json({ error: 'User not found' });
  }
});

router.post('/', async (req, res) => {
  try {
    const user = await userService.create(req.body, getEnv(req));
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  if (req.params.id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  try {
    const user = await userService.update(req.params.id, req.body, getEnv(req));
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await userService.remove(req.params.id, getEnv(req));
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
