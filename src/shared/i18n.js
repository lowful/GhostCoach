'use strict';

/**
 * Interface language.
 *
 * Two separate things travel under "language" in this app, and they have very
 * different costs:
 *
 *   1. The COACHING TIPS. Written by the model, so any language is native
 *      quality and costs nothing but a line in the prompt. Every language in
 *      LANGUAGES is supported for tips, no catalogue entry required.
 *   2. The UI STRINGS below. Hand written per language, so a language only gets
 *      translated chrome once its catalogue exists. A missing key falls back to
 *      English rather than showing a blank or a raw key, because an English
 *      label is a small blemish and an empty button is a broken app.
 *
 * That asymmetry is deliberate. A German player gets German coaching the day
 * their language is added to LANGUAGES, and German chrome whenever the
 * catalogue catches up.
 *
 * Adding a language: add it to LANGUAGES (tips work immediately), then add a
 * key block to STRINGS for the interface.
 */

// `name` is what the player picks in Settings, in their own language.
// `prompt` is the name the model is told to write in, in English, because the
// prompt itself is English and a model follows "write in German" far more
// reliably than "write in Deutsch".
const LANGUAGES = [
  { code: 'en',    name: 'English',    prompt: 'English' },
  { code: 'de',    name: 'Deutsch',    prompt: 'German' },
  { code: 'es',    name: 'Español',    prompt: 'Spanish' },
  { code: 'pt-BR', name: 'Português',  prompt: 'Brazilian Portuguese' },
  { code: 'fr',    name: 'Français',   prompt: 'French' },
  { code: 'tr',    name: 'Türkçe',     prompt: 'Turkish' },
  { code: 'ru',    name: 'Русский',    prompt: 'Russian' },
  { code: 'pl',    name: 'Polski',     prompt: 'Polish' },
  { code: 'ja',    name: '日本語',      prompt: 'Japanese' },
  { code: 'ko',    name: '한국어',      prompt: 'Korean' },
];

const DEFAULT_LANG = 'en';

/**
 * UI strings, keyed by a dotted id used in markup as data-i18n="panel.start".
 * English is the source of truth and the fallback for every other language.
 */
