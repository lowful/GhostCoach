'use strict';
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const supabase = require('../db/supabase');

function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `GC-${seg()}-${seg()}-${seg()}-${seg()}`;
}

function getExpiresAt(plan) {
  if (plan === 'lifetime') return null;
  const d = new Date();
  if (plan === 'weekly')  d.setDate(d.getDate() + 7);
  if (plan === 'monthly') d.setDate(d.getDate() + 30);
  return d.toISOString();
}

function extendExpiresAt(currentExpires, plan) {
  const base = currentExpires ? new Date(currentExpires) : new Date();
  const from = base < new Date() ? new Date() : base;
  if (plan === 'weekly')  from.setDate(from.getDate() + 7);
  if (plan === 'monthly') from.setDate(from.getDate() + 30);
  return from.toISOString();
}

// POST /api/payments/webhook
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

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.client_reference_id;
        const plan    = session.metadata?.plan;

        if (!userId || !plan) {
          console.error('[webhook] Missing userId or plan in session metadata', session.id);
          break;
        }

        // Idempotency — skip if license already exists for this session
        const { data: existing } = await supabase
          .from('licenses')
          .select('id')
          .eq('stripe_session_id', session.id)
          .single();

        if (existing) {
          console.log(`[webhook] License already exists for session ${session.id}, skipping`);
          break;
        }

        const licenseKey = generateLicenseKey();
        const expiresAt  = getExpiresAt(plan);

        const { error } = await supabase.from('licenses').insert({
          user_id:                userId,
          license_key:            licenseKey,
          plan,
          status:                 'active',
          expires_at:             expiresAt,
          stripe_customer_id:     session.customer || null,
          stripe_subscription_id: session.subscription || null,
          stripe_session_id:      session.id,
        });

        if (error) {
          console.error('[webhook] Supabase insert error:', error.message);
          break;
        }

        console.log(`[webhook] License ${licenseKey} created for user ${userId} (${plan})`);
        break;
      }

      case 'invoice.paid': {
        const invoice        = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;

        const { data: license } = await supabase
          .from('licenses')
          .select('expires_at, plan')
          .eq('stripe_subscription_id', subscriptionId)
          .single();

        if (!license) {
          console.warn(`[webhook] No license found for subscription ${subscriptionId}`);
          break;
        }

        const newExpiry = extendExpiresAt(license.expires_at, license.plan);
        await supabase
          .from('licenses')
          .update({ expires_at: newExpiry, status: 'active' })
          .eq('stripe_subscription_id', subscriptionId);

        console.log(`[webhook] Subscription ${subscriptionId} renewed. New expiry: ${newExpiry}`);
        break;
      }

      case 'invoice.payment_failed': {
        const subscriptionId = event.data.object.subscription;
        if (!subscriptionId) break;
        await supabase
          .from('licenses')
          .update({ status: 'payment_failed' })
          .eq('stripe_subscription_id', subscriptionId);
        console.log(`[webhook] Payment failed for subscription ${subscriptionId}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscriptionId = event.data.object.id;
        await supabase
          .from('licenses')
          .update({ status: 'cancelled' })
          .eq('stripe_subscription_id', subscriptionId);
        console.log(`[webhook] Subscription ${subscriptionId} cancelled`);
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
