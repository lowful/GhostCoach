'use strict';

/**
 * Translate a surface in place.
 *
 * Renderers have no Node access, so the catalogue arrives over the preload
 * bridge rather than being required here. Every surface calls applyI18n() once
 * after load and again whenever the language changes, so a switch in Settings
 * repaints every open window instead of only the one being edited.
 *
 * Markup opts in per element:
 *   <button data-i18n="panel.start">Start Coaching</button>
 *   <input  data-i18n-placeholder="settings.riotIdHint">
 *   <span   data-i18n-title="common.close">
 *
 * The English text stays in the HTML as the literal content. That is
 * deliberate: it is the fallback if this never runs, it keeps the markup
 * readable, and a missing key shows English rather than a blank element.
 */

/** @param {(key: string) => string} t  translator supplied by the host page */
function applyI18n(t, root = document) {
  if (typeof t !== 'function') return 0;
  let n = 0;

  for (const el of root.querySelectorAll('[data-i18n]')) {
    const v = t(el.getAttribute('data-i18n'));
    if (v && v !== el.textContent) { el.textContent = v; n++; }
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const v = t(el.getAttribute('data-i18n-placeholder'));
    if (v) { el.setAttribute('placeholder', v); n++; }
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const v = t(el.getAttribute('data-i18n-title'));
    if (v) { el.setAttribute('title', v); n++; }
  }

  // Screen readers and the OS window list should follow the language too.
  const lang = root === document ? document.documentElement : null;
  if (lang && typeof t === 'function') {
    const code = t('__lang__');
    if (code && code !== '__lang__') lang.setAttribute('lang', code);
  }
  return n;
}

/**
 * Set a surface up for translation in one call.
 *
 * Returns a bound t(key) for the strings a surface builds at runtime, which the
 * markup pass cannot reach. Those are the ones that silently stay English
 * otherwise, and they are usually the most visible: a button whose label flips
 * between "Start Coaching" and "Stop Coaching" is written by JS, not markup.
 *
 * The language is re-read on every config push, so switching it in Settings
 * repaints every open window rather than only the one being edited.
 *
 * @returns {Promise<(key: string) => string>}
 */
async function initI18n(onChange) {
  let lang = 'en';
  const t = (key) => (window.occlara && window.occlara.i18n ? window.occlara.i18n.t(lang, key) : key);

  /**
   * The palette rides along with the language refresh.
   *
   * Both answer "what does this window look like right now", both come from the
   * same config push, and every surface already calls this once at load and
   * again on every change. Giving the game its own subscription would mean a
   * second listener doing the same work on the same event, and a window that
   * could end up half repainted if one fired and the other did not.
   */
  const applyGame = (cfg) => {
    const game = (cfg && cfg.game) || 'valorant';
    const root = document.documentElement;
    // Valorant is the default palette in theme.css, so it carries no attribute.
    // Anything else selects a :root[data-game="..."] block.
    if (game === 'valorant') root.removeAttribute('data-game');
    else root.setAttribute('data-game', game);
  };

  const refresh = async () => {
    try {
      const cfg = await window.occlara.getConfig();
      applyGame(cfg);
      const next = (cfg && cfg.language) || 'en';
      if (next === lang) return false;
      lang = next;
      return true;
    } catch { return false; }
  };

  await refresh();
  applyI18n(t);

  // Follow later changes. onState fires on every config push, so this keeps
  // open windows in step without each surface polling.
  //
  // SUBSCRIBE ONCE PER SURFACE. Calling initI18n again (Settings does exactly
  // that after saving a language, to repaint itself immediately) used to add
  // another listener every time, so each save left one more live subscription
  // repainting the page on every state push for the rest of the session.
  if (!window.__i18nSubscribed && window.occlara && typeof window.occlara.onState === 'function') {
    window.__i18nSubscribed = true;
    window.occlara.onState(async () => {
      if (await refresh()) {
        applyI18n(t);
        if (typeof onChange === 'function') onChange(t);
      }
    });
  }
  return t;
}

if (typeof window !== 'undefined') {
  window.applyI18n = applyI18n;
  window.initI18n = initI18n;
}
if (typeof module !== 'undefined') module.exports = { applyI18n, initI18n };
