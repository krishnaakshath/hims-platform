// Lobby queue display labels (WS6 T10). Hindi in Devanagari, Kannada in
// Kannada script. No web fonts: the page relies on the local font stack, and
// the operating system's fallback font draws any glyph the app font lacks.

export type QueueLang = 'en' | 'hi' | 'kn'

export interface QueueLabels {
  nowServing: string
  waiting: string
  ready: string
  room: string
  noTickets: string
  urgent: string
  emergency: string
}

export const QUEUE_LANGS: readonly QueueLang[] = ['en', 'hi', 'kn']

/** The language's own name, for the toggle. */
export const QUEUE_LANG_NAMES: Record<QueueLang, string> = { en: 'English', hi: 'हिन्दी', kn: 'ಕನ್ನಡ' }

export const QUEUE_LABELS: Record<QueueLang, QueueLabels> = {
  en: {
    nowServing: 'Now serving',
    waiting: 'Waiting',
    ready: 'Ready',
    room: 'Room',
    noTickets: 'No tickets',
    urgent: 'Urgent',
    emergency: 'Emergency',
  },
  hi: {
    nowServing: 'अब सेवा में',
    waiting: 'प्रतीक्षा में',
    ready: 'तैयार',
    room: 'कक्ष',
    noTickets: 'कोई टोकन नहीं',
    urgent: 'अत्यावश्यक',
    emergency: 'आपातकालीन',
  },
  kn: {
    nowServing: 'ಈಗ ಸೇವೆಯಲ್ಲಿ',
    waiting: 'ಕಾಯುತ್ತಿರುವವರು',
    ready: 'ಸಿದ್ಧ',
    room: 'ಕೊಠಡಿ',
    noTickets: 'ಯಾವುದೇ ಟೋಕನ್‌ಗಳಿಲ್ಲ',
    urgent: 'ತುರ್ತು',
    emergency: 'ತುರ್ತು ಪರಿಸ್ಥಿತಿ',
  },
}

export function isQueueLang(lang: string | null | undefined): lang is QueueLang {
  return lang === 'en' || lang === 'hi' || lang === 'kn'
}

/** Labels for `lang`; anything unknown or missing is English. */
export function queueLabels(lang: string | null): QueueLabels {
  return isQueueLang(lang) ? QUEUE_LABELS[lang] : QUEUE_LABELS.en
}
