'use strict';

// One place decides where Herald keeps things, because four different pieces
// need to agree on it: the daemon that writes, the CLI and the MCP server that
// read, and anything written later.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function home() {
  if (process.env.HERALD_HOME) return process.env.HERALD_HOME;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'herald');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Everything Herald writes can contain the bridge token or the names of people
// he talks to, so all of it is 0600 and none of it is world-readable.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

module.exports = { home, readJson, writeJson };
