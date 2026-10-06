import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BRIDGE = new URL('./bridge.mjs', import.meta.url).pathname

function fixture(t) {
  const project = mkdtempSync(join(tmpdir(), 'codex-bridge-relay-'))
  const root = join(project, '.codex-bridge')
  const log = join(project, 'codex-log.jsonl')
  const claimLog = join(project, 'claim-log.jsonl')
  const timeLog = join(project, 'time-log.txt')
  const fakeCodex = join(project, 'fake-codex')
  mkdirSync(root)
  writeFileSync(fakeCodex, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.TEST_CODEX_LOG, JSON.stringify(args) + '\\n');\nfs.appendFileSync(process.env.TEST_CLAIM_LOG, JSON.stringify(fs.readdirSync(path.join(process.cwd(), '.codex-bridge', 'alpha'))) + '\\n');\nfs.appendFileSync(process.env.TEST_TIME_LOG, String(Date.now()) + '\\n');\nsetTimeout(() => { if (args.includes('--thread') && args[args.indexOf('--thread') + 1] === 'thread-alpha') process.exit(7); }, Number(process.env.TEST_CODEX_DELAY || 0));\n`)
  chmodSync(fakeCodex, 0o755)
  t.after(() => rmSync(project, { recursive: true, force: true }))

  const bridge = (name, thread, queues = []) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'chat.md'), `history for ${name}\n`)
    writeFileSync(join(dir, 'codex.json'), JSON.stringify({ first: 'head', seen: 3, thread }))
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ first: 'head', seen: 2, custom: true }))
    writeFileSync(join(dir, 'claude.member.json'), JSON.stringify({ id: `${name}-claude`, pid: 123 }))
    writeFileSync(join(dir, 'codex.member.json'), JSON.stringify({ id: `${name}-codex`, pid: 456 }))
    for (const [id, message, queueThread = thread] of queues)
      writeFileSync(join(dir, `queue-${id}.json`), JSON.stringify({ thread: queueThread, message }))
    return dir
  }
  const run = (...args) => {
    const env = { ...process.env, CODEX_BRIDGE_CODEX_BIN: fakeCodex, TEST_CODEX_LOG: log, TEST_CLAIM_LOG: claimLog, TEST_TIME_LOG: timeLog, CODEX_BRIDGE_RETRY_DELAYS_MS: '100,300' }
    delete env.NODE_TEST_CONTEXT
    return spawnSync(process.execPath, [BRIDGE, ...args], { cwd: project, encoding: 'utf8', env })
  }
  const runAsync = (...args) => {
    const env = { ...process.env, CODEX_BRIDGE_CODEX_BIN: fakeCodex, TEST_CODEX_LOG: log, TEST_CLAIM_LOG: claimLog, TEST_TIME_LOG: timeLog, TEST_CODEX_DELAY: '1200', CODEX_BRIDGE_RETRY_DELAYS_MS: '100,300' }
    delete env.NODE_TEST_CONTEXT
    return new Promise(resolve => {
      const child = spawn(process.execPath, [BRIDGE, ...args], { cwd: project, encoding: 'utf8', env, stdio: 'ignore' })
      child.on('error', error => resolve({ status: null, error }))
      child.on('exit', (status, signal) => resolve({ status, signal }))
    })
  }
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const claimSnapshots = () => existsSync(claimLog) ? readFileSync(claimLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const callTimes = () => existsSync(timeLog) ? readFileSync(timeLog, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
  return { project, root, bridge, run, runAsync, calls, claimSnapshots, callTimes }
}

test('relay holds one project flock and claims a queue item before sending it', async t => {
  const f = fixture(t)
  const queueId = '11111111-1111-4111-8111-111111111111'
  const dir = f.bridge('alpha', 'thread-live', [[queueId, 'only once']])
  const first = f.runAsync('relay', '--once', '--project', f.project)
  for (let attempt = 0; attempt < 100 && !f.calls().length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(f.claimSnapshots().some(names => names.includes(`inflight-${queueId}.json`)), 'the queue file is renamed before codex queue runs')
  const second = f.run('relay', '--once', '--project', f.project)
  assert.equal(second.status, 1)
  assert.equal((await first).status, 0)
  assert.deepEqual(f.calls(), [['queue', '--thread', 'thread-live', '--message', 'only once']])
  assert.deepEqual(readdirSync(dir).filter(name => /^(queue|inflight)-/.test(name)), [])
})

test('relay retries a failed request three times, archives it, and continues the queues', t => {
  const f = fixture(t)
  const alpha = f.bridge('alpha', 'thread-alpha', [['a1', 'alpha message']])
  const beta = f.bridge('beta', 'thread-beta', [['b1', 'beta one'], ['b2', 'beta two']])

  const result = f.run('relay', '--once', '--project', f.project)

  assert.notEqual(result.status, 0, 'a queue failure should be reflected in the command exit status')
  assert.deepEqual(f.calls(), [
    ['queue', '--thread', 'thread-alpha', '--message', 'alpha message'],
    ['queue', '--thread', 'thread-alpha', '--message', 'alpha message'],
    ['queue', '--thread', 'thread-alpha', '--message', 'alpha message'],
    ['queue', '--thread', 'thread-beta', '--message', 'beta one'],
    ['queue', '--thread', 'thread-beta', '--message', 'beta two'],
  ])
  const [firstTry, secondTry, thirdTry] = f.callTimes()
  assert.ok(secondTry - firstTry >= 80, 'the retry delay increases after the first failure')
  assert.ok(thirdTry - secondTry >= 280, 'the second retry waits longer than the first')
  const failed = JSON.parse(readFileSync(join(alpha, 'failed', 'a1.json'), 'utf8'))
  assert.equal(failed.attempts, 3)
  assert.match(failed.reason, /failed after 3 attempts/)
  assert.match(readFileSync(join(alpha, 'chat.md'), 'utf8'), /failed after 3 attempts/)
  assert.equal(readdirSync(alpha).filter(name => name.startsWith('queue-')).length, 0)
  assert.equal(readdirSync(beta).filter(name => name.startsWith('queue-')).length, 0, 'successful queue items are removed')
})

test('stale thread requests move to failed, warn in chat, and do not block the next request', t => {
  const f = fixture(t)
  const staleId = '11111111-1111-4111-8111-111111111111'
  const liveId = '22222222-2222-4222-8222-222222222222'
  const dir = f.bridge('alpha', 'thread-current', [
    [staleId, 'old task', 'thread-old'],
    [liveId, 'current task', 'thread-current'],
  ])

  const result = f.run('relay', '--once', '--project', f.project)

  assert.equal(result.status, 0, result.stderr)
  const failedName = `${staleId}.json`
  const failed = JSON.parse(readFileSync(join(dir, 'failed', failedName), 'utf8'))
  assert.equal(failed.thread, 'thread-old')
  assert.match(failed.reason, /target thread thread-old is stale; current thread is thread-current/)
  assert.match(readFileSync(join(dir, 'chat.md'), 'utf8'), new RegExp(`request ${failedName} failed:.*failed/${failedName}`))
  assert.deepEqual(f.calls(), [['queue', '--thread', 'thread-current', '--message', 'current task']])
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('queue-') || name.startsWith('inflight-')), [])
})

test('clear --bridge resets chat and side states while preserving thread, member files, and queued messages', t => {
  const f = fixture(t)
  const pendingId = '33333333-3333-4333-8333-333333333333'
  const dir = f.bridge('alpha', 'thread-keep', [[pendingId, 'keep me']])

  const result = f.run('clear', '--bridge', 'alpha')

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(dir, 'chat.md'), 'utf8'), '')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8')), { first: '', seen: 0, thread: 'thread-keep' })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf8')), { first: '', seen: 0 })
  assert.equal(readFileSync(join(dir, 'claude.member.json'), 'utf8'), JSON.stringify({ id: 'alpha-claude', pid: 123 }))
  assert.equal(readFileSync(join(dir, 'codex.member.json'), 'utf8'), JSON.stringify({ id: 'alpha-codex', pid: 456 }))
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('queue-')), [`queue-${pendingId}.json`])
})

test('clear --bridge --queue removes pending requests but keeps in-flight and failed records', t => {
  const f = fixture(t)
  const pendingId = '33333333-3333-4333-8333-333333333333'
  const inflightId = '44444444-4444-4444-8444-444444444444'
  const dir = f.bridge('alpha', 'thread-keep', [[pendingId, 'remove me']])
  writeFileSync(join(dir, `inflight-${inflightId}.json`), JSON.stringify({ thread: 'thread-keep', message: 'already claimed' }))
  mkdirSync(join(dir, 'failed'))
  writeFileSync(join(dir, 'failed', 'old.json'), JSON.stringify({ reason: 'old failure' }))

  const result = f.run('clear', '--bridge', 'alpha', '--queue')

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('queue-')), [])
  assert.ok(existsSync(join(dir, `inflight-${inflightId}.json`)))
  assert.ok(existsSync(join(dir, 'failed', 'old.json')))
})
