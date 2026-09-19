'use strict';

// The process that holds the WhatsApp session. It is the only long-lived piece
// of Herald: everything else — the CLI, the MCP server — is a thin client that
// talks to it over a loopback socket, because WhatsApp Web allows exactly one
// linked browser and it has to stay open between messages.
//
// It has no window and never asks for anything. The single moment a human is
// needed is the QR code, and even that is drawn in his terminal by `herald
// login`, which reads it from here.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');

const signature = require('./core/signature.cjs');
const contactId = require('./core/contact-id.cjs');
const rules = require('./core/rules.cjs');
const { createBridge, newToken, DEFAULT_PORT } = require('./core/bridge.cjs');
const { home, readJson, writeJson } = require('./core/paths.cjs');

const JOURNAL_LIMIT = 300;
const INBOX_LIMIT = 200;

const defaults = {
  contacts: [],
  // 'list' keeps to the allow-list; 'ask' lets the agent reach anybody in his
  // address book and makes every message wait for him. See core/rules.cjs.
  gate: rules.DEFAULT_GATE,
  // Which channel he answers the queue on. See core/rules.cjs — 'mac' keeps the
  // decision in his terminal, where the agent cannot reach it.
  approvals: rules.DEFAULT_APPROVALS,
  // The visible line that tells the person reading that this is software. Always
  // present; only its wording is the owner's to choose.
  identity: '',
  port: DEFAULT_PORT,
  token: '',
  notify: true
};

let settings = { ...defaults };
let client = null;
const sendLog = Object.create(null);

const state = {
  connection: 'disconnected',
  qr: null,
  error: null,
  startedAt: Date.now(),
  pending: [],
  journal: [],
  inbox: []
};

/* ----------------------------------------------------------------- settings */

function settingsPath() {
  return path.join(home(), 'settings.json');
}

function load() {
  const saved = readJson(settingsPath()) || {};
  settings = {
    ...defaults,
    ...saved,
    gate: rules.normalizeGate(saved.gate),
    approvals: rules.normalizeApprovals(saved.approvals),
    identity: signature.normalizeLabel(saved.identity),
    contacts: (saved.contacts || []).map((contact) => ({
      ...contact,
      mode: rules.normalizeMode(contact.mode)
    }))
  };
  if (!settings.token) {
    settings.token = newToken();
    save();
  }
}

// The file holds the bridge token, so it is 0600 and lives nowhere else.
function save() {
  writeJson(settingsPath(), settings);
}

/* ------------------------------------------------------------------ journal */

function record(entry) {
  state.journal.unshift({ id: crypto.randomUUID(), at: Date.now(), ...entry });
  state.journal = state.journal.slice(0, JOURNAL_LIMIT);
}

