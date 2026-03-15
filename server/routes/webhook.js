'use strict';
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('../db/database');
const { generateLicenseKey, getExpiresAt, extendExpiresAt } = require('../utils/license');

// POST /api/payments/webhook
// Exported as a plain async handler (not a router) so server.js can mount it
// with express.raw() at the exact path Stripe sends events to.
async function webhookHandler(req, res) {
  console.log('[webhook] Received webhook event');

  const sig = req.headers['stripe-signature'];

  if (!sig) {
    console.warn('[webhook] Missing stripe-signature header');
    return res.status(400).json({ error: 'Missing Stripe signature' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  console.log(`[webhook] Processing event: ${event.type}`);

  try {
    switch (event.type) {

      // ── Payment completed (first payment) ───────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = parseInt(session.client_reference_id, 10);
        const plan = session.metadata?.plan;

        if (!userId || !plan) {
          console.error('[webhook] Missing userId or plan in session metadata', session.id);
          break;
        }

        // Check if license already generated (idempotency)
        const existing = db.prepare('SELECT id FROM licenses WHERE stripe_session_id = ?').get(session.id);
        if (existing) {
          console.log(`[webhook] License already exists for session ${session.id}, skipping`);
          break;
        }

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!user) {
          console.error(`[webhook] User ${userId} not found`);
          break;
        }

        // Update stripe_customer_id on user if not set
        if (!user.stripe_customer_id && session.customer) {
          db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(session.customer, userId);
        }

        const key = generateLicenseKey();
        const expiresAt = getExpiresAt(plan);
        const subscriptionId = session.subscription || null;

        db.prepare(`
          INSERT INTO licenses (user_id, key, plan, status, expires_at, stripe_session_id, stripe_subscription_id)
          VALUES (?, ?, ?, 'active', ?, ?, ?)
        `).run(userId, key, plan, expiresAt, session.id, subscriptionId);

        console.log(`[webhook] License generated: ${key} for user ${user.email} (${plan})`);
        console.log(`[webhook] TODO: Send email to ${user.email} with license key ${key} (${plan}) expiring ${expiresAt || 'never'}`);

        break;
      }

      // ── Recurring invoice paid — extend subscription ──────────────────────────
      case 'invoice.paid': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) break; // one-time payment, not a subscription invoice

        const license = db.prepare('SELECT * FROM licenses WHERE stripe_subscription_id = ?').get(subscriptionId);
        if (!license) {
          console.warn(`[webhook] No license found for subscription ${subscriptionId}`);
          break;
        }

        const newExpiry = extendExpiresAt(license.expires_at, license.plan);
        db.prepare('UPDATE licenses SET status = ?, expires_at = ? WHERE stripe_subscription_id = ?')
          .run('active', newExpiry, subscriptionId);

        console.log(`[webhook] Subscription ${subscriptionId} renewed. New expiry: ${newExpiry}`);
        break;
      }

      // ── Recurring invoice payment failed ────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) break;

        const license = db.prepare('SELECT * FROM licenses WHERE stripe_subscription_id = ?').get(subscriptionId);
        if (!license) break;

        db.prepare('UPDATE licenses SET status = ? WHERE stripe_subscription_id = ?')
          .run('payment_failed', subscriptionId);

        console.log(`[webhook] Payment failed for subscription ${subscriptionId}`);
        break;
      }

      // ── Subscription cancelled ────────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        const license = db.prepare('SELECT * FROM licenses WHERE stripe_subscription_id = ?').get(subscription.id);
        if (!license) break;

        db.prepare('UPDATE licenses SET status = ? WHERE stripe_subscription_id = ?')
          .run('cancelled', subscription.id);

        console.log(`[webhook] Subscription ${subscription.id} cancelled`);
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] Handler error:', err.message, err.stack);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

module.exports = webhookHandler;
