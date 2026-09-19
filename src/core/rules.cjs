'use strict';

// The whole safety model of this app is here, deliberately in one file with no
// I/O in it, so it can be read in one sitting and tested without a phone.
//
// Herald hands the agent a real WhatsApp account that belongs to a person. The
// rules below are what keep that from being the same thing as handing over his
// phone:
//
//   1. nobody is reachable by default — only contacts the owner picked himself;
//   2. every contact carries a mode, and a new one is always 'ask';
//   3. groups are never a destination, whatever the mode says;
//   4. a rate limit applies even to 'auto' contacts, so a loop in the agent
//      cannot turn into forty messages to somebody's father;
//   5. reading is scoped to the same list — the rest of the mailbox is his.

const contactId = require('./contact-id.cjs');

const MODES = ['ask', 'auto', 'off'];
const DEFAULT_MODE = 'ask';

// Per contact, per hour. Chosen to be comfortably above any honest use (a
// question, a follow-up, a thank-you) and far below anything that reads as a
// malfunction on the other person's phone.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 12;

const MAX_MESSAGE_LENGTH = 4000;

function normalizeMode(value) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase();
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

// The agent addresses people the way the owner does: by name. Exact match first,
// then a unique case-insensitive prefix, then the phone number. Ambiguity is an
// error rather than a guess, because guessing here means messaging the wrong
// person.
function resolveTarget(contacts, target) {
  const list = contacts || [];
  const query = String(target ?? '').trim();
  if (!query) return { error: 'no_target' };

  const digits = contactId.digitsOf(query);
  if (digits.length >= 8) {
    const byNumber = list.filter((contact) => contactId.matchesContact(contact, digits));
    if (byNumber.length === 1) return { contact: byNumber[0] };
    if (byNumber.length > 1) return { error: 'ambiguous', matches: byNumber };
    return { error: 'not_listed', query };
  }

  const folded = query.toLowerCase();
  const exact = list.filter((contact) => String(contact.name).toLowerCase() === folded);
  if (exact.length === 1) return { contact: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous', matches: exact };

  const partial = list.filter((contact) => String(contact.name).toLowerCase().includes(folded));
  if (partial.length === 1) return { contact: partial[0] };
  if (partial.length > 1) return { error: 'ambiguous', matches: partial };
  return { error: 'not_listed', query };
}

function recentSends(log, contact, now = Date.now()) {
  const key = contactId.userPartOf(contact.phone || contact.waId);
  return (log[key] || []).filter((time) => now - time < RATE_WINDOW_MS);
}

// The single decision the rest of the app asks for: may this text go to this
// target right now, and if so does it leave immediately or wait for the owner.
function decideSend({ contacts, target, text, log = {}, now = Date.now() }) {
  const body = String(text ?? '').trim();
  if (!body) return { allowed: false, reason: 'empty_message' };
  if (body.length > MAX_MESSAGE_LENGTH) {
    return { allowed: false, reason: 'too_long', limit: MAX_MESSAGE_LENGTH };
  }

  const found = resolveTarget(contacts, target);
  if (found.error) {
    return {
      allowed: false,
      reason: found.error,
      matches: (found.matches || []).map((contact) => contact.name)
    };
  }

  const contact = found.contact;
  if (contact.isGroup) return { allowed: false, reason: 'group', contact };

  const mode = normalizeMode(contact.mode);
  if (mode === 'off') return { allowed: false, reason: 'muted', contact };

  const recent = recentSends(log, contact, now);
  if (recent.length >= RATE_MAX_PER_WINDOW) {
    return {
      allowed: false,
      reason: 'rate_limited',
      contact,
      retryAfterMs: RATE_WINDOW_MS - (now - recent[0])
    };
  }

  return { allowed: true, contact, mode, delivery: mode === 'auto' ? 'sent' : 'pending' };
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  RATE_WINDOW_MS,
  RATE_MAX_PER_WINDOW,
  MAX_MESSAGE_LENGTH,
  normalizeMode,
  resolveTarget,
  recentSends,
  decideSend
};
