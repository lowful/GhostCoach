'use strict';
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/account/dashboard
// Auth required. Returns full account + license info for the website dashboard.
router.get('/dashboard', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, stripe_customer_id FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const license = db.prepare(`
    SELECT key, plan, status, expires_at, created_at, device_name, activated_at,
           deactivation_count, last_deactivation_date
    FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(req.userId);

  let licenseData = null;
  if (license) {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const lastDeactMonth = license.last_deactivation_date ? license.last_deactivation_date.slice(0, 7) : null;
    const deactivationsThisMonth = lastDeactMonth === thisMonth ? (license.deactivation_count || 0) : 0;

    licenseData = {
      key:                    license.key,
      plan:                   license.plan,
      status:                 license.status,
      created_at:             license.created_at,
      expires_at:             license.expires_at,
      device_name:            license.device_name || null,
      device_activated:       !!license.device_name,
      activated_at:           license.activated_at || null,
      deactivations_this_month: deactivationsThisMonth,
      deactivations_remaining:  Math.max(0, 3 - deactivationsThisMonth),
    };
  }

  res.json({
    email: user.email,
    license: licenseData,
    stripe: {
      can_manage_subscription: !!user.stripe_customer_id,
      portal_url: null,
    },
  });
});

// POST /api/account/portal
// Auth required. Creates a Stripe Customer Portal session.
router.post('/portal', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.stripe_customer_id) {
    return res.status(400).json({ error: 'No Stripe subscription found for this account' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: 'https://ghostcoachai.com/account',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[account] Portal error:', err.message);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

module.exports = router;
