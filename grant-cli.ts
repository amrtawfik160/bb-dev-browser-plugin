import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import type { BrowserService } from "./browser-service.js";
import {
  BROWSER_WHOLE_WEB_ORIGIN_SCOPE,
  PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
  normalizeBrowserOriginScope,
  type BrowserGrantRequestDecisionResponse,
  type BrowserProfileGrant,
} from "./contracts.js";

/**
 * Owner grant management from a project thread.
 *
 * Profile Grants used to be reachable only from authenticated Browser
 * Settings, so an agent that hit `origin_denied` could do nothing but wait for
 * a human to open a panel. These commands put the same owner decisions on the
 * CLI: one `trust` unlocks whole-web automation for a project and profile,
 * and `grants`/`grant`/`revoke`/`approve`/`deny` cover the narrower cases.
 *
 * The trade is deliberate. Anything that can run `bb` can now grant itself the
 * browser, so a grant is only ever as strong as shell access to the host.
 * Every command still routes through the same owner-authority service methods,
 * so grants stay recorded as Activity Records and remain revocable.
 */

export const WHOLE_WEB_SCOPE = BROWSER_WHOLE_WEB_ORIGIN_SCOPE;

export type GrantCliCommand =
  "trust" | "untrust" | "grants" | "grant" | "revoke" | "approve" | "deny";

export const GRANT_CLI_COMMANDS: readonly GrantCliCommand[] = [
  "trust",
  "untrust",
  "grants",
  "grant",
  "revoke",
  "approve",
  "deny",
];

export type GrantCliArguments = {
  command: GrantCliCommand;
  json: boolean;
  profileId?: string;
  hostId?: string;
  originScope?: string;
  grantId?: string;
  requestId?: string;
  fileTransfer?: boolean;
  includeRevoked?: boolean;
  oneHour?: boolean;
};

export function isGrantCliCommand(
  command: string | undefined,
): command is GrantCliCommand {
  return (
    command !== undefined &&
    GRANT_CLI_COMMANDS.some((known) => known === command)
  );
}

function grantSummary(grant: BrowserProfileGrant) {
  const elevations = [
    grant.wholeWeb ? "whole web" : null,
    grant.fileTransfer ? "file transfer" : null,
    grant.invalidCertificateOrigins.length > 0
      ? `invalid certificates (${grant.invalidCertificateOrigins.length})`
      : null,
  ].filter((entry): entry is string => entry !== null);
  return [
    `${grant.grantId}  ${grant.originScope}`,
    `  profile: ${grant.profileId}  project: ${grant.projectId}`,
    `  elevations: ${elevations.length === 0 ? "none" : elevations.join(", ")}`,
    `  expires: ${grant.wholeWebExpiresAt ?? "never"}`,
  ].join("\n");
}

function jsonOrText<T>(json: boolean, payload: T, text: string) {
  return json ? JSON.stringify(payload) : text;
}

/**
 * Find an active grant that already covers a scope, so repeated `trust` calls
 * report the existing unlock instead of stacking duplicate grants.
 */
function equivalentGrant(
  grants: readonly BrowserProfileGrant[],
  originScope: string,
  fileTransfer: boolean,
) {
  return grants.find(
    (grant) =>
      grant.revokedAt === null &&
      grant.originScope === originScope &&
      (!fileTransfer || grant.fileTransfer) &&
      (grant.wholeWebExpiresAt == null ||
        new Date(grant.wholeWebExpiresAt) > new Date()),
  );
}

async function scopedGrants(
  browser: BrowserService,
  authority: unknown,
  context: PluginCliContext,
  cliArguments: GrantCliArguments,
) {
  const scope = await browser.grantScope(context, {
    ...(cliArguments.profileId === undefined
      ? {}
      : { profileId: cliArguments.profileId }),
    ...(cliArguments.hostId === undefined
      ? {}
      : { hostId: cliArguments.hostId }),
  });
  const grants = await browser.grants(authority, {
    projectId: scope.projectId,
    hostId: scope.hostId,
    installationId: scope.installationId,
    profileId: scope.profileId,
    includeRevoked: cliArguments.includeRevoked ?? false,
  });
  return { scope, grants };
}

async function runTrustCli(
  browser: BrowserService,
  authority: unknown,
  context: PluginCliContext,
  cliArguments: GrantCliArguments,
) {
  const originScope = normalizeBrowserOriginScope(
    cliArguments.originScope ?? WHOLE_WEB_SCOPE,
  );
  const fileTransfer = cliArguments.fileTransfer ?? false;
  const { scope, grants } = await scopedGrants(browser, authority, context, {
    ...cliArguments,
    includeRevoked: false,
  });
  const existing = equivalentGrant(grants, originScope, fileTransfer);
  if (existing !== undefined) {
    return {
      exitCode: 0,
      stdout: jsonOrText(
        cliArguments.json,
        { outcome: "already-trusted", grant: existing },
        `Already trusted.\n${grantSummary(existing)}`,
      ),
    };
  }
  const grant = await browser.createGrant(
    authority,
    {
      projectId: scope.projectId,
      hostId: scope.hostId,
      installationId: scope.installationId,
      profileId: scope.profileId,
      originScope,
      wholeWeb: originScope === WHOLE_WEB_SCOPE,
      fileTransfer,
      invalidCertificateOrigins: [],
      persistentElevations: true,
      persistenceConfirmation: PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
    },
    context.signal,
  );
  const headline =
    originScope === WHOLE_WEB_SCOPE
      ? `Browser unlocked for this project on profile ${scope.profileId}. Agents can now automate any site.`
      : `Granted ${originScope} on profile ${scope.profileId}.`;
  return {
    exitCode: 0,
    stdout: jsonOrText(
      cliArguments.json,
      { outcome: "trusted", grant },
      `${headline}\n${grantSummary(grant)}\nRevoke with: bb browser untrust`,
    ),
  };
}

