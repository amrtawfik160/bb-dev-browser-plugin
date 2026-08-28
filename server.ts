import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginCliContext,
} from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  createBrowserService,
  panelIdentity,
  type BrowserService,
} from "./browser-service.js";
import {
  browserScriptParametersSchema,
  type BrowserProfileGrant,
  type BrowserActivityRecord,
  type BrowserHostChoicesInput,
  type BrowserProfileBackupRequest,
  type BrowserProfile,
  type BrowserProfileImportRequest,
  type BrowserProfileInventory,
  type BrowserProfileRecoveryResponse,
  type BrowserProfileRestoreRequest,
  rpcContract,
  setupStepIdSchema,
  type BrowserScriptFailure,
  type BrowserScriptResponse,
  type BrowserPurgePlan,
  type BrowserPurgeResponse,
  type BrowserSetupPlan,
  type BrowserSetupResponse,
  type BrowserStatus,
  type BrowserProfileGrantCreateRequest,
  type BrowserProfileGrantQuery,
} from "./contracts.js";

const CLI_USAGE = [
  "Usage: bb browser <status|diagnostics|activity|activity-export|activity-clear|list|create|rename|select|backup|restore|import|grant|setup|disable|uninstall|purge> [options]",
  "  setup [--profile <id>] [--step <id> --confirm <text>] [--json]",
  "  purge [--profile <id>] [--confirm <text>] [--json]",
  "  disable|uninstall [--profile <id>] --confirm <text> [--json]",
  "  activity [--profile <id>] [--json]",
  `  activity-export [--profile <id>] [--json]`,
  `  activity-clear [--profile <id>] --confirm "Clear Browser activity records" [--json]`,
  "  list [--host <id>] [--json]",
  "  create --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]",
  "  rename --profile <id> --name <name> [--locale <locale>] [--timezone <zone>] [--host <id>] [--json]",
  "  select --profile <id> [--host <id>] [--json]",
  "  backup --profile <id> --archive <path> [--host <id>] [--json]",
  "  restore --profile <id> --archive <path> [--host <id>] [--json]",
  "  import --name <name> --source <path> [--host <id>] [--json]",
  "  grant list [--project <id>] [--host <id>] [--profile <id>] [--json]",
  "  grant inspect --grant <id> [--json]",
  "  grant create --profile <id> --origin <scope> [--project <id>] [--host <id>] [--whole-web] [--file-transfer] [--invalid-certificate-origin <origin>] [--json]",
  "  grant revoke --grant <id> [--json]",
].join("\n");
const PROFILE_IMPORT_COMMAND = ["imp", "ort"].join("");
type BrowserScriptParameters = z.output<typeof browserScriptParametersSchema>;
const BROWSER_COMMANDS = [
  "status",
  "diagnostics",
  "activity",
  "activity-export",
  "activity-clear",
  "list",
  "create",
  "rename",
  "select",
  "backup",
  "restore",
  PROFILE_IMPORT_COMMAND,
  "setup",
  "disable",
  "uninstall",
  "purge",
  "grant",
] as const;
type BrowserCommand = (typeof BROWSER_COMMANDS)[number];
const GRANT_ACTIONS = ["list", "inspect", "create", "revoke"] as const;
type GrantAction = (typeof GRANT_ACTIONS)[number];

