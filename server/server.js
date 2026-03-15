'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes    = require('./routes/auth');
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
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:5174',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Electron app, curl, Stripe webhooks
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (origin.endsWith('.lovable.app') || origin.endsWith('.lovable.dev')) return callback(null, true);
    callback(null, true); // Allow all during dev — tighten before full prod
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-License-Key'],
  credentials: true,
}));

// ─── Rate limiters ────────────────────────────────────────────────────────────
// Auth: 5 login attempts / 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Registration: 3 attempts / hour per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many registration attempts. Please try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// License activation: 10 attempts / hour per IP
const activationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many activation attempts. Please try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Webhook — MUST come before JSON parser ───────────────────────────────────
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

// ─── Global JSON parser ───────────────────────────────────────────────────────
app.use(express.json());

// ─── Apply rate limiters to specific routes ───────────────────────────────────
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/license/activate', activationLimiter);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/license',  licenseRoutes);
app.use('/api/account',  accountRoutes);

// ─── Health checks ────────────────────────────────────────────────────────────
app.get('/health',     (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, _, res, __) => {
  console.error('[server] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[server] GhostCoach API running on port ${PORT}`);
  console.log(`[server] Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE' : 'TEST'}`);
});
