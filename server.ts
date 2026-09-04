import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginCliContext,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createBrowserService,
  panelIdentity,
  type BrowserService,
} from "./browser-service.js";
import {
  failClosedGrantCliCommand,
  GRANT_CLI_COMMANDS,
  GRANT_CLI_SETTINGS_REQUIRED,
  isGrantCliCommand,
} from "./grant-cli.js";
import {
  openBrowserScript,
  openCliText,
  parseOpenPageState,
} from "./browser-open.js";
import {
  projectLoopbackAddress,
  resolveBrowserAddress,
} from "./browser-navigation.js";
import {
  BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  BROWSER_SCRIPT_MIN_TIMEOUT_MS,
  browserScriptParametersSchema,
  browserScriptResultSchema,
  type BrowserActivityRecord,
  type BrowserHostChoicesInput,
  type BrowserGrantRequest,
  type BrowserProfileBackupRequest,
  type BrowserProfile,
  type BrowserProfileImportRequest,
  type BrowserProfileInventory,
  type BrowserProfileRecoveryResponse,
  type BrowserProfileRestoreRequest,
  type BrowserNavigationResponse,
  rpcContract,
  setupStepIdSchema,
  type BrowserScriptFailure,
  type BrowserScriptResponse,
  type BrowserPurgePlan,
  type BrowserPurgeResponse,
  type BrowserSetupPlan,
  type BrowserSetupResponse,
  type BrowserStatus,
} from "./contracts.js";

const CLI_USAGE = [
  "Usage: bb browser <open|trust|untrust|grants|grant|revoke|approve|deny|status|diagnostics|script|activity|activity-export|activity-clear|requests|request-status|list|create|rename|select|backup|restore|import|archive|restore-archived|reset|delete|setup|disable|uninstall|purge> [options]",
  "  open <url> [--profile <id>] [--timeout <ms>] [--screenshot] [--json]",
  "  trust|untrust|grants|grant|revoke|approve|deny: authenticated Browser Settings required",
  "  script --purpose <text> --code <source> --origin <origin> [--profile <id>] [--tab <id>] [--timeout <ms>] [--screenshot] [--file-transfer] [--invalid-certificate] [--json]",
  "  setup [--profile <id>] [--step <id> --confirm <text>] [--json]",
  "  purge [--profile <id>] [--confirm <text>] [--json]",
  "  disable|uninstall [--profile <id>] --confirm <text> [--json]",
  "  activity [--profile <id>] [--json]",
  `  activity-export [--profile <id>] [--json]`,
  `  activity-clear [--profile <id>] --confirm "Clear Browser activity records" [--json]`,
  "  requests [--json]",
  "  request-status --request <id> [--json]",
  "  list [--host <id>] [--json]",
  "  create --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]",
  "  rename --profile <id> --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]",
  "  select --profile <id> [--host <id>] [--json]",
  "  backup --profile <id> --archive <path> [--host <id>] [--json]",
  "  restore --profile <id> --archive <path> [--host <id>] [--json]",
  "  import --name <name> --source <path> [--host <id>] [--json]",
  "  archive|restore-archived --profile <id> [--host <id>] [--json]",
  "  reset|delete --profile <id> --confirm <text> [--host <id>] [--json]",
  "  transfer --kind workspace --source <path> --environment-root <path> [--profile <id>] [--host <id>] [--json]",
  "  transfer --cancel --transfer-id <id> [--profile <id>] [--host <id>] [--json]",
].join("\n");
const PROFILE_IMPORT_COMMAND = ["imp", "ort"].join("");
type BrowserScriptParameters = z.output<typeof browserScriptParametersSchema>;
const BROWSER_COMMANDS = [
  "open",
  ...GRANT_CLI_COMMANDS,
  "status",
  "diagnostics",
  "script",
  "activity",
  "activity-export",
  "activity-clear",
  "requests",
  "request-status",
  "list",
  "create",
  "rename",
  "select",
  "backup",
  "restore",
  PROFILE_IMPORT_COMMAND,
  "archive",
  "restore-archived",
  "reset",
  "delete",
  "setup",
  "disable",
  "uninstall",
  "purge",
  "transfer",
] as const;
type BrowserCommand = (typeof BROWSER_COMMANDS)[number];

type ParsedCliArguments = {
  command: BrowserCommand;
  json: boolean;
  profileId?: string;
  hostId?: string;
  name?: string;
  locale?: string;
  timezone?: string;
  archivePath?: string;
  sourcePath?: string;
  stepId?: z.output<typeof setupStepIdSchema>;
  confirmation?: string;
  requestId?: string;
  purpose?: string;
  code?: string;
  tabId?: string;
  destinationOrigin?: string;
  timeoutMs?: number;
  screenshot?: boolean;
  fileTransfer?: boolean;
  invalidCertificate?: boolean;
  grantId?: string;
  includeRevoked?: boolean;
  oneHour?: boolean;
  address?: string;
};

type CliArgumentParseResult =
  { arguments: ParsedCliArguments } | { error: string };

function cliStatusText(status: BrowserStatus) {
  const checklist = status.capabilities.map((item) => {
    const marker = item.status === "ready" ? "✓" : "-";
    return `${marker} ${item.label}: ${item.reason}`;
  });
  return [status.label, status.message, "", ...checklist].join("\n");
}

function cliSetupPlanText(plan: BrowserSetupPlan) {
  const packages = plan.packages.map(
    (packageSpec) => `- ${packageSpec.name}: ${packageSpec.purpose}`,
  );
  const steps = plan.steps.map(
    (step) =>
      `- ${step.state}: ${step.label} (type "${step.confirmationText}")`,
  );
  return [
    `Browser setup plan for ${plan.hostId}`,
    `State: ${plan.state}`,
    `Runtime: ${plan.runtime.runAsUser} (${plan.runtime.shell}, Chrome sandbox required)`,
    `Storage root: ${plan.storageRoot}`,
    `Host storage: ${plan.hostStoragePath}`,
    `Storage owner: ${plan.storageOwner}`,
    `Storage permissions: ${plan.storageMode}`,
    `Configuration: ${plan.configurationPath}`,
    "Packages:",
    ...packages,
    "Steps:",
    ...steps,
  ].join("\n");
}

function cliPurgePlanText(plan: BrowserPurgePlan) {
  const targets = plan.targets.map((target) => {
    const location =
      "path" in target
        ? target.path
        : "scope" in target
          ? target.scope
          : target.username;
    return `- ${target.state}: ${target.id} — ${location}`;
  });
  return [
    `Browser purge plan for ${plan.hostId}`,
    `State: ${plan.state}`,
    `Type exactly: ${plan.confirmationText}`,
    "Targets:",
    ...targets,
  ].join("\n");
}

function cliSetupResponseText(response: BrowserSetupResponse) {
  return [response.message, "", cliSetupPlanText(response.plan)].join("\n");
}

function cliPurgeResponseText(response: BrowserPurgeResponse) {
  return [response.message, "", cliPurgePlanText(response.plan)].join("\n");
}

function cliActivityText(records: readonly BrowserActivityRecord[]) {
  if (records.length === 0) return "No Browser activity records.";
  return records
    .map(
      (record) =>
        `${record.occurredAt} ${record.kind}:${record.action} ${record.outcome}`,
    )
    .join("\n");
}

function cliProfileText(profile: BrowserProfile) {
  const retention =
    profile.state === "archived"
      ? `\nRecoverable until: ${profile.expiresAt}`
      : "";
  return `${profile.name} (${profile.profileId})\nState: ${profile.state}${retention}\nLocale: ${profile.locale}\nTimezone: ${profile.timezone}`;
}

function cliProfilesText(inventory: BrowserProfileInventory) {
  const profiles = inventory.profiles.map((profile) => {
    const marker = profile.selected ? "*" : "-";
    return `${marker} ${cliProfileText(profile).replaceAll("\n", " — ")}`;
  });
  return [
    `Browser Profiles for ${inventory.hostId}`,
    `Selected: ${inventory.selectedProfileId}`,
    ...profiles,
  ].join("\n");
}

function cliProfileRecoveryText(response: BrowserProfileRecoveryResponse) {
  const { phase, completedBytes, totalBytes, phases } = response.progress;
  return [
    response.message,
    `Progress: ${(phases ?? [phase]).join(" → ")} (${completedBytes}/${totalBytes} bytes)`,
  ].join("\n");
}

function cliJsonOrText<T>(json: boolean, payload: T, textValue: string) {
  return json ? JSON.stringify(payload) : textValue;
}

function administrationExitCode(outcome: string) {
  return [
    "confirmation-required",
    "blocked",
    "partial-failure",
    "failed",
  ].includes(outcome)
    ? 1
    : 0;
}

