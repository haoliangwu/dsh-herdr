/**
 * dsh-herdr — report the dsh TUI's lifecycle state to Herdr's agent panel.
 *
 * Mirrors Herdr's own agent integrations: an agent process inside a Herdr
 * pane inherits `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and
 * `HERDR_SOCKET_PATH`. This plugin maps dsh events to Herdr's semantic states
 * and reports them through the pane socket API (JSON-lines requests, the same
 * protocol Herdr's opencode/pi/omp plugins use).
 *
 * State mapping (only the pane's root agent is reported; subagent churn is
 * internal to the root's turn and never reaches the panel):
 *   - `agent/status` running  -> working
 *   - `agent/status` idle     -> idle
 *   - session `approval/asked`   -> blocked (a human decision is pending)
 *   - session `approval/decided` -> previous lifecycle state
 *
 * The plugin reports `idle` immediately at boot so the pane shows dsh even
 * before a session exists, includes the dsh session id with every report for
 * Herdr's pane/agent APIs, and releases lifecycle authority when dsh exits.
 *
 * Outside a Herdr pane (`HERDR_ENV` != 1) the plugin is a strict no-op.
 * @module dsh-herdr
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Merge the approval event types (approval/asked, approval/decided) into the
// session event map; without this augmentation the SessionEvent union does
// not contain them.
import type {} from '@deepseek-ai/dsh-user-approval'
import { HerdrReporter, type HerdrState } from './reporter.ts'

/** Cordis plugin name (loader diagnostics). */
export const name = 'herdr-reporter'

/** No configuration today; the plugin keys off the Herdr environment. */
export interface Config {}

const SOURCE = 'custom:dsh'
const AGENT = 'dsh'

export function apply(ctx: Context, _config: Config = {}): void {
  const paneId = process.env.HERDR_PANE_ID
  const socketPath = process.env.HERDR_SOCKET_PATH
  if (process.env.HERDR_ENV !== '1' || !paneId || !socketPath) {
    ctx.logger?.debug?.('dsh-herdr: not inside a Herdr pane; integration is a no-op')
    return
  }

  const reporter = new HerdrReporter({ paneId, socketPath, source: SOURCE, agent: AGENT })

  // Report immediately so the pane shows dsh before any session exists.
  reporter.report('idle')

  /** The pane's root agent; only its lifecycle is reported. */
  let reported: Agent | undefined

  const report = (state: HerdrState, message?: string): void => {
    reporter.report(state, message, reported?.session.id)
  }

  const isRoot = (agent: Agent): boolean => {
    try {
      const agents = (ctx.get('agents') as { roots(): Agent[] } | undefined) ?? (ctx as unknown as { agents?: { roots(): Agent[] } }).agents
      if (agents === undefined) return true
      return agents.roots().includes(agent)
    } catch {
      // The agents registry is not available yet (or at all); assume root.
      return true
    }
  }

  const onCreated = (agent: Agent): void => {
    if (reported !== undefined || !isRoot(agent)) return
    reported = agent
    report(agent.status === 'running' ? 'working' : 'idle')
  }

  const onDisposed = (agent: Agent): void => {
    if (agent !== reported) return
    reported = undefined
    report('idle')
  }

  const onStatus = (agent: Agent, status: AgentStatus): void => {
    if (agent !== reported) return
    report(status === 'running' ? 'working' : 'idle')
  }

  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    if (reported === undefined || session !== reported.session) return
    if (event.type === 'approval/asked') {
      report('blocked', event.data.reason ?? `waiting for approval: ${event.data.toolName}`)
    } else if (event.type === 'approval/decided') {
      report(reported.status === 'running' ? 'working' : 'idle')
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    onCreated(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    onDisposed(agent)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    onStatus(agent, status)
  })
  ctx.on('session/event', onSessionEvent)

  // Safety sweep for agents that already exist when this plugin loads (HMR):
  // the registry may not be ready inside `apply`, so retry on the next tick.
  const sweep = (): void => {
    try {
      const agents = (ctx.get('agents') as { roots(): Agent[] } | undefined) ?? (ctx as unknown as { agents?: { roots(): Agent[] } }).agents
      if (agents === undefined) return
      for (const agent of agents.roots()) onCreated(agent)
    } catch {
      // agents registry not ready; `agent/created` will cover it.
    }
  }
  const timer = setTimeout(sweep, 0)
  ctx.effect(() => () => {
    clearTimeout(timer)
  })

  // Release lifecycle authority when dsh exits: async flush on graceful
  // shutdown, synchronous best-effort flush when the event loop is gone.
  process.once('beforeExit', () => {
    reporter.release()
  })
  process.once('exit', () => {
    reporter.releaseSync()
  })
}
