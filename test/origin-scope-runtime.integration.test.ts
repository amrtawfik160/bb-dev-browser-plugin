import { chromium } from "playwright";
import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { originScopeMatcher } from "../authorization.js";
import {
  BrowserOriginScopeDeniedError,
  installHostOriginScopeGuard,
} from "../origin-scope.js";

function policy(scope = "https://app.example.test") {
  return {
    matcher: originScopeMatcher(scope),
    invalidCertificateOrigins: [],
    timeoutMs: 5_000,
  };
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The pinned-runtime fixture did not bind TCP."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("pinned Chromium Origin Scope runtime", () => {
  it("denies a data document that produces no Playwright route request", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const dataRequests: string[] = [];
    const precommitUrls: string[] = [];
    const probe = await context.newCDPSession(page);
    await probe.send("Page.enable");
    probe.on("Page.frameStartedNavigating", (event) => {
      if (event.url.startsWith("data:")) precommitUrls.push(event.url);
    });
    page.on("request", (request) => {
      if (request.url().startsWith("data:")) dataRequests.push(request.url());
    });
    const guard = await installHostOriginScopeGuard(
      "unused",
      policy(),
      async () => browser,
    );

    try {
      await page.goto("data:text/html,<h1>private</h1>").catch(() => null);
      await vi.waitFor(() => expect(page.isClosed()).toBe(true));
      expect(guard.deniedError()).toEqual(
        new BrowserOriginScopeDeniedError(null),
      );
      expect(dataRequests).toEqual([]);
      expect(precommitUrls).toContain("data:text/html,<h1>private</h1>");
    } finally {
      await guard.dispose();
      await probe.detach().catch(() => undefined);
    }
  });

  it("denies renderer-created data frames before they can remain in the page", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const guard = await installHostOriginScopeGuard(
      "unused",
      policy(),
      async () => browser,
    );

    try {
      await page.setContent("<h1>in scope setup</h1>");
      await page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.src = "data:text/html,<h1>private</h1>";
        document.body.append(frame);
      });
      await vi.waitFor(() => {
        expect(guard.deniedError()).toEqual(
          new BrowserOriginScopeDeniedError(null),
        );
      });
      await vi.waitFor(() => expect(page.isClosed()).toBe(true));
    } finally {
      await guard.dispose();
    }
  });

  it("denies a renderer location change to a data document", async () => {
    const server = createServer((_request, response) => {
      response.end("<h1>in scope</h1>");
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const guard = await installHostOriginScopeGuard(
      "unused",
      policy(origin),
      async () => browser,
    );

    try {
      await page.goto("about:blank");
      expect(guard.deniedError()).toBeNull();
      await page.goto(origin);
      await page.evaluate(() => {
        window.setTimeout(() => {
          window.location.href = "data:text/html,<h1>private</h1>";
        }, 0);
      });
      await vi.waitFor(() => {
        expect(guard.deniedError()).toEqual(
          new BrowserOriginScopeDeniedError(null),
        );
      });
      await vi.waitFor(() => expect(page.isClosed()).toBe(true));
    } finally {
      await guard.dispose();
      await close(server);
    }
  });

  it("denies a data popup without closing the owner page", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const guard = await installHostOriginScopeGuard(
      "unused",
      policy(),
      async () => browser,
    );

    try {
      await page.setContent(
        "<button onclick=\"window.open('data:text/html,%3Ch1%3Eprivate%3C%2Fh1%3E')\">open</button>",
      );
      await page
        .getByRole("button", { name: "open" })
        .click()
        .catch((error: unknown) => {
          expect(String(error)).toContain("closed");
        });
      await vi.waitFor(() => {
        expect(guard.deniedError()).toEqual(
          new BrowserOriginScopeDeniedError(null),
        );
      });
      expect(context.pages()).toHaveLength(1);
      expect(page.isClosed()).toBe(false);
    } finally {
      await guard.dispose();
    }
  });

  it("keeps the owner page when route handling denies a web popup", async () => {
    const attacker = createServer((_request, response) => {
      response.end("<h1>outside</h1>");
    });
    const attackerPort = await listen(attacker);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const guard = await installHostOriginScopeGuard(
      "unused",
      policy(),
      async () => browser,
    );

    try {
      await page.setContent("<h1>in scope setup</h1>");
      await page.evaluate(
        (url) => window.open(url),
        `http://127.0.0.1:${attackerPort}/outside`,
      );
      await vi.waitFor(() => {
        expect(guard.deniedError()).toEqual(
          new BrowserOriginScopeDeniedError(`http://127.0.0.1:${attackerPort}`),
        );
      });
      await vi.waitFor(() => expect(context.pages()).toHaveLength(1));
      expect(page.isClosed()).toBe(false);
    } finally {
      await guard.dispose();
      await close(attacker);
    }
  });

  it("preserves an HTTP(S)-backed blob document for its approved origin", async () => {
    const server = createServer((_request, response) => {
      response.end("<h1>in scope</h1>");
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const guard = await installHostOriginScopeGuard(
      "unused",
      policy(origin),
      async () => browser,
    );

    try {
      await page.goto(origin);
      const blobUrl = await page.evaluate(() =>
        URL.createObjectURL(new Blob(["<h1>blob</h1>"], { type: "text/html" })),
      );
      await page.goto(blobUrl);
      expect(page.url()).toBe(blobUrl);
      expect(guard.deniedError()).toBeNull();
    } finally {
      await guard.dispose();
      await close(server);
    }
  });
});
