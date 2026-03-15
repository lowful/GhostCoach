'use strict';
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const PRICE_IDS = {
  weekly:   process.env.STRIPE_PRICE_WEEKLY,
  monthly:  process.env.STRIPE_PRICE_MONTHLY,
  lifetime: process.env.STRIPE_PRICE_LIFETIME,
};

const PLAN_MODES = {
  weekly:   'subscription',
  monthly:  'subscription',
  lifetime: 'payment',
};

// POST /api/payments/create-checkout
// Auth required. Body: { plan: 'weekly' | 'monthly' | 'lifetime' }
// Returns: { url } — redirect user to this Stripe Checkout URL
router.post('/create-checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;

  if (!['weekly', 'monthly', 'lifetime'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Must be weekly, monthly, or lifetime.' });
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return res.status(500).json({ error: `Price ID for plan "${plan}" is not configured. Set STRIPE_PRICE_${plan.toUpperCase()} in .env` });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: PLAN_MODES[plan],
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://ghostcoachai.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://ghostcoachai.com/signup',
      client_reference_id: String(req.userId),
      customer_email: user.email,
      metadata: { plan, userId: String(req.userId) },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[payments] Create checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/payments/success?session_id=xxx
// Called by success page after redirect from Stripe
// Polls until license is generated (up to 30s) then returns key
router.get('/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  // Poll for the license (webhook may not have fired yet)
  const maxAttempts = 15;
  const delay = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    const license = db.prepare('SELECT * FROM licenses WHERE stripe_session_id = ?').get(session_id);
    if (license && license.status === 'active') {
      return res.json({
        licenseKey: license.key,
        plan: license.plan,
        status: license.status,
        expiresAt: license.expires_at
      });
    }
    // Wait 2 seconds between checks
    await new Promise(r => setTimeout(r, delay));
  }

  // Webhook hasn't fired after 30s
  res.status(202).json({
    message: 'Payment is processing. Your license key will be emailed shortly.',
    processing: true
  });
});

module.exports = router;
