import type { PluginCliResult } from "@get-bb/plugin-sdk";

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

export const GRANT_CLI_SETTINGS_REQUIRED =
  "Browser grant administration requires an authenticated owner session. Open Browser Settings in BB to manage Profile Grants and Grant Requests.";

export function isGrantCliCommand(
  command: string | undefined,
): command is GrantCliCommand {
  return (
    command !== undefined &&
    GRANT_CLI_COMMANDS.some((known) => known === command)
  );
}

export function failClosedGrantCliCommand(): PluginCliResult {
  return { exitCode: 1, stderr: GRANT_CLI_SETTINGS_REQUIRED };
}
