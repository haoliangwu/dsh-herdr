/**
 * Smoke test for dsh-herdr.
 *
 * Boots the built plugin against a fake Herdr socket server and a minimal
 * fake cordis context, then drives the mapped events and asserts the JSON
 * requests the plugin sends. A separate child process exercises the
 * release-on-exit path (synchronous flush on `exit`).
 *
 * Run with: bun run smoke  (from the package directory)
 */

import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url))

/** Collect every JSON request line the fake server receives. */
async function startFakeHerdr() {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-smoke-'))
  const socketPath = join(dir, 'herdr.sock')
  const lines = []
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, idx)))
        buffer = buffer.slice(idx + 1)
      }
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    lines,
    close: () =>
      new Promise((resolve) => {
        // server.close() waits for open connections; drop the plugin's
        // persistent socket first so the close actually settles.
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.close(resolve)
      }),
  }
}

/** Minimal cordis-like context: stores listeners, provides agents registry. */
function fakeCtx(roots = []) {
  const listeners = new Map()
  return {
    roots,
    ctx: {
      on(name, cb) {
        listeners.set(name, cb)
      },
      effect() {
        return () => {}
      },
      agents: {
        roots: () => roots,
      },
      logger: { debug() {}, info() {} },
    },
    listeners,
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

const { socketPath, lines, close } = await startFakeHerdr()
const originalEnv = { ...process.env }
process.env.HERDR_ENV = '1'
process.env.HERDR_PANE_ID = 'w9:p1'
process.env.HERDR_SOCKET_PATH = socketPath

const { apply } = await import(dist)
const { ctx, listeners, roots } = fakeCtx([])

apply(ctx, {})

// --- 1. initial idle report at boot ---------------------------------------
await new Promise((r) => setTimeout(r, 100))
assert(lines.length >= 1, `expected an initial report, got ${lines.length}`)
const initial = lines[0]
assert(initial.method === 'pane.report_agent', `initial method ${initial.method}`)
assert(initial.params.pane_id === 'w9:p1', `pane_id ${JSON.stringify(initial.params.pane_id)}`)
assert(initial.params.source === 'custom:dsh', `source ${initial.params.source}`)
assert(initial.params.agent === 'dsh', `agent ${initial.params.agent}`)
assert(initial.params.state === 'idle', `initial state ${initial.params.state}`)
assert(typeof initial.params.seq === 'number', 'seq must be a number')

// --- 2. root agent created -> idle with session id ------------------------
const rootAgent = {
  id: 'sess-1',
  status: 'idle',
  session: { id: 'sess-1' },
}
roots.push(rootAgent)
listeners.get('agent/created')({ agent: rootAgent })
await new Promise((r) => setTimeout(r, 100))
const created = lines.at(-1)
assert(created.params.state === 'idle', `created state ${created.params.state}`)
assert(created.params.agent_session_id === 'sess-1', `session id ${created.params.agent_session_id}`)

// --- 3. running -> working -------------------------------------------------
rootAgent.status = 'running'
listeners.get('agent/status')({ agent: rootAgent, status: 'running' })
await new Promise((r) => setTimeout(r, 100))
assert(lines.at(-1).params.state === 'working', `running state ${lines.at(-1).params.state}`)

// --- 4. approval/asked -> blocked with message -----------------------------
const rootSession = rootAgent.session
listeners.get('session/event')(rootSession, {
  type: 'approval/asked',
  seq: 1,
  time: Date.now(),
  data: { id: 'a1', toolName: 'bash', reason: 'needs sudo' },
})
await new Promise((r) => setTimeout(r, 100))
const blocked = lines.at(-1)
assert(blocked.params.state === 'blocked', `blocked state ${blocked.params.state}`)
assert(blocked.params.message === 'needs sudo', `blocked message ${blocked.params.message}`)

// --- 5. approval/decided -> back to working --------------------------------
listeners.get('session/event')(rootSession, {
  type: 'approval/decided',
  seq: 2,
  time: Date.now(),
  data: { id: 'a1', outcome: 'granted' },
})
await new Promise((r) => setTimeout(r, 100))
assert(lines.at(-1).params.state === 'working', `decided state ${lines.at(-1).params.state}`)

// --- 6. idle -----------------------------------------------------------------
rootAgent.status = 'idle'
listeners.get('agent/status')({ agent: rootAgent, status: 'idle' })
await new Promise((r) => setTimeout(r, 100))
assert(lines.at(-1).params.state === 'idle', `idle state ${lines.at(-1).params.state}`)

// --- 7. child agent / child session events are ignored -----------------------
const childAgent = { id: 'sess-child', status: 'running', session: { id: 'sess-child' } }
listeners.get('agent/status')({ agent: childAgent, status: 'running' })
listeners.get('session/event')(childAgent.session, {
  type: 'approval/asked',
  seq: 3,
  time: Date.now(),
  data: { id: 'a2', toolName: 'bash' },
})
await new Promise((r) => setTimeout(r, 100))
assert(lines.at(-1).params.state === 'idle', `child event leaked: ${lines.at(-1).params.state}`)

// --- 8. seq strictly increasing, all requests well-formed ---------------------
const seqs = lines.map((line) => line.params.seq)
assert(seqs.every((v, i) => i === 0 || v > seqs[i - 1]), `seq not increasing: ${seqs}`)
assert(lines.every((line) => line.id && line.params.pane_id === 'w9:p1'), 'request envelope broken')

// --- 9. no-op outside Herdr ----------------------------------------------------
const lineCount = lines.length
const saved = { ...process.env }
delete process.env.HERDR_ENV
delete process.env.HERDR_PANE_ID
delete process.env.HERDR_SOCKET_PATH
const fresh = fakeCtx([])
apply(fresh.ctx, {})
await new Promise((r) => setTimeout(r, 100))
assert(lines.length === lineCount, 'plugin reported outside Herdr')
Object.assign(process.env, saved)

console.log(`OK — ${lines.length} requests verified (idle/working/blocked mapping, seq, no-op)`)

// --- 10. release on process exit (child process) --------------------------------
await close()
const { socketPath: exitSocket, lines: exitLines, close: closeExit } = await startFakeHerdr()
process.env.HERDR_SOCKET_PATH = exitSocket

const child = `
import { apply } from ${JSON.stringify(dist)}
const listeners = new Map()
const ctx = {
  on: (name, cb) => listeners.set(name, cb),
  effect: () => () => {},
  agents: { roots: () => [] },
  logger: { debug() {} },
}
apply(ctx, {})
setTimeout(() => process.exit(0), 300)
`
await new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', child], {
    env: process.env,
    stdio: 'inherit',
  })
  proc.on('error', reject)
  proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
})
await new Promise((r) => setTimeout(r, 200))
const release = exitLines.find((line) => line.method === 'pane.release_agent')
assert(release !== undefined, `no release_agent on exit; got ${JSON.stringify(exitLines)}`)
assert(release.params.source === 'custom:dsh' && release.params.agent === 'dsh', 'release identity wrong')
await closeExit()

console.log('OK — release_agent flushed on process exit')

process.exit(0)
