'use strict';

function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = () =>
    Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  return `GC-${segment()}-${segment()}-${segment()}-${segment()}`;
}

function getExpiresAt(plan) {
  if (plan === 'lifetime') return null;
  const date = new Date();
  if (plan === 'weekly') date.setDate(date.getDate() + 7);
  if (plan === 'monthly') date.setDate(date.getDate() + 30);
  return date.toISOString();
}

function extendExpiresAt(currentExpires, plan) {
  const base = currentExpires ? new Date(currentExpires) : new Date();
  // If already expired, extend from now
  const from = base < new Date() ? new Date() : base;
  if (plan === 'weekly') from.setDate(from.getDate() + 7);
  if (plan === 'monthly') from.setDate(from.getDate() + 30);
  return from.toISOString();
}

module.exports = { generateLicenseKey, getExpiresAt, extendExpiresAt };
