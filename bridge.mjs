#!/usr/bin/env node
/**
 * Codex Bridge — Claude Code <-> Codex CLI in one folder, through one shared file. No server.
 *
 *   node bridge.mjs hook      Stop + UserPromptSubmit hook for both tools (side auto-detected)
 *   node bridge.mjs channel   Claude Code channel (MCP over stdio): pushes Codex's messages into Claude
 *   node bridge.mjs say ...   append a message as the human observer
 *
 * The chat is ./.codex-bridge/chat.md of the folder both agents run in. One block per message:
 *
 *   ## codex @ 2026-09-08T10:15:02.113Z
 *   text...
 *
 * A reply that starts with @claude (or @codex) opens the bridge. From then on every reply is appended
 * by the Stop hook. The other side gets it either through the channel (Claude, when Claude Code runs
 * with the channel enabled) or by its own Stop hook waiting on the file and returning
 * {"decision":"block","reason":...}, which becomes its next prompt. [WAITING] at the start or end of
 * a reply means listen only; [DONE] ends the conversation; a new @claude/@codex reply reopens it.
 *
 * Per-side state in ./.codex-bridge/<side>.json: how many blocks that side has seen.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const VERSION = '0.2.0'
const WAIT_MS = Number(process.env.CODEX_BRIDGE_WAIT_MS ?? 570_000) // stay under the 600s hook timeout
const MAX_MSGS = 40
const MARK = /^## (claude|codex|user|bridge) @ \d{4}-\d\d-\d\dT[\d:.]+Z$/
const SIDES = ['claude', 'codex']
const NAMES = { claude: 'Claude Code', codex: 'Codex CLI' }

let DIR, CHAT, MARKER, WAITING
function setDir(cwd) {
  DIR = join(cwd, '.codex-bridge')
  CHAT = join(DIR, 'chat.md')
  MARKER = join(DIR, 'claude.channel') // pid of the channel process that delivers to Claude
  WAITING = join(DIR, 'codex.waiting')
}

/** Blocks in the file, or null while another writer's block is still landing (every complete block ends with a blank line). */
function parse() {
  const raw = readFileSync(CHAT, 'utf8')
  if (raw && !raw.endsWith('\n\n')) return null // ponytail: a chunk boundary right after a blank line would still slip through
  const blocks = []
  for (const line of raw.split('\n')) {
    const m = MARK.exec(line)
    if (m) blocks.push({ from: m[1], head: line, text: '' })
    else if (blocks.length) blocks.at(-1).text += line + '\n'
  }
  for (const b of blocks) b.text = b.text.trim()
  return blocks
}

function open() {
  let thread
  try { thread = JSON.parse(readFileSync(stateFile('codex'), 'utf8')).thread } catch {}
  mkdirSync(DIR, { recursive: true })
  writeFileSync(CHAT, '')
  writeFileSync(join(DIR, '.gitignore'), '*\n') // keep the chat out of the repo
  for (const s of SIDES) rmSync(stateFile(s), { force: true })
  if (thread) writeFileSync(stateFile('codex'), JSON.stringify({ first: '', seen: 0, thread }))
}

