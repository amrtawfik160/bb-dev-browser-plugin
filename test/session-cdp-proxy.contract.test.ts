import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  startSessionCdpProxy,
  type SessionCdpProxy,
} from "../src/browser/session-cdp-proxy.js";

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
};

const BROWSER_PATH = "/devtools/browser/fake-browser-id";
const AGENT = "AGENT-PAGE";
const OWNER = "OWNER-PAGE";

function pageInfo(targetId: string, extra: Record<string, unknown> = {}) {
  return {
    targetId,
    type: "page",
    title: targetId,
    url: "about:blank",
    attached: false,
    browserContextId: "DEFAULT",
    ...extra,
  };
}

/**
 * A fake Chromium: the HTTP discovery endpoints plus one browser socket. Tests
 * decide how it answers each command and push events at will.
 */
async function startFakeBrowser() {
  const received: CdpMessage[] = [];
  let socket: WebSocket | undefined;
  let nextNewTarget = 1;
  const state = {
    onCommand: (message: CdpMessage, send: (reply: CdpMessage) => void) => {
      send({ id: message.id, result: {}, sessionId: message.sessionId });
    },
  };
  const http: Server = createServer((request, response) => {
    const address = http.address();
    const port =
      address !== null && typeof address !== "string" ? address.port : 0;
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const page = (id: string) => ({
      id,
      type: "page",
      title: id,
      url: "about:blank",
      devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${id}`,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}`,
    });
    response.setHeader("content-type", "application/json");
    if (path === "/json/version" || path === "/json/version/") {
      response.end(
        JSON.stringify({
          Browser: "Chrome/145.0.0.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}${BROWSER_PATH}`,
        }),
      );
    } else if (path === "/json/list") {
      response.end(JSON.stringify([page(AGENT), page(OWNER)]));
    } else if (path === "/json/new" && request.method === "PUT") {
      response.end(JSON.stringify(page(`NEW-${nextNewTarget++}`)));
    } else if (path.startsWith("/json/activate/")) {
      response.end("Target activated");
    } else {
      response.statusCode = 404;
      response.end("missing");
    }
  });
  const wss = new WebSocketServer({ server: http, path: BROWSER_PATH });
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as CdpMessage;
      received.push(message);
      state.onCommand(message, (reply) => ws.send(JSON.stringify(reply)));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    received,
    state,
    emit(message: CdpMessage) {
      socket?.send(JSON.stringify(message));
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

type FakeBrowser = Awaited<ReturnType<typeof startFakeBrowser>>;

async function connectClient(proxy: SessionCdpProxy) {
  const version = (await (
    await fetch(`${proxy.endpoint}/json/version`)
  ).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const messages: CdpMessage[] = [];
  socket.on("message", (data) =>
    messages.push(JSON.parse(String(data)) as CdpMessage),
  );
  let nextId = 1;
  const send = async (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params, sessionId }));
    await vi.waitFor(() =>
      expect(messages.some((message) => message.id === id)).toBe(true),
    );
    return messages.find((message) => message.id === id)!;
  };
  return {
    socket,
    messages,
    send,
    events: () => messages.filter((message) => message.id === undefined),
  };
}

let fake: FakeBrowser | undefined;
let proxy: SessionCdpProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  await fake?.close();
  proxy = undefined;
  fake = undefined;
});

async function setup(initialTargetIds: string[] = [AGENT]) {
  fake = await startFakeBrowser();
  proxy = await startSessionCdpProxy({
    upstreamEndpoint: fake.endpoint,
    initialTargetIds,
  });
  return { fake, proxy };
}

function upstreamMethods(browser: FakeBrowser) {
  return browser.received.map((message) => message.method);
}

