/**
 * Minimal Herdr lifecycle reporter — JSON-lines client for Herdr's pane
 * socket API, modeled on Herdr's own integrations (see the opencode plugin).
 *
 * Reports are fire-and-forget: each write opens a short-lived connection, so
 * a missing or restarting Herdr server never blocks the agent. The one
 * exception is process exit: a dedicated persistent connection lets the
 * reporter flush `pane.release_agent` synchronously when the event loop is
 * already gone.
 * @module dsh-herdr/reporter
 */

import fs from 'node:fs'
import net from 'node:net'

/** Lifecycle states Herdr's agent panel understands. */
export type HerdrState = 'idle' | 'working' | 'blocked'

export interface HerdrReporterOptions {
  /** Value of HERDR_PANE_ID at boot. */
  readonly paneId: string
  /** Value of HERDR_SOCKET_PATH at boot. */
  readonly socketPath: string
  /** Stable, unique integration source label (Herdr convention: `custom:<name>`). */
  readonly source: string
  /** Agent label shown in the Herdr agent panel. */
  readonly agent: string
}

interface HerdrRequest {
  readonly id: string
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * How long one report connection may sit unaccepted before we give up on it.
 * Herdr's api server reads one request per connection and can fall behind
 * while the UI renders; a shorter window than Herdr's own read timeout drops
 * reports exactly when the pane is busiest.
 */
const REQUEST_TIMEOUT_MS = 3_000
/** Connection attempts per report before dropping it (fire-and-forget). */
const MAX_SEND_ATTEMPTS = 3

export class HerdrReporter {
  private seq = 0
  private readonly endpoint: string
  /** Long-lived connection used only for the synchronous exit flush. */
  private readonly persistent: net.Socket

  constructor(private readonly options: HerdrReporterOptions) {
    this.endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\${options.socketPath}` : options.socketPath
    this.persistent = net.createConnection(this.endpoint)
    this.persistent.on('error', () => {
      this.persistent.destroy()
    })
  }

  /**
   * Report a lifecycle state; include the dsh session id so Herdr can expose
   * the session reference through its pane and agent APIs.
   * @param state - semantic state for the agent panel.
   * @param message - human-readable block reason (only meaningful with `blocked`).
   * @param sessionId - the pane's dsh session id, when known.
   */
  report(state: HerdrState, message?: string, sessionId?: string): void {
    const params: Record<string, unknown> = { state }
    if (message !== undefined) params.message = message
    if (sessionId !== undefined) params.agent_session_id = sessionId
    this.send('pane.report_agent', params)
  }

  /** Release lifecycle authority for this source (agent process exiting). */
  release(): void {
    this.send('pane.release_agent', {})
  }

  /**
   * Best-effort synchronous release for the `exit` event, where the event
   * loop is gone and async writes never flush. No-op when the persistent
   * connection never reached a writable state.
   */
  releaseSync(): void {
    const handle = (this.persistent as unknown as { _handle?: { fd?: number } })._handle
    const fd = handle?.fd
    if (typeof fd !== 'number') return
    const request = this.buildRequest('pane.release_agent', {})
    try {
      fs.writeSync(fd, `${JSON.stringify(request)}\n`)
    } catch {
      // The pane (or Herdr) is already gone; nothing else to do.
    }
  }

  private send(method: string, extra: Record<string, unknown>): void {
    const request = this.buildRequest(method, extra)
    let attempts = 0
    const trySend = (): void => {
      attempts += 1
      let written = false
      const client = net.createConnection(this.endpoint, () => {
        written = true
        client.write(`${JSON.stringify(request)}\n`)
      })
      const drop = (): void => {
        client.destroy()
      }
      // Retry only a connection that never reached the server (still queued
      // behind Herdr's serial api server when our timeout fired). A request
      // already written is never re-sent: Herdr would apply it twice.
      client.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!written && attempts < MAX_SEND_ATTEMPTS) {
          drop()
          trySend()
        } else {
          drop()
        }
      })
      client.on('error', () => {
        if (!written && attempts < MAX_SEND_ATTEMPTS) {
          trySend()
        } else {
          drop()
        }
      })
      client.on('end', drop)
    }
    trySend()
  }

  private buildRequest(method: string, extra: Record<string, unknown>): HerdrRequest {
    this.seq += 1
    return {
      id: `${this.options.source}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
        .toString()
        .padStart(6, '0')}`,
      method,
      params: {
        pane_id: this.options.paneId,
        source: this.options.source,
        agent: this.options.agent,
        seq: this.seq,
        ...extra,
      },
    }
  }
}