function requiredOptionValue(
  argv: string[],
  index: number,
  option: string,
): { optionValue: string; nextIndex: number } | { error: string } {
  const optionValue = argv[index + 1];
  if (optionValue === undefined || optionValue.startsWith("--")) {
    return { error: `${option} requires a value.\n${CLI_USAGE}` };
  }
  return { optionValue, nextIndex: index + 1 };
}

type CliOptionName =
  | "--profile"
  | "--step"
  | "--host"
  | "--name"
  | "--locale"
  | "--timezone"
  | "--archive"
  | "--source"
  | "--request"
  | "--purpose"
  | "--code"
  | "--tab"
  | "--origin"
  | "--timeout"
  | "--grant"
  | "confirmation";
type ParsedCliOption = {
  name: CliOptionName;
  optionValue: string;
  nextIndex: number;
};

function cliOptionName(argument: string): CliOptionName | null {
  if (
    argument === "--profile" ||
    argument === "--step" ||
    argument === "--purpose" ||
    argument === "--code" ||
    argument === "--tab" ||
    argument === "--origin" ||
    argument === "--timeout"
  ) {
    return argument;
  }
  if (
    argument === "--host" ||
    argument === "--name" ||
    argument === "--locale" ||
    argument === "--timezone" ||
    argument === "--archive" ||
    argument === "--source" ||
    argument === "--request" ||
    argument === "--grant"
  ) {
    return argument;
  }
  if (argument === "--confirm" || argument === "--confirmation") {
    return "confirmation";
  }
  return null;
}

function readCliOption(
  argv: string[],
  index: number,
  argument: string,
): ParsedCliOption | { error: string } | null {
  const name = cliOptionName(argument);
  if (name === null) return null;
  const optionResult = requiredOptionValue(argv, index, argument);
  if ("error" in optionResult) return optionResult;
  return { name, ...optionResult };
}

type CliParseState = {
  positional: string[];
  json: boolean;
  profileId?: string;
  hostId?: string;
  name?: string;
  locale?: string;
  timezone?: string;
  archivePath?: string;
  sourcePath?: string;
  stepId?: ParsedCliArguments["stepId"];
  confirmation?: string;
  requestId?: string;
  purpose?: string;
  code?: string;
  tabId?: string;
  destinationOrigin?: string;
  timeoutMs?: number;
  screenshot?: boolean;
  fileTransfer?: boolean;
  invalidCertificate?: boolean;
  grantId?: string;
  includeRevoked?: boolean;
  oneHour?: boolean;
};

function applyCliOption(
  parseState: CliParseState,
  option: ParsedCliOption,
): string | null {
  if (option.name === "--profile") {
    parseState.profileId = option.optionValue;
    return null;
  }
  if (option.name === "--step") {
    const parsedStep = setupStepIdSchema.safeParse(option.optionValue);
    if (!parsedStep.success) {
      return `Unknown setup step: ${option.optionValue}.\n${CLI_USAGE}`;
    }
    parseState.stepId = parsedStep.data;
    return null;
  }
  if (option.name === "--host") {
    parseState.hostId = option.optionValue;
    return null;
  }
  if (option.name === "--name") {
    parseState.name = option.optionValue;
    return null;
  }
  if (option.name === "--locale") {
    parseState.locale = option.optionValue;
    return null;
  }
  if (option.name === "--timezone") {
    parseState.timezone = option.optionValue;
    return null;
  }
  if (option.name === "--archive") {
    parseState.archivePath = option.optionValue;
    return null;
  }
  if (option.name === "--source") {
    parseState.sourcePath = option.optionValue;
    return null;
  }
  if (option.name === "--request") {
    parseState.requestId = option.optionValue;
    return null;
  }
  if (option.name === "--grant") {
    parseState.grantId = option.optionValue;
    return null;
  }
  if (option.name === "--purpose") {
    parseState.purpose = option.optionValue;
    return null;
  }
  if (option.name === "--code") {
    parseState.code = option.optionValue;
    return null;
  }
  if (option.name === "--tab") {
    parseState.tabId = option.optionValue;
    return null;
  }
  if (option.name === "--origin") {
    parseState.destinationOrigin = option.optionValue;
    return null;
  }
  if (option.name === "--timeout") {
    const timeoutMs = Number(option.optionValue);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < BROWSER_SCRIPT_MIN_TIMEOUT_MS ||
      timeoutMs > BROWSER_SCRIPT_MAX_TIMEOUT_MS
    ) {
      return `--timeout must be an integer from ${BROWSER_SCRIPT_MIN_TIMEOUT_MS} to ${BROWSER_SCRIPT_MAX_TIMEOUT_MS}.\n${CLI_USAGE}`;
    }
    parseState.timeoutMs = timeoutMs;
    return null;
  }
  parseState.confirmation = option.optionValue;
  return null;
}

function isBrowserCommand(
  command: string | undefined,
): command is BrowserCommand {
  return (
    command !== undefined && BROWSER_COMMANDS.some((known) => known === command)
  );
}

/**
 * `open` is the one command that takes a positional value, because typing
 * `bb browser open example.com` is how a browser address bar behaves. Every
 * other command keeps the single-positional shape.
 */
function parsedCommand(
  positional: string[],
): { command: BrowserCommand; address?: string } | null {
  const command = positional[0];
  if (!isBrowserCommand(command)) return null;
  if (command === "open") {
    return positional.length > 2
      ? null
      : {
          command,
          ...(positional[1] === undefined ? {} : { address: positional[1] }),
        };
  }
  return positional.length === 1 ? { command } : null;
}

function validateGrantCommandOptions(
  command: BrowserCommand,
  parseState: CliParseState,
): string | null {
  if (isGrantCliCommand(command)) return GRANT_CLI_SETTINGS_REQUIRED;
  return parseState.grantId !== undefined ||
    parseState.includeRevoked !== undefined ||
    parseState.oneHour !== undefined
    ? `${GRANT_CLI_SETTINGS_REQUIRED}\n${CLI_USAGE}`
    : null;
}

