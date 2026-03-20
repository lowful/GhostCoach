'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const paymentRoutes = require('./routes/payments');
const licenseRoutes = require('./routes/license');
const accountRoutes = require('./routes/account');
const coachRoutes   = require('./routes/coach');
const adminRoutes   = require('./routes/admin');
const webhookHandler = require('./routes/webhook');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's proxy so rate-limiter can read real client IPs
app.set('trust proxy', 1);

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-License-Key', 'X-Prompt-Mode', 'X-Combat-Tip-Given', 'X-Recent-Tips', 'X-Admin-Password', 'X-Forced'],
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

// ─── Raw body routes — MUST come before JSON parser ──────────────────────────
// Stripe webhook needs raw JSON; coach/analyze needs raw binary JPEG
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);
app.post('/api/coach/analyze',      express.raw({ type: 'image/jpeg', limit: '500kb' }), (req, _, next) => { req._rawBody = req.body; next(); });
app.post('/api/coach/summary/round', express.raw({ type: 'image/jpeg', limit: '500kb' }), (req, _, next) => { req._rawBody = req.body; next(); });

// ─── Global JSON parser ───────────────────────────────────────────────────────
app.use(express.json());

// ─── Route-level rate limits ──────────────────────────────────────────────────
app.use('/api/license/activate',        activationLimiter);
app.use('/api/payments/create-checkout', checkoutLimiter);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/payments', paymentRoutes);
app.use('/api/license',  licenseRoutes);
app.use('/api/account',  accountRoutes);
app.use('/api/coach',    coachRoutes);
app.use('/api/admin',    adminRoutes);

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
  console.log(`[server] Gemini: ${process.env.GEMINI_API_KEY ? 'configured' : '(GEMINI_API_KEY not set)'}`);
});