function append(from, text) {
  // A quoted header line inside a message must not start a new block: indent it so it no longer matches MARK.
  const body = text.trim().replace(/^(?=## (?:claude|codex|user|bridge) @ )/gm, ' ')
  appendFileSync(CHAT, `## ${from} @ ${new Date().toISOString()}\n${body}\n\n`)
}

// Markers count only at the start or end of a message, so "I'll say [DONE] later" does not end it.
const tagged = (text, tag) => text.startsWith(tag) || text.endsWith(tag)
const done = all => all.some(b => tagged(b.text, '[DONE]'))
const fmt = b => `[${b.from}] ${b.text}`

const stateFile = me => join(DIR, `${me}.json`)
function loadState(me, first) {
  let s = { first: '', seen: 0 } // conversation key, blocks shown
  try { s = JSON.parse(readFileSync(stateFile(me), 'utf8')) } catch {}
  if (s.first && s.first !== first) s = { first: '', seen: 0, thread: s.thread } // a different conversation: forget the old one
  s.first = first
  return s
}
const saveState = (me, s) => writeFileSync(stateFile(me), JSON.stringify(s))

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const channelAlive = () => { try { return alive(Number(readFileSync(MARKER, 'utf8'))) } catch { return false } }
const codexWaiting = () => { try { return alive(Number(readFileSync(WAITING, 'utf8'))) } catch { return false } }

function firstLine(file) {
  const fd = openSync(file, 'r')
  const byte = Buffer.alloc(1)
  const bytes = []
  try {
    while (readSync(fd, byte, 0, 1, null)) {
      if (byte[0] === 10) break
      bytes.push(byte[0])
    }
  } finally { closeSync(fd) }
  return Buffer.from(bytes).toString('utf8')
}

function discoverCodexThread() {
  const root = process.env.CODEX_BRIDGE_SESSIONS || join(homedir(), '.codex', 'sessions')
  const files = []
  for (let day = 0; day < 3; day++) {
    const date = new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '/')
    const dir = join(root, date)
    try {
      for (const name of readdirSync(dir)) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue
        try {
          const file = join(dir, name)
          const stat = statSync(file)
          if (stat.isFile()) files.push({ file, mtime: stat.mtimeMs })
        } catch {} // a file may disappear during discovery
      }
    } catch {} // a day may have no session directory
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const { file } of files.slice(0, 20)) {
    try {
      const meta = JSON.parse(firstLine(file))
      if (meta.type === 'session_meta' && meta.payload?.originator === 'codex-tui' &&
          meta.payload.cwd === dirname(DIR) && typeof meta.payload.id === 'string' && meta.payload.id) return meta.payload.id
    } catch {} // ignore incomplete or invalid rollouts
  }
}

function wakeCodex() {
  if (codexWaiting()) return
  try {
    let thread
    try { thread = JSON.parse(readFileSync(stateFile('codex'), 'utf8')).thread } catch {}
    thread = process.env.CODEX_BRIDGE_THREAD || thread || discoverCodexThread()
    if (typeof thread !== 'string' || !thread.trim()) return
    execFileSync(process.env.CODEX_BRIDGE_CODEX_BIN || 'codex',
      ['queue', '--thread', thread, '--message', 'New message available.'], { timeout: 30_000 })
  } catch {} // a failed wake must not break Claude's hook
}

function changed() {
  // wake on file change; 2s fallback tick in case an event is missed
  return new Promise(resolve => {
    let w
    const finish = () => { w?.close(); clearTimeout(t); resolve() }
    const t = setTimeout(finish, 2000)
    try { w = watch(CHAT, finish) } catch { finish() }
  })
}

function side(arg, input) {
  if (SIDES.includes(arg)) return arg
  // Codex sets PLUGIN_DATA for plugin hooks and puts turn_id in hook input; Claude Code does neither.
  return process.env.PLUGIN_DATA || 'turn_id' in input ? 'codex' : 'claude'
}

const NOT_THIS = {
  codex: 'the codex plugin, the codex-rescue agent, `codex exec`, or any MCP tool',
  claude: 'the `claude` CLI or any MCP tool',
}
const context = (me, other) =>
  `${NAMES[other].split(' ')[0]} Bridge: the user wants you to talk to ${NAMES[other]}, which is running in a separate terminal in this same folder. ` +
  `The only way to reach it is to start your reply with @${other}. Everything you write after that is delivered to ${other} by a hook, ` +
  `and ${other}'s replies come back to you as channel messages or as your next prompt. ` +
  `Do not use ${NOT_THIS[other]}; those start a different ${NAMES[other].split(' ')[0]} and are not the bridge. ` +
  `Reply with just [WAITING] to listen without saying anything. End your reply with [DONE] when the conversation should end.`