describe("session CDP proxy", () => {
  it("rewrites the browser socket URL to the proxy", async () => {
    const { proxy } = await setup();
    const port = new URL(proxy.endpoint).port;
    for (const path of ["/json/version", "/json/version/"]) {
      const body = (await (await fetch(`${proxy.endpoint}${path}`)).json()) as {
        Browser: string;
        webSocketDebuggerUrl: string;
      };
      expect(body.Browser).toBe("Chrome/145.0.0.0");
      expect(body.webSocketDebuggerUrl).toBe(
        `ws://127.0.0.1:${port}${BROWSER_PATH}`,
      );
    }
  });

  it("lists only owned targets and hides their page sockets", async () => {
    const { proxy } = await setup();
    for (const path of ["/json/list", "/json"]) {
      const list = (await (
        await fetch(`${proxy.endpoint}${path}`)
      ).json()) as Record<string, unknown>[];
      expect(list.map((entry) => entry.id)).toEqual([AGENT]);
      expect(list[0]).not.toHaveProperty("webSocketDebuggerUrl");
      expect(list[0]).not.toHaveProperty("devtoolsFrontendUrl");
    }
    expect(
      (await fetch(`${proxy.endpoint}/json/activate/${OWNER}`)).status,
    ).toBe(404);
    expect((await fetch(`${proxy.endpoint}/json/close/${OWNER}`)).status).toBe(
      404,
    );
    expect(
      (await fetch(`${proxy.endpoint}/json/activate/${AGENT}`)).status,
    ).toBe(200);
    expect((await fetch(`${proxy.endpoint}/json/protocol`)).status).toBe(404);
  });

  it("owns a tab opened through /json/new", async () => {
    const { proxy } = await setup([]);
    const response = await fetch(`${proxy.endpoint}/json/new?about:blank`, {
      method: "PUT",
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe("NEW-1");
    expect(body).not.toHaveProperty("webSocketDebuggerUrl");
    expect(proxy.isOwned("NEW-1")).toBe(true);
  });

  it("refuses per-page sockets and requests from web pages", async () => {
    const { proxy } = await setup();
    const port = new URL(proxy.endpoint).port;
    const pageSocket = new WebSocket(
      `ws://127.0.0.1:${port}/devtools/page/${AGENT}`,
    );
    const status = await new Promise<number | undefined>((resolve) => {
      pageSocket.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode),
      );
      pageSocket.once("open", () => resolve(undefined));
      pageSocket.once("error", () => resolve(-1));
    });
    expect(status).toBe(404);
    expect(
      (
        await fetch(`${proxy.endpoint}/json/list`, {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
  });

  it("denies attaching to a target the session does not own", async () => {
    const { fake, proxy } = await setup();
    const client = await connectClient(proxy);
    const reply = await client.send("Target.attachToTarget", {
      targetId: OWNER,
      flatten: true,
    });
    expect(reply.error).toEqual({
      code: -32001,
      message: "Target is not available in this browser session.",
    });
    for (const method of [
      "Target.activateTarget",
      "Target.closeTarget",
      "Target.getTargetInfo",
      "Browser.getWindowForTarget",
      "Target.detachFromTarget",
    ]) {
      expect((await client.send(method, { targetId: OWNER })).error?.code).toBe(
        -32001,
      );
    }
    expect(upstreamMethods(fake)).toEqual([]);
  });

  it("denies browser-wide commands without forwarding them", async () => {
    const { fake, proxy } = await setup();
    const client = await connectClient(proxy);
    for (const method of [
      "Browser.close",
      "Browser.crash",
      "Target.createBrowserContext",
      "Target.exposeDevToolsProtocol",
      "SystemInfo.getProcessInfo",
      "Fetch.enable",
      "Tracing.start",
    ]) {
      expect((await client.send(method)).error?.code).toBe(-32001);
    }
    expect(upstreamMethods(fake)).toEqual([]);
    const version = await client.send("Browser.getVersion");
    expect(version.result).toEqual({});
    expect(upstreamMethods(fake)).toEqual(["Browser.getVersion"]);
  });

  it("detaches auto-attached foreign tabs before they reach the client", async () => {
    const { fake, proxy } = await setup();
    fake.state.onCommand = (message, send) => {
      send({ id: message.id, result: {}, sessionId: message.sessionId });
      if (message.method === "Target.setAutoAttach") {
        fake.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "S-OWNER",
            targetInfo: pageInfo(OWNER),
            waitingForDebugger: true,
          },
        });
        fake.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "S-AGENT",
            targetInfo: pageInfo(AGENT),
            waitingForDebugger: false,
          },
        });
      }
    };
    const client = await connectClient(proxy);
    await client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await vi.waitFor(() =>
      expect(
        fake.received.find(
          (message) => message.method === "Target.detachFromTarget",
        ),
      ).toBeDefined(),
    );
    const resume = fake.received.find(
      (message) => message.method === "Runtime.runIfWaitingForDebugger",
    );
    const detach = fake.received.find(
      (message) => message.method === "Target.detachFromTarget",
    );
    expect(resume?.sessionId).toBe("S-OWNER");
    expect(detach?.params).toEqual({ sessionId: "S-OWNER" });
    expect(fake.received.indexOf(resume!)).toBeLessThan(
      fake.received.indexOf(detach!),
    );

    // Owner session traffic is dropped in both directions.
    fake.emit({
      method: "Page.frameNavigated",
      sessionId: "S-OWNER",
      params: { frame: { id: OWNER, url: "https://owner.example/" } },
    });
    const sent = fake.received.length;
    const denied = await client.send("Runtime.evaluate", {}, "S-OWNER");
    expect(denied).toEqual({
      id: denied.id,
      sessionId: "S-OWNER",
      error: {
        code: -32001,
        message: "Session is not available in this browser session.",
      },
    });
    expect(fake.received).toHaveLength(sent);
    const owned = await client.send("Runtime.evaluate", {}, "S-AGENT");
    expect(owned.result).toEqual({});

    const events = client.events();
    expect(events.map((event) => event.params?.sessionId)).toEqual(["S-AGENT"]);
    expect(JSON.stringify(client.messages)).not.toContain(OWNER);
    // Only the client's own command ids come back, never the proxy's.
    expect(
      client.messages
        .filter((message) => message.id !== undefined)
        .map((message) => message.id),
    ).toEqual([1, 2, 3]);
  });

  it("owns a target created by the client even though Chromium announces it first", async () => {
    const { fake, proxy } = await setup([]);
    fake.state.onCommand = (message, send) => {
      if (message.method !== "Target.createTarget") {
        send({ id: message.id, result: {}, sessionId: message.sessionId });
        return;
      }
      // Chromium attaches the new page, and here an owner tab opened at the
      // same moment, before it answers createTarget.
      fake.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "S-NEW",
          targetInfo: pageInfo("CREATED"),
          waitingForDebugger: true,
        },
      });
      fake.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "S-OWNER-NEW",
          targetInfo: pageInfo("OWNER-NEW"),
          waitingForDebugger: true,
        },
      });
      fake.emit({
        method: "Runtime.executionContextCreated",
        sessionId: "S-NEW",
        params: {},
      });
      send({ id: message.id, result: { targetId: "CREATED" } });
    };
    const client = await connectClient(proxy);
    await client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const created = await client.send("Target.createTarget", {
      url: "about:blank",
    });
    expect(created.result).toEqual({ targetId: "CREATED" });
    expect(proxy.isOwned("CREATED")).toBe(true);
    expect(proxy.isOwned("OWNER-NEW")).toBe(false);
    expect([...proxy.ownedTargetIds()]).toEqual(["CREATED"]);

    const order = client.messages.map(
      (message) => message.method ?? `reply:${message.id}`,
    );
    expect(order).toEqual([
      "reply:1",
      "Target.attachedToTarget",
      "Runtime.executionContextCreated",
      `reply:${created.id}`,
    ]);
    await vi.waitFor(() =>
      expect(
        fake.received.find(
          (message) =>
            message.method === "Target.detachFromTarget" &&
            message.params?.sessionId === "S-OWNER-NEW",
        ),
      ).toBeDefined(),
    );
    expect((await client.send("Page.enable", {}, "S-NEW")).result).toEqual({});
  });

  it("owns popups opened by an owned page", async () => {
    const { fake, proxy } = await setup();
    const client = await connectClient(proxy);
    await client.send("Target.setDiscoverTargets", { discover: true });
    fake.emit({
      method: "Target.targetCreated",
      params: { targetInfo: pageInfo("POPUP", { openerId: AGENT }) },
    });
    fake.emit({
      method: "Target.targetCreated",
      params: { targetInfo: pageInfo("OWNER-POPUP", { openerId: OWNER }) },
    });
    fake.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "S-POPUP",
        targetInfo: pageInfo("POPUP", { openerId: AGENT }),
        waitingForDebugger: true,
      },
    });
    await vi.waitFor(() => expect(client.events()).toHaveLength(2));
    expect(client.events().map((event) => event.method)).toEqual([
      "Target.targetCreated",
      "Target.attachedToTarget",
    ]);
    expect(proxy.isOwned("POPUP")).toBe(true);
    expect(proxy.isOwned("OWNER-POPUP")).toBe(false);
    expect((await client.send("Page.enable", {}, "S-POPUP")).result).toEqual(
      {},
    );

    fake.emit({
      method: "Target.targetDestroyed",
      params: { targetId: "POPUP" },
    });
    await vi.waitFor(() => expect(client.events()).toHaveLength(3));
    expect(proxy.isOwned("POPUP")).toBe(false);
  });

  it("filters Target.getTargets to owned targets", async () => {
    const { fake, proxy } = await setup();
    fake.state.onCommand = (message, send) =>
      send({
        id: message.id,
        result: { targetInfos: [pageInfo(AGENT), pageInfo(OWNER)] },
      });
    const client = await connectClient(proxy);
    const reply = await client.send("Target.getTargets");
    expect(reply.result).toEqual({ targetInfos: [pageInfo(AGENT)] });
  });

  it("attaches a granted tab for a client that is already connected", async () => {
    const { fake, proxy } = await setup([]);
    fake.state.onCommand = (message, send) => {
      send({ id: message.id, result: {}, sessionId: message.sessionId });
      if (message.method === "Target.attachToTarget") {
        fake.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "S-GRANTED",
            targetInfo: pageInfo(OWNER),
            waitingForDebugger: false,
          },
        });
      }
    };
    const client = await connectClient(proxy);
    await client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    proxy.grantTarget(OWNER);
    expect(proxy.isOwned(OWNER)).toBe(true);
    await vi.waitFor(() =>
      expect(client.events().map((event) => event.method)).toEqual([
        "Target.attachedToTarget",
      ]),
    );
    expect(
      client.messages.filter((message) => message.id !== undefined),
    ).toHaveLength(1);
  });

  it("polices an extra browser-level session like the browser socket", async () => {
    // Playwright's context.newCDPSession(page) attaches to the page through a
    // second browser-level session opened with Target.attachToBrowserTarget.
    const { fake, proxy } = await setup();
    fake.state.onCommand = (message, send) => {
      if (message.method === "Target.attachToBrowserTarget") {
        fake.emit({
          method: "Target.attachedToTarget",
          params: {
            sessionId: "S-BROWSER",
            targetInfo: { targetId: "BROWSER", type: "browser" },
            waitingForDebugger: false,
          },
        });
        send({ id: message.id, result: { sessionId: "S-BROWSER" } });
        return;
      }
      send({ id: message.id, result: {}, sessionId: message.sessionId });
      if (
        message.method === "Target.setAutoAttach" &&
        message.sessionId === "S-BROWSER"
      ) {
        fake.emit({
          method: "Target.attachedToTarget",
          sessionId: "S-BROWSER",
          params: {
            sessionId: "S-OWNER-2",
            targetInfo: pageInfo(OWNER),
            waitingForDebugger: false,
          },
        });
      }
    };
    const client = await connectClient(proxy);
    const browserSession = await client.send("Target.attachToBrowserTarget");
    expect(browserSession.result).toEqual({ sessionId: "S-BROWSER" });

    const sent = fake.received.length;
    for (const [method, params] of [
      ["Target.attachToTarget", { targetId: OWNER, flatten: true }],
      ["Browser.close", {}],
      ["Fetch.enable", {}],
    ] as const) {
      expect((await client.send(method, params, "S-BROWSER")).error?.code).toBe(
        -32001,
      );
    }
    expect(fake.received).toHaveLength(sent);

    await client.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      "S-BROWSER",
    );
    await vi.waitFor(() =>
      expect(
        fake.received.find(
          (message) =>
            message.method === "Target.detachFromTarget" &&
            message.params?.sessionId === "S-OWNER-2",
        )?.sessionId,
      ).toBe("S-BROWSER"),
    );
    expect(JSON.stringify(client.messages)).not.toContain(OWNER);
    expect(
      (await client.send("Runtime.evaluate", {}, "S-OWNER-2")).error?.code,
    ).toBe(-32001);
  });

  it("closes the client when the browser goes away", async () => {
    const { fake, proxy } = await setup();
    const client = await connectClient(proxy);
    const closed = new Promise<void>((resolve) =>
      client.socket.once("close", () => resolve()),
    );
    await fake.close();
    await closed;
  });
});
