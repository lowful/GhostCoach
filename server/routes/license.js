'use strict';
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const KEY_REGEX = /^GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
function sanitizeKey(key) { return String(key).trim().toUpperCase(); }

// GET /api/license/my-key
router.get('/my-key', requireAuth, (req, res) => {
  const license = db.prepare(`
    SELECT key, plan, status, expires_at, device_name, activated_at,
           deactivation_count, last_deactivation_date
    FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(req.userId);
  if (!license) return res.status(404).json({ error: 'No license found for this account' });

  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const lastDeactMonth = license.last_deactivation_date ? license.last_deactivation_date.slice(0, 7) : null;
  const deactivationsThisMonth = lastDeactMonth === thisMonth ? (license.deactivation_count || 0) : 0;

  res.json({
    key: license.key, plan: license.plan, status: license.status,
    expiresAt: license.expires_at, deviceName: license.device_name || null,
    deviceActive: !!license.device_name, activatedAt: license.activated_at || null,
    deactivationsThisMonth,
  });
});

// POST /api/license/activate  — device locking, no auth required
router.post('/activate', (req, res) => {
  const { key, device_id, device_name } = req.body;
  if (!key) return res.status(400).json({ valid: false, error: 'License key is required' });
  if (!device_id) return res.status(400).json({ valid: false, error: 'device_id is required' });

  const cleanKey = sanitizeKey(key);
  if (!KEY_REGEX.test(cleanKey)) return res.status(400).json({ valid: false, error: 'Invalid license key format' });

  const license = db.prepare('SELECT * FROM licenses WHERE key = ?').get(cleanKey);
  if (!license) return res.status(404).json({ valid: false, error: 'License key not found' });
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return res.json({ valid: false, status: 'expired', error: 'License has expired' });
  if (license.status !== 'active')
    return res.json({ valid: false, status: license.status, error: `License status: ${license.status}` });

  if (license.device_id && license.device_id !== device_id) {
    return res.json({
      valid: false, status: 'device_mismatch', reason: 'device_mismatch',
      error: 'This key is already activated on another device. Deactivate it first from your account dashboard.',
    });
  }

  if (!license.device_id) {
    db.prepare("UPDATE licenses SET device_id=?, device_name=?, activated_at=datetime('now') WHERE key=?")
      .run(device_id, device_name || 'Unknown Device', cleanKey);
    console.log(`[license] Activated: ${cleanKey} on "${device_name}"`);
  }

  const updated = db.prepare('SELECT * FROM licenses WHERE key = ?').get(cleanKey);
  res.json({ valid: true, plan: updated.plan, status: updated.status, expiresAt: updated.expires_at, deviceName: updated.device_name });
});

// POST /api/license/deactivate  — auth required, 3/month limit
router.post('/deactivate', requireAuth, (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.userId);
  if (!license) return res.status(404).json({ error: 'No license found' });
  if (!license.device_id) return res.status(400).json({ error: 'License is not activated on any device' });

  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastDeactMonth = license.last_deactivation_date ? license.last_deactivation_date.slice(0, 7) : null;
  const count = lastDeactMonth === thisMonth ? (license.deactivation_count || 0) : 0;
  if (count >= 3) return res.status(429).json({ error: 'Deactivation limit reached. Maximum 3 deactivations per month.' });

  db.prepare(`UPDATE licenses SET device_id=NULL, device_name=NULL, activated_at=NULL,
    deactivation_count=?, last_deactivation_date=? WHERE key=?`)
    .run(count + 1, new Date().toISOString(), license.key);
  console.log(`[license] Deactivated: ${license.key} (this month: ${count + 1})`);
  res.json({ success: true, deactivationsThisMonth: count + 1, deactivationsRemaining: 3 - (count + 1) });
});

// POST /api/license/validate  — periodic check during coaching
router.post('/validate', (req, res) => {
  const { key, device_id } = req.body;
  if (!key) return res.status(400).json({ valid: false, error: 'License key is required' });

  const cleanKey = sanitizeKey(key);
  if (!KEY_REGEX.test(cleanKey)) return res.status(400).json({ valid: false, error: 'Invalid license key format' });

  const license = db.prepare('SELECT * FROM licenses WHERE key = ?').get(cleanKey);
  if (!license) return res.status(404).json({ valid: false, error: 'License key not found' });
  if (license.expires_at && new Date(license.expires_at) < new Date())
    return res.json({ valid: false, status: 'expired', error: 'License has expired' });
  if (license.status !== 'active')
    return res.json({ valid: false, status: license.status, error: `License status: ${license.status}` });
  if (device_id && license.device_id && license.device_id !== device_id)
    return res.json({ valid: false, status: 'device_mismatch', reason: 'device_mismatch', error: 'License is activated on a different device.' });

  res.json({ valid: true, plan: license.plan, status: license.status, expiresAt: license.expires_at, deviceName: license.device_name || null });
});

module.exports = router;
