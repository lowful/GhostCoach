'use strict';
const express  = require('express');
const supabase = require('../db/supabase');

const router = express.Router();

const KEY_REGEX = /^GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DANGEROUS = /<script|--|;drop|;delete|union select/i;

function sanitizeKey(key) { return String(key).trim().toUpperCase(); }

// POST /api/license/activate
// Body: { key, device_id, device_name }
// First activation locks the license to device_id; same device can reactivate freely.
router.post('/activate', async (req, res) => {
  const { key, device_id, device_name } = req.body;

  if (!key)       return res.status(400).json({ valid: false, error: 'License key is required' });
  if (!device_id) return res.status(400).json({ valid: false, error: 'device_id is required' });
  if (DANGEROUS.test(key)) return res.status(400).json({ valid: false, error: 'Invalid key format' });

  const cleanKey = sanitizeKey(key);
  if (!KEY_REGEX.test(cleanKey)) return res.status(400).json({ valid: false, error: 'Invalid license key format' });

  const { data: license, error: fetchErr } = await supabase
    .from('licenses')
    .select('*')
    .eq('license_key', cleanKey)
    .single();

  if (fetchErr || !license) return res.status(404).json({ valid: false, error: 'License key not found' });

  if (license.expires_at && new Date(license.expires_at) < new Date())
    return res.json({ valid: false, status: 'expired', error: 'License has expired' });

  if (license.status !== 'active')
    return res.json({ valid: false, status: license.status, error: `License status: ${license.status}` });

  // Device lock check
  if (license.device_id && license.device_id !== device_id) {
    return res.json({
      valid: false, status: 'device_mismatch', reason: 'device_mismatch',
      error: 'This key is already activated on another device. Deactivate it first from your account dashboard.',
    });
  }

  // First activation — lock to this device
  if (!license.device_id) {
    await supabase
      .from('licenses')
      .update({ device_id, device_name: device_name || 'Unknown Device' })
      .eq('license_key', cleanKey);
    console.log(`[license] Activated: ${cleanKey} on "${device_name}"`);
  }

  res.json({
    valid: true, plan: license.plan, status: license.status,
    expiresAt: license.expires_at, deviceName: device_name || license.device_name,
  });
});

// POST /api/license/deactivate
// Body: { userId } — called from account dashboard (Supabase userId).
// Clears device lock. Max 3 deactivations per calendar month.
router.post('/deactivate', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !license) return res.status(404).json({ error: 'No license found for this account' });
  if (!license.device_id) return res.status(400).json({ error: 'License is not activated on any device' });

  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastMonth = license.last_deactivation_date ? license.last_deactivation_date.slice(0, 7) : null;
  const count = lastMonth === thisMonth ? (license.deactivation_count || 0) : 0;

  if (count >= 3) return res.status(429).json({ error: 'Deactivation limit reached. Maximum 3 per month.' });

  await supabase
    .from('licenses')
    .update({
      device_id: null, device_name: null,
      deactivation_count: count + 1,
      last_deactivation_date: new Date().toISOString(),
    })
    .eq('license_key', license.license_key);

  console.log(`[license] Deactivated: ${license.license_key} (this month: ${count + 1})`);
  res.json({ success: true, deactivationsThisMonth: count + 1, deactivationsRemaining: 3 - (count + 1) });
});

// POST /api/license/validate
// Body: { key, device_id }
// Periodic check from Electron app during coaching.
router.post('/validate', async (req, res) => {
  const { key, device_id } = req.body;
  if (!key) return res.status(400).json({ valid: false, error: 'License key is required' });

  const cleanKey = sanitizeKey(key);
  if (!KEY_REGEX.test(cleanKey)) return res.status(400).json({ valid: false, error: 'Invalid license key format' });

  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('license_key', cleanKey)
    .single();

  if (error || !license) return res.status(404).json({ valid: false, error: 'License key not found' });

  if (license.expires_at && new Date(license.expires_at) < new Date())
    return res.json({ valid: false, status: 'expired', error: 'License has expired' });

  if (license.status !== 'active')
    return res.json({ valid: false, status: license.status, error: `License status: ${license.status}` });

  if (device_id && license.device_id && license.device_id !== device_id)
    return res.json({ valid: false, status: 'device_mismatch', reason: 'device_mismatch', error: 'License is activated on a different device.' });

  res.json({
    valid: true, plan: license.plan, status: license.status,
    expiresAt: license.expires_at, deviceName: license.device_name || null,
  });
});

module.exports = router;
