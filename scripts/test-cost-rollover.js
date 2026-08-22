'use strict';

/**
 * "This month" has to mean this month.
 *
 * trackCall reset only the DAILY counters. callsMonth and costMonth were zeroed
 * exactly once, when the module first loaded, and then climbed for as long as
 * the container lived. So /api/admin/costs reported a figure labelled "month"
 * that was really "since the last deploy", and because Railway redeploys often
 * it looked plausible rather than obviously broken. A cost number that is wrong
 * in an unknown direction is worse than no cost number, because it gets used.
 *
 * The two things worth pinning, since the second is what a naive fix breaks:
 *   1. crossing into a new month zeroes the monthly counters
 *   2. crossing into a new DAY inside the same month does NOT
 *
 * Both the global totals and the per key entry are checked, because they are
 * separate counters and only one of them was fixed first.
 *
 * Run: npm run test:costrollover
 */
const path = require('path');

// coach.js builds a Supabase client at import time. Nothing here touches it.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key-not-used';

const coach = require(path.join(__dirname, '..', 'server', 'routes', 'coach.js'));
const { trackCall, globalStats, costStore } = coach;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${got}, want ${want}`}`);
};

/** Run fn with the clock pinned to an instant, so a rollover is reproducible. */
function at(iso, fn) {
  const Real = Date;
  global.Date = class extends Real {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return new Real(iso).getTime(); }
  };
  try { fn(); } finally { global.Date = Real; }
}

const KEY = 'GC-TEST-TEST-TEST-TEST';
const entry = () => costStore.get(KEY);

// Day one of the month: two calls.
at('2026-01-30T12:00:00.000Z', () => { trackCall(KEY); trackCall(KEY); });
check('day 1, calls today',        globalStats.callsToday, 2);
check('day 1, calls month',        globalStats.callsMonth, 2);
check('day 1, per key today',      entry().callsToday, 2);
check('day 1, per key month',      entry().callsMonth, 2);

// NEXT DAY, SAME MONTH. The daily counter resets, the monthly one must not.
at('2026-01-31T09:00:00.000Z', () => { trackCall(KEY); });
check('next day, today reset',     globalStats.callsToday, 1);
check('next day, month carries',   globalStats.callsMonth, 3);
check('next day, per key today',   entry().callsToday, 1);
check('next day, per key month',   entry().callsMonth, 3);

// NEXT MONTH. Both reset.
at('2026-02-01T09:00:00.000Z', () => { trackCall(KEY); });
check('new month, today reset',    globalStats.callsToday, 1);
check('new month, month reset',    globalStats.callsMonth, 1);
check('new month, per key today',  entry().callsToday, 1);
check('new month, per key month',  entry().callsMonth, 1);

// A month later still resets rather than only comparing adjacent months.
at('2026-05-14T09:00:00.000Z', () => { trackCall(KEY); trackCall(KEY); });
check('month skip, month reset',   globalStats.callsMonth, 2);
check('month skip, per key month', entry().callsMonth, 2);

// Cost must track the calls, not drift on its own.
check('cost month is positive',    globalStats.costMonth > 0, true);

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
