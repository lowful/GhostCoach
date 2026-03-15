'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Reject inputs containing obvious SQL injection or script tag patterns
const DANGEROUS = /<script|<\/script|--|;drop|;delete|;insert|;update|union select/i;

function sanitizeInput(val) {
  return String(val).trim();
}

function validateEmail(email) {
  return EMAIL_REGEX.test(email) && !DANGEROUS.test(email) && email.length <= 254;
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const raw = req.body || {};
  const email    = sanitizeInput(raw.email    || '');
  const password = sanitizeInput(raw.password || '');

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (DANGEROUS.test(password)) return res.status(400).json({ error: 'Invalid characters in password' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email.toLowerCase(), hash);
    const token = jwt.sign({ userId: result.lastInsertRowid, email: email.toLowerCase() }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: { id: result.lastInsertRowid, email: email.toLowerCase() } });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    console.error('[auth] Register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const raw = req.body || {};
  const email    = sanitizeInput(raw.email    || '');
  const password = sanitizeInput(raw.password || '');

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email address' });

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('[auth] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
