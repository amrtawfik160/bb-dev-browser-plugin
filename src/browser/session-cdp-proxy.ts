import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/**
 * A filtering Chrome DevTools endpoint for one agent session.
 *
 * The owner and agents share one Chromium. An agent session connects through
 * this proxy instead of the real endpoint, and the proxy only exposes the
 * targets that session owns: pages it created, popups those pages opened, and
 * tabs the host granted explicitly. Every other target, including the owner's
 * tabs, is invisible and unreachable through the proxy, so the owner can keep
 * browsing while an agent runs.
 *
 * Playwright drives Chromium through flattened sessions on the browser socket,
 * so that is the only socket the proxy accepts. Per-page sockets would bypass
 * the session bookkeeping below and are refused.
 */

export type SessionCdpProxy = {
  /** http endpoint to pass to `dev-browser --connect` / connectOverCDP. */
  endpoint: string;
  /** Target ids this session owns right now (pages it created, their popups, explicitly granted tabs). */
  ownedTargetIds(): ReadonlySet<string>;
  /** Grant an existing page target to this session (explicit tabId). */
  grantTarget(targetId: string): void;
  isOwned(targetId: string): boolean;
  close(): Promise<void>;
};

export type StartSessionCdpProxyOptions = {
  /**
   * http://127.0.0.1:<port> of the real browser, or a function that wakes the
   * browser and returns its current endpoint. A function lets one proxy keep
   * a stable address for a whole agent session across browser restarts.
   */
  upstreamEndpoint: string | (() => Promise<string>);
  initialTargetIds?: Iterable<string>;
  host?: string;
  /** Called (at most once a second) while a client sends commands. */
  onActivity?: () => void;
  /**
   * Host paths a client may never hand to the browser (file uploads, drags,
   * and download folders), such as the browser's own profile storage.
   */
  deniedPathPrefixes?: readonly string[];
};

/** Schemes an agent session may open: the web, plus blank and inline pages. */
const NAVIGABLE_SCHEMES = new Set(["http:", "https:", "data:", "blob:"]);

export function navigableUrl(address: string): boolean {
  if (address === "" || address === "about:blank") return true;
  try {
    return NAVIGABLE_SCHEMES.has(new URL(address).protocol);
  } catch {
    return false;
  }
}

/**
 * The browser's HTTP DevTools origin. Chromium's own endpoint is reported as
 * `ws://127.0.0.1:<port>/devtools/browser/<id>`; the proxy reads
 * `/json/*` from the same host and port over HTTP.
 */
export function upstreamHttpOrigin(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  return new URL(url.origin);
}