// Without a window, this is the only way he learns something is waiting. Fire
// and forget: a missing notification must never hold up a message.
function notify(title, body) {
  if (!settings.notify || process.platform !== 'darwin') return;
  const escape = (text) => String(text).replace(/["\\]/g, '\\$&').slice(0, 200);
  execFile(
    'osascript',
    ['-e', `display notification "${escape(body)}" with title "${escape(title)}"`],
    () => {}
  );
}

/* ----------------------------------------------------------------- whatsapp */

function chromeExecutable() {
  if (process.env.HERALD_CHROME_PATH) return process.env.HERALD_CHROME_PATH;
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium'
        ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    // Herald deliberately does not ship a browser: WhatsApp Web runs in the one
    // already installed. Saying so beats puppeteer's own error, which blames a
    // missing download nobody asked for.
    throw new Error(
      'No Chrome found. Install Google Chrome (or Chromium), or point HERALD_CHROME_PATH at one.'
    );
  }
  return found;
}

// WhatsApp migrated accounts to LID addressing: the phone book still reports
// 554792078506@c.us while the account's sendable id is now something like
// 220301992398854@lid. Sending to the phone-shaped id reaches nobody, so the id
// is resolved once per contact and kept.
async function resolveChatId(contact) {
  if (contact.waId && contact.waId.includes('@')) return contact.waId;
  const numberId = await client.getNumberId(contactId.userPartOf(contact.phone));
  if (!numberId?._serialized) {
    throw new Error(`${contact.name} does not look like a WhatsApp account.`);
  }
  const stored = settings.contacts.find((candidate) => candidate.id === contact.id);
  if (stored) {
    stored.waId = numberId._serialized;
    save();
  }
  return numberId._serialized;
}

async function resolveMissingContactIds() {
  const missing = settings.contacts.filter((contact) => !contact.waId);
  if (!missing.length) return;
  let resolved = 0;
  for (const contact of missing) {
    try {
      const numberId = await client.getNumberId(contactId.userPartOf(contact.phone));
      if (numberId?._serialized) {
        contact.waId = numberId._serialized;
        resolved += 1;
      }
    } catch (error) {
      console.warn(`Could not resolve ${contact.name}: ${error.message}`);
    }
  }
  if (resolved) save();
}

// whatsapp-web.js can resolve sendMessage with an empty result when WhatsApp Web
// moves under it: no error, no message, and the daemon would happily report a
// send that never happened. Nothing counts as sent without an id back.
// Whether a send worked is decided by sendMessage resolving, not by what it
// resolves to. Measured against a real account on 19/09/2026: six consecutive
// sends all arrived, and every one of them resolved with undefined. On this
// WhatsApp Web build the library's whole feedback layer is gone — sendMessage
// describes nothing, chat.fetchMessages throws, and message_create never fires —
// while the send itself works every time.
//
// Treating undefined as failure was therefore wrong, and not harmlessly wrong:
// the caller put each "failed" message back on the queue and a real person got
// the same text three times. Between reporting a delivered message as failed and
// reporting a failed one as delivered, only the first is proven to happen here,
// and only the first spams somebody. So a throw is the failure, and anything
// else is a send.
async function sendAndConfirm(chatId, text) {
  const sent = await client.sendMessage(chatId, text);
  if (sent?.id?._serialized) return sent;
  // No id to record. The send still happened; the log says so rather than
  // pretending to an id that this build did not hand back.
  console.log(`herald: sent, but this build described it as ${describe(sent)} — no message id`);
  return { id: { _serialized: '' } };
}

// Enough of an unknown value to tell those two cases apart, and never the
// message body: this line goes to a log file.
function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') return `${typeof value} ${JSON.stringify(value)}`;
  const keys = Object.keys(value);
  const id = value.id ? `id:{${Object.keys(value.id).join(',')}}` : 'no id';
  return `object keys:[${keys.join(',')}] ${id}`;
}

async function deliver(contact, text) {
  const chatId = await resolveChatId(contact);
  const sent = await sendAndConfirm(chatId, signature.sign(text, settings.identity));
  const key = contactId.userPartOf(contact.phone || contact.waId);
  sendLog[key] = [...(sendLog[key] || []), Date.now()].filter(
    (time) => Date.now() - time < rules.RATE_WINDOW_MS
  );
  return sent;
}

