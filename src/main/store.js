const Store = require('electron-store');

const schema = {
  tipPosition:               { type: 'string',  default: 'bottom-right' },
  overlayPosition:           { type: 'string',  default: 'top-left' },
  performanceMode:           { type: 'string',  default: 'balanced' },
  onboardingCompleted:       { type: 'boolean', default: false },
  licenseKey:                { type: 'string',  default: '' },
  licenseStatus:             { type: 'string',  default: '' },
  licensePlan:               { type: 'string',  default: '' },
  licenseExpiry:             { type: 'string',  default: '' },
  serverUrl:                 { type: 'string',  default: 'https://ghostcoach-production.up.railway.app/api' },
  panelMinimized:            { type: 'boolean', default: false },
  audioDetection:            { type: 'boolean', default: true },
  deviceId:                  { type: 'string',  default: '' }
};

const store = new Store({ schema });
module.exports = store;