function pathDenied(path: string, prefixes: readonly string[]) {
  const normalized = path.replace(/\/+$/u, "");
  return prefixes.some((prefix) => {
    const root = prefix.replace(/\/+$/u, "");
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

type CdpParams = Record<string, unknown>;

type CdpMessage = {
  id?: unknown;
  method?: unknown;
  params?: CdpParams;
  result?: CdpParams;
  error?: unknown;
  sessionId?: unknown;
};

type TargetInfo = {
  targetId: string;
  type?: string;
  openerId?: string;
};

type InflightCommand = {
  /** Absent for commands the proxy sends on its own behalf. */
  clientId?: number;
  method: string;
  createsTarget: boolean;
};

// Matches Chromium's own error code for an unknown session or target, so
// clients treat a hidden target the same way as one that does not exist.
const UNAVAILABLE_CODE = -32001;
const SESSION_UNAVAILABLE = "Session is not available in this browser session.";
const TARGET_UNAVAILABLE = "Target is not available in this browser session.";
const COMMAND_UNAVAILABLE = "Command is not available in this browser session.";
const NAVIGATION_UNAVAILABLE =
  "Only web pages can be opened in this browser session.";

// Screenshots and large evaluate results arrive as single CDP frames.
// Playwright's own client accepts 256 MiB, so the proxy must not be smaller.
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

const BROWSER_SOCKET_PATH = /^\/devtools\/browser\/[A-Za-z0-9-]+$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Commands that reach past one session's own targets: other browser contexts,
 * every target at once, the whole browser process, or the host. They are
 * refused without reaching Chromium.
 *
 * Target.attachToBrowserTarget is deliberately not here. Playwright's
 * context.newCDPSession(page) and browser.newBrowserCDPSession() open a
 * second browser-level session with it and attach to pages from there. The
 * proxy polices that session exactly like the browser socket itself.
 */
const DENIED_COMMANDS = new Set([
  "Target.exposeDevToolsProtocol",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.setRemoteLocations",
  // Non-flattened sessions tunnel through the browser socket and would hide
  // their traffic from the session filter.
  "Target.sendMessageToTarget",
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
]);
const DENIED_DOMAINS = ["Tethering.", "SystemInfo."];
/**
 * At browser level these domains observe or intercept every tab, including
 * the owner's: Fetch would see all requests and Tracing records every
 * renderer. Inside an owned page session they only see that page, so they are
 * denied only without a session.
 */
const DENIED_BROWSER_LEVEL_DOMAINS = ["Fetch.", "Tracing."];

/** Commands that name one target and are allowed only for owned targets. */
const TARGET_SCOPED_COMMANDS = new Set([
  "Target.attachToTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.getTargetInfo",
  "Target.autoAttachRelated",
  "Browser.getWindowForTarget",
]);

function isLoopbackHost(hostHeader: string | undefined, host: string) {
  if (hostHeader === undefined) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return (
    hostname === host ||
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]"
  );
}

/**
 * Pages in the same Chromium can reach loopback ports. Chromium protects its
 * own endpoint by rejecting web origins and foreign Host headers (DNS
 * rebinding); the proxy applies the same rule so a page cannot drive it.
 */
function acceptableRequest(request: IncomingMessage, host: string) {
  return (
    request.headers.origin === undefined &&
    isLoopbackHost(request.headers.host, host)
  );
}

function rawText(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function parseMessage(text: string): CdpMessage | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as CdpMessage)
      : null;
  } catch {
    return null;
  }
}

function stringParam(params: CdpParams | undefined, key: string) {
  const value = params?.[key];
  return typeof value === "string" ? value : undefined;
}

function targetInfoOf(params: CdpParams | undefined): TargetInfo | undefined {
  const info = params?.targetInfo;
  if (typeof info !== "object" || info === null) return undefined;
  const record = info as Record<string, unknown>;
  if (typeof record.targetId !== "string") return undefined;
  return {
    targetId: record.targetId,
    type: typeof record.type === "string" ? record.type : undefined,
    openerId:
      typeof record.openerId === "string" && record.openerId.length > 0
        ? record.openerId
        : undefined,
  };
}

function collectFrameIds(tree: unknown, into: Set<string>) {
  if (typeof tree !== "object" || tree === null) return;
  const node = tree as { frame?: { id?: unknown }; childFrames?: unknown };
  if (typeof node.frame?.id === "string") into.add(node.frame.id);
  if (Array.isArray(node.childFrames)) {
    for (const child of node.childFrames) collectFrameIds(child, into);
  }
}

function withoutPageSockets(entry: Record<string, unknown>) {
  const copy = { ...entry };
  delete copy.webSocketDebuggerUrl;
  delete copy.devtoolsFrontendUrl;
  delete copy.devtoolsFrontendUrlCompat;
  return copy;
}

/** Ownership shared by every socket and HTTP request of one session. */
class SessionOwnership {
  /** Page-level targets: created, popups, or granted. */
  readonly pages = new Set<string>();
  /** Iframes and workers attached under an owned page session. */
  readonly children = new Set<string>();
  /**
   * Target creations still waiting for Chromium's reply. Chromium announces
   * a new target before it answers the command that created it, so while one
   * is pending an unknown page cannot be judged yet and is held instead.
   */
  pendingCreations = 0;
  onActivity?: () => void;
  deniedPathPrefixes: readonly string[] = [];
  private lastActivityAt = 0;

  noteActivity() {
    const now = Date.now();
    if (now - this.lastActivityAt < 1_000) return;
    this.lastActivityAt = now;
    this.onActivity?.();
  }
  /**
   * Newer Chromium wraps every page in a "tab" target, created just before
   * the page, while the creating command is still pending. Clients that
   * attach in tab mode (Puppeteer, and so chrome-devtools-mcp) attach to that
   * tab, so it must belong to whoever created the page.
   */
  private readonly tabsDuringCreation: string[] = [];
  readonly connections = new Set<ProxyConnection>();