function validateCliCommandOptions(
  command: BrowserCommand,
  parseState: CliParseState,
): string | null {
  const grantError = validateGrantCommandOptions(command, parseState);
  if (grantError !== null) return grantError;
  if (command === "open" && parseState.hostId !== undefined) {
    return `open derives the host from BB context; --host is not valid.\n${CLI_USAGE}`;
  }
  const scriptOptions = [
    parseState.purpose,
    parseState.code,
    parseState.tabId,
    parseState.invalidCertificate,
  ];
  const openOptions = [parseState.timeoutMs, parseState.screenshot];
  if (
    command !== "script" &&
    (scriptOptions.some((value) => value !== undefined) ||
      (command !== "open" && openOptions.some((value) => value !== undefined)))
  ) {
    return `Script options are only valid for script.\n${CLI_USAGE}`;
  }
  if (command !== "script" && parseState.destinationOrigin !== undefined) {
    return `--origin is only valid for script.\n${CLI_USAGE}`;
  }
  if (command !== "script" && parseState.fileTransfer !== undefined) {
    return `--file-transfer is only valid for script.\n${CLI_USAGE}`;
  }
  if (command === "script") {
    if (parseState.hostId !== undefined) {
      return `script derives the host from BB context; --host is not valid.\n${CLI_USAGE}`;
    }
    if (parseState.purpose === undefined) {
      return `script requires --purpose.\n${CLI_USAGE}`;
    }
    if (parseState.code === undefined) {
      return `script requires --code.\n${CLI_USAGE}`;
    }
    if (parseState.destinationOrigin === undefined) {
      return `script requires --origin <exact origin, e.g. https://example.com>.\n${CLI_USAGE}`;
    }
    if (parseState.confirmation !== undefined) {
      return `--confirm is not valid for script.\n${CLI_USAGE}`;
    }
  }
  if (command !== "setup" && parseState.stepId !== undefined) {
    return `--step is only valid for setup.\n${CLI_USAGE}`;
  }
  if (
    [
      "status",
      "diagnostics",
      "activity",
      "activity-export",
      "list",
      "open",
      ...GRANT_CLI_COMMANDS,
    ].includes(command) &&
    parseState.confirmation !== undefined
  ) {
    return `Confirmation is not valid for ${command}.\n${CLI_USAGE}`;
  }
  if (command !== "request-status" && parseState.requestId !== undefined) {
    return `--request is only valid for request-status.\n${CLI_USAGE}`;
  }
  if (command === "request-status" && parseState.requestId === undefined) {
    return `request-status requires --request.\n${CLI_USAGE}`;
  }
  if (
    command === "setup" &&
    (parseState.stepId === undefined) !==
      (parseState.confirmation === undefined)
  ) {
    return `setup changes require both --step and --confirm.\n${CLI_USAGE}`;
  }
  if (
    ["disable", "uninstall"].includes(command) &&
    parseState.confirmation === undefined
  ) {
    return `${command} requires --confirm.\n${CLI_USAGE}`;
  }
  if (
    !["create", "rename", PROFILE_IMPORT_COMMAND].includes(command) &&
    parseState.name !== undefined
  ) {
    return `--name is only valid for create, rename, or import.\n${CLI_USAGE}`;
  }
  if (
    !["create", "rename"].includes(command) &&
    parseState.locale !== undefined
  ) {
    return `--locale is only valid for create or rename.\n${CLI_USAGE}`;
  }
  if (
    !["create", "rename"].includes(command) &&
    parseState.timezone !== undefined
  ) {
    return `--timezone is only valid for create or rename.\n${CLI_USAGE}`;
  }
  if (
    !["backup", "restore"].includes(command) &&
    parseState.archivePath !== undefined
  ) {
    return `--archive is only valid for backup or restore.\n${CLI_USAGE}`;
  }
  if (
    command !== PROFILE_IMPORT_COMMAND &&
    parseState.sourcePath !== undefined
  ) {
    return `--source is only valid for import.\n${CLI_USAGE}`;
  }
  if (command === "create" && parseState.name === undefined) {
    return `create requires --name.\n${CLI_USAGE}`;
  }
  if (command === "rename" && parseState.name === undefined) {
    return `rename requires --name.\n${CLI_USAGE}`;
  }
  if (command === "rename" && parseState.profileId === undefined) {
    return `rename requires --profile.\n${CLI_USAGE}`;
  }
  if (command === "select" && parseState.profileId === undefined) {
    return `select requires --profile.\n${CLI_USAGE}`;
  }
  if (
    ["archive", "restore-archived", "reset", "delete"].includes(command) &&
    parseState.profileId === undefined
  ) {
    return `${command} requires --profile.\n${CLI_USAGE}`;
  }
  if (
    ["reset", "delete"].includes(command) &&
    parseState.confirmation === undefined
  ) {
    return `${command} requires --confirm.\n${CLI_USAGE}`;
  }
  if (["backup", "restore"].includes(command)) {
    if (parseState.profileId === undefined) {
      return `${command} requires --profile.\n${CLI_USAGE}`;
    }
    if (parseState.archivePath === undefined) {
      return `${command} requires --archive.\n${CLI_USAGE}`;
    }
  }
  if (command === PROFILE_IMPORT_COMMAND) {
    if (parseState.name === undefined) {
      return `import requires --name.\n${CLI_USAGE}`;
    }
    if (parseState.sourcePath === undefined) {
      return `import requires --source.\n${CLI_USAGE}`;
    }
  }
  if (command === "activity-clear" && parseState.confirmation === undefined) {
    return `activity-clear requires --confirm.\n${CLI_USAGE}`;
  }
  return null;
}

function parseCliArguments(argv: string[]): CliArgumentParseResult {
  const parseState: CliParseState = {
    positional: [],
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      parseState.json = true;
      continue;
    }
    if (argument === "--screenshot") {
      parseState.screenshot = true;
      continue;
    }
    if (argument === "--file-transfer") {
      parseState.fileTransfer = true;
      continue;
    }
    if (argument === "--invalid-certificate") {
      parseState.invalidCertificate = true;
      continue;
    }
    if (argument === "--all") {
      parseState.includeRevoked = true;
      continue;
    }
    if (argument === "--one-hour") {
      parseState.oneHour = true;
      continue;
    }
    const option = readCliOption(argv, index, argument);
    if (option !== null) {
      if ("error" in option) return option;
      index = option.nextIndex;
      const optionError = applyCliOption(parseState, option);
      if (optionError !== null) return { error: optionError };
      continue;
    }
    if (argument.startsWith("--")) {
      return { error: `Unknown option: ${argument}.\n${CLI_USAGE}` };
    }
    parseState.positional.push(argument);
  }
  const parsed = parsedCommand(parseState.positional);
  if (parsed === null) return { error: CLI_USAGE };
  const optionError = validateCliCommandOptions(parsed.command, parseState);
  if (optionError !== null) return { error: optionError };
  return {
    arguments: {
      command: parsed.command,
      address: parsed.address,
      grantId: parseState.grantId,
      includeRevoked: parseState.includeRevoked,
      oneHour: parseState.oneHour,
      json: parseState.json,
      profileId: parseState.profileId,
      hostId: parseState.hostId,
      name: parseState.name,
      locale: parseState.locale,
      timezone: parseState.timezone,
      archivePath: parseState.archivePath,
      sourcePath: parseState.sourcePath,
      stepId: parseState.stepId,
      confirmation: parseState.confirmation,
      requestId: parseState.requestId,
      purpose: parseState.purpose,
      code: parseState.code,
      tabId: parseState.tabId,
      destinationOrigin: parseState.destinationOrigin,
      timeoutMs: parseState.timeoutMs,
      screenshot: parseState.screenshot,
      fileTransfer: parseState.fileTransfer,
      invalidCertificate: parseState.invalidCertificate,
    },
  };
}

async function runStatusCli(
  browser: BrowserService,
  profileId: string | undefined,
  hostId: string | undefined,
  json: boolean,
  context: PluginCliContext,
) {
  const status =
    profileId === undefined
      ? await browser.selectedStatus(context, context.signal, hostId)
      : await browser.status(context, profileId, context.signal, hostId);
  return {
    exitCode: 0,
    stdout: cliJsonOrText(json, status, cliStatusText(status)),
  };
}

async function runDiagnosticsCli(
  browser: BrowserService,
  profileId: string | undefined,
  hostId: string | undefined,
  json: boolean,
  context: PluginCliContext,
) {
  const status =
    profileId === undefined
      ? await browser.selectedStatus(context, context.signal, hostId)
      : await browser.status(context, profileId, context.signal, hostId);
  if (status.hostId === null) return { exitCode: 1, stderr: status.message };
  const diagnostics = await browser.diagnostics(status, context.signal);
  const stdout = json
    ? JSON.stringify(diagnostics)
    : JSON.stringify(diagnostics, null, 2);
  return { exitCode: 0, stdout };
}

function browserScriptText(browserResult: unknown) {
  const parsed = browserScriptResultSchema.safeParse(browserResult);
  if (parsed.success) return parsed.data.output;
  if (typeof browserResult === "string") return browserResult;
  const serialized = JSON.stringify(browserResult);
  return serialized === undefined ? "" : serialized;
}

function browserScriptJson(browserResult: unknown) {
  const serialized = JSON.stringify(browserResult);
  return serialized === undefined ? "" : serialized;
}

async function runBrowserScriptCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  if (context.projectId === undefined || context.threadId === undefined) {
    throw new Error(
      "browser script requires BB project and thread context; invoke it from a project thread.",
    );
  }
  const parameters = browserScriptParametersSchema.parse({
    purpose: cliArguments.purpose,
    code: cliArguments.code,
    ...(cliArguments.destinationOrigin === undefined
      ? {}
      : { destinationOrigin: cliArguments.destinationOrigin }),
    ...(cliArguments.fileTransfer === undefined
      ? {}
      : { fileTransfer: cliArguments.fileTransfer }),
    ...(cliArguments.invalidCertificate === undefined
      ? {}
      : { invalidCertificate: cliArguments.invalidCertificate }),
    ...(cliArguments.profileId === undefined
      ? {}
      : { profileId: cliArguments.profileId }),
    ...(cliArguments.tabId === undefined ? {} : { tabId: cliArguments.tabId }),
    ...(cliArguments.timeoutMs === undefined
      ? {}
      : { timeoutMs: cliArguments.timeoutMs }),
    ...(cliArguments.screenshot === undefined
      ? {}
      : { screenshot: cliArguments.screenshot }),
  });
  const response = await browser.browserScript(parameters, {
    projectId: context.projectId,
    threadId: context.threadId,
    signal: context.signal ?? new AbortController().signal,
  });
  if (!response.ok) {
    return cliArguments.json
      ? { exitCode: 1, stdout: JSON.stringify(response) }
      : { exitCode: 1, stderr: response.error.message };
  }
  return {
    exitCode: 0,
    stdout:
      cliArguments.json ||
      browserScriptResultSchema.safeParse(response.result).success
        ? browserScriptJson(response.result)
        : browserScriptText(response.result),
  };
}

