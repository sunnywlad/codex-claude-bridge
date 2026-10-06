import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BRIDGE = new URL('./bridge.mjs', import.meta.url).pathname

function fixture(t) {
  const project = mkdtempSync(join(tmpdir(), 'codex-bridge-relay-'))
  const root = join(project, '.codex-bridge')
  const log = join(project, 'codex-log.jsonl')
  const fakeCodex = join(project, 'fake-codex')
  mkdirSync(root)
  writeFileSync(fakeCodex, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.TEST_CODEX_LOG, JSON.stringify(args) + '\\n');\nif (args.includes('--thread') && args[args.indexOf('--thread') + 1] === 'thread-alpha') process.exit(7);\n`)
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
    const env = { ...process.env, CODEX_BRIDGE_CODEX_BIN: fakeCodex, TEST_CODEX_LOG: log }
    delete env.NODE_TEST_CONTEXT
    return spawnSync(process.execPath, [BRIDGE, ...args], { cwd: project, encoding: 'utf8', env })
  }
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  return { project, root, bridge, run, calls }
}

test('relay --once drains queues for every named bridge, including later bridges after one fails', t => {
  const f = fixture(t)
  const alpha = f.bridge('alpha', 'thread-alpha', [['a1', 'alpha message']])
  const beta = f.bridge('beta', 'thread-beta', [['b1', 'beta one'], ['b2', 'beta two']])

  const result = f.run('relay', '--once', '--project', f.project)

  assert.notEqual(result.status, 0, 'a queue failure should be reflected in the command exit status')
  assert.deepEqual(f.calls(), [
    ['queue', '--thread', 'thread-alpha', '--message', 'alpha message'],
    ['queue', '--thread', 'thread-beta', '--message', 'beta one'],
    ['queue', '--thread', 'thread-beta', '--message', 'beta two'],
  ])
  assert.equal(readdirSync(alpha).filter(name => name.startsWith('queue-')).length, 1, 'failed queue item remains available for retry')
  assert.equal(readdirSync(beta).filter(name => name.startsWith('queue-')).length, 0, 'successful queue items are removed')
})

test('clear --bridge resets chat and side states while preserving thread, member files, and queued messages', t => {
  const f = fixture(t)
  const dir = f.bridge('alpha', 'thread-keep', [['pending', 'keep me']])

  const result = f.run('clear', '--bridge', 'alpha')

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(dir, 'chat.md'), 'utf8'), '')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8')), { first: '', seen: 0, thread: 'thread-keep' })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf8')), { first: '', seen: 0 })
  assert.equal(readFileSync(join(dir, 'claude.member.json'), 'utf8'), JSON.stringify({ id: 'alpha-claude', pid: 123 }))
  assert.equal(readFileSync(join(dir, 'codex.member.json'), 'utf8'), JSON.stringify({ id: 'alpha-codex', pid: 456 }))
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('queue-')), ['queue-pending.json'])
})
