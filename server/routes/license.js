'use strict';
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/license/my-key
// Auth required. Returns the current user's license key.
router.get('/my-key', requireAuth, (req, res) => {
  const license = db
    .prepare('SELECT key, plan, status, expires_at, created_at FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(req.userId);

  if (!license) {
    return res.status(404).json({ error: 'No license found for this account' });
  }

  res.json({
    key:       license.key,
    plan:      license.plan,
    status:    license.status,
    expiresAt: license.expires_at
  });
});

// POST /api/license/validate
// No auth required — called by the Electron app to check a key.
// Body: { key }
router.post('/validate', (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ valid: false, error: 'License key is required' });
  }

  const license = db
    .prepare('SELECT * FROM licenses WHERE key = ?')
    .get(key.trim().toUpperCase());

  if (!license) {
    return res.status(404).json({ valid: false, error: 'License key not found' });
  }

  // Check expiry (lifetime licenses have null expires_at)
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.json({ valid: false, status: 'expired', error: 'License has expired' });
  }

  if (license.status !== 'active') {
    return res.json({ valid: false, status: license.status, error: `License status: ${license.status}` });
  }

  res.json({
    valid:     true,
    plan:      license.plan,
    status:    license.status,
    expiresAt: license.expires_at
  });
});

module.exports = router;