function bind(me, all) { // every session in this folder takes part; hooks are configured per folder
  const state = loadState(me, all[0]?.head ?? '')
  saveState(me, state)
  return state
}

function promptHook(me, other, input) {
  const isOpen = existsSync(CHAT)
  const mentions = new RegExp(`\\b${other}[ -]?bridge\\b`, 'i').test(input.prompt ?? '') // "discuss with codex bridge: ..."
  if (!isOpen && !mentions) return
  let extra = ''
  if (isOpen) {
    const all = parse() ?? []
    const state = bind(me, all)
    const fresh = all.slice(state.seen).filter(b => b.from !== me)
    if (fresh.length && !(me === 'claude' && channelAlive())) { // the channel delivers for Claude; otherwise hand over what is waiting
      state.seen = all.length
      saveState(me, state)
      extra = `\n\nUnread from the bridge:\n\n${fresh.map(fmt).join('\n\n')}`
    }
  }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context(me, other) + extra } }))
}

async function hook(arg) {
  const raw = readFileSync(0, 'utf8')
  const input = JSON.parse(raw || '{}')
  setDir(input.cwd ?? process.cwd())
  const me = side(arg, input)
  const other = me === 'claude' ? 'codex' : 'claude'
  if (process.env.CODEX_BRIDGE_DEBUG !== undefined ||
      existsSync(join(DIR, 'debug')) ||
      existsSync(join(homedir(), '.codex-bridge', 'debug'))) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, `debug-${me}.json`), JSON.stringify({
      input: raw,
      cwd: process.cwd(),
      ppid: process.ppid,
      envKeys: Object.keys(process.env),
      bridgeEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CODEX_BRIDGE_')))
    }))
  }
  if (me === 'codex') {
    const thread = process.env.CODEX_BRIDGE_THREAD || input.session_id || input.thread_id
    if (typeof thread === 'string' && thread.trim()) {
      mkdirSync(DIR, { recursive: true })
      let state = { first: '', seen: 0 }
      try { state = JSON.parse(readFileSync(stateFile(me), 'utf8')) } catch {}
      saveState(me, { ...state, thread })
    }
  }
  if (input.hook_event_name === 'UserPromptSubmit') return promptHook(me, other, input)

  let mine = input.last_assistant_message?.trim() ?? ''
  const addressed = new RegExp(`^@${other}\\b`, 'i').test(mine)
  if (addressed) mine = mine.replace(/^@\w+[:,]?\s*/, '')
  let all = existsSync(CHAT) ? (parse() ?? []) : null
  if (all === null) { if (!addressed) return; open(); all = [] } // no bridge here: only an @-addressed reply opens one
  else if (addressed && done(all)) { open(); all = [] }          // a new @-addressed reply after [DONE] starts over

  const state = bind(me, all)
  const unread = () => all.slice(state.seen).filter(b => b.from !== me)
  if (done(all) && !unread().length) return // conversation over: later chatter is not logged
  if (mine && !tagged(mine, '[WAITING]')) {
    append(me, mine)
    if (me === 'claude') wakeCodex()
  }
  if (me === 'claude') for (let i = 0; i < 4; i++) { // the channel claims a fresh bridge within one tick: give it a moment
    if (channelAlive()) return // the channel wakes Claude; no need to hold the terminal
    await new Promise(r => setTimeout(r, 500))
  }

  const deadline = Date.now() + WAIT_MS
  if (me === 'codex') writeFileSync(WAITING, String(process.pid))
  try { while (existsSync(CHAT)) {
    let parsed
    try { parsed = parse() } catch { return } // removed mid-wait
    if (parsed) {
      all = parsed
      const fresh = unread()
      if (fresh.length) {
        state.seen = all.length
        saveState(me, state)
        const reason =
          `New message${fresh.length > 1 ? 's' : ''} via codex-bridge:\n\n${fresh.map(fmt).join('\n\n')}` +
          `\n\n(Reply as usual; your reply is delivered to ${other} automatically. End your message with [DONE] when the conversation should end.)`
        console.log(JSON.stringify({ decision: 'block', reason }))
        return
      }
      if (done(all)) return
      if (all.length >= MAX_MSGS) {
        append('bridge', `Message cap (${MAX_MSGS}) reached. [DONE]`)
        return
      }
    }
    if (Date.now() > deadline) {
      console.log(JSON.stringify({ systemMessage: `codex-bridge: no reply from ${other} in ${WAIT_MS / 1000}s` }))
      return
    }
    await changed()
  } } finally {
    if (me === 'codex') {
      try { if (Number(readFileSync(WAITING, 'utf8')) === process.pid) rmSync(WAITING) } catch {}
    }
  }
}

