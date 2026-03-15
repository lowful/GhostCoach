'use strict';
const express = require('express');
const router  = express.Router();

// GET /api/admin/costs
// Protected by ADMIN_PASSWORD env var
// Returns cost tracking data from the coach module
router.get('/costs', (req, res) => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'] || req.query.password;

  if (!adminPassword || provided !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Lazy-require to avoid circular deps
  let coachModule;
  try {
    coachModule = require('./coach');
  } catch (e) {
    return res.status(500).json({ error: 'Cost data unavailable' });
  }

  const { costStore, globalStats } = coachModule;

  // Top 10 by calls today
  const byKey = [];
  for (const [key, stats] of costStore.entries()) {
    byKey.push({ key: key.slice(0, 8) + '...', callsToday: stats.callsToday, callsMonth: stats.callsMonth, costToday: +stats.costToday.toFixed(4), costMonth: +stats.costMonth.toFixed(4) });
  }
  byKey.sort((a, b) => b.callsToday - a.callsToday);

  res.json({
    global: {
      callsToday:  globalStats.callsToday,
      callsMonth:  globalStats.callsMonth,
      costToday:   +'$' + globalStats.costToday.toFixed(4),
      costMonth:   +'$' + globalStats.costMonth.toFixed(4),
      estCostToday:  '$' + globalStats.costToday.toFixed(4),
      estCostMonth:  '$' + globalStats.costMonth.toFixed(4),
    },
    topUsers: byKey.slice(0, 10),
    asOf: new Date().toISOString(),
  });
});

module.exports = router;
