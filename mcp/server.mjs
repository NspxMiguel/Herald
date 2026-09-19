#!/usr/bin/env node
// Herald as an MCP server: the same bridge the CLI uses, shaped as tools so the
// agent can reach it without shelling out. Written against the JSON-RPC wire
// format directly — one file, no dependency to keep current.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { home, readJson } = require('../src/core/paths.cjs');
const { spawn } = require('node:child_process');

const DAEMON = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'src',
  'daemon.cjs'
);

// Same rule as the CLI: needing the daemon is not a reason to bother anybody, so
// it gets started. Only the QR scan ever requires a human.
async function ensureDaemon() {
  const reachable = async () => {
    const found = readJson(path.join(home(), 'bridge.json'));
    if (!found) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${found.port}/status`, {
        headers: { authorization: `Bearer ${found.token}` },
        signal: AbortSignal.timeout(2000)
      });
      return response.ok ? found : null;
    } catch {
      return null;
    }
  };

  if (await reachable()) return;
  fs.mkdirSync(home(), { recursive: true });
  const log = fs.openSync(path.join(home(), 'daemon.log'), 'a');
  spawn(process.execPath, [DAEMON], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await reachable()) return;
  }
  throw new Error('Herald could not start. Ask Miguel to run: herald status');
}

async function call(method, route, payload) {
  await ensureDaemon();
  const door = readJson(path.join(home(), 'bridge.json'));
  if (!door) throw new Error('Herald is not running.');
  const url = new URL(`http://127.0.0.1:${door.port}${route}`);
  if (method === 'GET' && payload) {
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${door.token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
    },
    body: method === 'POST' ? JSON.stringify(payload || {}) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Machine names on the wire, sentences here: the agent acts on what it reads.
    const said = {
      not_connected:
        'WhatsApp is not linked yet. Ask Miguel to run `herald login` in a terminal — ' +
        'it draws a QR code for him to scan, and that is the only step he has to do.',
      not_listed:
        `"${payload?.to ?? 'that person'}" is not on Herald's list. Ask Miguel to run ` +
        `\`herald allow "${payload?.to ?? 'Name'}" --auto\` — the agent cannot add contacts itself.`,
      ambiguous: `More than one contact matches: ${(body.matches || []).join(', ')}.`,
      group: 'Herald never writes to groups.',
      muted: 'That contact is switched off in Herald.',
      rate_limited: 'Too many messages to that person in the last hour.',
      too_long: 'The message is too long.'
    }[body.error];
    throw new Error(said || body.message || `Herald refused (${response.status})`);
  }
  return body;
}

const TOOLS = [
  {
    name: 'herald_send',
    description:
      "Send a WhatsApp message from Miguel's account to somebody he put on Herald's list. " +
      'Contacts set to "auto" receive it immediately; contacts set to "ask" put the message ' +
      'in his approval queue and it is NOT delivered until he approves it — the reply says which happened. ' +
      'Use this instead of driving his phone. Never writes to groups.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Contact name as listed in Herald, or the phone number.'
        },
        text: { type: 'string', description: 'The message, exactly as it should arrive.' },
        note: {
          type: 'string',
          description: 'Optional line for Miguel explaining why, shown only to him.'
        }
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'herald_contacts',
    description:
      'List who Herald is allowed to write to, and the mode of each one (auto / ask / off).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'herald_inbox',
    description:
      'Replies that came back from people on the list. Herald does not see the rest of his WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        unread: { type: 'boolean', description: 'Only what has not been read yet.' },
        markRead: { type: 'boolean', description: 'Mark everything read afterwards.' }
      }
    }
  },
  {
    name: 'herald_thread',
    description:
      'The recent conversation with one contact. Messages Herald sent are flagged byAgent, so the ' +
      "agent's own words are distinguishable from Miguel's.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        limit: { type: 'number', description: 'How many messages back, up to 100.' }
      },
      required: ['to']
    }
  },
  {
    name: 'herald_status',
    description: 'Whether the WhatsApp session is connected, and how much is waiting for approval.',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function runTool(name, args = {}) {
  switch (name) {
    case 'herald_send': {
      const result = await call('POST', '/send', args);
      return result.status === 'sent'
        ? `Sent to ${result.to}.`
        : `Queued for ${result.to} — waiting for Miguel to approve (id ${result.id}). Not delivered yet.`;
    }
    case 'herald_contacts': {
      const { contacts } = await call('GET', '/contacts');
      if (!contacts.length) return 'Nobody on the list yet.';
      return contacts.map((c) => `${c.name} (${c.mode})${c.note ? ` — ${c.note}` : ''}`).join('\n');
    }
    case 'herald_inbox': {
      const { messages } = await call('GET', '/inbox', { unread: args.unread ? 'true' : '' });
      if (args.markRead) await call('POST', '/inbox/read', {});
      if (!messages.length) return 'Nothing new.';
      return messages
        .slice()
        .reverse()
        .map((m) => `[${new Date(m.at).toISOString()}] ${m.from}: ${m.text || '(media)'}`)
        .join('\n');
    }
    case 'herald_thread': {
      const result = await call('GET', '/thread', { to: args.to, limit: args.limit });
      return result.messages
        .map((m) => {
          const who = m.from === 'me' ? (m.byAgent ? 'me (agent)' : 'me') : m.from;
          return `[${new Date(m.at).toISOString()}] ${who}: ${m.text || '(media)'}`;
        })
        .join('\n');
    }
    case 'herald_status': {
      const status = await call('GET', '/status');
      return JSON.stringify(status, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  const reply = (result) => id !== undefined && write({ jsonrpc: '2.0', id, result });

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'herald', version: '1.0.0' }
      });
    }
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const text = await runTool(params?.name, params?.arguments || {});
      return reply({ content: [{ type: 'text', text }] });
    }
    if (method === 'ping') return reply({});
    if (id !== undefined) {
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  } catch (error) {
    if (id !== undefined) {
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Herald: ${error.message}` }], isError: true }
      });
    }
  }
});