/** True when an ancestor process (Claude Code) was started with this channel enabled. Otherwise our notifications would be ignored. */
function channelRegistered() {
  if (process.env.CODEX_BRIDGE_CHANNEL) return true
  let pid = process.ppid
  for (let i = 0; i < 5 && pid > 1; i++) {
    let out
    try { out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }) } catch { return false }
    const m = /^\s*(\d+)\s+([\s\S]*)$/.exec(out)
    if (!m) return false
    if (/--(?:dangerously-load-development-channels|channels)\b.*codex-bridge/.test(m[2])) return true
    pid = Number(m[1])
  }
  return false
}

/** Claude Code channel: a one-way MCP server over stdio that pushes new blocks from the other side into the session. */
function channel() {
  setDir(process.cwd())
  const me = 'claude'
  const write = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  let buf = ''
  process.stdin.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id === undefined) continue // a notification from the client; nothing to answer
      if (msg.method === 'initialize') write({ id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'codex-bridge', version: VERSION },
        instructions: `Messages from Codex CLI, running in this folder, arrive as <channel source="codex-bridge" sender="codex">. ` +
          `Reply with normal text: your final reply is delivered to Codex automatically by the codex-bridge Stop hook. ` +
          `Never call a tool to send it. End your reply with [DONE] when the conversation should end.`,
      } })
      else if (msg.method === 'ping') write({ id: msg.id, result: {} })
      else if (msg.method === 'tools/list') write({ id: msg.id, result: { tools: [] } })
      else write({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } })
    }
  })
  process.stdin.on('end', () => process.exit(0))

  if (!channelRegistered()) return // not enabled for this session: the Stop hook keeps delivering by waiting
  const tick = () => {
    if (!existsSync(CHAT)) return
    if (!channelAlive()) writeFileSync(MARKER, String(process.pid))     // claim delivery for this folder
    if (Number(readFileSync(MARKER, 'utf8')) !== process.pid) return    // another Claude session's channel owns it
    let all
    try { all = parse() } catch { return }
    if (!all) return
    const state = loadState(me, all[0]?.head ?? '')
    const fresh = all.slice(state.seen).filter(b => b.from !== me)
    if (!fresh.length) return
    state.seen = all.length
    saveState(me, state)
    for (const b of fresh) write({ method: 'notifications/claude/channel', params: {
      content: b.text,
      meta: { chat_id: 'codex-bridge', message_id: String(all.indexOf(b) + 1), sender: b.from, ts: new Date().toISOString() },
    } })
  }
  setInterval(tick, 500)
  process.on('exit', () => { try { if (Number(readFileSync(MARKER, 'utf8')) === process.pid) rmSync(MARKER) } catch {} })
}

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'hook':
    await hook(rest[0])
    break
  case 'channel':
    channel()
    break
  case 'say':
    setDir(process.cwd())
    if (!existsSync(CHAT) || !rest.join(' ').trim()) {
      console.error('usage: bridge.mjs say <text>   (no open bridge in this folder)')
      process.exit(1)
    }
    append('user', rest.join(' '))
    break
  default:
    console.error('usage: bridge.mjs hook [claude|codex]  |  bridge.mjs channel  |  bridge.mjs say <text>')
    process.exit(1)
}