async function runOpenCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  if (context.projectId === undefined || context.threadId === undefined) {
    throw new Error(
      "browser open requires BB project and thread context; invoke it from a project thread.",
    );
  }
  if (cliArguments.address === undefined) {
    throw new Error(
      "browser open requires an HTTP(S) URL; omit the URL only in the Browser Panel.",
    );
  }
  const target = await browser.grantScope(context, {
    ...(cliArguments.profileId === undefined
      ? {}
      : { profileId: cliArguments.profileId }),
    ...(cliArguments.hostId === undefined
      ? {}
      : { hostId: cliArguments.hostId }),
  });
  const address = agentOpenAddress(cliArguments.address, target.projectId);
  const response = await browser.browserScript(
    browserScriptParametersSchema.parse({
      purpose: "Open a URL in the Workspace Browser",
      code: openBrowserScript(address),
      destinationOrigin: new URL(address).origin,
      profileId: target.profileId,
      ...(cliArguments.timeoutMs === undefined
        ? {}
        : { timeoutMs: cliArguments.timeoutMs }),
      ...(cliArguments.screenshot === undefined
        ? {}
        : { screenshot: cliArguments.screenshot }),
    }),
    {
      projectId: context.projectId,
      threadId: context.threadId,
      signal: context.signal ?? new AbortController().signal,
    },
  );
  if (!response.ok) {
    return cliArguments.json
      ? { exitCode: 1, stdout: JSON.stringify(response) }
      : { exitCode: 1, stderr: response.error.message };
  }
  const page = parseOpenPageState(browserScriptText(response.result));
  if (page === null) {
    throw new Error("The Workspace Browser returned an invalid open result.");
  }
  const navigation = await currentOpenTab(browser, target, context);
  return openCliResult(target, navigation, page, cliArguments.json);
}

function agentOpenAddress(input: string, projectId: string) {
  const address = resolveBrowserAddress(input);
  if (address.kind === "search") {
    throw new Error(
      "Agent-authorized browser open requires an HTTP(S) URL. Enter searches in the Browser Panel.",
    );
  }
  return projectLoopbackAddress(projectId, address.url);
}

function openCliResult(
  target: { hostId: string; profileId: string },
  navigation: BrowserNavigationResponse,
  page: NonNullable<ReturnType<typeof parseOpenPageState>>,
  json: boolean,
) {
  if (json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        url: page.url,
        title: page.title,
        tabId: navigation.tabId,
        profileId: target.profileId,
        hostId: target.hostId,
        trusted: true,
      }),
    };
  }
  return {
    exitCode: 0,
    stdout: openCliText(navigation, page),
  };
}

/**
 * Describe the tab `open` would have navigated, shaped like a navigation
 * result so the caller does not branch on whether an address was given.
 */
async function currentOpenTab(
  browser: BrowserService,
  target: { hostId: string; profileId: string },
  context: PluginCliContext,
): Promise<BrowserNavigationResponse> {
  const strip = await browser.tabs(
    { hostId: target.hostId, profileId: target.profileId },
    context.signal,
  );
  const active =
    strip.tabs.find((tab) => tab.tabId === strip.activeTabId) ?? strip.tabs[0];
  if (active === undefined) {
    // A sleeping or freshly restarted instance reports no tabs until something
    // navigates it, and there is nothing to report after an authorized open.
    throw new Error(
      "This Browser Profile has no open tab yet. Pass a URL to open one: bb browser open <url>",
    );
  }
  return {
    address: { kind: "address", url: active.url },
    location: null,
    tabId: active.tabId,
  };
}

async function runActivityCli(
  browser: BrowserService,
  target: { hostId: string; profileId: string },
  json: boolean,
) {
  const records = await browser.activityRecords(target);
  return {
    exitCode: 0,
    stdout: cliJsonOrText(json, records, cliActivityText(records)),
  };
}

async function runActivityExportCli(
  browser: BrowserService,
  target: { hostId: string; profileId: string },
  json: boolean,
) {
  const exported = await browser.exportActivityRecords(target);
  return {
    exitCode: 0,
    stdout: json
      ? JSON.stringify(exported)
      : JSON.stringify(exported.records, null, 2),
  };
}

async function runActivityClearCli(
  browser: BrowserService,
  target: { hostId: string; profileId: string },
  confirmation: string | undefined,
  json: boolean,
) {
  if (confirmation === undefined) {
    throw new Error("activity-clear requires --confirm.");
  }
  const response = await browser.clearActivityRecords({
    ...target,
    confirmation,
  });
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(response) : response.message,
  };
}

async function runGrantRequestsCli(
  browser: BrowserService,
  json: boolean,
  context: PluginCliContext,
) {
  const requests = await browser.listAgentGrantRequests(context);
  return {
    exitCode: 0,
    stdout: json
      ? JSON.stringify(requests)
      : requests.map(cliGrantRequestText).join("\n\n"),
  };
}

function cliGrantRequestText(request: BrowserGrantRequest) {
  return [
    "Browser Grant Request " + request.requestId,
    "Status: " + request.status,
    "Origin: " + request.origin,
    "Requested elevations: " +
      (request.requestedElevations.fileTransfer
        ? "file transfer"
        : "standard") +
      (request.requestedElevations.invalidCertificate
        ? ", invalid certificate"
        : ""),
    "Decision: " + (request.decision ?? "none"),
    "Expires: " + request.expiresAt,
  ].join("\n");
}

async function runGrantRequestStatusCli(
  browser: BrowserService,
  requestId: string,
  json: boolean,
  context: PluginCliContext,
) {
  const request = await browser.inspectAgentGrantRequest(context, requestId);
  if (request === null) {
    return {
      exitCode: 1,
      stderr: `Browser Grant Request ${requestId} was not found.`,
    };
  }
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(request) : cliGrantRequestText(request),
  };
}

async function runSetupCli(
  browser: BrowserService,
  target: { hostId: string; profileId: string },
  cliArguments: ParsedCliArguments,
  signal?: AbortSignal,
) {
  const plan = await browser.setupPlan(target, signal);
  if (
    cliArguments.stepId === undefined ||
    cliArguments.confirmation === undefined
  ) {
    return {
      exitCode: 0,
      stdout: cliJsonOrText(cliArguments.json, plan, cliSetupPlanText(plan)),
    };
  }
  const response = await browser.setup(
    {
      ...target,
      stepId: cliArguments.stepId,
      confirmation: cliArguments.confirmation,
    },
    signal,
  );
  return {
    exitCode: administrationExitCode(response.outcome),
    stdout: cliJsonOrText(
      cliArguments.json,
      response,
      cliSetupResponseText(response),
    ),
  };
}

async function runPurgeCli(
  browser: BrowserService,
  target: { hostId: string; profileId: string },
  cliArguments: ParsedCliArguments,
  signal?: AbortSignal,
) {
  const plan = await browser.purgePlan(target, signal);
  if (cliArguments.confirmation === undefined) {
    return {
      exitCode: 0,
      stdout: cliJsonOrText(cliArguments.json, plan, cliPurgePlanText(plan)),
    };
  }
  const response = await browser.purge(
    { ...target, confirmation: cliArguments.confirmation },
    signal,
  );
  return {
    exitCode: administrationExitCode(response.outcome),
    stdout: cliJsonOrText(
      cliArguments.json,
      response,
      cliPurgeResponseText(response),
    ),
  };
}

async function runLifecycleCli(
  browser: BrowserService,
  target: { hostId: string; profileId: string },
  cliArguments: ParsedCliArguments,
  signal?: AbortSignal,
) {
  const action = cliArguments.command;
  if (action !== "disable" && action !== "uninstall") {
    throw new Error(`${action} is not a lifecycle command.`);
  }
  if (cliArguments.confirmation === undefined) {
    throw new Error(`${action} requires --confirm.`);
  }
  const response = await browser.lifecycle(
    action,
    { ...target, confirmation: cliArguments.confirmation },
    signal,
  );
  return {
    exitCode: administrationExitCode(response.outcome),
    stdout: cliArguments.json ? JSON.stringify(response) : response.message,
  };
}

async function profileTarget(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  return browser.resolveTarget(
    context,
    cliArguments.profileId,
    cliArguments.hostId,
  );
}

async function runProfileListCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const inventory = await browser.profiles(
    {
      hostId: target.hostId,
      projectId: context.projectId,
      threadId: context.threadId,
    },
    context.signal,
  );
  return {
    exitCode: 0,
    stdout: cliJsonOrText(
      cliArguments.json,
      inventory,
      cliProfilesText(inventory),
    ),
  };
}

async function runFailClosedProfileLifecycleCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const inventory = await browser.profiles(
    {
      hostId: target.hostId,
      projectId: context.projectId,
      threadId: context.threadId,
    },
    context.signal,
  );
  const profile = inventory.profiles.find(
    ({ profileId }) => profileId === target.profileId,
  );
  if (profile === undefined) {
    throw new Error(`Browser Profile ${target.profileId} is not available.`);
  }
  const status = {
    operation: cliArguments.command,
    progress: "not-started" as const,
    profile,
  };
  return {
    exitCode: 1,
    stdout: cliJsonOrText(
      cliArguments.json,
      status,
      `Progress: not started\n${cliProfileText(profile)}`,
    ),
    stderr:
      "Destructive Browser Profile changes require the authenticated owner Settings transport. Archive removes agent authority and retains data for 30 days; reset loses credentials; permanent deletion cannot be undone.",
  };
}

async function runProfileCreateCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const profile = await browser.createProfile(
    {
      hostId: target.hostId,
      name: cliArguments.name!,
      ...(cliArguments.locale === undefined
        ? {}
        : { locale: cliArguments.locale }),
      ...(cliArguments.timezone === undefined
        ? {}
        : { timezone: cliArguments.timezone }),
    },
    context.signal,
  );
  return {
    exitCode: 0,
    stdout: cliJsonOrText(cliArguments.json, profile, cliProfileText(profile)),
  };
}

async function runProfileRenameCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const profile = await browser.renameProfile(
    {
      hostId: target.hostId,
      profileId: cliArguments.profileId!,
      name: cliArguments.name!,
      ...(cliArguments.locale === undefined
        ? {}
        : { locale: cliArguments.locale }),
      ...(cliArguments.timezone === undefined
        ? {}
        : { timezone: cliArguments.timezone }),
    },
    context.signal,
  );
  return {
    exitCode: 0,
    stdout: cliJsonOrText(cliArguments.json, profile, cliProfileText(profile)),
  };
}

async function runProfileSelectCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const inventory = await browser.selectProfile(
    {
      hostId: target.hostId,
      profileId: cliArguments.profileId!,
      projectId: context.projectId,
      threadId: context.threadId,
    },
    context.signal,
  );
  return {
    exitCode: 0,
    stdout: cliJsonOrText(
      cliArguments.json,
      inventory,
      cliProfilesText(inventory),
    ),
  };
}

async function runProfileBackupCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const request: BrowserProfileBackupRequest = {
    ...target,
    archivePath: cliArguments.archivePath!,
  };
  const response = await browser.backupProfile(request, context.signal);
  return {
    exitCode: 0,
    stdout: cliJsonOrText(
      cliArguments.json,
      response,
      cliProfileRecoveryText(response),
    ),
  };
}

async function runProfileRestoreCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const request: BrowserProfileRestoreRequest = {
    ...target,
    archivePath: cliArguments.archivePath!,
  };
  const response = await browser.restoreProfile(request, context.signal);
  return {
    exitCode: 0,
    stdout: cliJsonOrText(
      cliArguments.json,
      response,
      cliProfileRecoveryText(response),
    ),
  };
}

async function runProfileImportCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const target = await profileTarget(browser, cliArguments, context);
  const request: BrowserProfileImportRequest = {
    hostId: target.hostId,
    name: cliArguments.name!,
    sourcePath: cliArguments.sourcePath!,
  };
  const response = await browser.importProfile(request, context.signal);
  return {
    exitCode: 0,
    stdout: cliJsonOrText(
      cliArguments.json,
      response,
      cliProfileRecoveryText(response),
    ),
  };
}

async function runAdministrationCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  if (
    ["archive", "restore-archived", "reset", "delete"].includes(
      cliArguments.command,
    )
  ) {
    return runFailClosedProfileLifecycleCli(browser, cliArguments, context);
  }
  if (cliArguments.command === "list") {
    return runProfileListCli(browser, cliArguments, context);
  }
  if (cliArguments.command === "create") {
    return runProfileCreateCli(browser, cliArguments, context);
  }
  if (cliArguments.command === "rename") {
    return runProfileRenameCli(browser, cliArguments, context);
  }
  if (cliArguments.command === "select") {
    return runProfileSelectCli(browser, cliArguments, context);
  }
  if (cliArguments.command === "backup") {
    return runProfileBackupCli(browser, cliArguments, context);
  }
  if (cliArguments.command === "restore") {
    return runProfileRestoreCli(browser, cliArguments, context);
  }
  if (cliArguments.command === PROFILE_IMPORT_COMMAND) {
    return runProfileImportCli(browser, cliArguments, context);
  }
  const target = await browser.resolveTarget(
    context,
    cliArguments.profileId,
    cliArguments.hostId,
  );
  if (cliArguments.command === "activity") {
    return runActivityCli(browser, target, cliArguments.json);
  }
  if (cliArguments.command === "activity-export") {
    return runActivityExportCli(browser, target, cliArguments.json);
  }
  if (cliArguments.command === "activity-clear") {
    return runActivityClearCli(
      browser,
      target,
      cliArguments.confirmation,
      cliArguments.json,
    );
  }
  if (cliArguments.command === "setup") {
    return runSetupCli(browser, target, cliArguments, context.signal);
  }
  if (cliArguments.command === "purge") {
    return runPurgeCli(browser, target, cliArguments, context.signal);
  }
  return runLifecycleCli(browser, target, cliArguments, context.signal);
}

async function runCli(
  bb: BbPluginApi,
  browser: BrowserService,
  argv: string[],
  context: PluginCliContext,
) {
  if (argv[0] === "transfer") {
    return await runTransferCli(bb, browser, argv.slice(1), context);
  }
  if (argv[0] === "downloads") {
    return await runDownloadsCli(bb, browser, argv.slice(1), context);
  }
  if (isGrantCliCommand(argv[0])) {
    return failClosedGrantCliCommand();
  }
  const parsed = parseCliArguments(argv);
  if ("error" in parsed) return { exitCode: 1, stderr: parsed.error };
  const { command, json, profileId, hostId, requestId } = parsed.arguments;
  try {
    if (command === "open") {
      return await runOpenCli(browser, parsed.arguments, context);
    }
    if (command === "status") {
      return await runStatusCli(browser, profileId, hostId, json, context);
    }
    if (command === "diagnostics") {
      return await runDiagnosticsCli(browser, profileId, hostId, json, context);
    }
    if (command === "requests") {
      return await runGrantRequestsCli(browser, json, context);
    }
    if (command === "request-status") {
      return await runGrantRequestStatusCli(browser, requestId!, json, context);
    }
    if (command === "script") {
      return await runBrowserScriptCli(browser, parsed.arguments, context);
    }
    return await runAdministrationCli(browser, parsed.arguments, context);
  } catch (error) {
    if (error instanceof Error) return { exitCode: 1, stderr: error.message };
    throw error;
  }
}

const TRANSFER_CLI_USAGE = [
  "Usage: bb browser transfer <stage|cancel|progress> [options]",
  "  stage (workspace): --kind workspace --environment <id> --path <relative-path> [--actor owner|agent] [--profile <id>] [--host <id>] [--transfer-id <id>] [--json]",
  "  stage (client):    --kind client --file <local-path> [--transfer-id <id>] [--profile <id>] [--host <id>] [--json]",
  "  cancel:            --cancel --transfer-id <id> [--profile <id>] [--host <id>] [--json]",
  "  progress:          --progress --transfer-id <id> [--profile <id>] [--host <id>] [--json]",
].join("\n");

function readTransferOption(argv: string[], index: number, name: string) {
  if (index + 1 >= argv.length) {
    return { error: `${name} requires a value.\n${TRANSFER_CLI_USAGE}` };
  }
  return { value: argv[index + 1]!, nextIndex: index + 2 };
}

