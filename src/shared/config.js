'use strict';

/**
 * App-wide constants and store defaults. Plain values only (required by both
 * main and renderer-side code), no Electron imports here.
 */

// ── Backend (documented contract, do not change) ───────────────────────────
const SERVER_BASE_URL = 'https://ghostcoach-production.up.railway.app';

const API = {
  ACTIVATE:     '/api/license/activate',
  ANALYZE:      '/api/coach/analyze',
  DETECT_AGENT: '/api/coach/detect-agent',
  MATCH_REVIEW: '/api/coach/match-review',
};

const PURCHASE_URL = 'https://ghostcoachai.com';

// ── Brand ───────────────────────────────────────────────────────────────────
const BRAND = {
  red:  '#FF4655',
  cyan: '#00F0FF',
  bg:   '#0F1923',
};

// ── Capture ─────────────────────────────────────────────────────────────────
// Two quality profiles: standard is plenty for HUD reading and uploads fast;
// high sends a sharper frame (bigger upload + more image tokens per call, so
// slightly slower replies, but zero effect on game FPS since capture runs in
// a worker thread).
const CAPTURE = {
  targetW: 854,
  targetH: 480,
  jpegQuality: 50,
  timeoutMs: 6000,
  profiles: {
    standard: { targetW: 854,  targetH: 480, jpegQuality: 50 },
    high:     { targetW: 1280, targetH: 720, jpegQuality: 70 },
  },
};

// ── Engine timing (ms) ──────────────────────────────────────────────────────
const TIMING = {
  welcomeDelay:        1500,
  agentDetectFirst:    3000,   // detect early so the agent bubble fills in fast
  agentDetectRetry:    30000,
  firstAnalyze:        8000,   // first AI look comes fast after Start
  analyzeInterval:     10000,  // overridden by performanceMode
  tipCooldown:         12000,  // min gap between tips (readable but snappy)
  librarySilence:      18000,  // library steps in sooner when the AI goes quiet
  serverTimeout:       8000,
};

// Screenshot/analyze frequency tiers (ms between captures). The engine's
// single-in-flight guard means the real ceiling is the AI's reply latency,
// so turbo/rapid capture "as fast as the coach can think" without stacking.
const PERFORMANCE_INTERVALS = {
  turbo:       1000,   // every second
  rapid:       2000,   // every 2 seconds
  ultra:       3000,   // every 3 seconds
  performance: 5000,   // every 5 seconds
  balanced:    10000,  // default
  battery:     24000,  // barely
};

// Tip mix: AI tips must stay the majority. Fallback library tips that fire while
// the AI IS available are suppressed if they'd push AI's share below this floor.
// (Hard failures, server/capture down, ignore this, since AI isn't an option.)
const COACHING = {
  aiMinShare: 0.65,
  // Allow this many library tips before the ratio governor kicks in, so the
  // overlay isn't dead-air early while the AI is still ramping up.
  bootstrapLibrary: 2,
};

// ── electron-store schema defaults ──────────────────────────────────────────
const STORE_DEFAULTS = {
  // license
  licenseKey:    '',
  licensePlan:   '',
  licenseStatus: '',
  licenseExpiry: '',
  deviceId:      '',
  // preferences
  performanceMode: 'balanced',   // battery | balanced | performance | ultra
  captureQuality:  'standard',   // standard | high (screenshot detail)
  riotId:          '',           // Name#TAG for tracker stats in Ask Coach
  playerStats:     null,         // last good tracker profile (persists = always connected)
  lastMatchStats:  null,         // stats snapshot from the previous match (delta arrows)
  badTips:         [],           // tip texts the player rated as bad (blocklist)
  tipRatings:      {},           // text -> 'good'|'bad', persists so ratings survive restarts
  overlayPosition: 'top-right',  // tip card anchor
  tipPosition:     'top-right',  // top-left | top-right | bottom-left | bottom-right
  tipScale:        1,            // tip card size ratio; 1 = normal (0.8 to 1.3)
  showTips:        true,         // false = tips hidden on the overlay but still recorded
  // experimental: pro playbook mode. off = classic static habits,
  // on = retrieved situation-matched habits, hybrid = both layered together.
  // (Frame memory is always on and session-scoped, no setting.)
  proPlaybook:     'off',        // off | on | hybrid
  panelBounds:     null,         // { x, y } remembered position of the control panel
  panelMinimized:  false,
  onboardingCompleted: false,
};

module.exports = {
  SERVER_BASE_URL,
  API,
  PURCHASE_URL,
  BRAND,
  CAPTURE,
  TIMING,
  PERFORMANCE_INTERVALS,
  COACHING,
  STORE_DEFAULTS,
};
