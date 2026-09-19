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
//
// On top of those sits one global switch, because listing people one by one is
// work the owner should not have to do up front:
//
//   'list' (default)  the five rules exactly as written above;
//   'ask'             anyone in his WhatsApp address book is a valid target, and
//                     every message waits for him unless he has already said
//                     otherwise about that one person.
//
// That last clause is the only exception in the whole file, and it is not a
// hidden one: the single way a contact reaches 'auto' is the owner putting them
// there, either with `herald allow NAME --auto` or by answering "and stop asking
// me about this one" to a waiting message. `herald contacts` lists who is on it.
// An exception he granted by name, and can see, is a decision; what rule 2 above
// guards against is an exception he never made. Asking again after he has
// answered "always" is not caution, it is ignoring him.

const contactId = require('./contact-id.cjs');

const MODES = ['ask', 'auto', 'off'];
const DEFAULT_MODE = 'ask';

const GATES = ['list', 'ask'];
const DEFAULT_GATE = 'list';

// Where the owner answers when a message is waiting. This is about the channel
// he uses, not about whether he is asked: every rule above still holds.
//
//   'mac' (default)  the notification and `herald approve` in his terminal. The
//                    agent has no way to decide — the two sides are separate
//                    programs, which is what makes the queue a real gate.
//   'chat'           he answers inside the conversation he is already having
//                    with the agent, and the agent relays that answer. The gate
//                    is then only as strong as the agent showing him the real
//                    text, so this is opt-in, never the default, and every
//                    approval taken this way is written to the log as such.
//   'both'           either channel decides, whichever he reaches first.
const APPROVALS = ['mac', 'chat', 'both'];
const DEFAULT_APPROVALS = 'mac';

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

function normalizeGate(value) {
  const gate = String(value ?? '')
    .trim()
    .toLowerCase();
  return GATES.includes(gate) ? gate : DEFAULT_GATE;
}

function normalizeApprovals(value) {
  const choice = String(value ?? '')
    .trim()
    .toLowerCase();
  return APPROVALS.includes(choice) ? choice : DEFAULT_APPROVALS;
}

// Asked of every decision that did not come from the owner's own terminal. The
// default answer is no: delegating the queue is something he turns on, not
// something an agent can arrange for itself.
function agentMayDecide(approvals) {
  const choice = normalizeApprovals(approvals);
  return choice === 'chat' || choice === 'both';
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
function decideSend({ contacts, target, text, log = {}, now = Date.now(), gate, contact: given }) {
  const body = String(text ?? '').trim();
  if (!body) return { allowed: false, reason: 'empty_message' };
  if (body.length > MAX_MESSAGE_LENGTH) {
    return { allowed: false, reason: 'too_long', limit: MAX_MESSAGE_LENGTH };
  }

  // In 'ask' mode the caller may have resolved somebody straight from the phone
  // book, who is on no list and never will be. Everything below still applies.
  const found = given ? { contact: given } : resolveTarget(contacts, target);
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
  // 'off' is the owner saying no to this person specifically, which outranks the
  // global switch in both directions.
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

  // 'auto' is the owner's standing answer about this person, and it holds under
  // either gate. Everything else waits.
  return {
    allowed: true,
    contact,
    mode,
    gate: normalizeGate(gate),
    delivery: mode === 'auto' ? 'sent' : 'pending'
  };
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  GATES,
  DEFAULT_GATE,
  normalizeGate,
  APPROVALS,
  DEFAULT_APPROVALS,
  normalizeApprovals,
  agentMayDecide,
  RATE_WINDOW_MS,
  RATE_MAX_PER_WINDOW,
  MAX_MESSAGE_LENGTH,
  normalizeMode,
  resolveTarget,
  recentSends,
  decideSend
};