  owns(targetId: string) {
    return this.pages.has(targetId) || this.children.has(targetId);
  }

  /** Owned targets, or new pages opened by an owned target. */
  claims(info: TargetInfo) {
    if (this.owns(info.targetId)) return true;
    if (info.openerId !== undefined && this.owns(info.openerId)) {
      this.pages.add(info.targetId);
      return true;
    }
    return false;
  }

  forget(targetId: string) {
    this.pages.delete(targetId);
    this.children.delete(targetId);
  }

  creationStarted() {
    this.pendingCreations += 1;
  }

  /** Remember an unclaimed tab target announced during a pending creation. */
  noteTabDuringCreation(info: TargetInfo) {
    if (info.type !== "tab" || this.pendingCreations === 0) return;
    if (this.tabsDuringCreation.includes(info.targetId)) return;
    this.tabsDuringCreation.push(info.targetId);
  }

  creationFinished(targetId: string | undefined) {
    if (targetId !== undefined) {
      this.pages.add(targetId);
      // Creations answer in order, so the oldest unclaimed tab is this page's.
      const tab = this.tabsDuringCreation.shift();
      if (tab !== undefined) this.pages.add(tab);
    }
    this.pendingCreations = Math.max(0, this.pendingCreations - 1);
    if (this.pendingCreations === 0) this.tabsDuringCreation.length = 0;
    for (const connection of this.connections) connection.settleHeld();
  }
}

type HeldTarget = {
  /** Held session id to the browser-level session it arrived on. */
  sessionIds: Map<string, string | undefined>;
  messages: CdpMessage[];
};

/** One downstream client socket paired with its own upstream socket. */
class ProxyConnection {
  private nextUpstreamId = 1;
  private readonly inflight = new Map<number, InflightCommand>();
  /** Owned session id to its parent session id ("" for browser level). */
  private readonly ownedSessions = new Map<string, string>();
  /** Extra browser-level sessions from Target.attachToBrowserTarget. */
  private readonly browserSessions = new Set<string>();
  private readonly held = new Map<string, HeldTarget>();
  private readonly heldSessions = new Map<string, string>();
  private readonly ownedFrames = new Set<string>();
  private readonly ownedDownloads = new Set<string>();
  private readonly ownedWindows = new Set<number>();
  private browserAutoAttach = false;
  private closed = false;

  constructor(
    private readonly ownership: SessionOwnership,
    private readonly upstream: WebSocket,
    private readonly downstream: WebSocket,
  ) {
    ownership.connections.add(this);
    upstream.on("message", (data) => this.onUpstream(rawText(data)));
    downstream.on("message", (data) => this.onDownstream(rawText(data)));
    upstream.on("close", () => this.close());
    downstream.on("close", () => this.close());
    upstream.on("error", () => this.close());
    downstream.on("error", () => this.close());
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ownership.connections.delete(this);
    for (const command of this.inflight.values()) {
      if (command.createsTarget) this.ownership.creationFinished(undefined);
    }
    this.inflight.clear();
    for (const socket of [this.upstream, this.downstream]) {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
    }
  }

  terminate() {
    this.close();
    this.upstream.terminate();
    this.downstream.terminate();
  }

  /** Attach to a newly granted target so a connected client sees it. */
  attachGranted(targetId: string) {
    if (!this.browserAutoAttach) return;
    this.sendInternal("Target.attachToTarget", { targetId, flatten: true });
  }

  /**
   * Re-judge held targets after a creation finished. A held target that is
   * now owned replays its messages in order; once nothing is pending, the
   * rest belong to someone else and are released.
   */
  settleHeld() {
    for (const [targetId, entry] of [...this.held]) {
      if (this.ownership.owns(targetId)) {
        this.held.delete(targetId);
        for (const sessionId of entry.sessionIds.keys()) {
          this.heldSessions.delete(sessionId);
        }
        for (const message of entry.messages) this.onUpstreamMessage(message);
      } else if (this.ownership.pendingCreations === 0) {
        this.held.delete(targetId);
        for (const [sessionId, via] of entry.sessionIds) {
          this.heldSessions.delete(sessionId);
          this.releaseForeign(sessionId, via);
        }
      }
    }
  }

