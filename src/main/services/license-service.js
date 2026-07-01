'use strict';

const os     = require('os');
const crypto = require('crypto');
const store  = require('./store');
const api    = require('./api-client');
const { API } = require('../../shared/config');

/**
 * License activation + caching + background re-validation against the documented
 * backend. The backend only exposes /api/license/activate, so we use it for both
 * first activation and periodic re-checks (idempotent for the bound device).
 */

// Deterministic device identity (matches the old client's derivation).
function computeDeviceId() {
  const raw = `${os.hostname()}::${os.userInfo().username}::${process.platform}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}
function deviceName() { return os.hostname() || 'Unknown Device'; }

// The LIVE backend expects snake_case { key, device_id, device_name } (verified
// against the production server, the documented camelCase contract was stale).
function buildBody(key, deviceId) {
  return { key, device_id: deviceId, device_name: deviceName() };
}

// Responses may use either camelCase or snake_case, normalize defensively.
function normalize(data = {}) {
  return {
    valid:     !!data.valid,
    plan:      data.plan   || '',
    status:    data.status || '',
    expiresAt: data.expiresAt || data.expires_at || '',
    error:     data.error  || '',
    reason:    data.reason || data.status || '',
  };
}

const STATUS_MESSAGES = {
  expired:        'Your license has expired. Renew at ghostcoachai.com.',
  cancelled:      'Your subscription was cancelled. Resubscribe at ghostcoachai.com.',
  payment_failed: 'Payment failed. Update your payment method at ghostcoachai.com.',
  device_mismatch:'This key is active on another device. Deactivate it there first.',
  invalid:        'That license key is not valid.',
};
function messageForStatus(status) {
  return STATUS_MESSAGES[status] || null;
}

function persist(licenseKey, n, deviceId) {
  store.set('licenseKey',    licenseKey);
  store.set('licenseStatus', n.status   || 'active');
  store.set('licensePlan',   n.plan     || '');
  store.set('licenseExpiry', n.expiresAt || '');
  store.set('deviceId',      deviceId);
}

function clear() {
  store.set('licenseKey',    '');
  store.set('licenseStatus', '');
  store.set('licensePlan',   '');
  store.set('licenseExpiry', '');
}

function getCached() {
  return {
    licenseKey:    store.get('licenseKey'),
    licensePlan:   store.get('licensePlan'),
    licenseStatus: store.get('licenseStatus'),
    licenseExpiry: store.get('licenseExpiry'),
  };
}

/** Fast, no-network local validity check used for instant startup. */
function isLocallyValid() {
  const key    = store.get('licenseKey');
  const status = store.get('licenseStatus');
  const expiry = store.get('licenseExpiry');
  return !!key && status === 'active' && (!expiry || new Date(expiry) > new Date());
}

/**
 * Activate a key entered by the user. Persists on success.
 * Returns { ok, valid, plan?, status?, expiresAt?, error? }.
 */
async function activate(rawKey) {
  const licenseKey = (rawKey || '').trim().toUpperCase();
  if (!licenseKey) return { ok: true, valid: false, error: 'Enter your license key.' };

  const deviceId = computeDeviceId();

  let resp;
  try {
    resp = await api.post(API.ACTIVATE, buildBody(licenseKey, deviceId), licenseKey);
  } catch (err) {
    // Couldn't reach server. Offline grace: accept a matching, unexpired cache.
    if (offlineGraceAllows(licenseKey, deviceId)) {
      console.warn('[license] Server unreachable, accepting cached license');
      return { ok: true, valid: true, plan: store.get('licensePlan'),
               status: 'active', expiresAt: store.get('licenseExpiry') };
    }
    console.error('[license] activate network error:', err.message);
    return { ok: false, valid: false, error: 'Could not reach the server. Check your connection.' };
  }

  const n = normalize(resp.data);
  if (resp.ok && n.valid) {
    persist(licenseKey, n, deviceId);
    console.log('[license] Activated:', n.plan || '(no plan)', n.status || '');
    return { ok: true, valid: true, plan: n.plan, status: n.status, expiresAt: n.expiresAt };
  }

  return {
    ok: true,
    valid: false,
    error: messageForStatus(n.reason) || n.error || 'That key could not be activated.',
  };
}

function offlineGraceAllows(licenseKey, deviceId) {
  return store.get('licenseKey') === licenseKey
      && store.get('licenseStatus') === 'active'
      && store.get('deviceId') === deviceId
      && isLocallyValid();
}

/**
 * Silent background re-validation for an already-cached license.
 * Rule: only sign out on an EXPLICIT valid:false. Network errors or ambiguous
 * responses keep the cached session.
 * Returns { valid, status?, offline?, ambiguous? }.
 */
async function revalidate() {
  const key = store.get('licenseKey');
  if (!key) return { valid: false };

  let resp;
  try {
    resp = await api.post(API.ACTIVATE, buildBody(key, computeDeviceId()), key);
  } catch (err) {
    console.warn('[license] revalidate offline:', err.message);
    return { valid: true, offline: true };
  }

  const n = normalize(resp.data);
  if (resp.ok && n.valid) {
    store.set('licenseStatus', n.status   || 'active');
    store.set('licensePlan',   n.plan     || store.get('licensePlan'));
    store.set('licenseExpiry', n.expiresAt || store.get('licenseExpiry'));
    return { valid: true };
  }
  if (resp.data && resp.data.valid === false) {
    // Keep the key (so a later renewal can be detected) but flag the status so
    // isLocallyValid() fails and the session locks. Manual Log out clears it.
    store.set('licenseStatus', n.reason || 'expired');
    console.warn('[license] revalidate: server says invalid ->', n.reason || 'unknown');
    return { valid: false, status: n.reason || 'expired' };
  }
  return { valid: true, ambiguous: true }; // keep cache on anything unclear
}

module.exports = {
  activate,
  revalidate,
  getCached,
  clear,
  isLocallyValid,
  computeDeviceId,
  messageForStatus,
};