async function runTransferCli(
  bb: BbPluginApi,
  browser: BrowserService,
  argv: string[],
  context: PluginCliContext,
) {
  let kind: string | undefined;
  let environmentId: string | undefined;
  let relativePath: string | undefined;
  let clientFile: string | undefined;
  let actor: "owner" | "agent" | undefined;
  let transferId: string | undefined;
  let profileId: string | undefined;
  let hostId: string | undefined;
  let cancel = false;
  let progress = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--cancel") {
      cancel = true;
      continue;
    }
    if (argument === "--progress") {
      progress = true;
      continue;
    }
    if (argument === "--kind") {
      const option = readTransferOption(argv, index, "--kind");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      kind = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--environment") {
      const option = readTransferOption(argv, index, "--environment");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      environmentId = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--path") {
      const option = readTransferOption(argv, index, "--path");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      relativePath = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--file") {
      const option = readTransferOption(argv, index, "--file");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      clientFile = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--actor") {
      const option = readTransferOption(argv, index, "--actor");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      actor = option.value as "owner" | "agent";
      index = option.nextIndex;
      continue;
    }
    if (argument === "--transfer-id") {
      const option = readTransferOption(argv, index, "--transfer-id");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      transferId = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--profile") {
      const option = readTransferOption(argv, index, "--profile");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      profileId = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--host") {
      const option = readTransferOption(argv, index, "--host");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      hostId = option.value;
      index = option.nextIndex;
      continue;
    }
    return {
      exitCode: 1,
      stderr: `Unknown option: ${argument}.\n${TRANSFER_CLI_USAGE}`,
    };
  }
  try {
    const target = await browser.resolveTarget(context, profileId, hostId);
    if (cancel) {
      if (transferId === undefined) {
        return {
          exitCode: 1,
          stderr: `transfer --cancel requires --transfer-id.\n${TRANSFER_CLI_USAGE}`,
        };
      }
      // Cancellation routes to `cancel()` (removing the staged copy), not to
      // `transferConsume` (which reads the staged file for the browser).
      const outcome = await browser.transferCancel(
        transferId,
        target.hostId,
        context.signal,
      );
      return {
        exitCode: outcome.outcome === "cancelled" ? 0 : 1,
        stdout: cliJsonOrText(
          json,
          outcome,
          `Transfer ${transferId}: ${outcome.outcome}.`,
        ),
      };
    }
    if (progress) {
      if (transferId === undefined) {
        return {
          exitCode: 1,
          stderr: `transfer --progress requires --transfer-id.\n${TRANSFER_CLI_USAGE}`,
        };
      }
      const result = await browser.transferProgress(
        transferId,
        target.hostId,
        context.signal,
      );
      const text =
        result === null
          ? `Transfer ${transferId}: not found.`
          : `Transfer ${result.transferId}: ${result.phase} (${result.bytesCopied}/${result.totalBytes} bytes).`;
      return {
        exitCode: 0,
        stdout: cliJsonOrText(json, result ?? {}, text),
      };
    }
    if (kind === "client") {
      if (clientFile === undefined) {
        return {
          exitCode: 1,
          stderr: `transfer --kind client requires --file <local-path>.\n${TRANSFER_CLI_USAGE}`,
        };
      }
      // The CLI stands in for the displaying-client file chooser: it reads the
      // selected file's bytes and stages them through the client upload path
      // so the same one-use staging policy applies.
      const data = await readFile(clientFile);
      const stagedTransferId = transferId ?? `transfer-${randomUUID()}`;
      const response = await browser.transferStage(
        {
          kind: "client",
          transferId: stagedTransferId,
          fileName: basename(clientFile),
          sizeBytes: data.byteLength,
          hostId: target.hostId,
          data: Buffer.from(data).toString("base64"),
        },
        context.signal,
      );
      const text =
        response.outcome === "staged"
          ? `Transfer ${response.transferId}: staged ${response.kind} file (${response.sizeBytes} bytes).`
          : `Transfer ${response.transferId}: rejected (${response.reason}).`;
      return {
        exitCode: response.outcome === "staged" ? 0 : 1,
        stdout: cliJsonOrText(json, response, text),
      };
    }
    if (kind !== "workspace") {
      return {
        exitCode: 1,
        stderr: `transfer staging requires --kind workspace or --kind client.\n${TRANSFER_CLI_USAGE}`,
      };
    }
    if (environmentId === undefined || relativePath === undefined) {
      return {
        exitCode: 1,
        stderr: `transfer --kind workspace requires --environment <id> and --path <relative-path>.\n${TRANSFER_CLI_USAGE}`,
      };
    }
    // Resolve the workspace file through the BB environment file APIs rather
    // than raw --source/--environment-root strings, so the environment root
    // and host come from the resolved environment the transfer targets.
    const environment = await bb.sdk.environments.get({
      environmentId,
      signal: context.signal,
    });
    if (environment.path === null) {
      return {
        exitCode: 1,
        stderr: `Environment ${environmentId} has no workspace path.`,
      };
    }
    const resolvedSourcePath = join(environment.path, relativePath);
    const stagedTransferId = transferId ?? `transfer-${randomUUID()}`;
    const response = await browser.transferStage(
      {
        kind: "workspace",
        transferId: stagedTransferId,
        sourcePath: resolvedSourcePath,
        environmentRoot: environment.path,
        hostId: hostId ?? environment.hostId,
        ...(actor === undefined ? {} : { actor }),
      },
      context.signal,
    );
    // Privacy-safe: report only transferId, kind, size, and content type. The
    // staged path and any unrelated workspace paths are never printed.
    const text =
      response.outcome === "staged"
        ? `Transfer ${response.transferId}: staged ${response.kind} file (${response.sizeBytes} bytes).`
        : `Transfer ${response.transferId}: rejected (${response.reason}).`;
    return {
      exitCode: response.outcome === "staged" ? 0 : 1,
      stdout: cliJsonOrText(json, response, text),
    };
  } catch (error) {
    if (error instanceof Error) return { exitCode: 1, stderr: error.message };
    throw error;
  }
}

const DOWNLOADS_CLI_USAGE = [
  "Usage: bb browser downloads <list|progress|cancel|export-client|export-workspace|limits|purge> [options]",
  "  list:               [--profile <id>] [--host <id>] [--json]",
  "  progress:           --download-id <id> [--profile <id>] [--host <id>] [--json]",
  "  cancel:             --download-id <id> [--profile <id>] [--host <id>] [--json]",
  "  export-client:     --download-id <id> [--actor owner|agent] [--profile <id>] [--host <id>] [--json]",
  "  export-workspace:  --download-id <id> --environment <id> --path <relative-path> [--overwrite] [--actor owner|agent] [--profile <id>] [--host <id>] [--json]",
  "  limits:            [--max-file-bytes <n>] [--max-profile-bytes <n>] [--expiry-ms <n>] [--profile <id>] [--host <id>] [--json]",
  "  purge:             [--profile <id>] [--host <id>] [--json]",
].join("\n");

function readDownloadsOption(argv: string[], index: number, name: string) {
  if (index + 1 >= argv.length) {
    return { error: `${name} requires a value.\n${DOWNLOADS_CLI_USAGE}` };
  }
  return { value: argv[index + 1]!, nextIndex: index + 2 };
}

