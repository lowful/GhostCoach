'use strict';

/**
 * Coaching languages, server side.
 *
 * This duplicates the code-to-English-name mapping from src/shared/i18n.js, and
 * that duplication is deliberate. server/ has its own package.json and is
 * deployed as its own root, so a require reaching up into src/ resolves fine on
 * a dev machine and is MODULE_NOT_FOUND in production. That took the whole
 * backend down: not a failed request, a crash loop on boot, which is the worst
 * way to learn where a deploy boundary is.
 *
 * The client keeps the full catalogue (display names, UI strings). The server
 * needs one thing only: the English name to put in the prompt, because a model
 * follows "write in German" far more reliably than "write in Deutsch".
 *
 * scripts/check-languages.js asserts this stays in step with the client list.
 */
const PROMPT_NAMES = {
  'en':    'English',
  'de':    'German',
  'es':    'Spanish',
  'pt-BR': 'Brazilian Portuguese',
  'fr':    'French',
  'tr':    'Turkish',
  'ru':    'Russian',
  'pl':    'Polish',
  'ja':    'Japanese',
  'ko':    'Korean',
};

/** English name for the prompt. Unknown or missing codes fall back to English. */
function promptName(code) {
  return PROMPT_NAMES[code] || 'English';
}

module.exports = { PROMPT_NAMES, promptName };
