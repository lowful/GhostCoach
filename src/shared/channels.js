'use strict';

/**
 * ★ SINGLE SOURCE OF TRUTH for every IPC channel name.
 *
 * Imported by the main process, every preload, and (indirectly) every renderer.
 * No channel string is ever hand-typed anywhere else in the app. This is the
 * fix for the old client's #1 bug: main and preload drifted to different
 * channel names and the overlay silently stopped receiving events.
 *
 * Conventions:
 *   - invoke/handle  → request/response   (renderer asks, main answers)
 *   - send/on        → fire-and-forget    (renderer commands main)
 *   - webContents.send → push             (main → renderer broadcast)
 */
const CHANNELS = {
  // ── request / response (ipcRenderer.invoke ⇄ ipcMain.handle) ──────────────
  LICENSE_ACTIVATE: 'license:activate', // (key) → { ok, valid, plan, status, expiresAt, error? }
  LICENSE_GET:      'license:get',       // () → { licenseKey, plan, status, expiresAt }
  COACH_FORCE_TIP:  'coach:forceTip',    // () → { ok }
  CONFIG_GET:       'config:get',        // () → full config snapshot
  CONFIG_SET:       'config:set',        // (partial) → { ok }
  STATE_GET:        'state:get',         // () → current coaching state snapshot
  AGENT_SET:        'agent:set',         // (name) → { ok, agent, confirmed, role }
  CHAT_SEND:        'chat:send',         // (messages) → { ok, reply }
  STATS_TEST:       'stats:test',        // () → { ok, stats?, error? } tracker connect test
  SESSIONS_LIST:    'sessions:list',     // () → [{ file, endedAt, tipCount, agent }]
  SESSION_GET:      'sessions:get',      // (file) → archived session JSON | null
  STATS_DASHBOARD:  'stats:dashboard',   // () → { categories, rank, winRate, sessions, sessionCount, matches, riotConnected }
  STATS_REFRESH:    'stats:refreshMatches', // (mode) → { matches, fetchedAt, mode, refreshBlockedFor? } (3-min manual limit)
  STATS_MATCHES:    'stats:matches',       // (mode) → { matches, fetchedAt, mode } cached fetch for mode switching
  CHAT_SEED:        'chat:seed',         // () → pending session context for Ask Coach, cleared on read

  // ── renderer → main commands (ipcRenderer.send ⇄ ipcMain.on) ──────────────
  COACH_START:     'coach:start',
  COACH_STOP:      'coach:stop',
  COACH_PAUSE:     'coach:pauseResume',
  OVERLAY_TOGGLE:  'overlay:toggle',
  OVERLAY_INTERACT:'overlay:interact',    // (bool) overlay accepts mouse input while hovering the review card's ✕
  AGENT_CONFIRM:   'agent:confirm',      // player tapped ✓ on the detected agent
  PANEL_RESIZE:    'panel:resize',       // (height) → fit the window to panel content
  PANEL_MINIMIZE:  'panel:minimize',     // hide the interactive panel (anti-aim-interference)
  OPEN_SETTINGS:   'window:openSettings',
  OPEN_HISTORY:    'window:openHistory',
  OPEN_CHAT:       'window:openChat',    // the Ask Coach chat window
  OPEN_STATS:      'window:openStats',   // the extended stats dashboard window
  OPEN_CHAT_SEEDED:'window:openChatSeeded', // (sessionSeed) open Ask Coach preloaded with a session's context
  TIP_RATE:        'tip:rate',           // ({ text, source, rating: good|bad })
  OPEN_PURCHASE:   'window:openPurchase',
  LICENSE_LOGOUT:  'license:logout',      // clear license + return to activation screen
  ONBOARDING_DONE: 'onboarding:done',     // close the welcome card + never show again
  AUDIO_CLIP:      'audio:clip',          // (wavB64) rolling 8s game-audio clip from the hidden listener
  APP_QUIT:        'app:quit',

  // ── main → renderer pushes (webContents.send ⇄ ipcRenderer.on) ────────────
  PUSH_TIP:          'push:tip',          // { text, source: 'ai'|'library'|'system', time }
  PUSH_STATUS:       'push:status',       // { status: 'coaching'|'paused'|'stopped'|'idle' }
  PUSH_STATE:        'push:state',        // full state snapshot (panel + settings)
  PUSH_AGENT:        'push:agent',        // { agent, confirmed, role }, drives the confirm bubble
  PUSH_MATCH_REVIEW: 'push:matchReview',  // { review, game, timestamp, tipsCount }
  PUSH_OVERLAY_VIS:  'push:overlayVisibility', // { visible }
};

// Channels the renderer is allowed to subscribe to (defensive whitelist used
// by preloads so a renderer can never listen on an arbitrary channel).
CHANNELS.PUSH_LIST = [
  CHANNELS.PUSH_TIP,
  CHANNELS.PUSH_STATUS,
  CHANNELS.PUSH_STATE,
  CHANNELS.PUSH_AGENT,
  CHANNELS.PUSH_MATCH_REVIEW,
  CHANNELS.PUSH_OVERLAY_VIS,
];

module.exports = CHANNELS;