async function runDownloadsCli(
  bb: BbPluginApi,
  browser: BrowserService,
  argv: string[],
  context: PluginCliContext,
) {
  const action = argv[0];
  if (action === undefined) {
    return { exitCode: 1, stderr: DOWNLOADS_CLI_USAGE };
  }
  let downloadId: string | undefined;
  let environmentId: string | undefined;
  let relativePath: string | undefined;
  let actor: "owner" | "agent" | undefined;
  let profileId: string | undefined;
  let hostId: string | undefined;
  let overwrite = false;
  let maxFileBytes: number | undefined;
  let maxProfileBytes: number | undefined;
  let expiryMs: number | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (argument === "--download-id") {
      const option = readDownloadsOption(argv, index, "--download-id");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      downloadId = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--environment") {
      const option = readDownloadsOption(argv, index, "--environment");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      environmentId = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--path") {
      const option = readDownloadsOption(argv, index, "--path");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      relativePath = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--actor") {
      const option = readDownloadsOption(argv, index, "--actor");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      actor = option.value as "owner" | "agent";
      index = option.nextIndex;
      continue;
    }
    if (argument === "--profile") {
      const option = readDownloadsOption(argv, index, "--profile");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      profileId = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--host") {
      const option = readDownloadsOption(argv, index, "--host");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      hostId = option.value;
      index = option.nextIndex;
      continue;
    }
    if (argument === "--max-file-bytes") {
      const option = readDownloadsOption(argv, index, "--max-file-bytes");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      maxFileBytes = Number(option.value);
      index = option.nextIndex;
      continue;
    }
    if (argument === "--max-profile-bytes") {
      const option = readDownloadsOption(argv, index, "--max-profile-bytes");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      maxProfileBytes = Number(option.value);
      index = option.nextIndex;
      continue;
    }
    if (argument === "--expiry-ms") {
      const option = readDownloadsOption(argv, index, "--expiry-ms");
      if ("error" in option) return { exitCode: 1, stderr: option.error };
      expiryMs = Number(option.value);
      index = option.nextIndex;
      continue;
    }
    return {
      exitCode: 1,
      stderr: `Unknown option: ${argument}.\n${DOWNLOADS_CLI_USAGE}`,
    };
  }
  try {
    const target = await browser.resolveTarget(context, profileId, hostId);
    if (action === "list") {
      const result = await browser.downloadList(
        { hostId: target.hostId, profileId: target.profileId },
        context.signal,
      );
      const text =
        result.downloads.length === 0
          ? "No quarantined downloads."
          : result.downloads
              .map(
                (d) =>
                  `${d.downloadId}: ${d.phase} ${d.safeName} (${d.sizeBytes} bytes, expires ${d.expiresAt})`,
              )
              .join("\n");
      return { exitCode: 0, stdout: cliJsonOrText(json, result, text) };
    }
    if (action === "progress") {
      if (downloadId === undefined) {
        return {
          exitCode: 1,
          stderr: `progress requires --download-id.\n${DOWNLOADS_CLI_USAGE}`,
        };
      }
      const result = await browser.downloadProgress(
        downloadId,
        target.hostId,
        context.signal,
      );
      const text =
        result === null
          ? `Download ${downloadId}: not found.`
          : `Download ${result.downloadId}: ${result.phase} (${result.bytesDownloaded}${result.totalBytes === null ? "" : `/${result.totalBytes}`} bytes).`;
      return { exitCode: 0, stdout: cliJsonOrText(json, result ?? {}, text) };
    }
    if (action === "cancel") {
      if (downloadId === undefined) {
        return {
          exitCode: 1,
          stderr: `cancel requires --download-id.\n${DOWNLOADS_CLI_USAGE}`,
        };
      }
      const outcome = await browser.downloadCancel(
        { hostId: target.hostId, downloadId },
        context.signal,
      );
      return {
        exitCode: outcome.outcome === "cancelled" ? 0 : 1,
        stdout: cliJsonOrText(
          json,
          outcome,
          `Download ${downloadId}: ${outcome.outcome}.`,
        ),
      };
    }
    if (action === "export-client") {
      if (downloadId === undefined) {
        return {
          exitCode: 1,
          stderr: `export-client requires --download-id.\n${DOWNLOADS_CLI_USAGE}`,
        };
      }
      const outcome = await browser.downloadExportClient(
        {
          hostId: target.hostId,
          downloadId,
          profileId: target.profileId,
          ...(actor === undefined ? {} : { actor }),
        },
        context.signal,
      );
      const text =
        outcome.outcome === "exported"
          ? `Download ${outcome.downloadId}: exported to client (${outcome.sizeBytes} bytes).`
          : `Download ${outcome.downloadId}: rejected (${outcome.reason}).`;
      return {
        exitCode: outcome.outcome === "exported" ? 0 : 1,
        stdout: cliJsonOrText(json, outcome, text),
      };
    }
    if (action === "export-workspace") {
      if (downloadId === undefined) {
        return {
          exitCode: 1,
          stderr: `export-workspace requires --download-id.\n${DOWNLOADS_CLI_USAGE}`,
        };
      }
      if (environmentId === undefined || relativePath === undefined) {
        return {
          exitCode: 1,
          stderr: `export-workspace requires --environment and --path.\n${DOWNLOADS_CLI_USAGE}`,
        };
      }
      const environment = await bb.sdk.environments.get({
        environmentId,
        signal: context.signal,
      });
      if (environment.path === null) {
        return {
          exitCode: 1,
          stderr: `Environment ${environmentId} has no workspace path.`,
        };
      }
      const outcome = await browser.downloadExportWorkspace(
        {
          hostId: target.hostId,
          downloadId,
          profileId: target.profileId,
          environmentRoot: environment.path,
          relativePath,
          overwriteConfirmed: overwrite || undefined,
          ...(actor === undefined ? {} : { actor }),
        },
        context.signal,
      );
      const text =
        outcome.outcome === "exported"
          ? `Download ${outcome.downloadId}: exported to workspace (${outcome.sizeBytes} bytes).`
          : `Download ${outcome.downloadId}: rejected (${outcome.reason}).`;
      return {
        exitCode: outcome.outcome === "exported" ? 0 : 1,
        stdout: cliJsonOrText(json, outcome, text),
      };
    }
    if (action === "limits") {
      const limits = await browser.downloadLimits(
        {
          hostId: target.hostId,
          profileId: target.profileId,
          ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
          ...(maxProfileBytes === undefined ? {} : { maxProfileBytes }),
          ...(expiryMs === undefined ? {} : { expiryMs }),
        },
        context.signal,
      );
      const text = `Limits: max file ${limits.maxFileBytes} bytes, max profile ${limits.maxProfileBytes} bytes, expiry ${limits.expiryMs} ms.`;
      return { exitCode: 0, stdout: cliJsonOrText(json, limits, text) };
    }
    if (action === "purge") {
      const outcome = await browser.downloadPurge(
        {
          hostId: target.hostId,
          ...(target.profileId ? { profileId: target.profileId } : {}),
        },
        context.signal,
      );
      return {
        exitCode: 0,
        stdout: cliJsonOrText(
          json,
          outcome,
          `Purged ${outcome.removed} download${outcome.removed === 1 ? "" : "s"}.`,
        ),
      };
    }
    return { exitCode: 1, stderr: DOWNLOADS_CLI_USAGE };
  } catch (error) {
    if (error instanceof Error) return { exitCode: 1, stderr: error.message };
    throw error;
  }
}

function toolFailure(failure: BrowserScriptFailure) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(failure) }],
    isError: true,
  };
}

function toolSuccess(browserResult: unknown) {
  const parsed = browserScriptResultSchema.safeParse(browserResult);
  if (parsed.success) {
    return {
      content: [
        { type: "text" as const, text: parsed.data.output },
        ...parsed.data.screenshots.map((screenshot) => ({
          type: "image" as const,
          data: screenshot.data,
          mimeType: screenshot.mimeType,
        })),
      ],
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: browserScriptText(browserResult),
      },
    ],
  };
}

async function runBrowserScript(
  browser: BrowserService,
  parameters: BrowserScriptParameters,
  context: PluginAgentToolContext,
) {
  const response: BrowserScriptResponse = await browser.browserScript(
    parameters,
    context,
  );
  return response.ok ? toolSuccess(response.result) : toolFailure(response);
}

function registerCli(bb: BbPluginApi, browser: BrowserService) {
  bb.cli.register({
    name: "browser",
    summary: "Inspect and manage Browser host state",
    commands: [
      {
        name: "open",
        summary: "Open an authorized URL",
        usage:
          "bb browser open <url> [--profile <id>] [--timeout <ms>] [--screenshot] [--json]",
      },
      {
        name: "trust",
        summary: "Grant administration requires authenticated Browser Settings",
        usage: "Open Browser Settings in BB to manage Profile Grants",
      },
      {
        name: "untrust",
        summary: "Grant administration requires authenticated Browser Settings",
        usage: "Open Browser Settings in BB to manage Profile Grants",
      },
      {
        name: "grants",
        summary: "Grant administration requires authenticated Browser Settings",
        usage: "Open Browser Settings in BB to inspect Profile Grants",
      },
      {
        name: "grant",
        summary: "Grant administration requires authenticated Browser Settings",
        usage: "Open Browser Settings in BB to create Profile Grants",
      },
      {
        name: "revoke",
        summary: "Grant administration requires authenticated Browser Settings",
        usage: "Open Browser Settings in BB to revoke Profile Grants",
      },
      {
        name: "approve",
        summary: "Grant administration requires authenticated Browser Settings",
        usage: "Open Browser Settings in BB to approve Grant Requests",
      },
      {
        name: "deny",
        summary: "Grant administration requires authenticated Browser Settings",
        usage: "Open Browser Settings in BB to deny Grant Requests",
      },
      {
        name: "status",
        summary: "Report Browser host readiness",
        usage: "bb browser status [--profile <id>] [--host <id>] [--json]",
      },
      {
        name: "diagnostics",
        summary: "Generate redacted Browser host diagnostics",
        usage: "bb browser diagnostics [--profile <id>] [--host <id>] [--json]",
      },
      {
        name: "script",
        summary: "Run bounded Playwright code in the host-local Browser",
        usage:
          "bb browser script --purpose <text> --code <source> --origin <origin> [--profile <id>] [--tab <id>] [--timeout <ms>] [--screenshot] [--file-transfer] [--invalid-certificate] [--json]",
      },
      {
        name: "activity",
        summary: "List retained Browser activity records",
        usage: "bb browser activity [--profile <id>] [--host <id>] [--json]",
      },
      {
        name: "activity-export",
        summary: "Export retained Browser activity metadata",
        usage:
          "bb browser activity-export [--profile <id>] [--host <id>] [--json]",
      },
      {
        name: "activity-clear",
        summary: "Clear retained Browser activity metadata",
        usage:
          'bb browser activity-clear [--profile <id>] [--host <id>] --confirm "Clear Browser activity records" [--json]',
      },
      {
        name: "requests",
        summary: "List Browser Grant Requests",
        usage: "bb browser requests [--json]",
      },
      {
        name: "request-status",
        summary: "Inspect a Browser Grant Request",
        usage: "bb browser request-status --request <id> [--json]",
      },
      {
        name: "list",
        summary: "List host-local Browser Profiles",
        usage: "bb browser list [--host <id>] [--json]",
      },
      {
        name: "create",
        summary: "Create a host-local Browser Profile",
        usage:
          "bb browser create --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]",
      },
      {
        name: "rename",
        summary: "Rename a host-local Browser Profile",
        usage:
          "bb browser rename --profile <id> --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]",
      },
      {
        name: "select",
        summary: "Select a host-local Browser Profile",
        usage: "bb browser select --profile <id> [--host <id>] [--json]",
      },
      {
        name: "backup",
        summary: "Create a stopped Browser Profile backup",
        usage:
          "bb browser backup --profile <id> --archive <path> [--host <id>] [--json]",
      },
      {
        name: "restore",
        summary: "Restore a stopped Browser Profile backup",
        usage:
          "bb browser restore --profile <id> --archive <path> [--host <id>] [--json]",
      },
      {
        name: PROFILE_IMPORT_COMMAND,
        summary: "Import a stopped dev-browser profile",
        usage:
          "bb browser import --name <name> --source <path> [--host <id>] [--json]",
      },
      {
        name: "archive",
        summary:
          "Show Archived Profile state; mutation requires owner Settings",
        usage: "bb browser archive --profile <id> [--host <id>] [--json]",
      },
      {
        name: "restore-archived",
        summary: "Restore within 30 days through authenticated owner Settings",
        usage:
          "bb browser restore-archived --profile <id> [--host <id>] [--json]",
      },
      {
        name: "reset",
        summary: "Reset credentials through authenticated owner Settings",
        usage:
          "bb browser reset --profile <id> --confirm <text> [--host <id>] [--json]",
      },
      {
        name: "delete",
        summary: "Permanently delete through authenticated owner Settings",
        usage:
          "bb browser delete --profile <id> --confirm <name> [--host <id>] [--json]",
      },
      {
        name: "setup",
        summary: "Show or apply the consent-gated Browser setup plan",
        usage: "bb browser setup [--step <id> --confirm <text>] [--json]",
      },
      {
        name: "disable",
        summary: "Stop Browser-owned processes and retain profiles",
        usage: 'bb browser disable --confirm "Stop Browser processes"',
      },
      {
        name: "uninstall",
        summary: "Stop Browser-owned processes and retain profiles",
        usage: 'bb browser uninstall --confirm "Stop Browser processes"',
      },
      {
        name: "purge",
        summary: "Show or apply the destructive Browser purge plan",
        usage: "bb browser purge [--confirm <text>] [--json]",
      },
      {
        name: "transfer",
        summary: "Stage, cancel, or watch a workspace/client file transfer",
        usage:
          "bb browser transfer --kind workspace --environment <id> --path <relative-path> | --kind client --file <local-path> | --cancel --transfer-id <id> | --progress --transfer-id <id> [--json]",
      },
    ],
    run: (argv, context) => runCli(bb, browser, argv, context),
  });
}

