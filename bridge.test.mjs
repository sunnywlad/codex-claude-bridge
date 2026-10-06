import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
const BDIR = join(DIR, '.codex-bridge')
const CHAT = join(BDIR, 'chat.md')
const BRIDGE = new URL('./bridge.mjs', import.meta.url).pathname
const FAKE_CODEX = join(DIR, 'fake-codex')
const WAKE_LOG = join(DIR, 'wake-log')
const SESSION_ROOT = join(DIR, 'sessions')
writeFileSync(FAKE_CODEX, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.CODEX_BRIDGE_WAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")\n')
chmodSync(FAKE_CODEX, 0o755)
const env = { ...process.env, CODEX_BRIDGE_WAIT_MS: '3000', CODEX_BRIDGE_SESSIONS: SESSION_ROOT }
delete env.PLUGIN_DATA
delete env.CODEX_BRIDGE_CHANNEL
delete env.CODEX_BRIDGE_THREAD
delete env.CODEX_BRIDGE_DEBUG
delete env.NODE_TEST_CONTEXT
const sleep = ms => new Promise(r => setTimeout(r, ms))
const chat = () => readFileSync(CHAT, 'utf8')
const reset = () => {
  rmSync(BDIR, { recursive: true, force: true })
  rmSync(SESSION_ROOT, { recursive: true, force: true })
}

let outputSerial = 0
function run(args, stdin = '', extraEnv = {}) {
  return new Promise(resolve => {
    const file = join(DIR, `hook-output-${outputSerial++}`)
    const fd = openSync(file, 'w')
    const p = spawn(process.execPath, [BRIDGE, ...args], { cwd: DIR, env: { ...env, ...extraEnv }, stdio: ['pipe', fd, 'inherit'] })
    p.on('close', () => {
      closeSync(fd)
      const out = readFileSync(file, 'utf8').trim()
      rmSync(file)
      resolve(out)
    })
    p.stdin.end(stdin)
  })
}

/** Stop hook for one side; resolves with its JSON output (or null). */
async function stop(side, msg, session = `${side}-1`, extra = {}, extraEnv = {}) {
  const out = await run(['hook', side], JSON.stringify({ hook_event_name: 'Stop', cwd: DIR, session_id: session, last_assistant_message: msg, ...extra }), extraEnv)
  return out ? JSON.parse(out) : null
}
/** UserPromptSubmit hook for one side; resolves with additionalContext (or null). */
async function prompt(side, text, session = `${side}-1`, extraEnv = {}) {
  const out = await run(['hook', side], JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: DIR, session_id: session, prompt: text }), extraEnv)
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null
}
/** A codex reply that opens the bridge and waits for claude. */
const openWith = (side, msg) => stop(side, `@${side === 'codex' ? 'claude' : 'codex'} ${msg}`)
const wakeEnv = { CODEX_BRIDGE_CODEX_BIN: FAKE_CODEX, CODEX_BRIDGE_WAKE_LOG: WAKE_LOG }
const wakeCalls = () => existsSync(WAKE_LOG) ? readFileSync(WAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse) : []
function readyToWake() {
  reset()
  rmSync(WAKE_LOG, { force: true })
  mkdirSync(BDIR, { recursive: true })
  writeFileSync(CHAT, '')
  writeFileSync(join(BDIR, 'claude.channel'), String(process.pid))
}
function rollout(name, payload, modified, daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '/')
  const folder = join(SESSION_ROOT, date)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `rollout-${name}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload }) + '\nnot JSON on line two\n')
  utimesSync(file, modified, modified)
}

test('no bridge and no @-address: hooks are no-ops', async () => {
  reset()
  assert.equal(await stop('claude', 'hello'), null)
  assert.equal(await prompt('claude', 'fix the tests'), null)
  assert.ok(!existsSync(CHAT))
})

test('@claude at the start of a Codex reply opens the bridge, strips the prefix, waits for Claude', async () => {
  reset()
  const codexWaiting = openWith('codex', 'Redis or Memcached for caching?')
  await sleep(400)
  assert.ok(existsSync(join(BDIR, 'codex.waiting')))
  assert.equal(chat(), chat().match(/^## codex @ [^\n]+\nRedis or Memcached for caching\?\n\n$/)?.[0])
  assert.equal(readFileSync(join(BDIR, '.gitignore'), 'utf8'), '*\n')
  assert.match(await prompt('claude', 'hi'), /Unread from the bridge:\n\n\[codex\] Redis or Memcached for caching\?/) // idle Claude, no channel: a prompt catches it up
  const claudeWaiting = stop('claude', 'Redis, it has persistence. [DONE]')
  assert.match((await codexWaiting).reason, /New message via codex-bridge:\n\n\[claude\] Redis, it has persistence\. \[DONE\]/)
  assert.ok(!existsSync(join(BDIR, 'codex.waiting')))
  assert.equal(await claudeWaiting, null) // conversation over
  assert.equal(await stop('codex', 'Thanks.'), null) // over: not logged
  assert.ok(!chat().includes('Thanks.'))
})

test('a new @-addressed reply after [DONE] starts a fresh conversation', async () => {
  const codexWaiting = openWith('codex', 'Next topic: sharding?')
  await sleep(400)
  assert.match(chat(), /^## codex @ [^\n]+\nNext topic: sharding\?\n\n$/) // old conversation gone
  const claudeWaiting = stop('claude', 'By tenant. [DONE]')
  assert.match((await codexWaiting).reason, /\[claude\] By tenant\./)
  await claudeWaiting
})

test('prompt context: only when the other agent is mentioned or the bridge is open', async () => {
  reset()
  assert.equal(await prompt('codex', 'refactor the parser with claude'), null) // bare name is not a trigger
  const ctx = await prompt('codex', 'Discuss caching with claude bridge')
  assert.match(ctx, /Claude Bridge: .*start your reply with @claude/)
  assert.match(ctx, /Do not use the `claude` CLI or any MCP tool/)
  assert.ok(!existsSync(CHAT)) // context alone does not open anything
  const codexWaiting = openWith('codex', 'Q')
  await sleep(300)
  assert.match(await prompt('claude', 'anything'), /start your reply with @codex/) // open: context regardless of wording
  reset()
  await codexWaiting
})

test('prompt hook hands over unread messages, so a plain prompt to an idle Codex catches it up', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Should we shard by tenant?')
  await sleep(300)
  const ctx = await prompt('codex', 'go')
  assert.match(ctx, /Unread from the bridge:\n\n\[claude\] Should we shard by tenant\?/)
  const codexWaiting = stop('codex', 'Yes, by tenant.') // seen already advanced: no re-delivery, it waits
  assert.match((await claudeWaiting).reason, /\[codex\] Yes, by tenant\./)
  reset()
  await codexWaiting
})

test('[WAITING] listens without sending; the listener gets the question at once', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Should we shard by tenant?')
  await sleep(300)
  const codexGot = await stop('codex', '[WAITING]')
  assert.match(codexGot.reason, /\[claude\] Should we shard by tenant\?/)
  assert.ok(!chat().includes('[WAITING]'))
  reset()
  assert.equal(await claudeWaiting, null)
})

test('a message that lands while I am mid-turn is delivered on my next stop, not dropped', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'A1')
  await sleep(300)
  await stop('codex', '[WAITING]')                        // codex has A1 and is "thinking"
  await run(['say', 'U1'])                                // human interjects
  assert.match((await claudeWaiting).reason, /\[user\] U1/) // claude is now "thinking" about U1
  assert.match((await stop('codex', 'C1')).reason, /\[user\] U1/) // codex replies to A1 and also sees U1
  const claudeGot = await stop('claude', 'A2')            // claude finishes its U1 turn
  assert.match(claudeGot.reason, /\[codex\] C1/)          // C1 was not skipped
  assert.ok(!claudeGot.reason.includes('[user] U1'))      // and U1 is not shown twice
  assert.match((await stop('codex', 'Noted.')).reason, /\[claude\] A2/)
})

test('[WAITING] on a later turn waits; it does not re-deliver the last message', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Q')
  await sleep(300)
  assert.match((await stop('codex', '[WAITING]')).reason, /\[claude\] Q/)
  const again = await stop('codex', '[WAITING] I need a moment.')
  assert.equal(again?.decision, undefined)
  assert.match(again.systemMessage, /no reply from claude/)
  reset()
  await claudeWaiting
})

test('side is detected from the Codex payload when no side is given', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Who are you?')
  await sleep(300)
  const out = JSON.parse(await run(['hook'], JSON.stringify({ hook_event_name: 'Stop', cwd: DIR, session_id: 'x', turn_id: 't1', last_assistant_message: 'Codex here.' })))
  assert.match(out.reason, /\[claude\] Who are you\?/)
  assert.match((await claudeWaiting).reason, /\[codex\] Codex here\./)
  assert.match(chat(), /## codex @ [^\n]+\nCodex here\./)
})

test('quoted markers: mid-sentence [DONE] does not end, a quoted header line does not split a block', async () => {
  reset()
  const codexWaiting = openWith('codex', 'I will say [DONE] when we agree. Your last block was:\n## codex @ 2026-01-01T00:00:00.000Z\nhello')
  await sleep(300)
  const claudeGot = await stop('claude', '[WAITING]')
  assert.ok(claudeGot.reason.includes('[codex] I will say [DONE] when we agree. Your last block was:\n ## codex @ 2026-01-01T00:00:00.000Z\nhello'))
  assert.ok(!claudeGot.reason.includes('[codex] hello'))
  const claudeWaiting = stop('claude', 'Fine.')
  assert.match((await codexWaiting).reason, /\[claude\] Fine\./) // still open
  reset()
  await claudeWaiting
})

test('a half-written block is not delivered until it is complete', async () => {
  reset()
  const codexWaiting = openWith('codex', 'Q')
  await sleep(300)
  appendFileSync(CHAT, '## claude @ 2026-01-01T00:00:00.000Z\nHalf')
  await sleep(400)
  appendFileSync(CHAT, ' and whole.\n\n')
  assert.match((await codexWaiting).reason, /\[claude\] Half and whole\./)
})

test('message cap closes the conversation', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true }); writeFileSync(CHAT, '')
  for (let i = 0; i < 40; i++) await run(['say', `m${i}`])
  assert.match((await stop('claude', 'hi')).reason, /\[user\] m39/) // backlog is delivered first
  assert.equal(await stop('claude', 'again'), null)
  assert.match(chat(), /## bridge @ [^\n]+\nMessage cap \(40\) reached\. \[DONE\]/)
})

test('no reply within the wait budget: stops with a systemMessage', async () => {
  reset()
  const out = await openWith('claude', 'Anyone there?')
  assert.equal(out?.decision, undefined)
  assert.match(out.systemMessage, /no reply from codex/)
})

test('removing the folder unblocks a waiting hook', async () => {
  reset()
  const claudeWaiting = openWith('claude', 'Waiting…')
  await sleep(300)
  reset()
  assert.equal(await claudeWaiting, null)
})

test('Claude Stop hook does not wait while a live channel owns delivery', async () => {
  reset()
  const codexWaiting = openWith('codex', 'Q')
  await sleep(300)
  writeFileSync(join(BDIR, 'claude.channel'), String(process.pid)) // a live channel
  const t = Date.now()
  assert.equal(await stop('claude', '@codex A'), null)
  assert.ok(Date.now() - t < 1500, 'returned without waiting')
  assert.match((await codexWaiting).reason, /\[claude\] A/)
  reset()
})

test('Claude Stop hook that opens the bridge returns once the channel claims the folder a moment later', async () => {
  reset()
  const t0 = Date.now()
  const claudeStop = stop('claude', '@codex Redis or Memcached?')
  await sleep(700)
  writeFileSync(join(BDIR, 'claude.channel'), String(process.pid)) // channel claims the new bridge
  assert.equal(await claudeStop, null)
  assert.ok(Date.now() - t0 < 2500, 'returned as soon as the channel appeared')
  assert.match(chat(), /## claude @ [^\n]+\nRedis or Memcached\?/)
  reset()
})

test('Claude wakes idle Codex with the saved configured thread and a short queue message', async () => {
  readyToWake()
  const thread = '01a11151-0f06-70b1-949b-f1a3be4513b2'
  await prompt('codex', 'go', 'codex-1', { CODEX_BRIDGE_THREAD: thread })
  assert.equal(JSON.parse(readFileSync(join(BDIR, 'codex.json'), 'utf8')).thread, thread)
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.deepEqual(wakeCalls(), [['queue', '--thread', thread, '--message', 'New message available.']])
})

test('opening a new bridge keeps the Codex thread learned before chat exists', async () => {
  reset()
  rmSync(WAKE_LOG, { force: true })
  const thread = 'configured-before-chat'
  await prompt('codex', 'ordinary prompt', 'codex-1', { CODEX_BRIDGE_THREAD: thread })
  assert.ok(!existsSync(CHAT))
  writeFileSync(join(BDIR, 'claude.channel'), String(process.pid))
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.deepEqual(wakeCalls(), [['queue', '--thread', thread, '--message', 'New message available.']])
})

test('Claude does not queue while the Codex Stop hook is waiting', async () => {
  readyToWake()
  await prompt('codex', 'go', 'codex-1', { CODEX_BRIDGE_THREAD: 'codex-thread' })
  writeFileSync(join(BDIR, 'codex.waiting'), String(process.pid))
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.deepEqual(wakeCalls(), [])
})

test('a stale waiting marker does not prevent the wake', async () => {
  readyToWake()
  await prompt('codex', 'go', 'codex-1', { CODEX_BRIDGE_THREAD: 'codex-thread' })
  writeFileSync(join(BDIR, 'codex.waiting'), '999999999')
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.equal(wakeCalls().length, 1)
})

test('without a Codex thread Claude does not queue or crash', async () => {
  readyToWake()
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.deepEqual(wakeCalls(), [])
})

test('CODEX_BRIDGE_THREAD supplies the thread when the hook payload has no ID', async () => {
  readyToWake()
  const thread = 'configured-thread'
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, { ...wakeEnv, CODEX_BRIDGE_THREAD: thread }), null)
  assert.deepEqual(wakeCalls(), [['queue', '--thread', thread, '--message', 'New message available.']])
})

test('hook session_id is saved for waking Codex when no configured thread exists', async () => {
  readyToWake()
  await run(['hook', 'codex'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: DIR, session_id: 'hook-session', thread_id: 'hook-thread', prompt: 'go' }))
  assert.equal(JSON.parse(readFileSync(join(BDIR, 'codex.json'), 'utf8')).thread, 'hook-session')
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.deepEqual(wakeCalls(), [['queue', '--thread', 'hook-session', '--message', 'New message available.']])
})

test('configured thread takes priority over the ID saved from a Codex hook', async () => {
  readyToWake()
  await run(['hook', 'codex'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: DIR, session_id: 'hook-session', prompt: 'go' }))
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, { ...wakeEnv, CODEX_BRIDGE_THREAD: 'configured-thread' }), null)
  assert.deepEqual(wakeCalls(), [['queue', '--thread', 'configured-thread', '--message', 'New message available.']])
})

test('discovery picks the newest codex-tui rollout in the bridge cwd', async () => {
  readyToWake()
  const now = Date.now()
  rollout('older-good', { originator: 'codex-tui', cwd: DIR, id: 'older-good' }, new Date(now - 4000))
  rollout('newer-good', { originator: 'codex-tui', cwd: DIR, id: 'newer-good' }, new Date(now - 3000))
  rollout('exec', { originator: 'codex_exec', cwd: DIR, id: 'exec' }, new Date(now - 2000))
  rollout('other-cwd', { originator: 'codex-tui', cwd: '/somewhere-else', id: 'other-cwd' }, new Date(now - 1000))
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.deepEqual(wakeCalls(), [['queue', '--thread', 'newer-good', '--message', 'New message available.']])
})

test('discovery searches only three days and twenty newest rollouts', async () => {
  readyToWake()
  const now = Date.now()
  rollout('old-day', { originator: 'codex-tui', cwd: DIR, id: 'old-day' }, new Date(now), 3)
  rollout('twenty-first', { originator: 'codex-tui', cwd: DIR, id: 'twenty-first' }, new Date(now - 30_000))
  for (let i = 0; i < 20; i++) rollout(`exec-${i}`, { originator: 'codex_exec', cwd: DIR, id: `exec-${i}` }, new Date(now - i * 1000))
  assert.equal(await stop('claude', '@codex A', 'claude-1', {}, wakeEnv), null)
  assert.deepEqual(wakeCalls(), [])
})

test('debug file captures hook input and environment names for each side', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true })
  writeFileSync(join(BDIR, 'debug'), '')
  const claudeInput = '{ "hook_event_name": "UserPromptSubmit", "cwd": ' + JSON.stringify(DIR) + ', "prompt": "go" }'
  const codexInput = '{ "hook_event_name": "UserPromptSubmit", "cwd": ' + JSON.stringify(DIR) + ', "prompt": "go", "session_id": "id" }'
  for (const [side, input] of [['claude', claudeInput], ['codex', codexInput]]) {
    await run(['hook', side], input, { OTHER_SECRET_MARKER: 'never-write-this-value' })
    const raw = readFileSync(join(BDIR, `debug-${side}.json`), 'utf8')
    const debug = JSON.parse(raw)
    assert.equal(debug.input, input)
    assert.equal(debug.cwd, DIR)
    assert.ok(Number.isInteger(debug.ppid) && debug.ppid > 0)
    assert.ok(debug.envKeys.includes('OTHER_SECRET_MARKER'))
    assert.ok(!('CODEX_BRIDGE_DEBUG' in debug.bridgeEnv))
    assert.equal(debug.bridgeEnv.CODEX_BRIDGE_WAIT_MS, '3000')
    assert.ok(!raw.includes('never-write-this-value'))
  }
})

test('debug environment variable and home fallback each enable capture', async () => {
  reset()
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: DIR, prompt: 'go' })
  await run(['hook', 'claude'], input, { CODEX_BRIDGE_DEBUG: '' })
  assert.equal(JSON.parse(readFileSync(join(BDIR, 'debug-claude.json'), 'utf8')).bridgeEnv.CODEX_BRIDGE_DEBUG, '')
  reset()
  const home = join(DIR, 'home')
  mkdirSync(join(home, '.codex-bridge'), { recursive: true })
  writeFileSync(join(home, '.codex-bridge', 'debug'), '')
  await run(['hook', 'codex'], input, { HOME: home })
  assert.equal(JSON.parse(readFileSync(join(BDIR, 'debug-codex.json'), 'utf8')).input, input)
})

test('named alpha and beta keep messages and Codex wake targets separate', async () => {
  reset()
  rmSync(WAKE_LOG, { force: true })
  for (const name of ['alpha', 'beta']) {
    const ctx = await prompt('claude', `discuss with codex bridge ${name}: hello`, `claude-${name}`)
    assert.match(ctx, new RegExp(`bridge ${name}`))
    await prompt('codex', `discuss with claude bridge ${name}: hello`, `codex-${name}`)
    writeFileSync(join(BDIR, name, 'claude.channel'), String(process.pid))
  }
  assert.equal((await stop('codex', '@claude alpha: alpha question', 'codex-alpha', {}, { CODEX_BRIDGE_WAIT_MS: '0' })).decision, undefined)
  assert.equal((await stop('codex', '@claude beta: beta question', 'codex-beta', {}, { CODEX_BRIDGE_WAIT_MS: '0' })).decision, undefined)
  assert.equal(await stop('claude', '@codex alpha: alpha answer', 'claude-alpha', {}, wakeEnv), null)
  assert.equal(await stop('claude', '@codex beta: beta answer', 'claude-beta', {}, wakeEnv), null)
  const alpha = readFileSync(join(BDIR, 'alpha', 'chat.md'), 'utf8')
  const beta = readFileSync(join(BDIR, 'beta', 'chat.md'), 'utf8')
  assert.match(alpha, /alpha question[\s\S]*alpha answer/)
  assert.doesNotMatch(alpha, /beta (question|answer)/)
  assert.match(beta, /beta question[\s\S]*beta answer/)
  assert.doesNotMatch(beta, /alpha (question|answer)/)
  assert.deepEqual(wakeCalls().map(c => c[2]), ['codex-alpha', 'codex-beta'])
})

test('named bridge ignores unrelated replies and forwards a reply to a delivered message', async () => {
  reset()
  await prompt('claude', 'discuss with codex bridge alpha: test', 'claude-alpha')
  await prompt('codex', 'discuss with claude bridge alpha: test', 'codex-alpha')
  writeFileSync(join(BDIR, 'alpha', 'claude.channel'), String(process.pid))
  assert.equal(await stop('claude', 'Progress update for Wladimir.', 'claude-alpha'), null)
  assert.ok(!existsSync(join(BDIR, 'alpha', 'chat.md')))
  await stop('codex', '@claude alpha: question', 'codex-alpha', {}, { CODEX_BRIDGE_WAIT_MS: '0' })
  rmSync(join(BDIR, 'alpha', 'claude.channel'))
  assert.match(await prompt('claude', 'continue', 'claude-alpha'), /\[codex\] question/)
  writeFileSync(join(BDIR, 'alpha', 'claude.channel'), String(process.pid))
  assert.equal(await stop('claude', 'Answer.', 'claude-alpha', {}, wakeEnv), null)
  assert.match(readFileSync(join(BDIR, 'alpha', 'chat.md'), 'utf8'), /## claude @ [^\n]+\nAnswer\./)
  assert.equal(await stop('claude', 'Another status.', 'claude-alpha'), null)
  assert.doesNotMatch(readFileSync(join(BDIR, 'alpha', 'chat.md'), 'utf8'), /Another status/)
})

test('default bridge also leaves unrelated status replies local', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true })
  writeFileSync(CHAT, '')
  assert.equal(await stop('claude', 'Working on the tests.'), null)
  assert.equal(chat(), '')
})

test('an addressed WAITING reply after DONE preserves the named transcript', async () => {
  reset()
  await prompt('codex', 'discuss with claude bridge alpha: test', 'codex-alpha')
  const file = join(BDIR, 'alpha', 'chat.md')
  writeFileSync(file, '## claude @ 2026-10-06T00:00:00.000Z\nfinished [DONE]\n\n')
  const before = readFileSync(file, 'utf8')
  assert.match(await prompt('codex', 'continue', 'codex-alpha'), /finished \[DONE\]/)
  assert.equal(await stop('codex', '@claude alpha: [WAITING]', 'codex-alpha'), null)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('say can address one named bridge without touching another', async () => {
  reset()
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(BDIR, name), { recursive: true })
    writeFileSync(join(BDIR, name, 'chat.md'), '')
  }
  assert.equal(await run(['say', '--bridge', 'alpha', 'test message']), '')
  assert.match(readFileSync(join(BDIR, 'alpha', 'chat.md'), 'utf8'), /test message/)
  assert.equal(readFileSync(join(BDIR, 'beta', 'chat.md'), 'utf8'), '')
})

test('a replaced named member cannot add messages to the old bridge', async () => {
  reset()
  await prompt('codex', 'discuss with claude bridge alpha: old', 'codex-old')
  await prompt('codex', 'discuss with claude bridge alpha: new', 'codex-new')
  assert.equal(await stop('codex', '@claude alpha: stale', 'codex-old'), null)
  assert.ok(!existsSync(join(BDIR, 'alpha', 'chat.md')))
})

test('two named Claude channels deliver only their own chat', async () => {
  reset()
  const channels = []
  for (const name of ['alpha', 'beta']) {
    await prompt('claude', `discuss with codex bridge ${name}: test`, `claude-${name}`)
    writeFileSync(join(BDIR, name, 'chat.md'), '')
    const file = join(DIR, `channel-${name}.out`)
    const fd = openSync(file, 'w')
    const proc = spawn('sh', ['-c', `sleep 2 | "${process.execPath}" "${BRIDGE}" channel claude-${name}`], {
      cwd: DIR, env: { ...env, CODEX_BRIDGE_CHANNEL: '1' }, stdio: ['ignore', fd, 'inherit'],
    })
    channels.push({ name, file, fd, proc })
  }
  try {
    for (const { name } of channels)
      appendFileSync(join(BDIR, name, 'chat.md'), `## codex @ 2026-10-06T00:00:00.000Z\n${name} only\n\n`)
    await sleep(1200)
    for (const { name, file } of channels) {
      const output = readFileSync(file, 'utf8')
      assert.match(output, new RegExp(`${name} only`))
      assert.doesNotMatch(output, new RegExp(`${name === 'alpha' ? 'beta' : 'alpha'} only`))
    }
  } finally {
    for (const { proc } of channels) if (proc.exitCode === null) await new Promise(resolve => proc.on('exit', resolve))
    for (const { fd } of channels) closeSync(fd)
  }
})

