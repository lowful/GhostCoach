const Store = require('electron-store');

const schema = {
  apiKey:                    { type: 'string',  default: '' },
  captureInterval:           { type: 'number',  default: 15000, minimum: 5000, maximum: 60000 },
  overlayVisible:            { type: 'boolean', default: true },
  panelPosition: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' } },
    default: { x: 20, y: 20 }
  },
  coachingMode:              { type: 'string',  default: 'smart' },
  tipPosition:               { type: 'string',  default: 'top-right' },
  audioEnabled:              { type: 'boolean', default: false },
  performanceMode:           { type: 'string',  default: 'balanced' },
  onboardingCompleted:       { type: 'boolean', default: false },
  continueCoachingWhileDead: { type: 'boolean', default: false },
  licenseKey:                { type: 'string',  default: '' },
  licenseStatus:             { type: 'string',  default: '' },
  licensePlan:               { type: 'string',  default: '' },
  licenseExpiry:             { type: 'string',  default: '' },
  serverUrl:                 { type: 'string',  default: 'https://ghostcoach-production.up.railway.app/api' },
  panelMinimized:            { type: 'boolean', default: false },
  panelCorner:               { type: 'string',  default: 'top-left' },
  deviceId:                  { type: 'string',  default: '' }
};

const store = new Store({ schema });
module.exports = store;
