import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { createProductionBrowserProcessBoundary } from "../browser-process.js";

const browserFixtureSource = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const profileArgument = process.argv.find((argument) => argument.startsWith("--user-data-dir="));
if (profileArgument === undefined) process.exit(2);
const profileDirectory = profileArgument.slice("--user-data-dir=".length);
const server = createServer((socket) => socket.end());
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(3);
  await writeFile(join(profileDirectory, "identity.json"), JSON.stringify({
    uid: process.getuid(),
    gid: process.getgid(),
    arguments: process.argv.slice(2),
    timezone: process.env.TZ,
  }));
  await writeFile(
    join(profileDirectory, "DevToolsActivePort"),
    String(address.port) + "\\n/devtools/browser/local-fixture\\n",
  );
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

function connectToEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(Number(url.port), url.hostname);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

describe("production browser process boundary", () => {
  it("resolves search text through the Browser Profile configured engine", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "browser-search-"));
    const profileDirectory = join(rootDirectory, "profile");
    await mkdir(join(profileDirectory, "Default"), { recursive: true });
    await writeFile(
      join(profileDirectory, "Default", "Preferences"),
      JSON.stringify({
        default_search_provider_data: {
          template_url_data: {
            url: "https://search.fixture.test/results?q={searchTerms}",
          },
        },
      }),
    );
    const boundary = createProductionBrowserProcessBoundary({
      devBrowserExecutable: "/bin/true",
    });
    try {
      await expect(
        boundary.configuredSearchUrl({
          profileDirectory,
          text: "configured search",
        }),
      ).resolves.toBe(
        "https://search.fixture.test/results?q=configured%20search",
      );
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("runs the browser identity unprivileged and binds Automation Mode to loopback", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "browser-process-"));
    const sourceDirectory = join(rootDirectory, "source");
    const fixtureExecutable = join(sourceDirectory, "chrome");
    const passwdPath = join(rootDirectory, "passwd");
    const userId = process.getuid?.() === 0 ? 65534 : process.getuid!();
    const groupId = process.getgid?.() === 0 ? 65534 : process.getgid!();
    await chmod(rootDirectory, 0o755);
    await mkdir(sourceDirectory);
    await writeFile(fixtureExecutable, browserFixtureSource);
    await chmod(fixtureExecutable, 0o755);
    await writeFile(
      passwdPath,
      `bb-browser:x:${userId}:${groupId}::${rootDirectory}:/usr/sbin/nologin\n`,
    );
    const profileDirectory = join(rootDirectory, "profile");
    const runtimeDirectory = join(rootDirectory, "runtime");
    const boundary = createProductionBrowserProcessBoundary({
      devBrowserExecutable: "/bin/true",
      passwdPath,
    });
    const running = await boundary.launch({
      kind: "playwright-chromium",
      executablePath: fixtureExecutable,
      browserName: "bb-fixture",
      profileDirectory,
      runtimeDirectory,
      locale: "en-GB",
      timezone: "Europe/London",
      chromeArguments: [
        `--user-data-dir=${profileDirectory}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
      ],
    });
    try {
      const status = await readFile(`/proc/${running.pid}/status`, "utf8");
      const identity = JSON.parse(
        await readFile(join(profileDirectory, "identity.json"), "utf8"),
      ) as {
        uid: number;
        gid: number;
        arguments: string[];
        timezone: string;
      };

      expect(status).toMatch(new RegExp(`^Uid:\\s+${userId}\\s`, "mu"));
      expect(identity).toMatchObject({
        uid: userId,
        gid: groupId,
        timezone: "Europe/London",
      });
      expect(identity.arguments).toContain(
        "--remote-debugging-address=127.0.0.1",
      );
      expect(identity.arguments).not.toContain("--no-sandbox");
      expect(new URL(running.automationEndpoint).hostname).toBe("127.0.0.1");
      await expect(connectToEndpoint(running.automationEndpoint)).resolves.toBe(
        undefined,
      );
    } finally {
      await running.stop();
      await expect(
        readFile(`/proc/${running.pid}/status`, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #11 recovers an unmanifested owned browser from its profile launch arguments", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "browser-orphan-"));
    const fixtureExecutable = join(rootDirectory, "chrome");
    const passwdPath = join(rootDirectory, "passwd");
    const userId = process.getuid?.() === 0 ? 65534 : process.getuid!();
    const groupId = process.getgid?.() === 0 ? 65534 : process.getgid!();
    await chmod(rootDirectory, 0o755);
    await writeFile(fixtureExecutable, browserFixtureSource);
    await chmod(fixtureExecutable, 0o755);
    await writeFile(
      passwdPath,
      `bb-browser:x:${userId}:${groupId}::${rootDirectory}:/usr/sbin/nologin\n`,
    );
    const request = {
      kind: "playwright-chromium" as const,
      executablePath: fixtureExecutable,
      browserName: "bb-orphan-fixture",
      profileDirectory: join(rootDirectory, "profile"),
      runtimeDirectory: join(rootDirectory, "runtime"),
      locale: "en-GB",
      timezone: "Europe/London",
      chromeArguments: [
        `--user-data-dir=${join(rootDirectory, "profile")}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
      ],
    };
    const boundary = createProductionBrowserProcessBoundary({
      devBrowserExecutable: "/bin/true",
      passwdPath,
    });
    const launched = await boundary.launch(request);
    try {
      const recovered = await boundary.recover(request, null, null);
      expect(recovered).not.toBeNull();
      expect(recovered?.pid).toBe(launched.pid);
      await recovered?.stop();
    } finally {
      await launched.stop();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("runs the dev-browser attachment helper as the same unprivileged identity", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "browser-helper-"));
    const helperExecutable = join(rootDirectory, "dev-browser-fixture.mjs");
    const passwdPath = join(rootDirectory, "passwd");
    const userId = process.getuid?.() === 0 ? 65534 : process.getuid!();
    const groupId = process.getgid?.() === 0 ? 65534 : process.getgid!();
    await chmod(rootDirectory, 0o755);
    await writeFile(
      helperExecutable,
      `#!/usr/bin/env node
let code = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { code += chunk; });
process.stdin.on("end", () => console.log(JSON.stringify({
  uid: process.getuid(),
  gid: process.getgid(),
  home: process.env.HOME,
  arguments: process.argv.slice(2),
  code,
})));
`,
    );
    await chmod(helperExecutable, 0o755);
    await writeFile(
      passwdPath,
      `bb-browser:x:${userId}:${groupId}::${rootDirectory}:/usr/sbin/nologin\n`,
    );
    const boundary = createProductionBrowserProcessBoundary({
      devBrowserExecutable: helperExecutable,
      passwdPath,
    });
    const runtimeDirectory = join(rootDirectory, "runtime");
    try {
      const output = await boundary.execute({
        endpoint: "ws://127.0.0.1:9222/devtools/browser/fixture",
        browserName: "bb-profile-a",
        code: "console.log(await browser.listPages())",
        timeoutMs: 5_000,
        runtimeDirectory,
      });
      expect(JSON.parse(String(output))).toEqual({
        uid: userId,
        gid: groupId,
        home: join(runtimeDirectory, "bb-profile-a"),
        arguments: [
          "--browser",
          "bb-profile-a",
          "--connect",
          "ws://127.0.0.1:9222/devtools/browser/fixture",
          "--timeout",
          "5",
        ],
        code: "console.log(await browser.listPages())",
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
