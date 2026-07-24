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

// Tip-frequency tiers. The tier the user picks is about HOW MANY TIPS they
// get; screenshots scale with it (Max analyzes every second). The engine's
// single-in-flight guard means the real capture ceiling is the AI's reply
// latency, so fast tiers run "as fast as the coach can think" without stacking.
const PERFORMANCE_INTERVALS = {
  turbo:       1000,   // Max: most tips the coach can give while staying good
  rapid:       2000,   // High+
  ultra:       3000,   // High
  performance: 5000,   // Medium
  balanced:    10000,  // Default
  battery:     24000,  // Minimal
};

// Tip pacing per tier: cooldown = minimum gap between tips, silence = how long
// an AI quiet spell lasts before the library covers it. Faster tiers allow
// more tips; every tip still passes the same quality gates, so "more" never
// means "worse", it means the good ones are allowed through sooner.
const TIP_PACING = {
  turbo:       { cooldown: 3000,  silence: 8000  },   // Max: a tip every 3s when there is one
  rapid:       { cooldown: 3500,  silence: 9000  },
  ultra:       { cooldown: 4500,  silence: 10000 },
  performance: { cooldown: 5500,  silence: 12000 },
  balanced:    { cooldown: 6500,  silence: 14000 },
  battery:     { cooldown: 8000,  silence: 18000 },
};

// Tip mix: beginner (library) tips target 25-35% of the stream, so AI tips
// keep a 65% floor. Library tips that would push AI below it are suppressed.
// (Hard failures, server/capture down, ignore this.)
const COACHING = {
  aiMinShare: 0.65,
  // Allow this many library tips before the ratio governor kicks in, so the
  // overlay isn't dead-air early while the AI is still ramping up.
  bootstrapLibrary: 3,
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
  riotId:          '',           // Name#TAG for tracker stats in Ask Coach
  playerStats:     null,         // last good tracker profile (persists = always connected)
  lastMatchStats:  null,         // stats snapshot from the previous match (delta arrows)
  badTipCounts:    {},           // text -> times rated X; 3 strikes on the SAME tip blocks it
  tipFeedback:     [],           // [{ text, reason, at }] the player's own words on why a tip missed
  tipRatings:      {},           // text -> 'good'|'bad', persists so ratings survive restarts
  overlayPosition: 'top-right',  // tip card anchor
  tipPosition:     'top-right',  // top-left | top-right | bottom-left | bottom-right
  tipScale:        1,            // tip card size ratio; 1 = normal (0.8 to 1.3)
  tipStyle:        'glass',      // glass | solid | minimal | neon, the tip card look
  tipOpacity:      0.9,          // tip card background opacity, 0.25 to 1
  showTips:        true,         // false = tips hidden on the overlay but still recorded
  // (The pro playbook runs permanently in hybrid mode; frame memory is always
  // on and session-scoped. Neither is a setting anymore.)
  beginnerTips:    true,         // curated library tips in the stream (25-35% of tips); off = AI only
  voiceCoach:      false,        // speak tips aloud through the overlay
  voiceStyle:      'normal',     // normal | hype | chill | funny | robot
  voiceVolume:     0.9,          // 0..1
  panelBounds:     null,         // { x, y } remembered position of the control panel
  panelMinimized:  false,
  onboardingCompleted: false,
  coachStartCount: 0,            // how many sessions started; the minimize hint rides on this
  // Weekly report: the baseline the current stats are compared against, and
  // which week the popup was last shown for (so it opens once a week, not on
  // every launch).
  weeklySnapshot:   null,        // { at, riotId, stats } captured at the start of the week
  weeklyReportWeek: '',          // "2026-W30", the last week whose report was shown
};

module.exports = {
  SERVER_BASE_URL,
  API,
  PURCHASE_URL,
  BRAND,
  CAPTURE,
  TIMING,
  PERFORMANCE_INTERVALS,
  TIP_PACING,
  COACHING,
  STORE_DEFAULTS,
};
