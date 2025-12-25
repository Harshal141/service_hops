/**
 * User Controller
 * Service: services/userService.js
 */
const express = require('express');
const router = express.Router();
const userService = require('../services/userService');

// Get all users
router.get('/', async (req, res) => {
  try {
    const users = await userService.findAll();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const user = await userService.findById(req.params.id);
    res.json(user);
  } catch (error) {
    res.status(404).json({ error: 'User not found' });
  }
});

// Create a new user
router.post('/', async (req, res) => {
  try {
    const user = await userService.create(req.body);
    res.status(201).json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update a user
router.put('/:id', async (req, res) => {
  try {
    const user = await userService.update(req.params.id, req.body);
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Delete a user
router.delete('/:id', async (req, res) => {
  try {
    await userService.remove(req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