function registerAgentTool(bb: BbPluginApi, browser: BrowserService) {
  bb.agents.registerTool({
    name: "browser_script",
    description:
      "Run Playwright code in the host-local Workspace Browser. Pass destinationOrigin as an exact origin such as https://example.com. The script gets `page` for the active tab; returned values become the tool result.",
    instructions:
      "Provide a purpose, an exact destinationOrigin, and QuickJS Playwright code. `page` is the active tab. `return` values become the result. Report typed failures without retrying setup.",
    presentation: {
      label: {
        pending: "Running browser script",
        completed: "Ran browser script",
      },
      icon: { glyph: "Globe" },
    },
    parameters: browserScriptParametersSchema,
    execute: (parameters, context) =>
      runBrowserScript(browser, parameters, context),
  });
}

export default function plugin(bb: BbPluginApi) {
  const ownerAuthority = Symbol("browser-owner-settings");
  const browser = createBrowserService(bb, ownerAuthority);
  bb.rpc.register(rpcContract, {
    browser_status: (input) =>
      input.profileSelection === "selected"
        ? browser.selectedStatus(panelIdentity(input))
        : browser.status(panelIdentity(input), input.profileId),
    browser_navigate: (input) => browser.navigate(input),
    browser_history: (input) => browser.history(input),
    browser_panel_visibility: (input) => browser.panelVisibility(input),
    browser_panel_capability: (input) => browser.panelCapability(input),
    browser_panel_release: (input) => browser.panelRelease(input),
    browser_tabs: (input) => browser.tabs(input),
    browser_tab_action: (input) => browser.tabAction(input),
    browser_panel_control: (input) => browser.panelControl(input),
    browser_panel_take_control: (input) => browser.takeControl(input),
    browser_panel_release_control: (input) => browser.releaseControl(input),
    browser_panel_reclaim_control: (input) => browser.reclaimControl(input),
    browser_settings_status: (input) =>
      browser.settingsStatuses(input.profileId),
    browser_diagnostics: (input) => browser.diagnostics(input),
    browser_activity_records: (input) => browser.activityRecords(input),
    browser_activity_export: (input) => browser.exportActivityRecords(input),
    browser_activity_clear: (input) => browser.clearActivityRecords(input),
    browser_setup_plan: (input) => browser.setupPlan(input),
    browser_setup: (input) => browser.setup(input),
    browser_disable: (input) => browser.lifecycle("disable", input),
    browser_uninstall: (input) => browser.lifecycle("uninstall", input),
    browser_purge_plan: (input) => browser.purgePlan(input),
    browser_purge: (input) => browser.purge(input),
    browser_profiles: (input) => browser.profiles(input),
    browser_grants: (input) => browser.grants(ownerAuthority, input),
    browser_grant_create: (input) => browser.createGrant(ownerAuthority, input),
    browser_grant_inspect: (input) =>
      browser.inspectGrant(ownerAuthority, input.grantId),
    browser_grant_revoke: (input) => browser.revokeGrant(ownerAuthority, input),
    browser_grant_requests: (input) =>
      browser.listGrantRequests(ownerAuthority, input),
    browser_grant_request_inspect: (input) =>
      browser.inspectGrantRequest(ownerAuthority, input.requestId),
    browser_grant_request_decide: (input) =>
      browser.decideGrantRequest(ownerAuthority, input),
    browser_grant_request_revoke: (input) =>
      browser.revokeGrantRequest(ownerAuthority, input.requestId),
    browser_profile_create: (input) => browser.createProfile(input),
    browser_profile_rename: (input) => browser.renameProfile(input),
    browser_profile_select: (input) => browser.selectProfile(input),
    browser_profile_archive: (input) =>
      browser.archiveProfile(ownerAuthority, input),
    browser_profile_restore_archived: (input) =>
      browser.restoreArchivedProfile(ownerAuthority, input),
    browser_profile_reset: (input) =>
      browser.resetProfile(ownerAuthority, input),
    browser_profile_delete: (input) =>
      browser.deleteProfile(ownerAuthority, input),
    browser_profile_backup: (input) => browser.backupProfile(input),
    browser_profile_restore: (input) => browser.restoreProfile(input),
    browser_profile_import: (input) => browser.importProfile(input),
    browser_transfer_stage: (input) => browser.transferStage(input),
    browser_transfer_consume: (input) =>
      browser.transferConsume(input.transferId, input.hostId),
    browser_transfer_release: (input) =>
      browser.transferRelease(input.transferId, input.hostId),
    browser_transfer_cancel: (input) =>
      browser.transferCancel(input.transferId, input.hostId),
    browser_transfer_progress: (input) =>
      browser.transferProgress(input.transferId, input.hostId),
    browser_control_lease_state: (input) =>
      browser.controlLeaseState(input.hostId, input.profileId),
    browser_file_transfer_authorize: (input) =>
      browser.fileTransferAuthorization(input),
    browser_download_start: (input) => browser.downloadStart(input),
    browser_download_append: (input) => browser.downloadAppend(input),
    browser_download_complete: (input) => browser.downloadComplete(input),
    browser_download_fail: (input) => browser.downloadFail(input),
    browser_download_cancel: (input) => browser.downloadCancel(input),
    browser_download_list: (input) => browser.downloadList(input),
    browser_download_limits: (input) => browser.downloadLimits(input),
    browser_download_progress: (input) =>
      browser.downloadProgress(input.downloadId, input.hostId),
    browser_download_export_client: (input) =>
      browser.downloadExportClient(input),
    browser_download_export_workspace: (input) =>
      browser.downloadExportWorkspace(input),
    browser_download_purge: (input) => browser.downloadPurge(input),
    browser_host_choices: (input: BrowserHostChoicesInput) =>
      browser.hostChoices(input),
  });
  registerCli(bb, browser);
  registerAgentTool(bb, browser);
  bb.agents.configure(() => ({
    tools: ["browser_script"],
    skills: ["browser"],
  }));
}
