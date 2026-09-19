'use strict';

// Every message Herald sends ends with two Hangul Filler characters (U+3164).
// They render as blank space in WhatsApp but Unicode treats them as ordinary
// letters, so trimEnd() never eats them. The point is provenance: the owner's
// own typing and the agent's writing share one phone number, and this marker is
// what tells the two apart later — in the thread, in the log, and in any check
// of what was actually sent in his name.
const MARKER_CHARACTER = 'ㅤ';
const MARKER = MARKER_CHARACTER.repeat(2);

function strip(text) {
  return String(text ?? '').replace(new RegExp(`${MARKER_CHARACTER}+`, 'g'), '');
}

function isSigned(text) {
  return String(text ?? '').includes(MARKER);
}

function sign(text) {
  return `${strip(text).trimEnd()}${MARKER}`;
}

module.exports = { MARKER, MARKER_CHARACTER, sign, strip, isSigned };
