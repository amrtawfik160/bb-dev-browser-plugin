/**
 * The deterministic loopback authentication fixture shared by the real-browser
 * worker's `signInScript` and the provisioned-host acceptance suites.
 *
 * Mirrors the contract the real-browser worker drives (`/sign-in` POST →
 * `/account`, `#popup`, `/popup`); centralized here so
 * `browser-auth.integration.test.ts` and `host-provisioning.ts` reuse one
 * fixture rather than each rebuilding it. Binds loopback only; never
 * provisions or mutates the host.
 */
import http, { type Server } from "node:http";

/**
 * Build the deterministic loopback authentication HTTP server. The worker's
 * `signInScript` POSTs `/sign-in`, follows the redirect to `/account`, opens
 * the `#popup`, and reads `Authenticated popup` from `/popup`.
 */
export function createLoopbackAuthFixture(): Server {
  return http.createServer((request, response) => {
    const signedIn = request.headers.cookie?.includes("fixture-session=valid");
    if (request.method === "POST" && request.url === "/sign-in") {
      response.writeHead(303, {
        location: "/account",
        "set-cookie": "fixture-session=valid; Path=/; SameSite=Lax",
      });
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/account" && signedIn) {
      response.end(
        "<h1>Signed in</h1><button id=\"popup\" onclick=\"open('/popup', 'fixture-popup')\">Popup</button>",
      );
      return;
    }
    if (request.url === "/popup" && signedIn) {
      response.end("<h1>Authenticated popup</h1>");
      return;
    }
    response.end(
      '<form method="post" action="/sign-in"><input name="user"><button>Sign in</button></form>',
    );
  });
}

/** Start a loopback fixture server and return its bound port. */
export function listenLoopbackFixture(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The local authentication fixture did not bind TCP."));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Close a loopback fixture server. */
export function closeLoopbackFixture(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
