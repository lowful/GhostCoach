'use strict';

const { SERVER_BASE_URL, TIMING } = require('../../shared/config');

/**
 * Minimal POST helper for the GhostCoach backend. Always JSON, always sends the
 * X-License-Key header when a key is supplied, always bounded by a timeout.
 *
 * Returns { ok, status, data }. Network/timeout failures throw so callers can
 * distinguish "server said no" (ok:false) from "couldn't reach server" (throw).
 */
async function post(path, body, licenseKey, timeoutMs, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMING.serverTimeout);

  try {
    const res = await fetch(SERVER_BASE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(licenseKey ? { 'X-License-Key': licenseKey } : {}),
        ...(extraHeaders || {}),
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => '');
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch { data = {}; } }

    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** GET helper (used for tracker player-stats). Same contract as post(). */
async function get(path, licenseKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMING.serverTimeout);
  try {
    const res = await fetch(SERVER_BASE_URL + path, {
      headers: { ...(licenseKey ? { 'X-License-Key': licenseKey } : {}) },
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch { data = {}; } }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { post, get };
