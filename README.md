# Herald

Herald lends an AI agent a voice on WhatsApp, under rules you set.

It exists for a narrow problem. An agent working on your machine sometimes needs
something only a person can give — a port opened on a server, a permission, an
answer. Until now the only way to ask was to drive your phone through screen
automation: slow, visible, and impossible while you are using the computer.

Herald replaces that with one command:

```bash
herald send "Dad" "Can you open TCP 8793 on the VPS for the nspx user?"
```

There is no window. You link WhatsApp once, by scanning a QR code drawn in your
terminal, and after that the agent talks to people through the command line.

## What keeps this safe

Handing an agent a WhatsApp account is handing it a voice that other people will
read as yours. Five rules, all enforced in [`src/core/rules.cjs`](src/core/rules.cjs),
are what make that survivable:

|                                        |                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Allow-list**                         | Nobody is reachable until you add them. An empty list means nothing can be sent, to anybody.                                |
| **A mode per person**                  | `auto` goes out immediately. `ask` waits for you to approve it. A contact added without a flag is `ask`.                    |
| **Never groups**                       | Whatever the mode says.                                                                                                     |
| **Rate limit**                         | 12 messages per hour per person, `auto` included, so a loop in the agent cannot become forty messages to somebody's father. |
| **Reading is scoped to the same list** | Messages from anyone else are dropped before they are stored. The rest of your WhatsApp never passes through Herald.        |

Every message the agent sends ends with two invisible characters (U+3164). They
render as nothing, Unicode treats them as letters so trimming never eats them,
and they are what tells your own writing apart from the agent's — in the thread
itself, months later.

## Install

Herald drives the Chrome already on your machine; it does not download a
browser. Node 20+ and Google Chrome (or Chromium) are the requirements.

```bash
git clone https://github.com/NspxMiguel/Herald.git
cd Herald && bun install
ln -s "$PWD/bin/herald" ~/.local/bin/herald
```

## Using it

**Link WhatsApp — the one thing only you can do:**

```bash
herald login
```

A QR code appears in the terminal. On your phone: WhatsApp → Settings → Linked
devices → Link a device. It is asked once; the session survives restarts.

**Decide who the agent may write to:**

```bash
herald allow "Dad" --auto      # goes out immediately
herald allow "Ana" --ask       # queued for you to approve
herald contacts                # who is reachable, and how
herald deny "Ana"              # off the list
```

**What the agent runs:**

```bash
herald send "Dad" "the message"   # sends, or queues when the mode is 'ask'
herald send "Dad" "…" --wait      # blocks until you approve or reject
herald inbox --unread             # replies, from people on the list only
herald thread "Dad" --limit 20    # the conversation, agent lines marked
herald status
```

**When something is queued**, you get a notification and:

```bash
herald pending
herald approve a1b2c3d4
herald reject a1b2c3d4
```

`herald log` shows everything Herald has done — sent, queued, refused, received.

## As an MCP server

So the agent can reach Herald without shelling out. In your MCP config:

```json
{
  "mcpServers": {
    "herald": { "command": "node", "args": ["/absolute/path/to/Herald/mcp/server.mjs"] }
  }
}
```

Tools: `herald_send`, `herald_contacts`, `herald_inbox`, `herald_thread`,
`herald_status`. The agent cannot add contacts or change a mode through any of
them — that is deliberate, and it is the whole point of the list.

## How it fits together

```
bin/herald ──┐
             ├──► 127.0.0.1 (bearer token, 0600 file) ──► src/daemon.cjs ──► WhatsApp Web
mcp/server ──┘                                                  │
                                                          src/core/rules.cjs
```

WhatsApp Web allows one linked browser, so the session lives in a daemon and
everything else is a thin client. The daemon starts itself the first time any
command needs it. Nothing listens off the loopback interface.

State lives in `~/.config/herald/`, all of it `0600`: `settings.json` (the list
and the bridge token), `whatsapp/` (the session), `daemon.log`.

## Tests

```bash
bun test
```

The suite covers the rules that matter: an unlisted name is refused rather than
guessed, a contact with no mode set is `ask`, groups are refused even on `auto`,
the rate limit counts, the marker survives `trimEnd`, and the bridge answers
nothing without the token.

## License

MIT