const STRINGS = {
  en: {
    'common.settings': 'Settings',
    'common.quit': 'Quit',
    'common.close': 'Close',
    'common.back': 'Back',
    'common.next': 'Next',
    'common.done': 'Done',
    'common.on': 'On',
    'common.off': 'Off',
    'common.language': 'Language',
    'common.save': 'Save',
    'settings.performance': 'Performance',
    'common.languageSaved': 'Language saved.',
    'common.languageHint': 'Coaching tips and the app appear in this language.',

    'panel.start': 'Start Coaching',
    'panel.stop': 'Stop Coaching',
    'panel.pause': 'Pause',
    'panel.resume': 'Resume',
    'panel.idle': 'Idle',
    'panel.coaching': 'Coaching',
    'panel.paused': 'Paused',
    'panel.noTips': 'No tips yet, start coaching.',
    'panel.tips': 'tips',
    'panel.stats': 'Stats',
    'panel.history': 'History',
    'panel.askCoach': 'Ask Coach',

    'settings.title': 'Settings',
    'settings.tipFrequency': 'Tip frequency',
    'settings.riotId': 'Riot ID',
    'settings.showTips': 'Show tips',
    'settings.tipStyle': 'Tip style',
    'settings.voice': 'Voice coach',
    'settings.connect': 'Connect',
    'settings.manageSub': 'Manage subscription',
    'settings.logOut': 'Log out',
    'settings.minimal': 'Minimal',
    'settings.max': 'Max',
    'settings.default': 'Default',

    'onboarding.welcome': 'Welcome to GhostCoach',
    'onboarding.chooseLanguage': 'Choose your language',
    'onboarding.getStarted': 'Get started',
    'onboarding.finish': 'Start coaching',

    'overlay.coach': 'Coach',
    'overlay.deathReview': 'Death Review',
  },

  de: {
    'common.settings': 'Einstellungen',
    'common.quit': 'Beenden',
    'common.close': 'Schließen',
    'common.back': 'Zurück',
    'common.next': 'Weiter',
    'common.done': 'Fertig',
    'common.on': 'An',
    'common.off': 'Aus',
    'common.language': 'Sprache',
    'common.save': 'Speichern',
    'settings.performance': 'Leistung',
    'common.languageSaved': 'Sprache gespeichert.',
    'common.languageHint': 'Coaching-Tipps und die App erscheinen in dieser Sprache.',

    'panel.start': 'Coaching starten',
    'panel.stop': 'Coaching beenden',
    'panel.pause': 'Pause',
    'panel.resume': 'Fortsetzen',
    'panel.idle': 'Bereit',
    'panel.coaching': 'Coaching läuft',
    'panel.paused': 'Pausiert',
    'panel.noTips': 'Noch keine Tipps, starte das Coaching.',
    'panel.tips': 'Tipps',
    'panel.stats': 'Statistiken',
    'panel.history': 'Verlauf',
    'panel.askCoach': 'Coach fragen',

    'settings.title': 'Einstellungen',
    'settings.tipFrequency': 'Tipp-Häufigkeit',
    'settings.riotId': 'Riot-ID',
    'settings.showTips': 'Tipps anzeigen',
    'settings.tipStyle': 'Tipp-Stil',
    'settings.voice': 'Sprach-Coach',
    'settings.connect': 'Verbinden',
    'settings.manageSub': 'Abo verwalten',
    'settings.logOut': 'Abmelden',
    'settings.minimal': 'Minimal',
    'settings.max': 'Max',
    'settings.default': 'Standard',

    'onboarding.welcome': 'Willkommen bei GhostCoach',
    'onboarding.chooseLanguage': 'Wähle deine Sprache',
    'onboarding.getStarted': 'Loslegen',
    'onboarding.finish': 'Coaching starten',

    'overlay.coach': 'Coach',
    'overlay.deathReview': 'Todesanalyse',
  },

  es: {
    'common.settings': 'Ajustes',
    'common.quit': 'Salir',
    'common.close': 'Cerrar',
    'common.back': 'Atrás',
    'common.next': 'Siguiente',
    'common.done': 'Listo',
    'common.on': 'Sí',
    'common.off': 'No',
    'common.language': 'Idioma',
    'common.save': 'Guardar',
    'settings.performance': 'Rendimiento',
    'common.languageSaved': 'Idioma guardado.',
    'common.languageHint': 'Los consejos y la app aparecen en este idioma.',

    'panel.start': 'Iniciar coaching',
    'panel.stop': 'Detener coaching',
    'panel.pause': 'Pausar',
    'panel.resume': 'Reanudar',
    'panel.idle': 'Inactivo',
    'panel.coaching': 'Entrenando',
    'panel.paused': 'En pausa',
    'panel.noTips': 'Aún no hay consejos, inicia el coaching.',
    'panel.tips': 'consejos',
    'panel.stats': 'Estadísticas',
    'panel.history': 'Historial',
    'panel.askCoach': 'Preguntar al coach',

    'settings.title': 'Ajustes',
    'settings.tipFrequency': 'Frecuencia de consejos',
    'settings.riotId': 'Riot ID',
    'settings.showTips': 'Mostrar consejos',
    'settings.tipStyle': 'Estilo de consejo',
    'settings.voice': 'Coach por voz',
    'settings.connect': 'Conectar',
    'settings.manageSub': 'Gestionar suscripción',
    'settings.logOut': 'Cerrar sesión',
    'settings.minimal': 'Mínimo',
    'settings.max': 'Máx',
    'settings.default': 'Predeterminado',

    'onboarding.welcome': 'Bienvenido a GhostCoach',
    'onboarding.chooseLanguage': 'Elige tu idioma',
    'onboarding.getStarted': 'Empezar',
    'onboarding.finish': 'Iniciar coaching',

    'overlay.coach': 'Coach',
    'overlay.deathReview': 'Análisis de muerte',
  },

  'pt-BR': {
    'common.settings': 'Configurações',
    'common.quit': 'Sair',
    'common.close': 'Fechar',
    'common.back': 'Voltar',
    'common.next': 'Avançar',
    'common.done': 'Pronto',
    'common.on': 'Sim',
    'common.off': 'Não',
    'common.language': 'Idioma',
    'common.save': 'Salvar',
    'settings.performance': 'Desempenho',
    'common.languageSaved': 'Idioma salvo.',
    'common.languageHint': 'As dicas e o app aparecem neste idioma.',

    'panel.start': 'Iniciar coaching',
    'panel.stop': 'Parar coaching',
    'panel.pause': 'Pausar',
    'panel.resume': 'Retomar',
    'panel.idle': 'Ocioso',
    'panel.coaching': 'Treinando',
    'panel.paused': 'Pausado',
    'panel.noTips': 'Nenhuma dica ainda, inicie o coaching.',
    'panel.tips': 'dicas',
    'panel.stats': 'Estatísticas',
    'panel.history': 'Histórico',
    'panel.askCoach': 'Perguntar ao coach',

    'settings.title': 'Configurações',
    'settings.tipFrequency': 'Frequência das dicas',
    'settings.riotId': 'Riot ID',
    'settings.showTips': 'Mostrar dicas',
    'settings.tipStyle': 'Estilo da dica',
    'settings.voice': 'Coach por voz',
    'settings.connect': 'Conectar',
    'settings.manageSub': 'Gerenciar assinatura',
    'settings.logOut': 'Sair da conta',
    'settings.minimal': 'Mínimo',
    'settings.max': 'Máx',
    'settings.default': 'Padrão',

    'onboarding.welcome': 'Bem-vindo ao GhostCoach',
    'onboarding.chooseLanguage': 'Escolha seu idioma',
    'onboarding.getStarted': 'Começar',
    'onboarding.finish': 'Iniciar coaching',

    'overlay.coach': 'Coach',
    'overlay.deathReview': 'Análise da morte',
  },

  fr: {
    'common.settings': 'Paramètres',
    'common.quit': 'Quitter',
    'common.close': 'Fermer',
    'common.back': 'Retour',
    'common.next': 'Suivant',
    'common.done': 'Terminé',
    'common.on': 'Oui',
    'common.off': 'Non',
    'common.language': 'Langue',
    'common.save': 'Enregistrer',
    'settings.performance': 'Performances',
    'common.languageSaved': 'Langue enregistrée.',
    'common.languageHint': 'Les conseils et l’application apparaissent dans cette langue.',

    'panel.start': 'Démarrer le coaching',
    'panel.stop': 'Arrêter le coaching',
    'panel.pause': 'Pause',
    'panel.resume': 'Reprendre',
    'panel.idle': 'Inactif',
    'panel.coaching': 'Coaching en cours',
    'panel.paused': 'En pause',
    'panel.noTips': 'Pas encore de conseils, lance le coaching.',
    'panel.tips': 'conseils',
    'panel.stats': 'Statistiques',
    'panel.history': 'Historique',
    'panel.askCoach': 'Demander au coach',

    'settings.title': 'Paramètres',
    'settings.tipFrequency': 'Fréquence des conseils',
    'settings.riotId': 'Riot ID',
    'settings.showTips': 'Afficher les conseils',
    'settings.tipStyle': 'Style des conseils',
    'settings.voice': 'Coach vocal',
    'settings.connect': 'Connecter',
    'settings.manageSub': 'Gérer l’abonnement',
    'settings.logOut': 'Se déconnecter',
    'settings.minimal': 'Minimal',
    'settings.max': 'Max',
    'settings.default': 'Par défaut',

    'onboarding.welcome': 'Bienvenue sur GhostCoach',
    'onboarding.chooseLanguage': 'Choisis ta langue',
    'onboarding.getStarted': 'Commencer',
    'onboarding.finish': 'Démarrer le coaching',

    'overlay.coach': 'Coach',
    'overlay.deathReview': 'Analyse de la mort',
  },
};

/** Is this a language we know about at all? */
function isSupported(code) {
  return LANGUAGES.some((l) => l.code === code);
}

function normalize(code) {
  return isSupported(code) ? code : DEFAULT_LANG;
}

/** The English name to put in the prompt, for tips in the player's language. */
function promptName(code) {
  const hit = LANGUAGES.find((l) => l.code === normalize(code));
  return hit ? hit.prompt : 'English';
}

/**
 * Translate a key. Falls back to English, then to the key itself, so a missing
 * translation degrades to a readable English label instead of blanking the UI.
 */
function t(code, key) {
  const lang = normalize(code);
  const table = STRINGS[lang];
  if (table && table[key] != null) return table[key];
  const en = STRINGS[DEFAULT_LANG];
  if (en && en[key] != null) return en[key];
  return key;
}

/** Does this language have translated chrome, or only translated coaching? */
function hasUi(code) {
  return Object.prototype.hasOwnProperty.call(STRINGS, normalize(code));
}

module.exports = { LANGUAGES, DEFAULT_LANG, STRINGS, t, promptName, isSupported, normalize, hasUi };
