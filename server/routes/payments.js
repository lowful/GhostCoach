'use strict';
const express  = require('express');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('../db/supabase');

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
// Body: { plan, userId, email }
// No JWT required — Supabase auth is handled client-side on the website.
router.post('/create-checkout', async (req, res) => {
  const { plan, userId, email } = req.body;

  if (!plan || !userId || !email) {
    return res.status(400).json({ error: 'plan, userId, and email are required' });
  }
  if (!['weekly', 'monthly', 'lifetime'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Must be weekly, monthly, or lifetime.' });
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return res.status(500).json({ error: `Price ID for plan "${plan}" is not configured on the server.` });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                PLAN_MODES[plan],
      payment_method_types: ['card'],
      line_items:          [{ price: priceId, quantity: 1 }],
      success_url:         'https://ghostcoachai.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:          'https://ghostcoachai.com/signup',
      client_reference_id: String(userId),
      customer_email:      email,
      metadata:            { plan, userId: String(userId) },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[payments] Create checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/payments/success?session_id=xxx
// Called by success page after Stripe redirect.
// Retrieves session from Stripe, then polls Supabase for the generated license.
router.get('/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  let userId;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    userId = session.client_reference_id;
  } catch (err) {
    console.error('[payments] Error retrieving session:', err.message);
    return res.status(400).json({ error: 'Invalid session_id' });
  }

  if (!userId) return res.status(400).json({ error: 'No user associated with this session' });

  // Poll Supabase up to 30s for the webhook to generate the license
  const maxAttempts = 15;
  for (let i = 0; i < maxAttempts; i++) {
    const { data: license } = await supabase
      .from('licenses')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (license) {
      return res.json({
        licenseKey: license.license_key,
        plan:       license.plan,
        status:     license.status,
        expiresAt:  license.expires_at,
      });
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  res.status(202).json({
    message:    'Payment is processing. Your license key will be emailed shortly.',
    processing: true,
  });
});

module.exports = router;
