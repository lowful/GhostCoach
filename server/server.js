'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const authRoutes    = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const licenseRoutes = require('./routes/license');
const webhookRoutes = require('./routes/webhook');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ──────────────────────────────────────────────────────────────────────
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
    // Allow requests with no origin (Electron app, curl, Stripe webhooks, etc.)
    if (!origin) return callback(null, true);
    // Allow explicit list
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Allow Lovable preview domains
    if (origin.endsWith('.lovable.app') || origin.endsWith('.lovable.dev')) return callback(null, true);
    // Allow all during development — tighten before full production launch
    callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-License-Key'],
  credentials: true,
}));

// ─── Webhook route — MUST come before JSON parser ──────────────────────────────
// Uses its own express.raw() middleware for Stripe signature verification
app.use('/api/webhook', webhookRoutes);

// ─── Global JSON parser (after webhook route) ──────────────────────────────────
app.use(express.json());

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/license',  licenseRoutes);

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── 404 handler ───────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _, res, __) => {
  console.error('[server] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[server] GhostCoach API running on port ${PORT}`);
  console.log(`[server] Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE' : 'TEST'}`);
});
