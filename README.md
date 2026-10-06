# Codex Bridge

[![Mentioned in Awesome Codex CLI](https://awesome.re/mentioned-badge.svg)](https://github.com/RoggeOhta/awesome-codex-cli)

### Your live Claude Code and Codex CLI sessions talk to each other. Named conversations stay separate in one folder.

You run `claude` and `codex` in the same folder. Tell each pair to use the same bridge name. They exchange messages through `.codex-bridge/<name>/chat.md`. The original unnamed bridge still uses `.codex-bridge/chat.md`.

<p align="center"><img src="docs/screenshot.png" alt="Live: Codex (right) opens with @claude and waits in its Stop hook; Claude (left) receives the message through the channel and answers with a comparison table" width="900"></p>

<p align="center"><img src="docs/architecture.svg" alt="Two terminals, one shared file: each side's Stop hook appends its reply to chat.md; Claude's channel and Codex's waiting hook deliver the other side's message as the next prompt" width="800"></p>

## Install

Needs `node` on the PATH of a non-interactive shell.

**Claude Code**

```
/plugin marketplace add abhishekgahlot2/codex-claude-bridge
```
```
/plugin install codex-bridge@codex-claude-bridge
```

Then launch Claude with the channel enabled (Channels are a research preview; the flag is required):

```bash
claude --dangerously-load-development-channels plugin:codex-bridge@codex-claude-bridge
```

**Codex CLI**

```bash
codex plugin marketplace add abhishekgahlot2/codex-claude-bridge
codex plugin add codex-bridge@codex-claude-bridge
```

Run `codex`, open `/hooks`, trust its two hooks.

## Use

In a Codex pane:

```
discuss with claude bridge alpha: redis vs memcached, keep going until you agree
```

In the matching Claude pane, say `discuss with codex bridge alpha: ...` once to join. Codex opens with `@claude alpha: ...`, then shows "Running hooks" while it waits. Claude's pane shows `← codex-bridge: ...` and its answer. The two agents alternate until one ends a message with `[DONE]`.

From the Claude pane, start with `discuss with codex bridge alpha: ...`. Codex must have joined `alpha` once; the bridge then wakes its saved session through `codex queue`. Use `beta` for a second pair. Without a name, `discuss with codex bridge: ...` keeps the original behavior.

Watch the transcript from anywhere:

```bash
tail -f .codex-bridge/alpha/chat.md
```

To send a note into one open named chat from the terminal:

```bash
node bridge.mjs say --bridge alpha "Please check the latest result"
```

To give an idle Codex session a task from a sandbox that cannot run `codex queue`, start one relay in a normal terminal for the project:

```bash
node /home/wladimir/codex-bridge-patched/bridge.mjs relay --project /home/wladimir
```

The relay watches all named bridges in that project and works independently of Claude sessions. Keep it running while you want automatic delivery. Then, from a Codex sandbox in the same project, use:

```bash
node bridge.mjs send --bridge alpha "Audit the report and reply briefly"
```

The relay passes the request to `codex queue` using the saved Codex session ID. A project-wide `flock` allows only one relay at a time; it atomically renames each request to `inflight-*.json` before sending. A failed send gets three attempts with 1 s and 3 s waits between them. Requests that still fail, or target a replaced Codex thread, move to that bridge's `failed/` folder with a reason, and the chat receives a warning. Claude Code does not need to be open for this path. For a one-time attempt, use `node bridge.mjs relay --once --project /home/wladimir` from a normal terminal.

For automatic restart after a crash or terminal closure, install the included `codex-bridge-relay.service` as a user service. Check its `ExecStart` Node path before installing it. This is optional; it uses the same relay command and does not launch Claude Code.

To clear one named chat and its read positions while keeping the paired session IDs and pending requests:

```bash
node /home/wladimir/codex-bridge-patched/bridge.mjs clear --bridge alpha
```

Run this from the project folder (`/home/wladimir` in the example). A new addressed conversation also clears that chat automatically. Individual conversations stop after 40 messages.

Add `--queue` to also delete requests still waiting in `queue-*.json`. Requests already claimed as `inflight-*.json` and past failures in `failed/` are preserved.

## How it works

`bridge.mjs` does three jobs. Each named bridge has its own chat and state files:

1. **Prompt hook** (both tools). A prompt such as "claude bridge alpha:" joins that session to `alpha` and tells the agent to use `@claude alpha:` only when writing to the other agent; replies to the user stay unprefixed. Each bridge keeps the session IDs of its current Claude and Codex members.
2. **Stop hook** (both tools). Forwards only replies explicitly addressed to the other agent with `@<agent> <bridge>:` (or `@<agent>:` for the default bridge). Replies to the user stay local, including after a bridge message. On Codex, it watches the named chat (`fs.watch`) until Claude's block lands and returns `{"decision":"block","reason":"<that message>"}`, which becomes Codex's next prompt. On Claude it returns at once, because:
3. **Channel** (Claude only). A dependency-free MCP server the plugin starts inside Claude Code. It follows the bridge joined by its parent Claude process and pushes its new blocks into that session. Without the launch flag it stays silent and Claude's Stop hook falls back to waiting.

Each side keeps a cursor in `.codex-bridge/<side>.json`, so nothing is dropped while an agent is mid-turn and nothing is shown twice. Conversations cap at 40 messages. The folder is gitignored automatically.

## File format

```
## codex @ 2026-09-08T14:15:01.957Z
Let's compare Redis and Memcached.

## claude @ 2026-09-08T14:16:30.079Z
Redis by default. [DONE]
```

| Marker | Meaning |
|--------|---------|
| `## <claude\|codex\|user\|bridge> @ <ISO-8601 UTC>` | Start of a message. `user` is you (`node bridge.mjs say "..."`), `bridge` is the cap notice. |
| `@claude` / `@codex` at the start of a reply | Open the bridge with this message. |
| `[WAITING]` at the start or end of a reply | Do not send this reply. Listen only. |
| `[DONE]` at the start or end of a reply | End the conversation after this reply. |

## Limitations

- Codex's pane is busy while it waits inside its Stop hook (up to 570s per reply). Esc abandons the wait. Typing into Codex during the wait interrupts it.
- Only the final message of a turn is sent. Drafts an agent writes mid-turn are not.
- Both agents must run in the same folder on the same machine.
- Each named chat is delivered only to its current pair of sessions. Join both sessions before expecting idle delivery.
- Claude needs the development-channels flag until custom channels leave preview.

## This vs v0.1

v0.1 was a blocking Codex MCP tool, a Claude channel, and an HTTP server with a web UI.

**Better now**
- No server, no port, no web UI. The markdown file is the transcript; `tail -f` is the viewer.
- Folder-scoped. Other projects and sessions are untouched.
- The Stop hook captures explicitly addressed replies; v0.1 lost replies when Claude omitted `reply_to`.
- Claude → Codex uses `codex queue` after the target Codex session joins the bridge.
- A cursor per side: nothing dropped while an agent is mid-turn, nothing shown twice.
- 570s per turn. v0.1 gave Codex 110s.

**Worse now**
- Codex's pane is busy while it waits inside its Stop hook. In v0.1 the wait was an MCP tool call.
- Two hooks to trust in Codex, and per-folder config without the plugins. v0.1 was one global config.
- Replies to received bridge messages must be explicitly addressed. An addressed reply also starts or resumes an exchange.
- Typing into Codex mid-wait interrupts the wait.
- Only the final message of a turn is sent.

**Same in both:** Claude needs the channels launch flag.

## Without the plugins

Clone the repo. Put the two hooks from `hooks/hooks.json` into `<folder>/.claude/settings.local.json` and `<folder>/.codex/hooks.json` with the clone path in place of `${CLAUDE_PLUGIN_ROOT}`, and launch Claude with `--dangerously-load-development-channels server:codex-bridge --mcp-config <a file declaring the codex-bridge server: node <clone>/bridge.mjs channel>`.

## Tests

```bash
node --test
```

## Working setup and what is set aside (2026-10-06)

What works, verified: Claude to Codex through `codex queue --thread <session name or UUID>`; Codex to Claude through `node bridge.mjs say --bridge <chat> '<text>'`, including from a session that is not a member of the chat (checked with a session named gamma); 48 tests. Say in each task which command to reply with, and sign the text with the worker's name: the channel labels every incoming message `sender="user"`.

Set aside on purpose, may come back:

- **Relay as a systemd service.** The `relay` command and a user unit exist but the service is not installed or tested. The relay only runs from a normal terminal, because `codex queue` fails inside the Codex sandbox (`~/.codex` is read-only there).
- **Codex to Codex.** No direct path. It would need `codex queue` from a sandbox that cannot write `~/.codex`, or a shared file read at the next turn. Today everything goes through the Claude orchestrator.
- **Several Codex workers as chat members.** A chat has one Claude member and one Codex member. Extra workers are not members; they report with `say`.
- **Session identity.** `/clear` in Codex creates a new thread with a new UUID, which orphans the chat membership. Address sessions by name instead; rename a session with `/rename <name>` in the Codex TUI (verified).
- **At-least-once delivery.** A relay that dies after sending but before deleting `inflight-*` resends the request on restart.
- **Silent channel switch.** A prompt naming another chat rebinds the session without any refusal, and the old chat keeps its stale `member.json`.

## Earlier design

[v0.1.0](https://github.com/abhishekgahlot2/codex-claude-bridge/releases/tag/v0.1.0) used a blocking Codex MCP tool, a local HTTP server, and a web UI. One-directional in practice.

## License

MIT
