'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const paymentRoutes = require('./routes/payments');
const licenseRoutes = require('./routes/license');
const accountRoutes = require('./routes/account');
const webhookHandler = require('./routes/webhook');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://ghostcoachai.com',
  'https://www.ghostcoachai.com',
  'https://ghostcoach-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (origin.endsWith('.lovable.app') || origin.endsWith('.lovable.dev')) return callback(null, true);
    callback(null, true); // allow all during dev — tighten for full prod launch
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-License-Key'],
  credentials: true,
}));

// ─── Rate limiters ────────────────────────────────────────────────────────────
const activationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Too many activation attempts. Try again in 1 hour.' },
  standardHeaders: true, legacyHeaders: false,
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { error: 'Too many checkout attempts. Try again in 1 hour.' },
  standardHeaders: true, legacyHeaders: false,
});

// ─── Webhook — raw body BEFORE json parser ────────────────────────────────────
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

// ─── Global JSON parser ───────────────────────────────────────────────────────
app.use(express.json());

// ─── Route-level rate limits ──────────────────────────────────────────────────
app.use('/api/license/activate',        activationLimiter);
app.use('/api/payments/create-checkout', checkoutLimiter);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/payments', paymentRoutes);
app.use('/api/license',  licenseRoutes);
app.use('/api/account',  accountRoutes);

// ─── Health checks ────────────────────────────────────────────────────────────
app.get('/health',     (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── 404 / Error ─────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _, res, __) => {
  console.error('[server] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[server] GhostCoach API running on port ${PORT}`);
  console.log(`[server] Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE' : 'TEST'}`);
  console.log(`[server] Supabase: ${process.env.SUPABASE_URL || '(not configured)'}`);
});
