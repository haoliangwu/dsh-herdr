// src/reporter.ts
import fs from "node:fs";
import net from "node:net";
var REQUEST_TIMEOUT_MS = 3000;
var MAX_SEND_ATTEMPTS = 3;

class HerdrReporter {
  options;
  seq = 0;
  endpoint;
  persistent;
  constructor(options) {
    this.options = options;
    this.endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${options.socketPath}` : options.socketPath;
    this.persistent = net.createConnection(this.endpoint);
    this.persistent.on("error", () => {
      this.persistent.destroy();
    });
  }
  report(state, message, sessionId) {
    const params = { state };
    if (message !== undefined)
      params.message = message;
    if (sessionId !== undefined)
      params.agent_session_id = sessionId;
    this.send("pane.report_agent", params);
  }
  release() {
    this.send("pane.release_agent", {});
  }
  releaseSync() {
    const handle = this.persistent._handle;
    const fd = handle?.fd;
    if (typeof fd !== "number")
      return;
    const request = this.buildRequest("pane.release_agent", {});
    try {
      fs.writeSync(fd, `${JSON.stringify(request)}
`);
    } catch {}
  }
  send(method, extra) {
    const request = this.buildRequest(method, extra);
    let attempts = 0;
    const trySend = () => {
      attempts += 1;
      let written = false;
      const client = net.createConnection(this.endpoint, () => {
        written = true;
        client.write(`${JSON.stringify(request)}
`);
      });
      const drop = () => {
        client.destroy();
      };
      client.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!written && attempts < MAX_SEND_ATTEMPTS) {
          drop();
          trySend();
        } else {
          drop();
        }
      });
      client.on("error", () => {
        if (!written && attempts < MAX_SEND_ATTEMPTS) {
          trySend();
        } else {
          drop();
        }
      });
      client.on("end", drop);
    };
    trySend();
  }
  buildRequest(method, extra) {
    this.seq += 1;
    return {
      id: `${this.options.source}:${Date.now()}:${Math.floor(Math.random() * 1e6).toString().padStart(6, "0")}`,
      method,
      params: {
        pane_id: this.options.paneId,
        source: this.options.source,
        agent: this.options.agent,
        seq: this.seq,
        ...extra
      }
    };
  }
}

// src/index.ts
var name = "herdr-reporter";
var SOURCE = "custom:dsh";
var AGENT = "dsh";
function apply(ctx, _config = {}) {
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath) {
    ctx.logger?.debug?.("dsh-herdr: not inside a Herdr pane; integration is a no-op");
    return;
  }
  const reporter = new HerdrReporter({ paneId, socketPath, source: SOURCE, agent: AGENT });
  reporter.report("idle");
  let reported;
  const report = (state, message) => {
    reporter.report(state, message, reported?.session.id);
  };
  const isRoot = (agent) => {
    try {
      return ctx.agents.roots().includes(agent);
    } catch {
      return true;
    }
  };
  const onCreated = (agent) => {
    if (reported !== undefined || !isRoot(agent))
      return;
    reported = agent;
    report(agent.status === "running" ? "working" : "idle");
  };
  const onDisposed = (agent) => {
    if (agent !== reported)
      return;
    reported = undefined;
    report("idle");
  };
  const onStatus = (agent, status) => {
    if (agent !== reported)
      return;
    report(status === "running" ? "working" : "idle");
  };
  const onSessionEvent = (session, event) => {
    if (reported === undefined || session !== reported.session)
      return;
    if (event.type === "approval/asked") {
      report("blocked", event.data.reason ?? `waiting for approval: ${event.data.toolName}`);
    } else if (event.type === "approval/decided") {
      report(reported.status === "running" ? "working" : "idle");
    }
  };
  ctx.on("agent/created", ({ agent }) => {
    onCreated(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    onDisposed(agent);
  });
  ctx.on("agent/status", ({ agent, status }) => {
    onStatus(agent, status);
  });
  ctx.on("session/event", onSessionEvent);
  const sweep = () => {
    try {
      for (const agent of ctx.agents.roots())
        onCreated(agent);
    } catch {}
  };
  const timer = setTimeout(sweep, 0);
  ctx.effect(() => () => {
    clearTimeout(timer);
  });
  process.once("beforeExit", () => {
    reporter.release();
  });
  process.once("exit", () => {
    reporter.releaseSync();
  });
}
export {
  name,
  apply
};