  private toClient(message: CdpMessage) {
    if (this.downstream.readyState === WebSocket.OPEN) {
      this.downstream.send(JSON.stringify(message));
    }
  }

  private sendUpstream(
    method: string,
    params: CdpParams | undefined,
    sessionId: string | undefined,
    command: InflightCommand,
  ) {
    const id = this.nextUpstreamId;
    this.nextUpstreamId += 1;
    this.inflight.set(id, command);
    const message: CdpMessage = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId !== undefined) message.sessionId = sessionId;
    if (this.upstream.readyState === WebSocket.OPEN) {
      this.upstream.send(JSON.stringify(message));
    }
  }

  // Every upstream id comes from one counter and maps back to its origin, so
  // the proxy's own commands can never collide with a client's ids.
  private sendInternal(method: string, params: CdpParams, sessionId?: string) {
    this.sendUpstream(method, params, sessionId, {
      method,
      createsTarget: false,
    });
  }

  /**
   * Browser-level auto-attach attaches to every existing and new page,
   * including the owner's. Those sessions are dropped here: resumed first in
   * case waitForDebuggerOnStart paused a new owner tab, then detached.
   */
  private releaseForeign(sessionId: string, via: string | undefined) {
    this.sendInternal("Runtime.runIfWaitingForDebugger", {}, sessionId);
    // A session is detached through the browser-level session that owns it.
    this.sendInternal("Target.detachFromTarget", { sessionId }, via);
  }

  private reject(id: number, sessionId: string | undefined, message: string) {
    const reply: CdpMessage = {
      id,
      error: { code: UNAVAILABLE_CODE, message },
    };
    if (sessionId !== undefined) reply.sessionId = sessionId;
    this.toClient(reply);
  }

  private commandDenial(
    method: string,
    params: CdpParams | undefined,
    browserLevel: boolean,
  ): string | null {
    // Only web pages: no file:, chrome:, devtools:, or view-source: documents.
    if (method === "Page.navigate" || method === "Target.createTarget") {
      const url = stringParam(params, "url");
      if (url !== undefined && !navigableUrl(url))
        return NAVIGATION_UNAVAILABLE;
    }
    // Never hand the browser's own storage to a page or a download.
    const denied = this.ownership.deniedPathPrefixes;
    if (denied.length > 0) {
      const files = [
        ...(Array.isArray(params?.files) ? params.files : []),
        ...(Array.isArray((params?.data as CdpParams | undefined)?.files)
          ? ((params!.data as CdpParams).files as unknown[])
          : []),
        params?.downloadPath,
      ].filter((value): value is string => typeof value === "string");
      if (files.some((path) => pathDenied(path, denied))) {
        return COMMAND_UNAVAILABLE;
      }
    }
    if (
      DENIED_COMMANDS.has(method) ||
      DENIED_DOMAINS.some((domain) => method.startsWith(domain))
    ) {
      return COMMAND_UNAVAILABLE;
    }
    if (
      browserLevel &&
      DENIED_BROWSER_LEVEL_DOMAINS.some((domain) => method.startsWith(domain))
    ) {
      return COMMAND_UNAVAILABLE;
    }
    if (TARGET_SCOPED_COMMANDS.has(method)) {
      const targetId = stringParam(params, "targetId");
      if (targetId === undefined) {
        // Without a target id these commands describe the caller's own
        // session, or the browser itself for getTargetInfo.
        if (browserLevel && method !== "Target.getTargetInfo") {
          return TARGET_UNAVAILABLE;
        }
      } else if (!this.ownership.owns(targetId)) {
        return TARGET_UNAVAILABLE;
      }
      if (method === "Target.attachToTarget" && params?.flatten !== true) {
        return COMMAND_UNAVAILABLE;
      }
    }
    if (method === "Target.detachFromTarget") {
      const detachSession = stringParam(params, "sessionId");
      const targetId = stringParam(params, "targetId");
      if (
        detachSession !== undefined &&
        !this.ownedSessions.has(detachSession) &&
        !this.browserSessions.has(detachSession)
      ) {
        return SESSION_UNAVAILABLE;
      }
      if (targetId !== undefined && !this.ownership.owns(targetId)) {
        return TARGET_UNAVAILABLE;
      }
      if (detachSession === undefined && targetId === undefined) {
        return TARGET_UNAVAILABLE;
      }
    }
    if (
      method === "Target.setAutoAttach" &&
      params?.autoAttach === true &&
      params.flatten !== true
    ) {
      return COMMAND_UNAVAILABLE;
    }
    if (
      method === "Browser.getWindowBounds" ||
      method === "Browser.setWindowBounds"
    ) {
      // Window ids are small integers. Only windows learned through an
      // owned target's getWindowForTarget may be read or resized.
      const windowId = params?.windowId;
      if (typeof windowId !== "number" || !this.ownedWindows.has(windowId)) {
        return TARGET_UNAVAILABLE;
      }
    }
    return null;
  }

  private onDownstream(text: string) {
    const message = parseMessage(text);
    if (
      message === null ||
      typeof message.id !== "number" ||
      typeof message.method !== "string"
    ) {
      // Not a CDP command. Chromium closes the socket on malformed input.
      this.close();
      return;
    }
    const { id, method, params } = message;
    this.ownership.noteActivity();
    const sessionId =
      typeof message.sessionId === "string" ? message.sessionId : undefined;
    const browserLevel =
      sessionId === undefined || this.browserSessions.has(sessionId);
    if (!browserLevel && !this.ownedSessions.has(sessionId)) {
      this.reject(id, sessionId, SESSION_UNAVAILABLE);
      return;
    }
    const denial = this.commandDenial(method, params, browserLevel);
    if (denial !== null) {
      this.reject(id, sessionId, denial);
      return;
    }
    if (method === "Target.setAutoAttach" && sessionId === undefined) {
      this.browserAutoAttach = params?.autoAttach === true;
    }
    const createsTarget = method === "Target.createTarget";
    if (createsTarget) this.ownership.creationStarted();
    this.sendUpstream(method, params, sessionId, {
      clientId: id,
      method,
      createsTarget,
    });
  }

  private onUpstream(text: string) {
    const message = parseMessage(text);
    if (message === null) return;
    this.onUpstreamMessage(message);
  }

  private onUpstreamMessage(message: CdpMessage) {
    if (typeof message.id === "number") {
      this.onResponse(message.id, message);
      return;
    }
    if (typeof message.method !== "string") return;
    const sessionId =
      typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (sessionId !== undefined) {
      const heldTarget = this.heldSessions.get(sessionId);
      if (heldTarget !== undefined) {
        this.held.get(heldTarget)?.messages.push(message);
        return;
      }
      if (this.browserSessions.has(sessionId)) {
        this.onBrowserLevelEvent(message, message.method, sessionId);
        return;
      }
      // Anything else is a released foreign session or unknown: drop it.
      if (!this.ownedSessions.has(sessionId)) return;
      if (message.method.startsWith("Target.")) {
        this.onPageTargetEvent(message, message.method, sessionId);
        return;
      }
      this.trackOwnedFrames(message.method, message.params);
      this.toClient(message);
      return;
    }
    this.onBrowserLevelEvent(message, message.method, undefined);
  }

  private trackOwnedFrames(method: string, params: CdpParams | undefined) {
    if (method === "Page.frameAttached") {
      const frameId = stringParam(params, "frameId");
      if (frameId !== undefined) this.ownedFrames.add(frameId);
    } else if (method === "Page.frameNavigated") {
      const frame = params?.frame as { id?: unknown } | undefined;
      if (typeof frame?.id === "string") this.ownedFrames.add(frame.id);
    }
  }

  private onBrowserLevelEvent(
    message: CdpMessage,
    method: string,
    via: string | undefined,
  ) {
    if (method.startsWith("Target.")) {
      this.onTargetEvent(message, method, via);
      return;
    }
    // Downloads are reported once at browser level for every tab. A main
    // frame id equals its target id; subframe ids are learned from owned
    // page sessions.
    if (method === "Browser.downloadWillBegin") {
      const frameId = stringParam(message.params, "frameId");
      const guid = stringParam(message.params, "guid");
      if (
        frameId === undefined ||
        guid === undefined ||
        !(this.ownership.owns(frameId) || this.ownedFrames.has(frameId))
      ) {
        return;
      }
      this.ownedDownloads.add(guid);
      this.toClient(message);
      return;
    }
    if (method === "Browser.downloadProgress") {
      const guid = stringParam(message.params, "guid");
      if (guid === undefined || !this.ownedDownloads.has(guid)) return;
      const state = stringParam(message.params, "state");
      if (state === "completed" || state === "canceled") {
        this.ownedDownloads.delete(guid);
      }
      this.toClient(message);
      return;
    }
    this.toClient(message);
  }

  private hold(
    targetId: string,
    message: CdpMessage,
    session?: { id: string; via: string | undefined },
  ) {
    let entry = this.held.get(targetId);
    if (entry === undefined) {
      entry = { sessionIds: new Map(), messages: [] };
      this.held.set(targetId, entry);
    }
    entry.messages.push(message);
    if (session !== undefined) {
      entry.sessionIds.set(session.id, session.via);
      this.heldSessions.set(session.id, targetId);
    }
  }

  /** Target events inside an owned page session: its iframes and workers. */
  private onPageTargetEvent(
    message: CdpMessage,
    method: string,
    pageSession: string,
  ) {
    const params = message.params;
    if (method === "Target.attachedToTarget") {
      const childSession = stringParam(params, "sessionId");
      const info = targetInfoOf(params);
      if (childSession === undefined || info === undefined) return;
      // Iframes and workers under an owned page belong to its owner.
      if (!this.ownership.pages.has(info.targetId)) {
        this.ownership.children.add(info.targetId);
      }
      this.ownedSessions.set(childSession, pageSession);
      this.toClient(message);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const childSession = stringParam(params, "sessionId");
      if (childSession !== undefined) this.dropSessionTree(childSession);
    }
    if (method === "Target.receivedMessageFromTarget") return;
    this.toClient(message);
  }

  /**
   * Target events on the browser socket or on an extra browser-level session
   * (`via`). These describe every target in Chromium, so only owned ones pass.
   */
  private onTargetEvent(
    message: CdpMessage,
    method: string,
    via: string | undefined,
  ) {
    const params = message.params;
    switch (method) {
      case "Target.attachedToTarget": {
        const childSession = stringParam(params, "sessionId");
        const info = targetInfoOf(params);
        if (childSession === undefined || info === undefined) return;
        if (info.type === "browser") {
          // Announced only for Target.attachToBrowserTarget. The new session
          // is browser level and is policed like the browser socket.
          this.browserSessions.add(childSession);
          this.toClient(message);
          return;
        }
        if (this.ownership.claims(info)) {
          this.ownedSessions.set(childSession, via ?? "");
          this.toClient(message);
          return;
        }
        if (this.ownership.pendingCreations > 0) {
          this.ownership.noteTabDuringCreation(info);
          this.hold(info.targetId, message, { id: childSession, via });
          return;
        }
        this.releaseForeign(childSession, via);
        return;
      }
      case "Target.detachedFromTarget": {
        const childSession = stringParam(params, "sessionId");
        if (childSession === undefined) return;
        const heldTarget = this.heldSessions.get(childSession);
        if (heldTarget !== undefined) {
          // Keep the order: a held page that turns out to be owned must
          // replay its detach after its attach.
          this.held.get(heldTarget)?.messages.push(message);
          return;
        }
        if (this.browserSessions.delete(childSession)) {
          this.dropSessionTree(childSession);
          this.toClient(message);
          return;
        }
        if (!this.ownedSessions.has(childSession)) return;
        this.dropSessionTree(childSession);
        this.toClient(message);
        return;
      }
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const info = targetInfoOf(params);
        if (info === undefined) return;
        if (this.ownership.claims(info)) {
          this.toClient(message);
        } else if (this.ownership.pendingCreations > 0) {
          this.ownership.noteTabDuringCreation(info);
          this.hold(info.targetId, message);
        }
        return;
      }
      case "Target.targetDestroyed":
      case "Target.targetCrashed": {
        const targetId = stringParam(params, "targetId");
        if (targetId === undefined) return;
        if (this.held.has(targetId)) {
          this.hold(targetId, message);
          return;
        }
        if (!this.ownership.owns(targetId)) return;
        if (method === "Target.targetDestroyed") {
          this.ownership.forget(targetId);
        }
        this.toClient(message);
        return;
      }
      default:
        // Includes Target.receivedMessageFromTarget, which only carries
        // non-flattened traffic that the proxy never allows.
        return;
    }
  }

  private dropSessionTree(sessionId: string) {
    this.ownedSessions.delete(sessionId);
    for (const [child, parent] of [...this.ownedSessions]) {
      if (parent === sessionId) this.dropSessionTree(child);
    }
  }

  private onResponse(upstreamId: number, message: CdpMessage) {
    const command = this.inflight.get(upstreamId);
    if (command === undefined) return;
    this.inflight.delete(upstreamId);
    const result = message.result;
    if (command.createsTarget) {
      const targetId = stringParam(result, "targetId");
      this.ownership.creationFinished(targetId);
    }
    if (command.clientId === undefined) return;
    if (result !== undefined) {
      if (
        command.method === "Target.getTargets" &&
        Array.isArray(result.targetInfos)
      ) {
        result.targetInfos = result.targetInfos.filter((entry: unknown) => {
          const info = targetInfoOf({ targetInfo: entry });
          return info !== undefined && this.ownership.owns(info.targetId);
        });
      } else if (
        command.method === "Browser.getWindowForTarget" &&
        typeof result.windowId === "number"
      ) {
        this.ownedWindows.add(result.windowId);
      } else if (command.method === "Page.getFrameTree") {
        collectFrameIds(result.frameTree, this.ownedFrames);
      }
    }
    this.toClient({ ...message, id: command.clientId });
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function listen(server: Server, bindHost: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The session CDP proxy did not bind TCP."));
        return;
      }
      resolve(address.port);
    });
  });
}

