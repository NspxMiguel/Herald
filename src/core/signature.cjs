'use strict';

// Two signatures ride on every message Herald sends, and they answer different
// questions.
//
// The visible one tells the PERSON READING that they are talking to software,
// not to the account's owner. It is never optional: somebody answering a
// question about a server at eleven at night deserves to know who is asking.
// The owner picks its wording — 'assistente de IA', 'IA do Miguel', whatever
// fits how he talks to those people — but not whether it appears.
//
// The invisible one is two Hangul Filler characters (U+3164). They render as
// nothing, Unicode treats them as ordinary letters so trimEnd() never eats them,
// and they let the OWNER tell his own typing apart from the agent's inside a
// thread where both arrive from the same phone number, months later.

const MARKER_CHARACTER = 'ㅤ';
const MARKER = MARKER_CHARACTER.repeat(2);

const DEFAULT_LABELS = { pt: 'assistente de IA', en: 'AI assistant' };
const MAX_LABEL_LENGTH = 60;

function defaultLabel(language) {
  const tag = String(language ?? process.env.LANG ?? '').toLowerCase();
  return tag.startsWith('pt') ? DEFAULT_LABELS.pt : DEFAULT_LABELS.en;
}

function normalizeLabel(value, language) {
  const label = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[—–-]\s*/, '');
  if (!label) return defaultLabel(language);
  return label.slice(0, MAX_LABEL_LENGTH);
}

function strip(text) {
  return String(text ?? '').replace(new RegExp(`${MARKER_CHARACTER}+`, 'g'), '');
}

function isSigned(text) {
  return String(text ?? '').includes(MARKER);
}

// The label goes on its own line, the way a person signs off — not glued to the
// last sentence, where it reads as part of what was said.
function sign(text, label) {
  const body = strip(text).trimEnd();
  const mark = normalizeLabel(label);
  return `${body}\n— ${mark}${MARKER}`;
}

// What the agent reads back: the label it wrote itself is noise in a transcript,
// so it comes off, while anything the other person wrote stays untouched.
function readable(text) {
  const clean = strip(text);
  return clean.replace(/\n—[^\n]{0,80}$/, '').trimEnd();
}

module.exports = {
  MARKER,
  MARKER_CHARACTER,
  DEFAULT_LABELS,
  MAX_LABEL_LENGTH,
  defaultLabel,
  normalizeLabel,
  sign,
  strip,
  isSigned,
  readable
};