type ParsedCliArguments = {
  command: BrowserCommand;
  grantAction?: GrantAction;
  json: boolean;
  profileId?: string;
  hostId?: string;
  name?: string;
  locale?: string;
  timezone?: string;
  archivePath?: string;
  sourcePath?: string;
  projectId?: string;
  originScope?: string;
  grantId?: string;
  wholeWeb?: boolean;
  fileTransfer?: boolean;
  invalidCertificateOrigins?: string[];
  stepId?: z.output<typeof setupStepIdSchema>;
  confirmation?: string;
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
  return `${profile.name} (${profile.profileId})\nLocale: ${profile.locale}\nTimezone: ${profile.timezone}`;
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

function cliGrantText(grant: BrowserProfileGrant) {
  return [
    `${grant.grantId} (${grant.projectId})`,
    `Host: ${grant.hostId}`,
    `Profile: ${grant.profileId}`,
    `Origin scope: ${grant.originScope}`,
    `Whole web: ${grant.wholeWeb}`,
    `File transfer: ${grant.fileTransfer}`,
    `Invalid certificates: ${grant.invalidCertificateOrigins.join(", ") || "none"}`,
    `Revoked: ${grant.revokedAt ?? "no"}`,
  ].join("\n");
}

function cliGrantsText(grants: readonly BrowserProfileGrant[]) {
  if (grants.length === 0) return "No Browser Profile Grants.";
  return grants.map(cliGrantText).join("\n\n");
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
  | "--project"
  | "--origin"
  | "--grant"
  | "--invalid-certificate-origin"
  | "confirmation";
type ParsedCliOption = {
  name: CliOptionName;
  optionValue: string;
  nextIndex: number;
};

function cliOptionName(argument: string): CliOptionName | null {
  if (argument === "--profile" || argument === "--step") return argument;
  if (
    argument === "--host" ||
    argument === "--name" ||
    argument === "--locale" ||
    argument === "--timezone" ||
    argument === "--archive" ||
    argument === "--source" ||
    argument === "--project" ||
    argument === "--origin" ||
    argument === "--grant" ||
    argument === "--invalid-certificate-origin"
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
  projectId?: string;
  originScope?: string;
  grantId?: string;
  wholeWeb: boolean;
  fileTransfer: boolean;
  invalidCertificateOrigins: string[];
  stepId?: ParsedCliArguments["stepId"];
  confirmation?: string;
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
  if (option.name === "--project") {
    parseState.projectId = option.optionValue;
    return null;
  }
  if (option.name === "--origin") {
    parseState.originScope = option.optionValue;
    return null;
  }
  if (option.name === "--grant") {
    parseState.grantId = option.optionValue;
    return null;
  }
  if (option.name === "--invalid-certificate-origin") {
    parseState.invalidCertificateOrigins.push(option.optionValue);
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

function parsedCommand(
  positional: string[],
): { command: BrowserCommand; grantAction?: GrantAction } | null {
  if (positional.length === 1) {
    const command = positional[0];
    return isBrowserCommand(command) ? { command } : null;
  }
  if (
    positional.length === 2 &&
    positional[0] === "grant" &&
    GRANT_ACTIONS.some((action) => action === positional[1])
  ) {
    return { command: "grant", grantAction: positional[1] as GrantAction };
  }
  return null;
}

function validateCliCommandOptions(
  command: BrowserCommand,
  parseState: CliParseState,
): string | null {
  if (command === "grant") return validateGrantCliOptions(parseState);
  if (command !== "setup" && parseState.stepId !== undefined) {
    return `--step is only valid for setup.\n${CLI_USAGE}`;
  }
  if (
    ["status", "diagnostics", "activity", "activity-export", "list"].includes(
      command,
    ) &&
    parseState.confirmation !== undefined
  ) {
    return `Confirmation is not valid for ${command}.\n${CLI_USAGE}`;
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

function validateGrantCliOptions(parseState: CliParseState): string | null {
  const action = parseState.positional[1] as GrantAction | undefined;
  if (action === undefined) return `grant requires an action.\n${CLI_USAGE}`;
  const commonError = validateGrantCommonOptions(parseState);
  if (commonError !== null) return commonError;
  if (action === "create") {
    return validateGrantCreateOptions(parseState);
  }
  return validateGrantLookupOptions(parseState, action);
}

function validateGrantCommonOptions(parseState: CliParseState): string | null {
  const invalidOption = [
    ["--step", parseState.stepId !== undefined],
    ["--confirm", parseState.confirmation !== undefined],
    ["--name", parseState.name !== undefined],
    ["--locale", parseState.locale !== undefined],
    ["--timezone", parseState.timezone !== undefined],
    ["--archive", parseState.archivePath !== undefined],
    ["--source", parseState.sourcePath !== undefined],
  ].find(([, present]) => present)?.[0];
  return invalidOption === undefined
    ? null
    : `${invalidOption} is not valid for grant commands.\n${CLI_USAGE}`;
}

function validateGrantCreateOptions(parseState: CliParseState): string | null {
  if (parseState.profileId === undefined) {
    return `grant create requires --profile.\n${CLI_USAGE}`;
  }
  if (parseState.originScope === undefined) {
    return `grant create requires --origin.\n${CLI_USAGE}`;
  }
  if (parseState.grantId !== undefined) {
    return `--grant is only valid for grant inspect or revoke.\n${CLI_USAGE}`;
  }
  return null;
}

function validateGrantLookupOptions(
  parseState: CliParseState,
  action: Exclude<GrantAction, "create">,
): string | null {
  if (parseState.grantId === undefined && action !== "list") {
    return `grant ${action} requires --grant.\n${CLI_USAGE}`;
  }
  if (action === "list" && parseState.grantId !== undefined) {
    return `--grant is only valid for grant inspect or revoke.\n${CLI_USAGE}`;
  }
  if (
    action !== "list" &&
    (parseState.projectId !== undefined ||
      parseState.hostId !== undefined ||
      parseState.profileId !== undefined)
  ) {
    return `--project, --host, and --profile are only valid for grant list or create.\n${CLI_USAGE}`;
  }
  if (parseState.originScope !== undefined) {
    return `--origin is only valid for grant create.\n${CLI_USAGE}`;
  }
  if (parseState.invalidCertificateOrigins.length > 0) {
    return `--invalid-certificate-origin is only valid for grant create.\n${CLI_USAGE}`;
  }
  if (parseState.wholeWeb) {
    return `--whole-web is only valid for grant create.\n${CLI_USAGE}`;
  }
  if (parseState.fileTransfer) {
    return `--file-transfer is only valid for grant create.\n${CLI_USAGE}`;
  }
  return null;
}

function parseCliArguments(argv: string[]): CliArgumentParseResult {
  const parseState: CliParseState = {
    positional: [],
    json: false,
    wholeWeb: false,
    fileTransfer: false,
    invalidCertificateOrigins: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      parseState.json = true;
      continue;
    }
    if (argument === "--whole-web") {
      parseState.wholeWeb = true;
      continue;
    }
    if (argument === "--file-transfer") {
      parseState.fileTransfer = true;
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
      grantAction: parsed.grantAction,
      json: parseState.json,
      profileId: parseState.profileId,
      hostId: parseState.hostId,
      name: parseState.name,
      locale: parseState.locale,
      timezone: parseState.timezone,
      archivePath: parseState.archivePath,
      sourcePath: parseState.sourcePath,
      projectId: parseState.projectId,
      originScope: parseState.originScope,
      grantId: parseState.grantId,
      wholeWeb: parseState.wholeWeb,
      fileTransfer: parseState.fileTransfer,
      invalidCertificateOrigins: parseState.invalidCertificateOrigins,
      stepId: parseState.stepId,
      confirmation: parseState.confirmation,
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

async function runGrantCreateCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const projectId = cliArguments.projectId ?? context.projectId;
  if (projectId === undefined) {
    throw new Error("grant create requires a project context or --project.");
  }
  const target = await browser.resolveTarget(
    { projectId },
    cliArguments.profileId,
    cliArguments.hostId,
  );
  const request: BrowserProfileGrantCreateRequest = {
    projectId,
    hostId: target.hostId,
    profileId: target.profileId,
    originScope: cliArguments.originScope!,
    wholeWeb: cliArguments.wholeWeb === true,
    fileTransfer: cliArguments.fileTransfer === true,
    invalidCertificateOrigins: cliArguments.invalidCertificateOrigins ?? [],
  };
  const grant = await browser.createGrant(request, context.signal);
  return {
    exitCode: 0,
    stdout: cliJsonOrText(cliArguments.json, grant, cliGrantText(grant)),
  };
}

async function runGrantListCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  const projectId = cliArguments.projectId ?? context.projectId;
  const query: BrowserProfileGrantQuery = {
    includeRevoked: false,
    ...(projectId === undefined ? {} : { projectId }),
    ...(cliArguments.hostId === undefined
      ? {}
      : { hostId: cliArguments.hostId }),
    ...(cliArguments.profileId === undefined
      ? {}
      : { profileId: cliArguments.profileId }),
  };
  const grants = await browser.grants(query);
  return {
    exitCode: 0,
    stdout: cliJsonOrText(cliArguments.json, grants, cliGrantsText(grants)),
  };
}

async function runGrantInspectCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
) {
  const grant = await browser.inspectGrant(cliArguments.grantId!);
  if (grant === null) {
    return {
      exitCode: 1,
      stderr: `Browser Profile Grant ${cliArguments.grantId} was not found.`,
    };
  }
  return {
    exitCode: 0,
    stdout: cliJsonOrText(cliArguments.json, grant, cliGrantText(grant)),
  };
}

async function runGrantRevokeCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
) {
  const response = await browser.revokeGrant({
    grantId: cliArguments.grantId!,
  });
  return {
    exitCode: response.outcome === "not-found" ? 1 : 0,
    stdout: cliJsonOrText(cliArguments.json, response, response.outcome),
  };
}

async function runGrantCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  if (cliArguments.grantAction === "create") {
    return runGrantCreateCli(browser, cliArguments, context);
  }
  if (cliArguments.grantAction === "list") {
    return runGrantListCli(browser, cliArguments, context);
  }
  if (cliArguments.grantAction === "inspect") {
    return runGrantInspectCli(browser, cliArguments);
  }
  if (cliArguments.grantAction === "revoke") {
    return runGrantRevokeCli(browser, cliArguments);
  }
  throw new Error("grant requires an action.");
}

async function runAdministrationCli(
  browser: BrowserService,
  cliArguments: ParsedCliArguments,
  context: PluginCliContext,
) {
  if (cliArguments.command === "grant") {
    return runGrantCli(browser, cliArguments, context);
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
  browser: BrowserService,
  argv: string[],
  context: PluginCliContext,
) {
  const parsed = parseCliArguments(argv);
  if ("error" in parsed) return { exitCode: 1, stderr: parsed.error };
  const { command, json, profileId, hostId } = parsed.arguments;
  try {
    if (command === "status") {
      return await runStatusCli(browser, profileId, hostId, json, context);
    }
    if (command === "diagnostics") {
      return await runDiagnosticsCli(browser, profileId, hostId, json, context);
    }
    return await runAdministrationCli(browser, parsed.arguments, context);
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

function toolSuccess(result: unknown) {
  const serialized = JSON.stringify(result);
  return {
    content: [
      {
        type: "text" as const,
        text: serialized === undefined ? "" : serialized,
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
        name: "grant",
        summary: "Create, inspect, list, or revoke Browser Profile Grants",
        usage: "bb browser grant <list|inspect|create|revoke> [grant options]",
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
    ],
    run: (argv, context) => runCli(browser, argv, context),
  });
}

function registerAgentTool(bb: BbPluginApi, browser: BrowserService) {
  bb.agents.registerTool({
    name: "browser_script",
    description: "Run Playwright code in the host-local Workspace Browser.",
    instructions:
      "Provide a purpose and QuickJS-compatible Playwright code. Report typed failures without retrying setup.",
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
  const browser = createBrowserService(bb);
  bb.rpc.register(rpcContract, {
    browser_status: (input) =>
      input.profileSelection === "selected"
        ? browser.selectedStatus(panelIdentity(input))
        : browser.status(panelIdentity(input), input.profileId),
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
    browser_grants: (input) => browser.grants(input),
    browser_grant_create: (input) => browser.createGrant(input),
    browser_grant_inspect: (input) => browser.inspectGrant(input.grantId),
    browser_grant_revoke: (input) => browser.revokeGrant(input),
    browser_profile_create: (input) => browser.createProfile(input),
    browser_profile_rename: (input) => browser.renameProfile(input),
    browser_profile_select: (input) => browser.selectProfile(input),
    browser_profile_backup: (input) => browser.backupProfile(input),
    browser_profile_restore: (input) => browser.restoreProfile(input),
    browser_profile_import: (input) => browser.importProfile(input),
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