test('Claude membership keeps the stable CLI PID across prompt and Stop hooks', async () => {
  reset()
  const home = join(DIR, 'claude-home')
  const sessions = join(home, '.claude', 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, '424242.json'), JSON.stringify({ pid: 424242, sessionId: 'claude-alpha', cwd: DIR }))
  await prompt('claude', 'discuss with codex bridge alpha: test', 'claude-alpha', { HOME: home })
  const memberFile = join(BDIR, 'alpha', 'claude.member.json')
  assert.equal(JSON.parse(readFileSync(memberFile, 'utf8')).pid, 424242)
  assert.equal(await stop('claude', 'Unrelated status.', 'claude-alpha', {}, { HOME: home }), null)
  assert.equal(JSON.parse(readFileSync(memberFile, 'utf8')).pid, 424242)
})

test('channel: MCP handshake, then pushes new Codex blocks as notifications and advances seen', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true }); writeFileSync(CHAT, '')
  const p = spawn(process.execPath, [BRIDGE, 'channel'], { cwd: DIR, env: { ...env, CODEX_BRIDGE_CHANNEL: '1' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = []
  let buf = ''
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) } })
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n')
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await sleep(400)
  const init = lines.find(l => l.id === 1)
  assert.deepEqual(init.result.capabilities, { experimental: { 'claude/channel': {} } })
  assert.match(init.result.instructions, /Never call a tool/)
  await sleep(700)
  assert.equal(readFileSync(join(BDIR, 'claude.channel'), 'utf8'), String(p.pid)) // claimed delivery
  await run(['say', 'ping from user'])
  await stop('codex', 'ping from codex', 'codex-1', {}) // appends and waits; we do not await it here
  await sleep(1200)
  const pushed = lines.filter(l => l.method === 'notifications/claude/channel')
  assert.deepEqual(pushed.map(n => [n.params.meta.sender, n.params.content]), [['user', 'ping from user'], ['codex', 'ping from codex']])
  assert.equal(JSON.parse(readFileSync(join(BDIR, 'claude.json'), 'utf8')).seen, 2)
  p.stdin.end()
  await new Promise(r => p.on('exit', r))
  assert.ok(!existsSync(join(BDIR, 'claude.channel'))) // marker released on exit
  reset()
})

test('channel: stays silent when Claude Code was not started with the channel enabled', async () => {
  reset()
  mkdirSync(BDIR, { recursive: true }); writeFileSync(CHAT, '')
  const p = spawn(process.execPath, [BRIDGE, 'channel'], { cwd: DIR, env, stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  p.stdout.on('data', d => { out += d })
  await run(['say', 'hello'])
  await sleep(1200)
  p.stdin.end()
  await new Promise(r => p.on('exit', r))
  assert.equal(out, '')
  assert.ok(!existsSync(join(BDIR, 'claude.channel')))
  reset()
})
