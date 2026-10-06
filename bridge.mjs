#!/usr/bin/env node
/**
 * Codex Bridge — Claude Code <-> Codex CLI in one folder, through named chats.
 *
 *   node bridge.mjs hook      Stop + UserPromptSubmit hook for both tools (side auto-detected)
 *   node bridge.mjs channel   Claude Code channel (MCP over stdio): pushes Codex's messages into Claude
 *   node bridge.mjs say ...   append a message as the human observer
 *   node bridge.mjs relay ... relay queued Codex messages independently of Claude
 *   node bridge.mjs clear ... clear one named conversation's transcript
 *
 * Chats live in ./.codex-bridge/<name>/chat.md (or chat.md at the root for default).
 * One block per message:
 *
 *   ## codex @ 2026-09-08T10:15:02.113Z
 *   text...
 *
 * A reply that starts with @claude or @codex opens the default bridge. Named bridges use
 * @claude <name>: or @codex <name>:. A direct reply to an incoming bridge message is also forwarded.
 * The other side gets it either through the channel (Claude, when Claude Code runs
 * with the channel enabled) or by its own Stop hook waiting on the file and returning
 * {"decision":"block","reason":...}, which becomes its next prompt. [WAITING] at the start or end of
 * a reply means listen only; [DONE] ends the conversation; a new @claude/@codex reply reopens it.
 *
 * Per-side state in ./.codex-bridge/<side>.json: how many blocks that side has seen.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const VERSION = '0.2.0'
const WAIT_MS = Number(process.env.CODEX_BRIDGE_WAIT_MS ?? 570_000) // stay under the 600s hook timeout
const MAX_MSGS = 40
const QUEUE_RETRIES = 3
const DEFAULT_QUEUE_RETRY_DELAYS_MS = [1000, 3000]
const MARK = /^## (claude|codex|user|bridge) @ \d{4}-\d\d-\d\dT[\d:.]+Z$/
const SIDES = ['claude', 'codex']
const NAMES = { claude: 'Claude Code', codex: 'Codex CLI' }
const execFileAsync = promisify(execFile)

let ROOT, DIR, CHAT, MARKER, WAITING, BRIDGE_NAME
function setDir(cwd, name = 'default') {
  ROOT = join(cwd, '.codex-bridge')
  BRIDGE_NAME = name
  DIR = name === 'default' ? ROOT : join(ROOT, name)
  CHAT = join(DIR, 'chat.md')
  MARKER = join(DIR, 'claude.channel') // pid of the channel process that delivers to Claude
  WAITING = join(DIR, 'codex.waiting')
}

const validName = name => typeof name === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(name)
const sessionFile = (side, id) => join(ROOT, 'sessions', `${side}-${createHash('sha256').update(id).digest('hex')}.json`)
function claudePid(id) {
  try {
    for (const name of readdirSync(join(homedir(), '.claude', 'sessions'))) {
      if (!/^\d+\.json$/.test(name)) continue
      try {
        const entry = JSON.parse(readFileSync(join(homedir(), '.claude', 'sessions', name), 'utf8'))
        if (entry.sessionId === id && entry.cwd === dirname(ROOT) && Number.isInteger(entry.pid)) return entry.pid
      } catch {}
    }
  } catch {}
}
function sessionName(side, id) {
  if (!id) return 'default'
  try { return JSON.parse(readFileSync(sessionFile(side, id), 'utf8')).name } catch { return 'default' }
}
function member(side, id, name) {
  if (!id || !validName(name)) return
  const pid = side === 'claude' ? (claudePid(id) ?? process.ppid) : process.ppid
  mkdirSync(join(ROOT, 'sessions'), { recursive: true })
  writeFileSync(join(ROOT, '.gitignore'), '*\n')
  writeFileSync(sessionFile(side, id), JSON.stringify({ id, name, pid }))
  mkdirSync(DIR, { recursive: true })
  try {
    const previous = JSON.parse(readFileSync(join(DIR, `${side}.member.json`), 'utf8'))
    if (previous.id !== id) rmSync(side === 'claude' ? MARKER : WAITING, { force: true })
  } catch {}
  writeFileSync(join(DIR, `${side}.member.json`), JSON.stringify({ id, pid }))
}
function currentMember(side, id) {
  if (BRIDGE_NAME === 'default' || !id) return true
  try { return JSON.parse(readFileSync(join(DIR, `${side}.member.json`), 'utf8')).id === id } catch { return false }
}
function namedPrompt(prompt, other) {
  const match = new RegExp(`\\b${other}[ -]?bridge\\s+([a-z][a-z0-9_-]{0,39})\\s*:`, 'i').exec(prompt ?? '')
  return match?.[1].toLowerCase()
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
  writeFileSync(stateFile('claude'), JSON.stringify({ first: '', seen: 0 }))
  writeFileSync(stateFile('codex'), JSON.stringify({ first: '', seen: 0, ...(thread ? { thread } : {}) }))
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
    thread = BRIDGE_NAME === 'default' ? (process.env.CODEX_BRIDGE_THREAD || thread || discoverCodexThread()) : thread
    if (typeof thread !== 'string' || !thread.trim()) return
    execFileSync(process.env.CODEX_BRIDGE_CODEX_BIN || 'codex',
      ['queue', '--thread', thread, '--message', 'New message available.'], { timeout: 30_000 })
  } catch {} // a failed wake must not break Claude's hook
}

function sendToCodex(message) {
  if (!existsSync(CHAT)) throw new Error(`bridge ${BRIDGE_NAME} is not open`)
  const thread = JSON.parse(readFileSync(stateFile('codex'), 'utf8')).thread
  if (typeof thread !== 'string' || !thread.trim()) throw new Error(`bridge ${BRIDGE_NAME} has no Codex session`)
  if (codexWaiting()) append('user', message)
  else writeFileSync(join(DIR, `queue-${randomUUID()}.json`), JSON.stringify({ thread, message }))
}

async function drainQueue() {
  // A previous relay may have died after claiming an item. The project flock ensures
  // there is no live owner before these claims are returned to the pending queue.
  for (const file of readdirSync(DIR).filter(name => /^inflight-[0-9a-f-]+\.json$/.test(name))) {
    const pending = file.replace(/^inflight-/, 'queue-')
    try { renameSync(join(DIR, file), join(DIR, pending)) } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  let allOk = true
  const configuredDelays = process.env.CODEX_BRIDGE_RETRY_DELAYS_MS?.split(',').map(Number)
  const retryDelays = configuredDelays?.length === 2 && configuredDelays.every(delay => Number.isFinite(delay) && delay >= 0)
    ? configuredDelays
    : DEFAULT_QUEUE_RETRY_DELAYS_MS
  for (const file of readdirSync(DIR).filter(name => /^queue-[0-9a-f-]+\.json$/.test(name))) {
    const path = join(DIR, file)
    const claimed = join(DIR, file.replace(/^queue-/, 'inflight-'))
    try {
      renameSync(path, claimed)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      console.error(`codex-bridge queue claim: ${err.message}`)
      return false
    }
    try {
      const request = JSON.parse(readFileSync(claimed, 'utf8'))
      const { thread, message } = request
      const current = JSON.parse(readFileSync(stateFile('codex'), 'utf8')).thread
      if (thread !== current) {
        const reason = `target thread ${thread} is stale; current thread is ${current}`
        const failedDir = join(DIR, 'failed')
        mkdirSync(failedDir, { recursive: true })
        const failedName = file.replace(/^queue-/, '')
        writeFileSync(join(failedDir, failedName), JSON.stringify({ ...request, failedAt: new Date().toISOString(), reason }))
        rmSync(claimed)
        if (!existsSync(CHAT)) writeFileSync(CHAT, '')
        append('bridge', `Queued Codex request ${failedName} failed: ${reason}. Details: failed/${failedName}`)
        continue
      }
      let sent = false
      let lastError
      for (let attempt = 0; attempt < QUEUE_RETRIES; attempt++) {
        try {
          await execFileAsync(process.env.CODEX_BRIDGE_CODEX_BIN || 'codex',
            ['queue', '--thread', thread, '--message', message], { timeout: 30_000 })
          sent = true
          break
        } catch (err) {
          lastError = err
          if (attempt < QUEUE_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]))
        }
      }
      if (!sent) {
        const reason = `codex queue failed after ${QUEUE_RETRIES} attempts: ${lastError?.message ?? 'unknown error'}`
        const failedDir = join(DIR, 'failed')
        mkdirSync(failedDir, { recursive: true })
        const failedName = file.replace(/^queue-/, '')
        writeFileSync(join(failedDir, failedName), JSON.stringify({ ...request, attempts: QUEUE_RETRIES, failedAt: new Date().toISOString(), reason }))
        rmSync(claimed)
        if (!existsSync(CHAT)) writeFileSync(CHAT, '')
        append('bridge', `Queued Codex request ${failedName} failed after ${QUEUE_RETRIES} attempts: ${lastError?.message ?? 'unknown error'}. Details: failed/${failedName}`)
        allOk = false
        continue
      }
      rmSync(claimed)
    } catch (err) {
      try { renameSync(claimed, path) } catch {}
      console.error(`codex-bridge queue: ${err.message}`)
      return false
    }
  }
  return allOk
}

async function relayAll(project) {
  setDir(project)
  const names = ['default']
  try {
    for (const name of readdirSync(ROOT)) {
      if (validName(name) && name !== 'default' && statSync(join(ROOT, name)).isDirectory()) names.push(name)
    }
  } catch (err) {
    if (err.code === 'ENOENT') return true
    throw err
  }
  let ok = true
  for (const name of names) {
    setDir(project, name)
    if (!existsSync(DIR)) continue
    if (!await drainQueue()) ok = false
  }
  return ok
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
  `This conversation uses bridge ${BRIDGE_NAME}. Start your reply with @${other}${BRIDGE_NAME === 'default' ? '' : ` ${BRIDGE_NAME}:`}. Your reply is delivered to ${other} by a hook, ` +
  `and ${other}'s replies come back to you as channel messages or as your next prompt. ` +
  `Do not use ${NOT_THIS[other]}; those start a different ${NAMES[other].split(' ')[0]} and are not the bridge. ` +
  `Reply with just [WAITING] to listen without saying anything. End your reply with [DONE] when the conversation should end. Only an addressed reply or a reply to a bridge message is forwarded.`

function bind(me, all) { // every session in this folder takes part; hooks are configured per folder
  const state = loadState(me, all[0]?.head ?? '')
  saveState(me, state)
  return state
}

function promptHook(me, other, input) {
  const isOpen = existsSync(CHAT)
  const mentions = new RegExp(`\\b${other}[ -]?bridge\\b`, 'i').test(input.prompt ?? '')
  if (!isOpen && !mentions) return
  let extra = ''
  if (isOpen) {
    const all = parse() ?? []
    const state = bind(me, all)
    const fresh = all.slice(state.seen).filter(b => b.from !== me)
    if (fresh.length && !(me === 'claude' && channelAlive())) { // the channel delivers for Claude; otherwise hand over what is waiting
      state.seen = all.length
      state.pending = true
      saveState(me, state)
      extra = `\n\nUnread from the bridge:\n\n${fresh.map(fmt).join('\n\n')}`
    }
  }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context(me, other) + extra } }))
}

async function hook(arg) {
  const raw = readFileSync(0, 'utf8')
  const input = JSON.parse(raw || '{}')
  const me = side(arg, input)
  const other = me === 'claude' ? 'codex' : 'claude'
  const cwd = input.cwd ?? process.cwd()
  setDir(cwd)
  const id = input.session_id
  const requested = input.hook_event_name === 'UserPromptSubmit' ? namedPrompt(input.prompt, other) : undefined
  const name = requested || sessionName(me, id)
  setDir(cwd, validName(name) ? name : 'default')
  if (requested || (name !== 'default' && currentMember(me, id))) member(me, id, name)
  if (name !== 'default' && !currentMember(me, id)) return
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
  if (me === 'codex' && (name === 'default' || requested || currentMember(me, id))) {
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
  const explicitAddress = new RegExp(`^@${other}\\s+([a-z][a-z0-9_-]{0,39}):\\s*`, 'i').exec(mine)
  const plainAddress = new RegExp(`^@${other}(?:(?:[:,]\\s*)|\\s+)`, 'i').exec(mine)
  const addressed = explicitAddress ? explicitAddress[1].toLowerCase() === name : name === 'default' && !!plainAddress
  if (addressed) mine = mine.slice((explicitAddress || plainAddress)[0].length).trim()
  const listening = tagged(mine, '[WAITING]')
  let all = existsSync(CHAT) ? (parse() ?? []) : null
  if (all === null) { if (!addressed || listening) return; open(); all = [] }
  else if (addressed && done(all) && !listening) { open(); all = [] }

  const state = bind(me, all)
  const unread = () => all.slice(state.seen).filter(b => b.from !== me)
  if (done(all) && !unread().length) return // conversation over: later chatter is not logged
  const forwarding = addressed || state.pending
  if (!forwarding && !unread().length) return
  if (mine && forwarding && !listening) {
    append(me, mine)
    state.pending = false
    saveState(me, state)
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
        state.pending = true
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
function channel(sessionId) {
  setDir(process.cwd())
  const me = 'claude'
  const owned = new Set()
  const selectBridge = () => {
    setDir(process.cwd())
    if (sessionId) {
      setDir(process.cwd(), sessionName('claude', sessionId))
      return
    }
    let latest
    try {
      for (const file of readdirSync(join(ROOT, 'sessions'))) {
        if (!file.startsWith('claude-')) continue
        const path = join(ROOT, 'sessions', file)
        const entry = JSON.parse(readFileSync(path, 'utf8'))
        if (entry.name !== 'default') {
          const active = JSON.parse(readFileSync(join(ROOT, entry.name, 'claude.member.json'), 'utf8'))
          if (active.id !== entry.id) continue
        }
        if (entry.pid === process.ppid && (!latest || statSync(path).mtimeMs > latest.mtime))
          latest = { name: entry.name, mtime: statSync(path).mtimeMs }
      }
    } catch {}
    setDir(process.cwd(), latest?.name ?? 'default')
  }
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
    selectBridge()
    for (const marker of owned) {
      if (marker === MARKER) continue
      try { if (Number(readFileSync(marker, 'utf8')) === process.pid) rmSync(marker) } catch {}
      owned.delete(marker)
    }
    if (!existsSync(CHAT)) return
    if (!channelAlive()) writeFileSync(MARKER, String(process.pid))     // claim delivery for this folder
    if (Number(readFileSync(MARKER, 'utf8')) !== process.pid) return    // another Claude session's channel owns it
    owned.add(MARKER)
    let all
    try { all = parse() } catch { return }
    if (!all) return
    const state = loadState(me, all[0]?.head ?? '')
    const fresh = all.slice(state.seen).filter(b => b.from !== me)
    if (!fresh.length) return
    state.seen = all.length
    state.pending = true
    saveState(me, state)
    for (const b of fresh) write({ method: 'notifications/claude/channel', params: {
      content: b.text,
      meta: { chat_id: 'codex-bridge', message_id: String(all.indexOf(b) + 1), sender: b.from, ts: new Date().toISOString() },
    } })
  }
  setInterval(tick, 500)
  process.on('exit', () => { for (const marker of owned) try { if (Number(readFileSync(marker, 'utf8')) === process.pid) rmSync(marker) } catch {} })
}

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'hook':
    await hook(rest[0])
    break
  case 'channel':
    channel(rest[0])
    break
  case 'say':
    if (rest[0] === '--bridge') {
      if (!validName(rest[1])) {
        console.error('usage: bridge.mjs say --bridge <name> <text>')
        process.exit(1)
      }
      setDir(process.cwd(), rest[1])
      rest.splice(0, 2)
    } else setDir(process.cwd())
    if (!existsSync(CHAT) || !rest.join(' ').trim()) {
      console.error('usage: bridge.mjs say [--bridge <name>] <text>   (no open bridge in this folder)')
      process.exit(1)
    }
    append('user', rest.join(' '))
    break
  case 'send':
    if (rest[0] !== '--bridge' || !validName(rest[1]) || !rest.slice(2).join(' ').trim()) {
      console.error('usage: bridge.mjs send --bridge <name> <message>')
      process.exit(1)
    }
    setDir(process.cwd(), rest[1])
    try { sendToCodex(rest.slice(2).join(' ')) }
    catch (err) { console.error(err.message); process.exit(1) }
    break
  case 'drain':
    if (rest[0] !== '--bridge' || !validName(rest[1])) {
      console.error('usage: bridge.mjs drain --bridge <name>')
      process.exit(1)
    }
    setDir(process.cwd(), rest[1])
    if (!await drainQueue()) process.exit(1)
    break
  case 'relay': {
    let project = process.cwd()
    let once = false
    let locked = false
    let valid = true
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--once' && !once) once = true
      else if (rest[i] === '--_locked' && !locked) locked = true
      else if (rest[i] === '--project' && rest[i + 1] && !rest[i + 1].startsWith('--')) project = rest[++i]
      else valid = false
    }
    if (!valid) {
      console.error('usage: bridge.mjs relay [--once] [--project <path>]')
      process.exit(1)
    }
    if (!locked) {
      const absoluteProject = resolve(project)
      const lockPath = join(absoluteProject, '.codex-bridge', 'relay.lock')
      mkdirSync(dirname(lockPath), { recursive: true })
      const args = ['-n', '-E', '75', lockPath, process.execPath,
        resolve(process.argv[1]), 'relay', '--_locked', '--project', absoluteProject,
        ...(once ? ['--once'] : [])]
      const result = spawnSync(process.env.CODEX_BRIDGE_FLOCK_BIN || '/usr/bin/flock', args, { stdio: 'inherit' })
      if (result.error) {
        console.error(`codex-bridge relay: cannot start flock: ${result.error.message}`)
        process.exitCode = 1
      } else if (result.status === 75) {
        console.error(`codex-bridge relay: another relay already holds ${lockPath}`)
        process.exitCode = 1
      } else process.exitCode = result.status ?? 1
      break
    }
    if (once) {
      if (!await relayAll(project)) process.exitCode = 1
    } else {
      console.error(`codex-bridge relay: watching ${join(project, '.codex-bridge')}`)
      while (true) {
        let ok = false
        try { ok = await relayAll(project) }
        catch (err) { console.error(`codex-bridge relay: ${err.message}`) }
        await new Promise(resolve => setTimeout(resolve, ok ? 1000 : 5000))
      }
    }
    break
  }
  case 'clear': {
    const clearQueue = rest.includes('--queue')
    if (rest[0] !== '--bridge' || !validName(rest[1]) || rest.some((arg, i) => i > 1 && arg !== '--queue') ||
        (clearQueue && rest.filter(arg => arg === '--queue').length !== 1)) {
      console.error('usage: bridge.mjs clear --bridge <name> [--queue]')
      process.exit(1)
    }
    setDir(process.cwd(), rest[1])
    if (!existsSync(CHAT)) {
      console.error(`bridge ${rest[1]} is not open`)
      process.exit(1)
    }
    open()
    if (clearQueue) {
      for (const file of readdirSync(DIR).filter(name => /^queue-[0-9a-f-]+\.json$/.test(name)))
        rmSync(join(DIR, file), { force: true })
    }
    break
  }
  default:
    console.error('usage: bridge.mjs hook [claude|codex]  |  bridge.mjs channel  |  bridge.mjs say [--bridge <name>] <text>  |  bridge.mjs send --bridge <name> <message>  |  bridge.mjs relay [--once] [--project <path>]  |  bridge.mjs clear --bridge <name>')
    process.exit(1)
}
