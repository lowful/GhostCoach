'use strict';

const Store = require('electron-store');
const { STORE_DEFAULTS } = require('../../shared/config');

/**
 * Thin wrapper over electron-store with our defaults baked in.
 * Single shared instance for the whole main process.
 */
const store = new Store({
  name: 'ghostcoach-config',
  defaults: STORE_DEFAULTS,
});

module.exports = store;
