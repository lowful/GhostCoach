'use strict';
// Run: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node create-test-key.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { generateLicenseKey } = require('./utils/license');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  const key = process.argv[2] || generateLicenseKey();
  const expires = new Date('2027-12-31T00:00:00.000Z').toISOString();

  const { error } = await supabase.from('licenses').insert({
    license_key:  key,
    status:       'active',
    plan:         'monthly',
    expires_at:   expires,
  });

  if (error) {
    console.error('Failed:', error.message);
  } else {
    console.log('Created test key:', key);
    console.log('Expires:', expires);
  }
}

main();