function respondJson(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=UTF-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function notFound(response: ServerResponse) {
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
}

function refuseUpgrade(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

export async function startSessionCdpProxy(
  options: StartSessionCdpProxyOptions,
): Promise<SessionCdpProxy> {
  const host = options.host ?? "127.0.0.1";
  // The endpoint grants browser control without credentials, exactly like
  // Chromium's own debugging port, so it must never leave the machine.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("The session CDP proxy only binds to loopback.");
  }
  const resolveUpstream = async () =>
    upstreamHttpOrigin(
      typeof options.upstreamEndpoint === "string"
        ? options.upstreamEndpoint
        : await options.upstreamEndpoint(),
    );
  const ownership = new SessionOwnership();
  ownership.onActivity = options.onActivity;
  ownership.deniedPathPrefixes = options.deniedPathPrefixes ?? [];
  for (const targetId of options.initialTargetIds ?? []) {
    ownership.pages.add(targetId);
  }

  let port = 0;
  const ownSocketUrl = (path: string) => `ws://${host}:${port}${path}`;

  const fetchUpstream = async (path: string, method = "GET") => {
    ownership.noteActivity();
    const response = await fetch(new URL(path, await resolveUpstream()), {
      method,
    });
    return { status: response.status, text: await response.text() };
  };

  const handleHttp = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (!acceptableRequest(request, host)) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Forbidden");
      return;
    }
    const url = new URL(request.url ?? "/", "http://proxy.invalid");
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    const method = request.method ?? "GET";

    if (path === "/json/version" && method === "GET") {
      const upstream = await fetchUpstream("/json/version");
      if (upstream.status !== 200) return notFound(response);
      const body = JSON.parse(upstream.text) as Record<string, unknown>;
      const browserUrl = body.webSocketDebuggerUrl;
      if (typeof browserUrl !== "string") return notFound(response);
      body.webSocketDebuggerUrl = ownSocketUrl(new URL(browserUrl).pathname);
      return respondJson(response, 200, body);
    }
    if ((path === "/json/list" || path === "/json") && method === "GET") {
      const upstream = await fetchUpstream("/json/list");
      if (upstream.status !== 200) return notFound(response);
      const entries = JSON.parse(upstream.text) as unknown;
      const visible = Array.isArray(entries)
        ? entries.flatMap((entry: unknown) => {
            if (typeof entry !== "object" || entry === null) return [];
            const record = entry as Record<string, unknown>;
            return typeof record.id === "string" && ownership.owns(record.id)
              ? [withoutPageSockets(record)]
              : [];
          })
        : [];
      return respondJson(response, 200, visible);
    }
    if (path === "/json/new" && (method === "PUT" || method === "GET")) {
      const requested = decodeURIComponent(url.search.replace(/^\?/u, ""));
      if (requested.length > 0 && !navigableUrl(requested)) {
        return notFound(response);
      }
      // Chromium decides whether GET is still accepted; the proxy forwards
      // the client's method so it never weakens that check.
      ownership.creationStarted();
      let createdId: string | undefined;
      try {
        const upstream = await fetchUpstream(`/json/new${url.search}`, method);
        if (upstream.status !== 200) {
          response.writeHead(upstream.status, { "content-type": "text/plain" });
          response.end(upstream.text);
          return;
        }
        const body = JSON.parse(upstream.text) as Record<string, unknown>;
        if (typeof body.id === "string") createdId = body.id;
        return respondJson(response, 200, withoutPageSockets(body));
      } finally {
        ownership.creationFinished(createdId);
      }
    }
    const targetAction = /^\/json\/(activate|close)\/([^/]+)$/u.exec(path);
    if (targetAction !== null && method === "GET") {
      const [, action, targetId] = targetAction;
      if (
        targetId === undefined ||
        !TARGET_ID_PATTERN.test(targetId) ||
        !ownership.owns(targetId)
      ) {
        return notFound(response);
      }
      const upstream = await fetchUpstream(`/json/${action}/${targetId}`);
      response.writeHead(upstream.status, { "content-type": "text/plain" });
      response.end(upstream.text);
      return;
    }
    notFound(response);
  };

  const server = createServer((request, response) => {
    handleHttp(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" });
      }
      response.end("Browser is not available.");
    });
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
  const pendingUpstreams = new Set<WebSocket>();

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
    socket.on("error", () => socket.destroy());
    const path = new URL(request.url ?? "/", "http://proxy.invalid").pathname;
    if (!acceptableRequest(request, host)) {
      refuseUpgrade(socket, "403 Forbidden");
      return;
    }
    if (!BROWSER_SOCKET_PATH.test(path)) {
      // Per-page sockets skip the flattened session filter; refuse them.
      refuseUpgrade(socket, "404 Not Found");
      return;
    }
    void connectUpstream(request, socket, head);
  });

  /**
   * Connect to the browser's current endpoint, waking it if it slept. The
   * client's browser id is ignored: a restarted browser has a new one, and
   * the session's address must keep working across restarts.
   */
  const connectUpstream = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    let target: string;
    try {
      const version = await fetchUpstream("/json/version");
      const body = JSON.parse(version.text) as {
        webSocketDebuggerUrl?: unknown;
      };
      if (typeof body.webSocketDebuggerUrl !== "string")
        throw new Error("no browser");
      target = body.webSocketDebuggerUrl;
    } catch {
      refuseUpgrade(socket, "502 Bad Gateway");
      return;
    }
    const upstream = new WebSocket(target, {
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    pendingUpstreams.add(upstream);
    const fail = () => {
      pendingUpstreams.delete(upstream);
      upstream.terminate();
      refuseUpgrade(socket, "502 Bad Gateway");
    };
    upstream.once("error", fail);
    upstream.once("unexpected-response", fail);
    upstream.once("open", () => {
      pendingUpstreams.delete(upstream);
      upstream.off("error", fail);
      upstream.off("unexpected-response", fail);
      if (socket.destroyed) {
        upstream.close();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (downstream) => {
        new ProxyConnection(ownership, upstream, downstream);
      });
    });
  };

  port = await listen(server, host);
  let closing: Promise<void> | undefined;

  return {
    endpoint: `http://${host}:${port}`,
    ownedTargetIds: () => new Set(ownership.pages),
    grantTarget(targetId) {
      if (ownership.pages.has(targetId)) return;
      ownership.pages.add(targetId);
      for (const connection of ownership.connections) {
        connection.attachGranted(targetId);
      }
    },
    isOwned: (targetId) => ownership.pages.has(targetId),
    close() {
      closing ??= (async () => {
        for (const upstream of pendingUpstreams) upstream.terminate();
        for (const connection of [...ownership.connections]) {
          connection.terminate();
        }
        sockets.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}
