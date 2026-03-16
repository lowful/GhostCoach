/**
 * api.js — Electron main process
 * All AI analysis now goes through the GhostCoach server (Gemini Flash).
 * No Anthropic SDK. Raw binary JPEG is posted to /api/coach/analyze.
 */

'use strict';
const https = require('https');
const http  = require('http');
const store = require('./store');

// ─── Sanitization ──────────────────────────────────────────────────────────────
function sanitizeText(text) {
  if (!text) return '';
  return text
    .replace(/\u2014/g, ', ')
    .replace(/\u2013/g, ', ')
    .replace(/ - /g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── HTTP helper — binary POST ─────────────────────────────────────────────────
function serverPostBinary(endpoint, buffer, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const serverUrl = store.get('serverUrl') || 'https://ghostcoach-production.up.railway.app/api';
    const url = new URL(`${serverUrl}${endpoint}`);
    const transport = url.protocol === 'https:' ? https : http;

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'image/jpeg',
        'Content-Length': buffer.length,
        'Connection': 'keep-alive',
      }, headers),
    };

    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from server')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs || 8000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(buffer);
    req.end();
  });
}

// ─── HTTP helper — JSON POST ──────────────────────────────────────────────────
function serverPostJSON(endpoint, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const serverUrl = store.get('serverUrl') || 'https://ghostcoach-production.up.railway.app/api';
    const payload = JSON.stringify(body);
    const url = new URL(`${serverUrl}${endpoint}`);
    const transport = url.protocol === 'https:' ? https : http;

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Connection': 'keep-alive',
      }, headers),
    };

    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from server')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs || 12000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

// ─── Response cache ────────────────────────────────────────────────────────────
// Stores last 5 { hash, tip } pairs. If hash matches, return cached tip.
const responseCache = [];
const CACHE_SIZE = 5;

function getCachedTip(hash) {
  const entry = responseCache.find(e => e.hash === hash);
  return entry ? entry.tip : null;
}

function cacheResponse(hash, tip) {
  if (!tip || tip.length < 3) return;
  responseCache.unshift({ hash, tip });
  if (responseCache.length > CACHE_SIZE) responseCache.pop();
}

// ─── Duplicate tip check ───────────────────────────────────────────────────────
// If first 6 words match a recent tip, it's a duplicate
function isDuplicateTip(tip, recentTips) {
  if (!tip || recentTips.length === 0) return false;
  const words = tip.trim().split(/\s+/).slice(0, 6).join(' ').toLowerCase();
  return recentTips.some(t => t.trim().split(/\s+/).slice(0, 6).join(' ').toLowerCase() === words);
}

// ─── Main analysis ─────────────────────────────────────────────────────────────
// imageBuffer: Buffer of raw JPEG bytes
// imageHash: simple hash string for dedup
// combatTipGiven: true if a tip was shown this combat encounter
// recentTips: last 5 tips shown this match
async function analyzeScreenshot(imageBuffer, licenseKey, mode, combatTipGiven, recentTips, imageHash) {
  if (!imageBuffer || !licenseKey) return '';

  // Check cache first — if same hash, return cached tip
  if (imageHash) {
    const cached = getCachedTip(imageHash);
    if (cached) {
      console.log('[api] Cache hit — reusing tip');
      return cached;
    }
  }

  const headers = {
    'X-License-Key':      licenseKey,
    'X-Prompt-Mode':      mode || 'smart',
    'X-Combat-Tip-Given': combatTipGiven ? 'true' : 'false',
    'X-Recent-Tips':      (recentTips || []).slice(0, 5).join('||'),
  };

  const result = await serverPostBinary('/coach/analyze', imageBuffer, headers, 8000);
  const tip = sanitizeText(result.tip || '');

  // Cache the result
  if (imageHash && tip) cacheResponse(imageHash, tip);

  return tip;
}

// ─── Round summary ─────────────────────────────────────────────────────────────
async function getRoundSummary(imageBuffer, licenseKey) {
  if (!imageBuffer || !licenseKey) return null;
  const headers = { 'X-License-Key': licenseKey };
  try {
    const result = await serverPostBinary('/coach/summary/round', imageBuffer, headers, 12000);
    if (result && result.round_result) return result;
    return null;
  } catch (err) {
    console.error('[api] Round summary error:', err.message);
    return null;
  }
}

// ─── Match summary ─────────────────────────────────────────────────────────────
async function getMatchSummary(tipTexts, licenseKey) {
  if (!licenseKey || !tipTexts || tipTexts.length < 3) return null;
  const headers = { 'X-License-Key': licenseKey };
  try {
    const result = await serverPostJSON('/coach/summary/match', { tips: tipTexts.slice(0, 30) }, headers, 12000);
    if (result && result.overall_rating) return result;
    return null;
  } catch (err) {
    console.error('[api] Match summary error:', err.message);
    return null;
  }
}

// ─── Match detection (heuristic, no API call) ──────────────────────────────────
// The server's analyze response returns WAITING when not in a match.
// checkIfMatch is now a simple pass-through that always returns true
// so the analyze call itself determines state. This eliminates one API call.
async function checkIfMatch() {
  return true;
}

// ─── Alive check (heuristic, no API call) ─────────────────────────────────────
// The server's analyze response returns PLAYER_DEAD when dead.
// checkIfAlive is now a pass-through — the analyze call handles this.
async function checkIfAlive() {
  return true;
}

// ─── Round recap (text-only, sent after round ends) ───────────────────────────
async function getRoundRecap(tips, licenseKey) {
  if (!licenseKey || !tips || tips.length === 0) return null;
  const headers = { 'X-License-Key': licenseKey };
  try {
    const result = await serverPostJSON('/coach/recap', { tips }, headers, 12000);
    if (result && result.recap) return sanitizeText(result.recap);
    return null;
  } catch (err) {
    console.error('[api] Round recap error:', err.message);
    return null;
  }
}

module.exports = {
  analyzeScreenshot,
  getRoundSummary,
  getMatchSummary,
  getRoundRecap,
  checkIfMatch,
  checkIfAlive,
  sanitizeText,
  isDuplicateTip,
};