function phoneBook() {
  return client.getContacts().then((contacts) => {
    const unique = new Map();
    for (const contact of contacts) {
      if (!contact.isMyContact || contact.isMe || contact.isGroup || contact.isBlocked) continue;
      const waId = contact.id?._serialized || '';
      if (!contactId.isPersonId(waId)) continue;

      // Since the LID migration, getContacts() returns the same person twice:
      // same serialized id, but `number` carrying the phone on one entry and the
      // LID number on the other. Measured on this account, 19/09/2026: 60 of 125
      // contacts came back duplicated, so searching a name found two matches and
      // refused to send to either. The serialized id is the thing that actually
      // addresses a chat, so it decides identity here, and for a @c.us id its
      // own user part is the phone number — `number` is not to be trusted.
      const phone = waId.endsWith('@c.us')
        ? contactId.userPartOf(waId)
        : contactId.userPartOf(contact.number);
      const name = String(contact.name || contact.pushname || '').trim();
      // Service accounts, short codes and broadcast ids are not people.
      if (!name || phone.length < 8 || phone.length > 15) continue;
      if (unique.has(waId)) continue;
      unique.set(waId, { waId, phone, name });
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}

/* ------------------------------------------------------------------ sending */

// In 'ask' mode the target does not have to be on the list, but it does have to
// be a real contact in his phone: a name he never saved is not somebody the
// agent gets to message, and a raw number is not a person he knows.
async function fromPhoneBook(target) {
  const query = String(target ?? '').trim();
  if (!query) return null;
  const all = await phoneBook();
  const digits = contactId.digitsOf(query);

  const byNumber =
    digits.length >= 8 ? all.filter((entry) => contactId.sameContact(entry.phone, digits)) : [];
  const folded = query.toLowerCase();
  const exact = all.filter((entry) => entry.name.toLowerCase() === folded);
  const partial = all.filter((entry) => entry.name.toLowerCase().includes(folded));
  const hits = byNumber.length ? byNumber : exact.length ? exact : partial;

  if (!hits.length) return { error: 'not_in_phonebook' };
  if (hits.length > 1) return { error: 'ambiguous', matches: hits.map((entry) => entry.name) };
  return { contact: { ...hits[0], id: `book:${hits[0].phone}`, mode: 'ask', ephemeral: true } };
}

async function requestSend({ to, text, note, origin = 'agent' }) {
  const asking = rules.normalizeGate(settings.gate) === 'ask';
  let guest;

  if (asking && rules.resolveTarget(settings.contacts, to).error) {
    requireReady();
    const found = await fromPhoneBook(to);
    if (found?.error) {
      record({ kind: 'refused', name: String(to ?? ''), reason: found.error, text });
      return {
        status: 400,
        body: { error: found.error, query: String(to ?? ''), matches: found.matches }
      };
    }
    guest = found?.contact;
  }

  const decision = rules.decideSend({
    contacts: settings.contacts,
    target: to,
    text,
    log: sendLog,
    gate: settings.gate,
    contact: guest
  });

  if (!decision.allowed) {
    record({ kind: 'refused', name: String(to ?? ''), reason: decision.reason, text });
    return {
      status: decision.reason === 'rate_limited' ? 429 : 400,
      body: {
        error: decision.reason,
        query: String(to ?? ''),
        matches: decision.matches,
        limit: decision.limit,
        retryAfterMs: decision.retryAfterMs
      }
    };
  }

  const contact = decision.contact;
  const body = String(text).trim();

  if (decision.delivery === 'sent') {
    const sent = await deliver(contact, body);
    record({
      kind: 'sent',
      contactId: contact.id,
      name: contact.name,
      text: body,
      waMessageId: sent.id._serialized
    });
    return { body: { status: 'sent', to: contact.name } };
  }

  const item = {
    id: crypto.randomUUID().slice(0, 8),
    at: Date.now(),
    contactId: contact.id,
    // A guest resolved from the phone book is on no list, so the queue carries
    // the whole contact: approving must not depend on him adding them first.
    contact: contact.ephemeral ? contact : null,
    name: contact.name,
    text: body,
    note: String(note ?? '').trim(),
    origin
  };
  state.pending.unshift(item);
  record({ kind: 'queued', contactId: contact.id, name: contact.name, text: body });
  // He gets the notification whichever channel he answers on: a message waiting
  // in a chat he has closed would otherwise wait forever, and a receipt on his
  // screen is also how a chat approval stays impossible to miss.
  const how =
    rules.normalizeApprovals(settings.approvals) === 'chat'
      ? 'waiting for you in the chat'
      : `herald approve ${item.id}`;
  notify(`Herald → ${contact.name}`, `${body.slice(0, 120)}\n${how}`);
  return { body: { status: 'pending', id: item.id, to: contact.name } };
}

async function decidePending({ id, action, always = false, by = 'owner' }) {
  // A decision relayed by the agent only counts when he delegated that channel.
  // Checked before the item is pulled off the queue, so a refusal leaves the
  // message exactly where it was.
  if (by === 'agent' && !rules.agentMayDecide(settings.approvals)) {
    return {
      status: 403,
      body: { error: 'approval_not_delegated', approvals: rules.normalizeApprovals(settings.approvals) }
    };
  }

  const item = state.pending.find((candidate) => candidate.id === id);
  if (!item) return { status: 404, body: { error: 'unknown_request' } };
  state.pending = state.pending.filter((candidate) => candidate.id !== id);

  if (action !== 'approve') {
    record({ kind: 'rejected', contactId: item.contactId, name: item.name, text: item.text, by });
    return { body: { status: 'rejected', id, to: item.name, by } };
  }

  const contact =
    settings.contacts.find((candidate) => candidate.id === item.contactId) || item.contact;
  if (!contact) {
    state.pending.unshift(item);
    return { status: 404, body: { error: 'not_listed' } };
  }

  // The item came off the queue above so that two approvals cannot send it
  // twice. If the delivery then fails, that removal has to be undone: an
  // approval that evaporates is worse than one that is refused, because he
  // believes the message went out and there is nothing left to retry.
  let sent;
  try {
    sent = await deliver(contact, item.text);
  } catch (error) {
    state.pending.unshift(item);
    record({
      kind: 'failed',
      contactId: contact.id,
      name: contact.name,
      text: item.text,
      error: error.message
    });
    return {
      status: 502,
      body: { error: 'delivery_failed', message: error.message, id: item.id, to: contact.name }
    };
  }

  // Approving a message to somebody off the list opens that conversation: their
  // reply has to reach the agent, otherwise it asked a question it can never
  // hear the answer to. They join the list at 'ask', marked as having arrived
  // this way — never at 'auto', and never without him having approved first.
  if (contact.ephemeral && !settings.contacts.some((entry) => entry.id === contact.id)) {
    const { ephemeral, ...entry } = contact;
    settings.contacts = [...settings.contacts, { ...entry, mode: 'ask', viaApproval: true }].sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    save();
  }
  record({
    kind: 'sent',
    contactId: contact.id,
    name: contact.name,
    text: item.text,
    approved: true,
    // Written down so `herald log` can always answer "who let this one out" —
    // the point of allowing the chat channel is transparency, not trust.
    by,
    always: always || undefined,
    waMessageId: sent.id._serialized || ''
  });

  // "and stop asking me about this one" — the contact goes to 'auto'. It is the
  // same switch as `herald allow NAME --auto`, reached from the answer instead
  // of from a second command.
  let standing = null;
  if (always) {
    const stored = settings.contacts.find((entry) => entry.id === contact.id);
    if (stored) stored.mode = 'auto';
    save();
    // The global 'ask' mode queues everything, with no per-contact exception —
    // that is written into rules.cjs on purpose. Saying "always" while it is on
    // therefore changes nothing today, and pretending otherwise would be the
    // trap that mode exists to avoid. So it is said out loud instead.
    standing =
      rules.normalizeGate(settings.gate) === 'ask'
        ? `${contact.name} is now 'auto', but your global mode is 'ask', which queues every ` +
          "message with no exception — so this one will still wait. Run: herald mode list"
        : `${contact.name} is now 'auto' — messages go out without asking you.`;
  }

  return { body: { status: 'sent', id, to: contact.name, by, standing } };
}

/* ---------------------------------------------------------------- receiving */

// Herald reads exactly as much of his WhatsApp as it writes to: the people on
// the list, and nobody else. Anyone else is dropped here, before being stored,
// counted or shown — his conversations are not the agent's to see.
// Learns which @lid belongs to which contact, the only way that link can be
// made: ask WhatsApp who sent this. Done once per contact and written down, so
// the next message from them matches without a lookup.
async function linkLid(message) {
  try {
    const who = await message.getContact();
    const number = who?.number || who?.id?.user || '';
    if (!number) return null;
    const contact = contactId.findContact(settings.contacts, number);
    if (!contact) return null;
    contact.lid = message.from;
    save();
    console.log(`herald: ${contact.name} also answers as ${message.from} — linked`);
    return contact;
  } catch (error) {
    console.log(`herald: could not resolve ${message.from} (${error.message})`);
    return null;
  }
}

async function handleIncoming(message) {
  if (message.fromMe) return;
  // Which of the three filters dropped it, and never the body: this is a log
  // file, and the point is to tell "the event never fired" apart from "it fired
  // and we threw it away".
  const from = message.from || '';
  if (!contactId.isPersonId(from)) {
    console.log(`herald: incoming from ${from} — not a person id, dropped`);
    return;
  }
  let contact = contactId.findContact(settings.contacts, from);
  if (!contact && contactId.isLid(from)) contact = await linkLid(message);
  if (!contact) {
    console.log(`herald: incoming from ${from} — no contact on the list matches, dropped`);
    return;
  }
  if (rules.normalizeMode(contact.mode) === 'off') {
    console.log(`herald: incoming from ${contact.name} — switched off, dropped`);
    return;
  }
  console.log(`herald: incoming from ${contact.name} — kept`);

  const entry = {
    id: message.id?._serialized || crypto.randomUUID(),
    at: (message.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    name: contact.name,
    text: signature.strip(message.body || ''),
    hasMedia: Boolean(message.hasMedia),
    read: false
  };
  state.inbox = [entry, ...state.inbox.filter((item) => item.id !== entry.id)].slice(
    0,
    INBOX_LIMIT
  );
  record({ kind: 'received', contactId: contact.id, name: contact.name, text: entry.text });
}

async function readThread({ to, limit = 30 }) {
  const found = rules.resolveTarget(settings.contacts, to);
  if (found.error) {
    return {
      status: 400,
      body: {
        error: found.error,
        query: String(to ?? ''),
        matches: (found.matches || []).map((item) => item.name)
      }
    };
  }
  const contact = found.contact;
  const chat = await client.getChatById(await resolveChatId(contact));
  const messages = await chat.fetchMessages({ limit: Math.min(Number(limit) || 30, 100) });
  return {
    body: {
      contact: contact.name,
      messages: messages.map((message) => ({
        at: (message.timestamp || 0) * 1000,
        from: message.fromMe ? 'me' : contact.name,
        // A message he typed himself and one Herald sent for him both come back
        // as fromMe; the marker is the only thing that tells them apart.
        byAgent: message.fromMe ? signature.isSigned(message.body || '') : false,
        text: signature.isSigned(message.body || '')
          ? signature.readable(message.body || '')
          : signature.strip(message.body || ''),
        hasMedia: Boolean(message.hasMedia)
      }))
    }
  };
}

/* ------------------------------------------------------------------ session */

function startSession() {
  if (client) return;
  state.connection = 'connecting';
  state.error = null;

  let chrome;
  try {
    chrome = chromeExecutable();
  } catch (error) {
    state.connection = 'error';
    state.error = error.message;
    return;
  }

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'herald', dataPath: path.join(home(), 'whatsapp') }),
    puppeteer: {
      headless: true,
      executablePath: chrome,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  // Off unless asked for, and names only — never message contents. This is what
  // tells a dead event layer apart from a filter throwing traffic away, without
  // needing anybody to send a message to prove it. It is how the dropped @lid
  // above was found: the events were firing all along.
  if (process.env.HERALD_TRACE_EVENTS) {
    const emit = client.emit.bind(client);
    client.emit = (event, ...rest) => {
      console.log(`herald: event ${String(event)}`);
      return emit(event, ...rest);
    };
  }

  client.on('qr', (qr) => {
    // Kept raw. `herald login` reads it from here and draws it in his terminal,
    // which is the only screen this app ever uses.
    state.qr = qr;
    state.connection = 'scan_qr';
  });
  client.on('authenticated', () => {
    state.qr = null;
    state.connection = 'authenticating';
  });
  client.on('ready', () => {
    state.qr = null;
    state.error = null;
    state.connection = 'ready';
    resolveMissingContactIds().catch((error) => console.warn('resolve:', error.message));
  });
  client.on('auth_failure', (reason) => {
    state.connection = 'error';
    state.error = `WhatsApp refused the session: ${reason}`;
  });
  client.on('disconnected', (reason) => {
    client = null;
    state.connection = 'disconnected';
    state.error = `WhatsApp disconnected: ${reason}`;
  });
  // Both names for the same traffic. 'message' is the documented one; on builds
  // where it goes quiet, 'message_create' still carries incoming messages, and
  // handleIncoming drops anything fromMe anyway.
  client.on('message_create', (message) => {
    if (!message?.fromMe) handleIncoming(message);
  });

  client.on('message', (message) => {
    try {
      handleIncoming(message);
    } catch (error) {
      console.error('incoming:', error.message);
    }
  });

  client.initialize().catch((error) => {
    client = null;
    state.connection = 'error';
    state.error = `Could not start the WhatsApp session: ${error.message}`;
  });
}

function requireReady() {
  if (!client || state.connection !== 'ready') throw new Error('WhatsApp is not connected.');
}

/* ------------------------------------------------------------------- routes */

const routes = {
  'GET /status': async () => ({
    body: {
      connection: state.connection,
      gate: rules.normalizeGate(settings.gate),
      approvals: rules.normalizeApprovals(settings.approvals),
      identity: signature.normalizeLabel(settings.identity),
      contacts: settings.contacts.length,
      pending: state.pending.length,
      unread: state.inbox.filter((item) => !item.read).length,
      uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
      error: state.error
    }
  }),

  // What `herald login` polls: the raw QR string, or the fact that it is no
  // longer needed.
  'GET /qr': async () => ({ body: { connection: state.connection, qr: state.qr } }),

  'POST /login': async () => {
    startSession();
    return { body: { connection: state.connection } };
  },

  // Unlinking is a real WhatsApp operation, not just closing the browser: the
  // device disappears from his phone's Linked devices list.
  'POST /logout': async () => {
    const current = client;
    client = null;
    state.connection = 'disconnected';
    state.qr = null;
    if (current) {
      await current.logout().catch(() => {});
      await current.destroy().catch(() => {});
    }
    return { body: { ok: true } };
  },

  'GET /mode': async () => ({ body: { gate: rules.normalizeGate(settings.gate) } }),

  'GET /identity': async () => ({
    body: {
      identity: signature.normalizeLabel(settings.identity),
      example: signature.sign('…', settings.identity).replace(signature.MARKER, '')
    }
  }),

  // Only the wording changes here. There is no route that removes the line,
  // because "always identifies itself" was the requirement, not a default.
  'POST /identity': async ({ identity }) => {
    const wanted = String(identity ?? '').trim();
    if (!wanted) return { status: 400, body: { error: 'empty_identity' } };
    settings.identity = signature.normalizeLabel(wanted);
    save();
    return {
      body: {
        identity: settings.identity,
        example: signature.sign('…', settings.identity).replace(signature.MARKER, '')
      }
    };
  },

  'GET /approvals': async () => ({
    body: { approvals: rules.normalizeApprovals(settings.approvals), allowed: rules.APPROVALS }
  }),

  // Only ever reachable from the owner's own terminal: the agent has no tool
  // that maps here, so it cannot widen its own permission.
  'POST /approvals': async ({ approvals }) => {
    const wanted = String(approvals ?? '').toLowerCase();
    if (!rules.APPROVALS.includes(wanted)) {
      return { status: 400, body: { error: 'bad_approvals', allowed: rules.APPROVALS } };
    }
    settings.approvals = rules.normalizeApprovals(wanted);
    save();
    return { body: { approvals: settings.approvals } };
  },

  'POST /mode': async ({ gate }) => {
    if (!rules.GATES.includes(String(gate ?? '').toLowerCase())) {
      return { status: 400, body: { error: 'bad_gate', allowed: rules.GATES } };
    }
    settings.gate = rules.normalizeGate(gate);
    save();
    return { body: { gate: settings.gate } };
  },

  'GET /contacts': async () => ({
    body: {
      gate: rules.normalizeGate(settings.gate),
      contacts: settings.contacts.map((contact) => ({
        name: contact.name,
        phone: contactId.displayNumber(contact.phone),
        mode: rules.normalizeMode(contact.mode),
        note: contact.note || '',
        viaApproval: Boolean(contact.viaApproval)
      }))
    }
  }),

  // The phone book, for `herald allow` to pick from. Reading it is not the same
  // as being allowed to write to anybody in it.
  'GET /phonebook': async ({ query }) => {
    requireReady();
    const all = await phoneBook();
    const needle = String(query ?? '').toLowerCase();
    return {
      body: {
        contacts: needle
          ? all.filter((contact) => contact.name.toLowerCase().includes(needle))
          : all
      }
    };
  },

  'POST /contacts/add': async ({ name, phone, waId, mode, note }) => {
    const digits = contactId.userPartOf(phone);
    if (!digits) return { status: 400, body: { error: 'bad_number' } };
    const already = settings.contacts.find((contact) =>
      contactId.sameContact(contact.phone, digits)
    );
    const entry = {
      id: already?.id || crypto.randomUUID().slice(0, 8),
      name: String(name || already?.name || digits).trim(),
      phone: digits,
      waId: waId || already?.waId || '',
      note: note === undefined ? already?.note || '' : String(note).trim(),
      mode: rules.normalizeMode(mode ?? already?.mode)
    };
    settings.contacts = [...settings.contacts.filter((c) => c.id !== entry.id), entry].sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    save();
    return { body: { contact: { name: entry.name, mode: entry.mode } } };
  },

  'POST /contacts/remove': async ({ name }) => {
    const found = rules.resolveTarget(settings.contacts, name);
    if (found.error)
      return { status: 400, body: { error: found.error, query: String(name ?? '') } };
    settings.contacts = settings.contacts.filter((contact) => contact.id !== found.contact.id);
    save();
    return { body: { removed: found.contact.name } };
  },

  'POST /send': async ({ to, text, note }) => {
    requireReady();
    return requestSend({ to, text, note });
  },

  'GET /pending': async () => ({
    body: {
      pending: state.pending.map((item) => ({
        id: item.id,
        to: item.name,
        text: item.text,
        note: item.note,
        at: item.at
      }))
    }
  }),

  'POST /pending/decide': async ({ id, action, always, by }) => {
    if (action === 'approve') requireReady();
    return decidePending({
      id,
      action,
      always: Boolean(always),
      by: by === 'agent' ? 'agent' : 'owner'
    });
  },

  'GET /request': async ({ id }) => {
    if (state.pending.some((item) => item.id === id)) return { body: { status: 'pending', id } };
    const decided = state.journal.find(
      (entry) => entry.kind === 'rejected' || entry.kind === 'sent'
    );
    return { body: { status: decided?.kind === 'rejected' ? 'rejected' : 'done', id } };
  },

  'GET /inbox': async ({ unread }) => {
    const wanted = String(unread ?? '') === 'true';
    return {
      body: {
        messages: state.inbox
          .filter((item) => (wanted ? !item.read : true))
          .map(({ name, at, text, hasMedia, read }) => ({ from: name, at, text, hasMedia, read }))
      }
    };
  },

  'POST /inbox/read': async () => {
    state.inbox = state.inbox.map((item) => ({ ...item, read: true }));
    return { body: { ok: true } };
  },

  'GET /thread': async ({ to, limit }) => {
    requireReady();
    return readThread({ to, limit });
  },

  'GET /journal': async ({ limit }) => ({
    body: { entries: state.journal.slice(0, Math.min(Number(limit) || 30, JOURNAL_LIMIT)) }
  }),

  'POST /stop': async () => {
    // Answer first, then go: the client is waiting on this response, and the
    // browser takes a moment to close.
    setTimeout(() => shutdown(), 50);
    return { body: { ok: true } };
  }
};

/* ----------------------------------------------------------------- shutdown */

// Leaving without this strands a headless Chrome holding the WhatsApp session:
// invisible, alive, and the next `herald login` then fights it for the profile
// directory. Measured on 19/09/2026 — `herald stop` reported success and left
// four Chrome processes running.
let leaving = false;

async function shutdown(code = 0) {
  if (leaving) return;
  leaving = true;
  const current = client;
  client = null;
  if (current) {
    await Promise.race([
      current.destroy().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000))
    ]);
  }
  try {
    fs.unlinkSync(path.join(home(), 'bridge.json'));
  } catch {
    /* it may already be gone */
  }
  process.exit(code);
}

/* -------------------------------------------------------------------- start */

async function main() {
  fs.mkdirSync(home(), { recursive: true });
  load();

  const bridge = createBridge({
    token: () => settings.token,
    routes,
    onError: (error) => console.error('bridge:', error.message)
  });

  let port;
  try {
    port = await bridge.listen(settings.port);
  } catch (error) {
    console.error(
      error.code === 'EADDRINUSE'
        ? `Port ${settings.port} is taken — Herald may already be running.`
        : `Could not open the local bridge: ${error.message}`
    );
    process.exit(1);
  }

  // How every client finds the door, so nothing has to be configured twice.
  writeJson(path.join(home(), 'bridge.json'), { port, token: settings.token, pid: process.pid });
  console.log(`herald: listening on 127.0.0.1:${port} (pid ${process.pid})`);

  // A session that has been linked before comes back on its own; a first run
  // waits for `herald login` so nothing spins up a browser for nothing.
  if (fs.existsSync(path.join(home(), 'whatsapp', 'session-herald'))) startSession();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => console.error('unhandled:', reason));
}

main();