async function runUntrustCli(
  browser: BrowserService,
  authority: unknown,
  context: PluginCliContext,
  cliArguments: GrantCliArguments,
) {
  const { scope, grants } = await scopedGrants(browser, authority, context, {
    ...cliArguments,
    includeRevoked: false,
  });
  const targets =
    cliArguments.originScope === undefined
      ? grants
      : grants.filter(
          (grant) =>
            grant.originScope ===
            normalizeBrowserOriginScope(cliArguments.originScope!),
        );
  const revoked = [];
  for (const grant of targets) {
    revoked.push(
      await browser.revokeGrant(authority, { grantId: grant.grantId }),
    );
  }
  const text =
    revoked.length === 0
      ? `No active Browser Profile Grants for profile ${scope.profileId}.`
      : `Revoked ${revoked.length} Browser Profile Grant(s) on profile ${scope.profileId}.`;
  return {
    exitCode: 0,
    stdout: jsonOrText(cliArguments.json, { revoked }, text),
  };
}

async function runGrantsCli(
  browser: BrowserService,
  authority: unknown,
  context: PluginCliContext,
  cliArguments: GrantCliArguments,
) {
  const { scope, grants } = await scopedGrants(
    browser,
    authority,
    context,
    cliArguments,
  );
  const text =
    grants.length === 0
      ? `No Browser Profile Grants for profile ${scope.profileId}. Run: bb browser trust`
      : grants.map(grantSummary).join("\n\n");
  return { exitCode: 0, stdout: jsonOrText(cliArguments.json, grants, text) };
}

async function runGrantCli(
  browser: BrowserService,
  authority: unknown,
  context: PluginCliContext,
  cliArguments: GrantCliArguments,
) {
  if (cliArguments.originScope === undefined) {
    return {
      exitCode: 1,
      stderr:
        "grant requires --origin <origin|subdomain pattern|*>. Use `bb browser trust` for whole-web access.",
    };
  }
  return runTrustCli(browser, authority, context, cliArguments);
}

async function runRevokeCli(
  browser: BrowserService,
  authority: unknown,
  cliArguments: GrantCliArguments,
) {
  if (cliArguments.grantId === undefined) {
    return { exitCode: 1, stderr: "revoke requires --grant <id>." };
  }
  const response = await browser.revokeGrant(authority, {
    grantId: cliArguments.grantId,
  });
  return {
    exitCode: response.outcome === "not-found" ? 1 : 0,
    stdout: jsonOrText(
      cliArguments.json,
      response,
      `${response.grantId}: ${response.outcome}`,
    ),
  };
}

function decisionText(response: BrowserGrantRequestDecisionResponse) {
  const grantId = response.grant?.grantId ?? response.temporaryGrant?.grantId;
  return [
    `Browser Grant Request ${response.request.requestId}: ${response.outcome}`,
    `Origin: ${response.request.origin}`,
    grantId === undefined ? null : `Grant: ${grantId}`,
    "The denied call does not resume; retry the browser script.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function runDecisionCli(
  browser: BrowserService,
  authority: unknown,
  cliArguments: GrantCliArguments,
) {
  if (cliArguments.requestId === undefined) {
    return {
      exitCode: 1,
      stderr: `${cliArguments.command} requires --request <id>. List them with: bb browser requests`,
    };
  }
  const decision =
    cliArguments.command === "deny"
      ? "deny"
      : cliArguments.oneHour === true
        ? "one-hour"
        : "persist";
  const response = await browser.decideGrantRequest(authority, {
    requestId: cliArguments.requestId,
    decision,
    ...(decision === "persist"
      ? {
          persistenceConfirmation: PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
        }
      : {}),
  });
  const failed = ["not-found", "expired", "already-decided"].includes(
    response.outcome,
  );
  return {
    exitCode: failed ? 1 : 0,
    stdout: jsonOrText(cliArguments.json, response, decisionText(response)),
  };
}

export async function runGrantCliCommand(
  browser: BrowserService,
  authority: unknown,
  cliArguments: GrantCliArguments,
  context: PluginCliContext,
): Promise<PluginCliResult> {
  if (cliArguments.command === "trust") {
    return runTrustCli(browser, authority, context, cliArguments);
  }
  if (cliArguments.command === "untrust") {
    return runUntrustCli(browser, authority, context, cliArguments);
  }
  if (cliArguments.command === "grants") {
    return runGrantsCli(browser, authority, context, cliArguments);
  }
  if (cliArguments.command === "grant") {
    return runGrantCli(browser, authority, context, cliArguments);
  }
  if (cliArguments.command === "revoke") {
    return runRevokeCli(browser, authority, cliArguments);
  }
  return runDecisionCli(browser, authority, cliArguments);
}
