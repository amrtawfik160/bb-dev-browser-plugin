import { describe, expect, it } from "vitest";
import type { BrowserService } from "../browser-service.js";
import {
  GRANT_CLI_COMMANDS,
  isGrantCliCommand,
  runGrantCliCommand,
  WHOLE_WEB_SCOPE,
  type GrantCliArguments,
} from "../grant-cli.js";
import { PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION } from "../contracts.js";

const SCOPE = {
  projectId: "proj_1",
  hostId: "host_1",
  installationId: "install_1",
  profileId: "bb-personal",
};

function grant(overrides: Record<string, unknown> = {}) {
  return {
    grantId: "grant-1",
    ...SCOPE,
    originScope: WHOLE_WEB_SCOPE,
    wholeWeb: true,
    fileTransfer: false,
    invalidCertificateOrigins: [],
    persistentElevations: true,
    wholeWebExpiresAt: null,
    fileTransferExpiresAt: null,
    invalidCertificateExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

type ServiceCalls = {
  created: unknown[];
  revoked: unknown[];
  decided: unknown[];
};

function stubService(
  existing: unknown[],
  calls: ServiceCalls,
  decision: unknown = null,
) {
  return {
    grantScope: async () => SCOPE,
    grants: async () => existing,
    createGrant: async (_authority: unknown, request: unknown) => {
      calls.created.push(request);
      return grant();
    },
    revokeGrant: async (_authority: unknown, request: { grantId: string }) => {
      calls.revoked.push(request);
      return { grantId: request.grantId, outcome: "revoked" as const };
    },
    decideGrantRequest: async (_authority: unknown, request: unknown) => {
      calls.decided.push(request);
      return decision;
    },
  } as unknown as BrowserService;
}

function args(overrides: Partial<GrantCliArguments> = {}): GrantCliArguments {
  return { command: "trust", json: false, ...overrides };
}

const authority = Symbol("owner");
const context = { projectId: "proj_1", threadId: "thread_1" };

describe("grant CLI", () => {
  it("recognizes only its own commands", () => {
    for (const command of GRANT_CLI_COMMANDS) {
      expect(isGrantCliCommand(command)).toBe(true);
    }
    expect(isGrantCliCommand("script")).toBe(false);
    expect(isGrantCliCommand(undefined)).toBe(false);
  });

  it("trust creates a persistent whole-web grant", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    const result = await runGrantCliCommand(
      stubService([], calls),
      authority,
      args(),
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(calls.created).toEqual([
      {
        ...SCOPE,
        originScope: WHOLE_WEB_SCOPE,
        wholeWeb: true,
        fileTransfer: false,
        invalidCertificateOrigins: [],
        persistentElevations: true,
        persistenceConfirmation: PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
      },
    ]);
  });

  it("trust is idempotent when an equivalent grant is already active", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    const result = await runGrantCliCommand(
      stubService([grant()], calls),
      authority,
      args({ json: true }),
      context,
    );
    expect(calls.created).toEqual([]);
    expect(JSON.parse(result.stdout!)).toMatchObject({
      outcome: "already-trusted",
    });
  });

  it("trust re-grants when the existing whole-web elevation has expired", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    await runGrantCliCommand(
      stubService(
        [grant({ wholeWebExpiresAt: "2020-01-01T00:00:00.000Z" })],
        calls,
      ),
      authority,
      args(),
      context,
    );
    expect(calls.created).toHaveLength(1);
  });

  it("trust re-grants when the existing grant lacks a requested elevation", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    await runGrantCliCommand(
      stubService([grant()], calls),
      authority,
      args({ fileTransfer: true }),
      context,
    );
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({ fileTransfer: true });
  });

  it("grant narrows the scope to one origin", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    await runGrantCliCommand(
      stubService([], calls),
      authority,
      args({ command: "grant", originScope: "https://example.com" }),
      context,
    );
    expect(calls.created[0]).toMatchObject({
      originScope: "https://example.com",
      wholeWeb: false,
    });
  });

  it("grant without an origin explains itself instead of granting the web", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    const result = await runGrantCliCommand(
      stubService([], calls),
      authority,
      args({ command: "grant" }),
      context,
    );
    expect(result.exitCode).toBe(1);
    expect(calls.created).toEqual([]);
  });

  it("untrust revokes every active grant for the profile", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    await runGrantCliCommand(
      stubService([grant(), grant({ grantId: "grant-2" })], calls),
      authority,
      args({ command: "untrust" }),
      context,
    );
    expect(calls.revoked).toEqual([
      { grantId: "grant-1" },
      { grantId: "grant-2" },
    ]);
  });

  it("untrust limited to one scope leaves the others alone", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    await runGrantCliCommand(
      stubService(
        [
          grant(),
          grant({
            grantId: "grant-2",
            originScope: "https://example.com",
            wholeWeb: false,
          }),
        ],
        calls,
      ),
      authority,
      args({ command: "untrust", originScope: "https://example.com" }),
      context,
    );
    expect(calls.revoked).toEqual([{ grantId: "grant-2" }]);
  });

  it("approve persists by default and confirms the elevation", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    await runGrantCliCommand(
      stubService([], calls, {
        outcome: "persisted",
        request: { requestId: "req-1", origin: "https://example.com" },
        temporaryGrant: null,
        grant: grant(),
      }),
      authority,
      args({ command: "approve", requestId: "req-1" }),
      context,
    );
    expect(calls.decided).toEqual([
      {
        requestId: "req-1",
        decision: "persist",
        persistenceConfirmation: PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
      },
    ]);
  });

  it("approve --one-hour asks for the temporary decision", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    await runGrantCliCommand(
      stubService([], calls, {
        outcome: "one-hour-approved",
        request: { requestId: "req-1", origin: "https://example.com" },
        temporaryGrant: { grantId: "temp-1" },
        grant: null,
      }),
      authority,
      args({ command: "approve", requestId: "req-1", oneHour: true }),
      context,
    );
    expect(calls.decided).toEqual([
      { requestId: "req-1", decision: "one-hour" },
    ]);
  });

  it("deny records a denial", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    const result = await runGrantCliCommand(
      stubService([], calls, {
        outcome: "denied",
        request: { requestId: "req-1", origin: "https://example.com" },
        temporaryGrant: null,
        grant: null,
      }),
      authority,
      args({ command: "deny", requestId: "req-1" }),
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(calls.decided).toEqual([{ requestId: "req-1", decision: "deny" }]);
  });

  it("reports a failing exit code for a request that cannot be decided", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    const result = await runGrantCliCommand(
      stubService([], calls, {
        outcome: "expired",
        request: { requestId: "req-1", origin: "https://example.com" },
        temporaryGrant: null,
        grant: null,
      }),
      authority,
      args({ command: "approve", requestId: "req-1" }),
      context,
    );
    expect(result.exitCode).toBe(1);
  });

  it("grants points at trust when the project has none", async () => {
    const calls: ServiceCalls = { created: [], revoked: [], decided: [] };
    const result = await runGrantCliCommand(
      stubService([], calls),
      authority,
      args({ command: "grants" }),
      context,
    );
    expect(result.stdout).toContain("bb browser trust");
  });
});
