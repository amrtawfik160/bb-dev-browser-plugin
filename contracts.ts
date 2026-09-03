import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_PROFILE_ID = "bb-personal";
export const PROFILE_MANIFEST_VERSION = 1 as const;
export const PROFILE_DEFAULT_LOCALE = "en-US";
export const PROFILE_DEFAULT_TIMEZONE = "UTC";
export const SETUP_REQUIRED_MESSAGE =
  "Browser host setup has not been completed.";
export const BROWSER_STORAGE_ROOT = "/var/lib/bb-browser";
export const BROWSER_CONFIGURATION_ROOT = "/etc/bb-browser";
export const STOP_BROWSER_CONFIRMATION = "Stop Browser processes";
export const CLEAR_ACTIVITY_CONFIRMATION = "Clear Browser activity records";
export const RESET_PROFILE_CONFIRMATION =
  "Lose saved sessions and reset this Browser Profile";
export const PROFILE_ARCHIVE_RETENTION_DAYS = 30;
export const ACTIVITY_RECORD_LIMIT = 10_000;
export const ACTIVITY_RETENTION_DAYS = 30;
export const ACTIVITY_OUTBOX_BATCH_LIMIT = 100;
export const BROWSER_SCRIPT_MIN_TIMEOUT_MS = 1_000;
export const BROWSER_SCRIPT_MAX_TIMEOUT_MS = 30_000;
export const BROWSER_SCRIPT_RESULT_LIMIT_BYTES = 256 * 1024;
export const BROWSER_SCRIPT_MAX_SCREENSHOTS = 3;
export const BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES = 1 * 1024 * 1024;
export const BROWSER_SCRIPT_MAX_SCREENSHOT_BASE64_LENGTH =
  4 * Math.ceil(BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES / 3);

/**
 * Panel Capability transport constants (design §Transport). The capability is
 * single-use, expires unredeemed after 60 seconds, binds to one owner session,
 * panel instance, host, and profile, and is redeemed in the first WebSocket
 * message rather than placed in a URL. Connected authorization rotates every
 * five minutes and is revoked on panel close or profile switch.
 */
export const PANEL_CAPABILITY_TTL_MS = 60_000;
export const PANEL_AUTH_ROTATION_MS = 5 * 60_000;
export const PANEL_RECLAIM_WINDOW_MS = 10_000;
export const PANEL_MAX_VIEWPORT_WIDTH = 1920;
export const PANEL_MAX_VIEWPORT_HEIGHT = 1080;
export const PANEL_MIN_FRAMES_PER_SECOND = 5;
export const PANEL_MAX_FRAMES_PER_SECOND = 15;
export const PANEL_GATEWAY_BIND_HOST = "127.0.0.1";
export const PANEL_PROTOCOL_VERSION = 1 as const;
export const PANEL_GATEWAY_MESSAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PANEL_GATEWAY_INPUT_MAX_PER_SECOND = 60;
export const PANEL_GATEWAY_BANDWIDTH_BYTES_PER_SECOND =
  PANEL_MAX_FRAMES_PER_SECOND * PANEL_GATEWAY_MESSAGE_MAX_BYTES;
export const PANEL_RECONNECT_INITIAL_BACKOFF_MS = 500;
export const PANEL_RECONNECT_MAX_BACKOFF_MS = 8_000;

/**
 * Transfer Staging constants (issue #19). One-use host storage brokers an
 * explicitly selected file between a workspace or displaying client and a
 * Workspace Browser without granting browser processes direct repository
 * access. The defaults mirror Host Download quotas: 1 GiB per file and a
 * bounded staging lifetime so leftover data is reaped on use, cancellation,
 * failure, expiry, worker restart, or profile lifecycle operations.
 */
export const BROWSER_TRANSFER_MAX_FILE_BYTES = 1 * 1024 * 1024 * 1024;
export const BROWSER_TRANSFER_STAGING_TTL_MS = 5 * 60_000;
export const BROWSER_TRANSFER_LOW_DISK_MARGIN_BYTES = 16 * 1024 * 1024;
export const BROWSER_TRANSFER_STAGING_DIR_MODE = 0o700;
export const BROWSER_TRANSFER_STAGING_FILE_MODE = 0o600;
/** Maximum text the explicit clipboard exchange carries per action. */
export const BROWSER_CLIPBOARD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Host Downloads constants (issue #20). Browser downloads enter a
 * profile-scoped Host Downloads quarantine owned by `bb-browser` with
 * restrictive permissions (0600 file / 0700 directory) and are never opened,
 * executed, or exported automatically. Defaults are 1 GiB per file, 5 GiB per
 * profile, and a seven-day expiry; the owner may configure bounded limits. New
 * instances and downloads are refused below the host low-free-space threshold.
 */
export const BROWSER_DOWNLOAD_MAX_FILE_BYTES = 1 * 1024 * 1024 * 1024;
export const BROWSER_DOWNLOAD_MAX_PROFILE_BYTES = 5 * 1024 * 1024 * 1024;
export const BROWSER_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60_000;
export const BROWSER_DOWNLOAD_LOW_DISK_MARGIN_BYTES =
  BROWSER_TRANSFER_LOW_DISK_MARGIN_BYTES;
export const BROWSER_DOWNLOAD_DIR_MODE = 0o700;
export const BROWSER_DOWNLOAD_FILE_MODE = 0o600;
/** Upper bound the owner may raise a configured limit to. */
export const BROWSER_DOWNLOAD_MAX_FILE_BYTES_LIMIT = 16 * 1024 * 1024 * 1024;
export const BROWSER_DOWNLOAD_MAX_PROFILE_BYTES_LIMIT = 64 * 1024 * 1024 * 1024;
/** Smallest configured limit (1 byte) so an owner may effectively disable. */
export const BROWSER_DOWNLOAD_MIN_LIMIT_BYTES = 1;

export function browserHostStorageSegment(hostId: string) {
  return encodeURIComponent(hostId).replaceAll(".", "%2E");
}

export const SETUP_STEP_IDS = [
  "dedicated-user",
  "system-packages",
  "protected-storage",
] as const;

export const setupStepIdSchema = z.enum(SETUP_STEP_IDS);
export type SetupStepId = z.infer<typeof setupStepIdSchema>;

export const SETUP_STEP_DEFINITIONS = [
  {
    id: "dedicated-user",
    label: "Create the dedicated browser user",
    description:
      "Create bb-browser with a non-login shell and no administrative privileges.",
    confirmationText: "Create bb-browser",
  },
  {
    id: "system-packages",
    label: "Install Browser system packages",
    description:
      "Install the pinned Browser runtime and Safe Login display helpers.",
    confirmationText: "Install Browser packages",
  },
  {
    id: "protected-storage",
    label: "Configure protected Browser storage",
    description:
      "Create installation- and host-scoped storage owned only by bb-browser.",
    confirmationText: "Configure protected Browser storage",
  },
] as const satisfies readonly {
  id: SetupStepId;
  label: string;
  description: string;
  confirmationText: string;
}[];

export const browserSetupStepSchema = z
  .object({
    id: setupStepIdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    confirmationText: z.string().min(1),
    state: z.enum(["pending", "completed", "failed"]),
    failure: z.string().min(1).nullable(),
  })
  .strict();

export const browserSetupPlanSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    installationId: z.string().min(1),
    state: z.enum(["pending", "in-progress", "partial-failure", "ready"]),
    nextStepId: setupStepIdSchema.nullable(),
    storageRoot: z.string().min(1),
    hostStoragePath: z.string().min(1),
    storageOwner: z.literal("bb-browser"),
    storageMode: z.literal("0700"),
    configurationPath: z.string().min(1),
    runtime: z
      .object({
        runAsUser: z.literal("bb-browser"),
        homeDirectory: z.string().min(1),
        shell: z.literal("/usr/sbin/nologin"),
        sandbox: z.literal("required"),
        noSandbox: z.literal(false),
      })
      .strict(),
    packages: z
      .array(
        z
          .object({
            name: z.string().min(1),
            purpose: z.string().min(1),
          })
          .strict(),
      )
      .length(4),
    steps: z.array(browserSetupStepSchema).length(3),
  })
  .strict();

export const browserSetupRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    stepId: setupStepIdSchema,
    confirmation: z.string().min(1),
  })
  .strict();

export const browserSetupResponseSchema = z
  .object({
    outcome: z.enum([
      "confirmation-required",
      "blocked",
      "progressed",
      "completed",
      "already-complete",
      "partial-failure",
    ]),
    message: z.string().min(1),
    plan: browserSetupPlanSchema,
  })
  .strict();

export const browserLifecycleRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    confirmation: z.string().min(1),
  })
  .strict();

export const browserLifecycleResponseSchema = z
  .object({
    action: z.enum(["disable", "uninstall"]),
    outcome: z.enum([
      "confirmation-required",
      "stopped",
      "already-stopped",
      "failed",
    ]),
    message: z.string().min(1),
    confirmationText: z.string().min(1),
    profilesRetained: z.literal(true),
  })
  .strict();

export const browserPurgeTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("processes"),
      id: z.literal("stop-owned-processes"),
      scope: z.literal("Browser-owned processes"),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser-data"),
      id: z.literal("browser-data"),
      path: z.string().min(1),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("configuration"),
      id: z.literal("configuration"),
      path: z.string().min(1),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system-user"),
      id: z.literal("dedicated-user"),
      username: z.literal("bb-browser"),
      state: z.enum(["pending", "completed", "failed"]),
      failure: z.string().min(1).nullable(),
    })
    .strict(),
]);

export const browserPurgePlanSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    installationId: z.string().min(1),
    state: z.enum(["pending", "in-progress", "partial-failure", "purged"]),
    confirmationText: z.string().min(1),
    targets: z.array(browserPurgeTargetSchema).length(4),
  })
  .strict();

export const browserPurgeRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    confirmation: z.string().min(1),
  })
  .strict();

export const browserPurgeResponseSchema = z
  .object({
    outcome: z.enum([
      "confirmation-required",
      "progressed",
      "purged",
      "already-purged",
      "partial-failure",
    ]),
    message: z.string().min(1),
    plan: browserPurgePlanSchema,
  })
  .strict();

export type BrowserSetupPlan = z.infer<typeof browserSetupPlanSchema>;
export type BrowserSetupRequest = z.infer<typeof browserSetupRequestSchema>;
export type BrowserSetupResponse = z.infer<typeof browserSetupResponseSchema>;
export type BrowserLifecycleRequest = z.infer<
  typeof browserLifecycleRequestSchema
>;
export type BrowserLifecycleResponse = z.infer<
  typeof browserLifecycleResponseSchema
>;
export type BrowserPurgePlan = z.infer<typeof browserPurgePlanSchema>;
export type BrowserPurgeRequest = z.infer<typeof browserPurgeRequestSchema>;
export type BrowserPurgeResponse = z.infer<typeof browserPurgeResponseSchema>;

export const browserProfileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
export const browserProfileNameSchema = z.string().trim().min(1).max(80);
export const browserProfileLocaleSchema = z.string().trim().min(2).max(64);
export const browserProfileTimezoneSchema = z.string().trim().min(1).max(128);

export const browserProfileStartupSchema = z
  .object({
    initialTabUrl: z.literal("about:blank"),
    suppressWelcome: z.literal(true),
    chromeArguments: z.tuple([
      z.literal("--no-first-run"),
      z.literal("--no-default-browser-check"),
    ]),
  })
  .strict();

export const browserProfileStorageSchema = z
  .object({
    owner: z.literal("bb-browser"),
    directoryMode: z.literal("0700"),
    manifestMode: z.literal("0600"),
  })
  .strict();

const browserProfileManifestBaseSchema = z
  .object({
    version: z.literal(PROFILE_MANIFEST_VERSION),
    profileId: browserProfileIdSchema,
    name: browserProfileNameSchema,
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    locale: browserProfileLocaleSchema,
    timezone: browserProfileTimezoneSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startup: browserProfileStartupSchema,
    storage: browserProfileStorageSchema,
  })
  .strict();

const activeBrowserProfileManifestSchema = browserProfileManifestBaseSchema
  .extend({
    state: z.literal("active"),
    archivedAt: z.null().default(null),
    expiresAt: z.null().default(null),
  })
  .strict();

const archivedBrowserProfileManifestSchema = browserProfileManifestBaseSchema
  .extend({
    state: z.literal("archived"),
    archivedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const browserProfileManifestSchema = z.discriminatedUnion("state", [
  activeBrowserProfileManifestSchema,
  archivedBrowserProfileManifestSchema,
]);

export const browserProfileSchema = z.discriminatedUnion("state", [
  activeBrowserProfileManifestSchema.extend({ selected: z.boolean() }).strict(),
  archivedBrowserProfileManifestSchema
    .extend({ selected: z.boolean() })
    .strict(),
]);

export const browserProfileHostTargetSchema = z
  .object({ hostId: z.string().min(1) })
  .strict();

export const browserProfileCreateRequestSchema = z
  .object({
    hostId: z.string().min(1),
    name: browserProfileNameSchema,
    locale: browserProfileLocaleSchema.optional(),
    timezone: browserProfileTimezoneSchema.optional(),
  })
  .strict();

export const browserProfileRenameRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    name: browserProfileNameSchema,
    locale: browserProfileLocaleSchema.optional(),
    timezone: browserProfileTimezoneSchema.optional(),
  })
  .strict();

export const browserProfileSelectRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
  })
  .strict();

export const browserProfileTargetSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
  })
  .strict();

export const browserProfileResetRequestSchema = browserProfileTargetSchema
  .extend({ confirmation: z.string().min(1) })
  .strict();

export const browserProfileDeleteRequestSchema = browserProfileTargetSchema
  .extend({
    confirmation: z.string().min(1),
    defaultProfileId: browserProfileIdSchema.optional(),
  })
  .strict();

export const browserProfileLifecyclePhaseSchema = z.enum([
  "stopping",
  "updating-storage",
  "completed",
]);

export const browserProfileLifecycleProgressSchema = z
  .object({
    phase: browserProfileLifecyclePhaseSchema,
    message: z.string().min(1),
  })
  .strict();

export const browserProfileLifecycleResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.enum([
          "archived",
          "already-archived",
          "restored",
          "already-restored",
          "reset",
        ]),
        profile: browserProfileSchema,
        progress: browserProfileLifecycleProgressSchema,
        message: z.string().min(1),
      })
      .strict(),
    z
      .object({
        outcome: z.enum(["deleted", "already-deleted"]),
        profileId: browserProfileIdSchema,
        progress: browserProfileLifecycleProgressSchema,
        message: z.string().min(1),
      })
      .strict(),
  ],
);

export const browserProfileExpiryResponseSchema = z
  .object({ deletedProfileIds: z.array(browserProfileIdSchema) })
  .strict();

const browserProfileContextSchema = z
  .object({
    projectId: z.string().min(1).nullable().optional(),
    threadId: z.string().min(1).optional(),
  })
  .strict();

export const browserProfileQuerySchema = browserProfileHostTargetSchema
  .extend(browserProfileContextSchema.shape)
  .strict();

export const browserProfileSelectionRequestSchema =
  browserProfileSelectRequestSchema
    .extend(browserProfileContextSchema.shape)
    .strict();

export const browserProfileInventorySchema = z
  .object({
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    selectedProfileId: browserProfileIdSchema,
    profiles: z.array(browserProfileSchema),
  })
  .strict();

export const browserHostChoiceSchema = z
  .object({
    hostId: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const browserHostChoicesInputSchema = z.discriminatedUnion("surface", [
  z
    .object({
      surface: z.literal("thread"),
      threadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      surface: z.literal("new-thread"),
      projectId: z.string().min(1).nullable(),
    })
    .strict(),
]);
export const browserHostChoicesSchema = z.array(browserHostChoiceSchema);

export type BrowserProfileManifest = z.infer<
  typeof browserProfileManifestSchema
>;
export type BrowserProfile = z.infer<typeof browserProfileSchema>;
export type BrowserProfileHostTarget = z.infer<
  typeof browserProfileHostTargetSchema
>;
export type BrowserProfileCreateRequest = z.infer<
  typeof browserProfileCreateRequestSchema
>;
export type BrowserProfileRenameRequest = z.infer<
  typeof browserProfileRenameRequestSchema
>;
export type BrowserProfileSelectRequest = z.infer<
  typeof browserProfileSelectRequestSchema
>;
export type BrowserProfileTarget = z.infer<typeof browserProfileTargetSchema>;
export type BrowserProfileResetRequest = z.infer<
  typeof browserProfileResetRequestSchema
>;
export type BrowserProfileDeleteRequest = z.infer<
  typeof browserProfileDeleteRequestSchema
>;
export type BrowserProfileLifecycleProgress = z.infer<
  typeof browserProfileLifecycleProgressSchema
>;
export type BrowserProfileLifecycleResponse = z.infer<
  typeof browserProfileLifecycleResponseSchema
>;
export type BrowserProfileExpiryResponse = z.infer<
  typeof browserProfileExpiryResponseSchema
>;
export type BrowserProfileQuery = z.infer<typeof browserProfileQuerySchema>;
export type BrowserProfileSelectionRequest = z.infer<
  typeof browserProfileSelectionRequestSchema
>;
export type BrowserProfileInventory = z.infer<
  typeof browserProfileInventorySchema
>;
export type BrowserHostChoice = z.infer<typeof browserHostChoiceSchema>;
export type BrowserHostChoicesInput = z.infer<
  typeof browserHostChoicesInputSchema
>;

const BROWSER_ORIGIN_PATH_ERROR =
  "Browser origin scopes cannot contain paths or credentials.";

type ParsedBrowserOrigin = { trimmed: string; url: URL };

function parseBrowserHttpOrigin(candidate: string): ParsedBrowserOrigin {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    throw new Error("Browser origins cannot be empty.");
  }
  let origin: URL;
  try {
    origin = new URL(trimmed);
  } catch {
    throw new Error("Browser origins must be valid HTTP or HTTPS origins.");
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("Browser origins must use HTTP or HTTPS.");
  }
  return { trimmed, url: origin };
}

function assertRootBrowserOriginPath(trimmed: string) {
  const authority = trimmed.slice(trimmed.indexOf("://") + 3);
  const suffixIndex = authority.search(/[/?#]/u);
  if (suffixIndex >= 0 && authority.slice(suffixIndex) !== "/") {
    throw new Error(BROWSER_ORIGIN_PATH_ERROR);
  }
}

function assertExactBrowserOrigin(url: URL) {
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(BROWSER_ORIGIN_PATH_ERROR);
  }
  if (url.hostname.includes("*")) {
    throw new Error("Wildcard hosts require an explicit subdomain scope.");
  }
}

export function normalizeBrowserOrigin(candidate: string): string {
  const { trimmed, url } = parseBrowserHttpOrigin(candidate);
  assertRootBrowserOriginPath(trimmed);
  assertExactBrowserOrigin(url);
  return url.origin;
}

function subdomainScopeParts(candidate: string) {
  const match = /^(https?):\/\/\*\.(.+)$/iu.exec(candidate.trim());
  if (match === null) {
    throw new Error(
      "Subdomain scopes must use an explicit https://*.example.test pattern.",
    );
  }
  const protocol = match[1]!.toLowerCase();
  const rawHostPort = match[2]!;
  const hostPort = rawHostPort.endsWith("/")
    ? rawHostPort.slice(0, -1)
    : rawHostPort;
  if (/[/?#@]/u.test(hostPort)) {
    throw new Error(BROWSER_ORIGIN_PATH_ERROR);
  }
  return { protocol, hostPort };
}

function parseSubdomainBase(protocol: string, hostPort: string): URL {
  let base: URL;
  try {
    base = new URL(`${protocol}://${hostPort}`);
  } catch {
    throw new Error("Subdomain scopes must contain a valid host and port.");
  }
  return base;
}

function assertDnsSubdomainBase(base: URL) {
  if (
    base.username !== "" ||
    base.password !== "" ||
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== "" ||
    base.hostname.includes(":") ||
    !base.hostname.includes(".") ||
    /^\d+(?:\.\d+){3}$/u.test(base.hostname)
  ) {
    throw new Error("Subdomain scopes must target a DNS host without a path.");
  }
}

function normalizeBrowserSubdomainPattern(candidate: string): string {
  const { protocol, hostPort } = subdomainScopeParts(candidate);
  const base = parseSubdomainBase(protocol, hostPort);
  assertDnsSubdomainBase(base);
  return `${protocol}://*.${base.hostname}${
    base.port.length === 0 ? "" : `:${base.port}`
  }`;
}

export function normalizeBrowserOriginScope(candidate: string): string {
  const trimmed = candidate.trim();
  return trimmed === "*"
    ? trimmed
    : trimmed.startsWith("*.") || /:\/\/\*\./u.test(trimmed)
      ? normalizeBrowserSubdomainPattern(trimmed)
      : normalizeBrowserOrigin(trimmed);
}

export const browserOriginScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((candidate, context) => {
    try {
      normalizeBrowserOriginScope(candidate);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid origin scope.",
      });
    }
  })
  .transform(normalizeBrowserOriginScope);

export type BrowserOriginScope = z.output<typeof browserOriginScopeSchema>;

export const browserExactOriginSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((candidate, context) => {
    try {
      normalizeBrowserOrigin(candidate);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid browser origin.",
      });
    }
  })
  .transform(normalizeBrowserOrigin);

export const browserProfileGrantIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u);

export const PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION =
  "Persist Browser elevated access";

export const browserProfileGrantSchema = z
  .object({
    grantId: browserProfileGrantIdSchema,
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    profileId: browserProfileIdSchema,
    originScope: browserOriginScopeSchema,
    wholeWeb: z.boolean(),
    fileTransfer: z.boolean(),
    invalidCertificateOrigins: z.array(browserExactOriginSchema).max(100),
    persistentElevations: z.boolean(),
    wholeWebExpiresAt: z.string().datetime().nullable(),
    fileTransferExpiresAt: z.string().datetime().nullable(),
    invalidCertificateExpiresAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine(({ originScope, wholeWeb }, context) => {
    if (wholeWeb !== (originScope === "*")) {
      context.addIssue({
        code: "custom",
        path: ["wholeWeb"],
        message: "Whole-web grants must use the * origin scope.",
      });
    }
  });

type BrowserProfileGrantRecord = z.output<typeof browserProfileGrantSchema>;
export type BrowserProfileGrant = Omit<
  BrowserProfileGrantRecord,
  | "persistentElevations"
  | "wholeWebExpiresAt"
  | "fileTransferExpiresAt"
  | "invalidCertificateExpiresAt"
> & {
  persistentElevations?: boolean;
  wholeWebExpiresAt?: string | null;
  fileTransferExpiresAt?: string | null;
  invalidCertificateExpiresAt?: string | null;
};
export const browserProfileGrantsSchema = z.array(browserProfileGrantSchema);

export const browserGrantRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u);
export const browserGrantRequestDecisionSchema = z.enum([
  "deny",
  "retry",
  "one-hour",
  "persist",
]);
/**
 * The Origin Scope that matches every site. A Profile Grant carrying it is a
 * whole-web grant: the project's agents may drive this profile anywhere.
 */
export const BROWSER_WHOLE_WEB_ORIGIN_SCOPE = "*";

export const browserGrantRequestStatusSchema = z.enum([
  "pending",
  "denied",
  "approved",
  "consumed",
  "expired",
  "revoked",
]);

export const browserGrantRequestElevationsSchema = z
  .object({
    fileTransfer: z.boolean(),
    invalidCertificate: z.boolean(),
  })
  .strict();

export const browserGrantRequestSchema = z
  .object({
    requestId: browserGrantRequestIdSchema,
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    profileId: browserProfileIdSchema,
    origin: browserExactOriginSchema,
    requestedElevations: browserGrantRequestElevationsSchema,
    status: browserGrantRequestStatusSchema,
    decision: browserGrantRequestDecisionSchema.nullable(),
    expiresAt: z.string().datetime(),
    decisionAt: z.string().datetime().nullable(),
    consumedAt: z.string().datetime().nullable(),
    expiredAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();

export const browserTemporaryGrantSchema = z
  .object({
    grantId: browserProfileGrantIdSchema,
    requestId: browserGrantRequestIdSchema,
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    profileId: browserProfileIdSchema,
    originScope: browserOriginScopeSchema,
    wholeWeb: z.literal(false),
    fileTransfer: z.boolean(),
    invalidCertificateOrigins: z.array(browserExactOriginSchema).max(100),
    mode: z.enum(["retry", "one-hour"]),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    consumedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();

export const browserGrantRequestsSchema = z.array(browserGrantRequestSchema);

export const browserGrantRequestQuerySchema = z
  .object({
    requestId: browserGrantRequestIdSchema.optional(),
    projectId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    installationId: z.string().min(1).optional(),
    profileId: browserProfileIdSchema.optional(),
    status: browserGrantRequestStatusSchema.optional(),
  })
  .strict();

export const browserGrantRequestDecisionRequestSchema = z
  .object({
    requestId: browserGrantRequestIdSchema,
    decision: browserGrantRequestDecisionSchema.default("retry"),
    persistenceConfirmation: z.string().optional(),
  })
  .strict();

const browserGrantRequestDecisionResponseShapeSchema = z
  .object({
    outcome: z.enum([
      "denied",
      "retry-approved",
      "one-hour-approved",
      "persisted",
      "already-decided",
      "expired",
      "revoked",
      "not-found",
    ]),
    request: browserGrantRequestSchema,
    temporaryGrant: browserTemporaryGrantSchema.nullable(),
    grant: browserProfileGrantSchema.nullable(),
  })
  .strict();

export const browserGrantRequestDecisionResponseSchema =
  browserGrantRequestDecisionResponseShapeSchema;

export type BrowserGrantRequestDecisionResponse = z.output<
  typeof browserGrantRequestDecisionResponseSchema
>;

export const browserGrantRequestRevokeRequestSchema = z
  .object({ requestId: browserGrantRequestIdSchema })
  .strict();

export type BrowserGrantRequest = z.output<typeof browserGrantRequestSchema>;
export type BrowserTemporaryGrant = z.output<
  typeof browserTemporaryGrantSchema
>;
export type BrowserAuthorizationRequest = {
  projectId: string;
  hostId: string;
  installationId: string;
  profileId: string;
  origin: string;
  fileTransfer?: boolean;
  invalidCertificate?: boolean;
};
export type BrowserGrantRequestQuery = z.output<
  typeof browserGrantRequestQuerySchema
>;
export type BrowserGrantRequestDecisionRequest = z.input<
  typeof browserGrantRequestDecisionRequestSchema
>;
export type BrowserGrantRequestRevokeRequest = z.output<
  typeof browserGrantRequestRevokeRequestSchema
>;

export const browserProfileGrantCreateRequestSchema = z
  .object({
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    installationId: z.string().min(1).optional(),
    originScope: browserOriginScopeSchema,
    wholeWeb: z.boolean().default(false),
    fileTransfer: z.boolean().default(false),
    invalidCertificateOrigins: z
      .array(browserExactOriginSchema)
      .max(100)
      .default([]),
    persistentElevations: z.boolean().default(false),
    persistenceConfirmation: z.string().optional(),
  })
  .strict()
  .superRefine(
    (
      { originScope, wholeWeb, persistentElevations, persistenceConfirmation },
      context,
    ) => {
      if (wholeWeb !== (originScope === "*")) {
        context.addIssue({
          code: "custom",
          path: ["wholeWeb"],
          message: "Whole-web grants must use the * origin scope.",
        });
      }
      if (
        persistentElevations &&
        persistenceConfirmation !== PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION
      ) {
        context.addIssue({
          code: "custom",
          path: ["persistenceConfirmation"],
          message: "Persistent elevated access requires a second confirmation.",
        });
      }
    },
  );

export const browserProfileGrantQuerySchema = z
  .object({
    grantId: browserProfileGrantIdSchema.optional(),
    projectId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    installationId: z.string().min(1).optional(),
    profileId: browserProfileIdSchema.optional(),
    includeRevoked: z.boolean().default(false),
  })
  .strict();

export const browserProfileGrantRevokeRequestSchema = z
  .object({ grantId: browserProfileGrantIdSchema })
  .strict();

export const browserProfileGrantRevokeResponseSchema = z
  .object({
    grantId: browserProfileGrantIdSchema,
    outcome: z.enum(["revoked", "already-revoked", "not-found"]),
  })
  .strict();

export type BrowserProfileGrantCreateRequest = z.output<
  typeof browserProfileGrantCreateRequestSchema
>;
export type BrowserProfileGrantQuery = z.output<
  typeof browserProfileGrantQuerySchema
>;
export type BrowserProfileGrantRevokeRequest = z.output<
  typeof browserProfileGrantRevokeRequestSchema
>;
export type BrowserProfileGrantRevokeResponse = z.output<
  typeof browserProfileGrantRevokeResponseSchema
>;

export const browserOriginDeniedErrorSchema = z
  .object({
    state: z.literal("origin-denied"),
    code: z.literal("origin_denied"),
    label: z.literal("Origin denied"),
    hostId: z.string().min(1).nullable(),
    profileId: z.string().min(1),
    message: z.string().min(1),
    /**
     * The exact web origin that was denied. The server sets it for both the
     * declared-origin denial and the real-browser navigation denial so the
     * owner-facing Grant Request carries the precise origin the agent reached.
     */
    origin: browserExactOriginSchema.nullable(),
    grantRequest: browserGrantRequestSchema.nullable(),
  })
  .strict();

const browserProfileRecoveryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path) => !path.includes("\0"),
    "Recovery paths cannot contain NUL bytes.",
  );

export const browserProfileBackupRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    archivePath: browserProfileRecoveryPathSchema,
  })
  .strict();

export const browserProfileRestoreRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    archivePath: browserProfileRecoveryPathSchema,
  })
  .strict();

export const browserProfileImportRequestSchema = z
  .object({
    hostId: z.string().min(1),
    name: browserProfileNameSchema,
    sourcePath: browserProfileRecoveryPathSchema,
  })
  .strict();

export const browserProfileRecoveryProgressSchema = z
  .object({
    phase: z.enum(["validating", "copying", "promoting", "completed"]),
    completedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    phases: z
      .array(z.enum(["validating", "copying", "promoting", "completed"]))
      .min(1)
      .optional(),
  })
  .strict();

const browserProfileBackupResponseSchema = z
  .object({
    outcome: z.literal("backed-up"),
    message: z.string().min(1),
    archivePath: browserProfileRecoveryPathSchema,
    credentialEquivalent: z.literal(true),
    progress: browserProfileRecoveryProgressSchema,
  })
  .strict();

const browserProfileRestoreResponseSchema = z
  .object({
    outcome: z.literal("restored"),
    message: z.string().min(1),
    archivePath: browserProfileRecoveryPathSchema,
    credentialEquivalent: z.literal(true),
    progress: browserProfileRecoveryProgressSchema,
  })
  .strict();

const browserProfileImportResponseSchema = z
  .object({
    outcome: z.literal("imported"),
    message: z.string().min(1),
    profileId: browserProfileIdSchema,
    progress: browserProfileRecoveryProgressSchema,
  })
  .strict();

export const browserProfileRecoveryResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    browserProfileBackupResponseSchema,
    browserProfileRestoreResponseSchema,
    browserProfileImportResponseSchema,
  ],
);

export type BrowserProfileBackupRequest = z.infer<
  typeof browserProfileBackupRequestSchema
>;
export type BrowserProfileRestoreRequest = z.infer<
  typeof browserProfileRestoreRequestSchema
>;
export type BrowserProfileImportRequest = z.infer<
  typeof browserProfileImportRequestSchema
>;
export type BrowserProfileRecoveryResponse = z.infer<
  typeof browserProfileRecoveryResponseSchema
>;

export const readinessCapabilityIdSchema = z.enum([
  "operating-system",
  "architecture",
  "bb-connect",
  "browser",
  "sandbox",
  "dedicated-user",
  "protected-storage",
  "disk-headroom",
  "loopback",
]);

export const readinessCapabilitySchema = z
  .object({
    id: readinessCapabilityIdSchema,
    label: z.string().min(1),
    status: z.enum([
      "ready",
      "missing",
      "failed",
      "unsupported",
      "unavailable",
    ]),
    reason: z.string().min(1),
  })
  .strict();

export const browserStatusTargetSchema = z
  .object({
    hostId: z.string().min(1).nullable(),
    profileId: z.string().min(1),
  })
  .strict();

export const browserHostTargetSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict();

export const browserHostConnectionRequestSchema = z
  .object({
    hostId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    state: z.enum(["connected", "disconnected"]),
  })
  .strict();

export const browserHostConnectionResponseSchema =
  browserHostConnectionRequestSchema.extend({ applied: z.boolean() }).strict();

export const browserActivityEventIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u);

export const browserActivityOriginSchema = browserExactOriginSchema;
export type BrowserActivityOrigin = z.infer<typeof browserActivityOriginSchema>;

export const browserActivityActorSchema = z.enum(["owner", "agent", "system"]);
export const browserActivityKindSchema = z.enum([
  "setup",
  "lifecycle",
  "purge",
  "agent-operation",
  "grant",
  "control",
  "mode",
  "export",
]);

export const browserActivityGrantElevationsSchema = z
  .object({
    wholeWeb: z.boolean(),
    fileTransfer: z.boolean(),
    invalidCertificateOrigins: z.array(browserExactOriginSchema).max(100),
    persistentElevations: z.boolean(),
  })
  .strict();

export const browserActivityGrantMetadataSchema = z
  .object({
    grantId: browserProfileGrantIdSchema.nullable(),
    grantScope: browserOriginScopeSchema.nullable(),
    grantElevations: browserActivityGrantElevationsSchema.nullable(),
  })
  .strict();

export type BrowserActivityGrantMetadata = z.output<
  typeof browserActivityGrantMetadataSchema
>;

const browserActivityMetadataShape = {
  eventId: browserActivityEventIdSchema,
  actor: browserActivityActorSchema,
  projectId: z.string().min(1).nullable(),
  hostId: z.string().min(1),
  profileId: z.string().min(1),
  requestId: browserGrantRequestIdSchema.nullable().optional(),
  grantId: browserProfileGrantIdSchema.optional().nullable(),
  grantScope: browserOriginScopeSchema.optional().nullable(),
  grantElevations: browserActivityGrantElevationsSchema.optional().nullable(),
  destinationOrigin: browserActivityOriginSchema.nullable(),
  occurredAt: z.string().datetime(),
  kind: browserActivityKindSchema,
  action: z.string().trim().min(1).max(80),
  outcome: z.string().trim().min(1).max(80),
  interrupted: z.boolean(),
  interruptionReason: z.string().trim().min(1).max(120).nullable(),
  durationMs: z.number().int().nonnegative().max(30_000).nullable(),
};

export const browserActivityEventSchema = z
  .object(browserActivityMetadataShape)
  .strict();

export const browserControlLeaseSchema = z
  .object({
    actor: z.enum(["owner", "agent"]),
    purpose: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

const browserStatusFields = {
  ...browserStatusTargetSchema.shape,
  capabilities: z.array(readinessCapabilitySchema).length(9),
  grantRequest: browserGrantRequestSchema.nullable().optional(),
  controlLease: browserControlLeaseSchema.optional(),
};

export const browserStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...browserStatusFields,
      state: z.literal("setup-required"),
      code: z.literal("setup_required"),
      label: z.literal("Setup required"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("sleeping"),
      code: z.literal("sleeping"),
      label: z.literal("Sleeping"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("waking"),
      code: z.literal("waking"),
      label: z.literal("Waking"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("host-offline"),
      code: z.literal("host_offline"),
      label: z.literal("Host offline"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("safe-login-elsewhere"),
      code: z.literal("safe_login_elsewhere"),
      label: z.literal("Safe Login elsewhere"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("repair-required"),
      code: z.literal("repair_required"),
      label: z.literal("Repair required"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("unsupported"),
      code: z.literal("unsupported"),
      label: z.literal("Unsupported"),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...browserStatusFields,
      state: z.literal("healthy"),
      code: z.literal("healthy"),
      label: z.literal("Ready"),
      message: z.string().min(1),
    })
    .strict(),
]);

export type BrowserStatusTarget = z.infer<typeof browserStatusTargetSchema>;
export type BrowserHostTarget = z.infer<typeof browserHostTargetSchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export type ReadinessCapability = z.infer<typeof readinessCapabilitySchema>;

export const READINESS_CAPABILITIES = [
  ["operating-system", "Operating system"],
  ["architecture", "Architecture"],
  ["bb-connect", "BB Connect"],
  ["browser", "Browser"],
  ["sandbox", "Browser sandbox"],
  ["dedicated-user", "Dedicated browser user"],
  ["protected-storage", "Protected storage"],
  ["disk-headroom", "Disk headroom"],
  ["loopback", "Loopback networking"],
] as const;

function unavailableCapabilities(reason: string): ReadinessCapability[] {
  return READINESS_CAPABILITIES.map(([id, label]) => ({
    id,
    label,
    status: "unavailable",
    reason,
  }));
}

export const browserDiagnosticsSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    generatedAt: z.string().datetime(),
    readiness: browserStatusSchema,
    dependencies: z.array(
      z
        .object({
          name: z.string().min(1),
          version: z.string().min(1).nullable(),
        })
        .strict(),
    ),
    processes: z.array(
      z
        .object({
          name: z.string().min(1),
          state: z.enum(["running", "stopped", "failed"]),
          pid: z.number().int().positive().optional(),
        })
        .strict(),
    ),
    resourceUse: z
      .object({
        diskFreeBytes: z.number().nonnegative(),
        diskTotalBytes: z.number().nonnegative(),
        workerRssBytes: z.number().nonnegative(),
      })
      .strict(),
    exitLogs: z.array(z.string().max(500)).max(50),
    controlLease: browserControlLeaseSchema.optional(),
  })
  .strict();

export type BrowserDiagnostics = z.infer<typeof browserDiagnosticsSchema>;

export const browserActivityRecordSchema = z
  .object({ id: z.number().int().positive(), ...browserActivityMetadataShape })
  .strict();

export const browserActivityRecordsSchema = z
  .array(browserActivityRecordSchema)
  .max(ACTIVITY_RECORD_LIMIT);

export const browserActivityOutboxItemSchema = z
  .object({
    ...browserActivityMetadataShape,
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime(),
  })
  .strict();

export const browserActivityOutboxSchema = z
  .array(browserActivityOutboxItemSchema)
  .max(ACTIVITY_OUTBOX_BATCH_LIMIT);

export const browserActivityExportSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    exportedAt: z.string().datetime(),
    records: browserActivityRecordsSchema,
  })
  .strict();

export const browserActivityClearRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    confirmation: z.string().min(1),
  })
  .strict();

export const browserActivityClearResponseSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    clearedCount: z.number().int().nonnegative(),
    message: z.string().min(1),
  })
  .strict();

export const browserActivityOutboxRequestSchema = z
  .object({
    hostId: z.string().min(1),
    limit: z
      .number()
      .int()
      .positive()
      .max(ACTIVITY_OUTBOX_BATCH_LIMIT)
      .default(ACTIVITY_OUTBOX_BATCH_LIMIT),
  })
  .strict();

export const browserActivityAcknowledgementRequestSchema = z
  .object({
    hostId: z.string().min(1),
    eventIds: z.array(browserActivityEventIdSchema).max(10_000),
  })
  .strict();

export const browserActivityAcknowledgementResponseSchema = z
  .object({
    acknowledgedEventIds: z.array(browserActivityEventIdSchema),
  })
  .strict();

export const browserActivityReconciliationRequestSchema = z
  .object({
    hostId: z.string().min(1),
    acknowledgedEventIds: z.array(browserActivityEventIdSchema).max(10_000),
    limit: z
      .number()
      .int()
      .positive()
      .max(ACTIVITY_OUTBOX_BATCH_LIMIT)
      .default(ACTIVITY_OUTBOX_BATCH_LIMIT),
  })
  .strict();

export type BrowserActivityRecord = z.infer<typeof browserActivityRecordSchema>;
export type BrowserActivityEvent = z.infer<typeof browserActivityEventSchema>;
export type BrowserActivityOutboxItem = z.infer<
  typeof browserActivityOutboxItemSchema
>;
export type BrowserActivityExport = z.infer<typeof browserActivityExportSchema>;
export type BrowserActivityClearResponse = z.infer<
  typeof browserActivityClearResponseSchema
>;

export function browserActivityEventFromOutboxItem(
  outboxItem: BrowserActivityOutboxItem,
): BrowserActivityEvent {
  return browserActivityEventSchema.parse({
    eventId: outboxItem.eventId,
    actor: outboxItem.actor,
    projectId: outboxItem.projectId,
    hostId: outboxItem.hostId,
    profileId: outboxItem.profileId,
    requestId: outboxItem.requestId,
    grantId: outboxItem.grantId,
    grantScope: outboxItem.grantScope,
    grantElevations: outboxItem.grantElevations,
    destinationOrigin: outboxItem.destinationOrigin,
    occurredAt: outboxItem.occurredAt,
    kind: outboxItem.kind,
    action: outboxItem.action,
    outcome: outboxItem.outcome,
    interrupted: outboxItem.interrupted,
    interruptionReason: outboxItem.interruptionReason,
    durationMs: outboxItem.durationMs,
  });
}

export function setupRequiredStatus(
  target: BrowserStatusTarget,
): BrowserStatus {
  return {
    ...target,
    state: "setup-required",
    code: "setup_required",
    label: "Setup required",
    message: SETUP_REQUIRED_MESSAGE,
    capabilities: unavailableCapabilities(
      target.hostId === null
        ? "Select a workspace host to run this check."
        : "Run Browser status on the workspace host to inspect this check.",
    ),
  };
}

export function hostOfflineStatus(target: BrowserStatusTarget): BrowserStatus {
  return {
    ...target,
    state: "host-offline",
    code: "host_offline",
    label: "Host offline",
    message: "Reconnect this workspace host to run Browser readiness checks.",
    capabilities: unavailableCapabilities(
      "Reconnect the host to inspect this capability.",
    ),
  };
}

export function sleepingBrowserStatus(ready: BrowserStatus): BrowserStatus {
  return {
    ...ready,
    state: "sleeping",
    code: "sleeping",
    label: "Sleeping",
    message:
      "This Browser Instance is sleeping and will wake without changing its Browser Profile.",
  };
}

export function wakingBrowserStatus(ready: BrowserStatus): BrowserStatus {
  return {
    ...ready,
    state: "waking",
    code: "waking",
    label: "Waking",
    message: "This Browser Instance is waking from its Browser Profile.",
  };
}

export function hostCanDispatchAutomation(status: BrowserStatus): boolean {
  return (
    status.state === "healthy" ||
    status.state === "sleeping" ||
    status.state === "waking"
  );
}

export function hostProbeFailedStatus(
  target: BrowserStatusTarget,
): BrowserStatus {
  return {
    ...target,
    state: "repair-required",
    code: "repair_required",
    label: "Repair required",
    message:
      "Connected host readiness checks failed. Retry, then inspect Browser diagnostics.",
    capabilities: unavailableCapabilities(
      "The retained host worker could not complete this check.",
    ),
  };
}

export function browserProfileUnavailableStatus(
  target: BrowserStatusTarget,
): BrowserStatus {
  return {
    ...target,
    state: "repair-required",
    code: "repair_required",
    label: "Repair required",
    message: "The requested Browser Profile is not available on this host.",
    capabilities: unavailableCapabilities(
      "Select a profile listed for this workspace host.",
    ),
  };
}

const threadSurfaceSchema = z
  .object({
    surface: z.literal("thread"),
    threadId: z.string().min(1),
    profileId: z.string().min(1),
    hostId: z.string().min(1).optional(),
    profileSelection: z.literal("selected").optional(),
  })
  .strict();

const newThreadSurfaceSchema = z
  .object({
    surface: z.literal("new-thread"),
    projectId: z.string().min(1).nullable(),
    profileId: z.string().min(1),
    hostId: z.string().min(1).optional(),
    profileSelection: z.literal("selected").optional(),
  })
  .strict();

export const browserStatusInputSchema = z.discriminatedUnion("surface", [
  threadSurfaceSchema,
  newThreadSurfaceSchema,
]);

export type BrowserStatusInput = z.infer<typeof browserStatusInputSchema>;

/**
 * The Browser Panel a request came from, when it came from one. The shared
 * browser is driven by exactly one panel at a time, so a request that carries
 * a panel identity is authorized against the control session before it reaches
 * the browser. Agent scripts, the CLI, and owner tools carry none and are
 * unaffected.
 */
const browserPanelOriginField = {
  panelId: z.string().min(1).optional(),
} as const;

const browserNavigationFields = {
  input: z.string().min(1).max(2048),
  tabId: z.string().min(1).optional(),
  rawLocalhost: z.boolean().default(false),
  ...browserPanelOriginField,
} as const;

export const browserPanelNavigationRequestSchema = z.discriminatedUnion(
  "surface",
  [
    threadSurfaceSchema.extend(browserNavigationFields).strict(),
    newThreadSurfaceSchema.extend(browserNavigationFields).strict(),
  ],
);

export const browserNavigationRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    projectId: z.string().min(1),
    input: z.string().min(1).max(2048),
    tabId: z.string().min(1).optional(),
    rawLocalhost: z.boolean(),
    ...browserPanelOriginField,
  })
  .strict();

const browserHistoryFields = {
  direction: z.enum(["back", "forward", "reload"]),
  tabId: z.string().min(1).optional(),
  ...browserPanelOriginField,
} as const;

export const browserPanelHistoryRequestSchema = z.discriminatedUnion(
  "surface",
  [
    threadSurfaceSchema.extend(browserHistoryFields).strict(),
    newThreadSurfaceSchema.extend(browserHistoryFields).strict(),
  ],
);

export const browserHistoryRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    projectId: z.string().min(1),
    direction: z.enum(["back", "forward", "reload"]),
    tabId: z.string().min(1).optional(),
    ...browserPanelOriginField,
  })
  .strict();

/**
 * Owner tab actions on the shared Browser Tab strip (ADR 0005). Opening,
 * switching, and closing a tab are the three things a browser lets its owner
 * do with a tab strip; each one changes state that belongs to the Browser
 * Profile, so the result is the whole strip every panel for that profile then
 * observes. `open` takes no tab, while `activate` and `close` name one.
 */
export const browserTabActionSchema = z.enum(["open", "activate", "close"]);
export type BrowserTabAction = z.infer<typeof browserTabActionSchema>;

const browserTabActionFields = {
  action: browserTabActionSchema,
  tabId: z.string().min(1).optional(),
  ...browserPanelOriginField,
} as const;

export const browserPanelTabActionRequestSchema = z.discriminatedUnion(
  "surface",
  [
    threadSurfaceSchema.extend(browserTabActionFields).strict(),
    newThreadSurfaceSchema.extend(browserTabActionFields).strict(),
  ],
);
export type BrowserPanelTabActionInput = z.infer<
  typeof browserPanelTabActionRequestSchema
>;

export const browserTabActionRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    projectId: z.string().min(1),
    ...browserTabActionFields,
  })
  .strict()
  .refine(
    (request) => request.action === "open" || request.tabId !== undefined,
    {
      path: ["tabId"],
      message: "Switching or closing a Browser Tab requires a tab.",
    },
  );
export type BrowserTabActionRequest = z.infer<
  typeof browserTabActionRequestSchema
>;

export const panelIdentityRejectionReasonSchema = z.enum([
  "project-mismatch",
  "thread-mismatch",
  "owner-session-mismatch",
  "panel-mismatch",
  "host-mismatch",
  "profile-mismatch",
]);

export const panelIdentityRejectionSchema = z
  .object({
    outcome: z.literal("rejected"),
    reason: panelIdentityRejectionReasonSchema,
    message: z.string().min(1),
  })
  .strict();

export const browserHostPanelVisibilityRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
    visibility: z.enum(["visible", "hidden"]),
  })
  .strict();

export const browserPanelVisibilityRequestSchema =
  browserHostPanelVisibilityRequestSchema.extend({
    ownerSessionId: z.string().min(1),
  });

export type BrowserHostPanelVisibilityRequest = z.infer<
  typeof browserHostPanelVisibilityRequestSchema
>;
export type BrowserPanelVisibilityRequest = z.infer<
  typeof browserPanelVisibilityRequestSchema
>;

/**
 * Request a single-use Panel Capability that bootstraps an authenticated stream
 * connection. The capability binds to one owner session, panel instance, host,
 * and profile, and is redeemed in the first WebSocket message rather than
 * placed in a URL. BB Connect enrollment is required even for a locally
 * displayed client so one authenticated transport serves web/PWA and desktop.
 */
export const browserPanelCapabilityRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
    ownerSessionId: z.string().min(1),
  })
  .strict();

export const browserPanelCapabilityResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("issued"),
        capabilityId: z.string().min(1),
        /**
         * Opaque single-use secret redeemed in the first WebSocket message. It
         * is never placed in a URL and carries no transport address.
         */
        secret: z.string().min(1),
        /**
         * Dynamic loopback gateway port the host chose for this worker
         * generation. The server declares it to BB Connect for tunneling; the
         * panel never opens it directly.
         */
        gatewayPort: z.number().int().positive().max(65535),
        /**
         * Read-only BB Connect tunnel identity for the host. The daemon owns
         * the trusted enrollment; plugins cannot influence the destination.
         */
        tunnel: z
          .object({
            label: z.string().min(1),
            baseDomain: z.string().min(1),
          })
          .strict(),
        expiresAt: z.string().datetime(),
        rotatesAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        /**
         * A public reason that never exposes transport secrets. It mirrors the
         * readiness state the owner already sees (setup-required, host-offline, or
         * missing BB Connect enrollment).
         */
        reason: z.enum([
          "setup-required",
          "host-offline",
          "bb-connect-required",
        ]),
        message: z.string().min(1),
      })
      .strict(),
    panelIdentityRejectionSchema,
  ],
);

export type BrowserPanelCapabilityRequest = z.infer<
  typeof browserPanelCapabilityRequestSchema
>;
export type BrowserPanelCapabilityResponse = z.infer<
  typeof browserPanelCapabilityResponseSchema
>;

/**
 * The first WebSocket message a panel sends after connecting through BB
 * Connect. The Panel Capability is redeemed here, never in a URL. A bounded
 * gateway validates this shape and size before authorizing the stream.
 */
export const browserPanelRedeemMessageSchema = z
  .object({
    type: z.literal("redeem"),
    capabilityId: z.string().min(1),
    secret: z.string().min(1),
    ownerSessionId: z.string().min(1),
    panelId: z.string().min(1),
  })
  .strict();

export type BrowserPanelRedeemMessage = z.infer<
  typeof browserPanelRedeemMessageSchema
>;

/**
 * Host-side request to open a dynamic loopback gateway for a profile's panel
 * transport. The host chooses a per-worker-generation port, binds it to
 * loopback only, and returns it so the server can declare it to BB Connect.
 * The host never exposes the gateway directly.
 */
export const browserPanelTransportRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
    ownerSessionId: z.string().min(1),
  })
  .strict();

export const browserPanelTransportResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("opened"),
        gatewayPort: z.number().int().positive().max(65535),
        bindHost: z.string().min(1),
        capabilityId: z.string().min(1),
        secret: z.string().min(1),
        expiresAt: z.string().datetime(),
        rotatesAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        reason: z.enum([
          "setup-required",
          "host-offline",
          "bb-connect-required",
        ]),
        message: z.string().min(1),
      })
      .strict(),
    panelIdentityRejectionSchema,
  ],
);

export const browserPanelReleaseRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
    ownerSessionId: z.string().min(1),
  })
  .strict();

export const browserPanelReleaseHostRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
  })
  .strict();

export const browserPanelReleaseHostResponseSchema = z
  .object({ outcome: z.literal("released") })
  .strict();

export const browserPanelReleaseResponseSchema = z.discriminatedUnion(
  "outcome",
  [browserPanelReleaseHostResponseSchema, panelIdentityRejectionSchema],
);

export type BrowserPanelTransportRequest = z.infer<
  typeof browserPanelTransportRequestSchema
>;
export type BrowserPanelTransportResponse = z.infer<
  typeof browserPanelTransportResponseSchema
>;
export type BrowserPanelReleaseRequest = z.infer<
  typeof browserPanelReleaseRequestSchema
>;
export type BrowserPanelReleaseHostRequest = z.infer<
  typeof browserPanelReleaseHostRequestSchema
>;
export type BrowserPanelReleaseResponse = z.infer<
  typeof browserPanelReleaseResponseSchema
>;
export type PanelIdentityRejection = z.infer<
  typeof panelIdentityRejectionSchema
>;

/**
 * Shared Browser Tab strip for one profile (ADR 0005). Tabs, one active tab,
 * and one Browser Instance belong to a Browser Profile rather than a BB
 * thread, so every Browser Panel using that profile observes the same ordered
 * tab set. Popups are normalized into the strip; runtime-only tab identifiers
 * stay consistent for the life of the instance and are invalidated on
 * restart.
 */
export const browserTabSchema = z
  .object({
    tabId: z.string().min(1),
    url: z.string().min(1),
    title: z.string(),
    origin: z.enum(["page", "popup"]),
    openerTabId: z.string().min(1).nullable(),
  })
  .strict();

export const browserTabStripSchema = z
  .object({
    tabs: z.array(browserTabSchema),
    activeTabId: z.string().min(1).nullable(),
  })
  .strict();

export type BrowserTab = z.infer<typeof browserTabSchema>;
export type BrowserTabStrip = z.infer<typeof browserTabStripSchema>;

/**
 * Shared Control Lease state across every Browser Panel using one profile
 * (ADR 0005/0007/0012). Exactly one panel is the controller at a time and owns
 * the logical viewport that drives page layout; the rest are view-only
 * spectators that scale and letterbox that viewport. A second client starts
 * view-only and cannot send browser input until the owner explicitly chooses
 * Take control. Transfer is atomic and visible to every panel; the live
 * agent-purpose indicator is shown while an agent holds the lease.
 */
export const browserPanelClientSchema = z
  .object({
    panelId: z.string().min(1),
    ownerSessionId: z.string().min(1),
    role: z.enum(["controller", "spectator"]),
    connection: z.enum(["connected", "disconnected"]),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    /**
     * Deadline (clock ms) until which this panel may reclaim control after a
     * disconnect, or null when it has no reclaim window. A spectator with an
     * unexpired deadline must reclaim explicitly to regain input.
     */
    reclaimUntil: z.number().int().nullable(),
  })
  .strict();

export const browserPanelControlStateSchema = z
  .object({
    controllerPanelId: z.string().min(1).nullable(),
    controllerViewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .nullable(),
    agentPurpose: z.string().nullable(),
    panels: z.array(browserPanelClientSchema),
  })
  .strict();

export type BrowserPanelClient = z.infer<typeof browserPanelClientSchema>;
export type BrowserPanelControlState = z.infer<
  typeof browserPanelControlStateSchema
>;

/** Request the shared tab strip for a profile. */
export const browserTabsRequestSchema = browserHostTargetSchema;

/** Request the shared control state for one panel's profile. */
export const browserPanelControlRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
    ownerSessionId: z.string().min(1),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
  })
  .strict();

export const browserPanelControlResponseSchema = z
  .object({
    role: z.enum(["controller", "spectator"]),
    control: browserPanelControlStateSchema,
    tabs: browserTabStripSchema,
  })
  .strict();

export type BrowserPanelControlRequest = z.infer<
  typeof browserPanelControlRequestSchema
>;
export type BrowserPanelControlResponse = z.infer<
  typeof browserPanelControlResponseSchema
>;

/** The controller explicitly transfers control to another panel. */
export const browserPanelTakeControlRequestSchema =
  browserPanelControlRequestSchema;
export type BrowserPanelTakeControlRequest = z.infer<
  typeof browserPanelTakeControlRequestSchema
>;

/**
 * A disconnected controller reclaims control within its reclaim window. The
 * same panel must call this explicitly after a reconnect; input is not
 * re-granted automatically.
 */
export const browserPanelReclaimControlRequestSchema =
  browserPanelControlRequestSchema;
export type BrowserPanelReclaimControlRequest = z.infer<
  typeof browserPanelReclaimControlRequestSchema
>;

/** The controller releases control and returns to spectator. */
export const browserPanelReleaseControlRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
  })
  .strict();
export type BrowserPanelReleaseControlRequest = z.infer<
  typeof browserPanelReleaseControlRequestSchema
>;

/**
 * Browser dialogs captured from the page and rendered as actionable BB panel
 * chrome (issue #17). `Page.javascriptDialogOpening` events are forwarded to
 * every panel over the Automation Mode stream; the controller responds, while
 * spectators see the dialog read-only. Unresolved dialogs are dismissed when a
 * Control Lease ends and survive bounded reconnects or fail closed without an
 * invisible modal block. beforeunload mirrors the native leave/stay choice.
 *
 * Fail-closed default per type (SPEC-8): when the controller never reclaims,
 * a stranded dialog is resolved with the safe default that preserves page
 * state — `alert` accepts (OK, no destructive choice), while `confirm`,
 * `prompt`, and `beforeunload` cancel/stay (`accept:false`) so an unseen
 * action is never silently confirmed and the page is never silently left.
 */
export const browserDialogTypeSchema = z.enum([
  "alert",
  "confirm",
  "prompt",
  "beforeunload",
]);
export type BrowserDialogType = z.infer<typeof browserDialogTypeSchema>;

export const browserDialogEventSchema = z
  .object({
    dialogId: z.string().min(1),
    type: browserDialogTypeSchema,
    message: z.string(),
    /** Default text prefilled in a prompt dialog; empty for the other types. */
    defaultValue: z.string().optional().default(""),
    /** Page URL reported by CDP for the dialog, used for accessible labeling. */
    url: z.string().min(1),
  })
  .strict();
export type BrowserDialogEvent = z.infer<typeof browserDialogEventSchema>;

/**
 * Panel → host response to an open dialog. `accept` selects OK / confirm /
 * stay; its negation selects Cancel / dismiss / leave. `text` carries the
 * prompt answer and is ignored for the other dialog types.
 */
export const browserDialogResponseMessageSchema = z
  .object({
    type: z.literal("dialog_response"),
    dialogId: z.string().min(1),
    accept: z.boolean(),
    text: z.string().max(10_000).optional(),
  })
  .strict();
export type BrowserDialogResponseMessage = z.infer<
  typeof browserDialogResponseMessageSchema
>;

/**
 * Common link and image actions Automation Mode exposes without depending on
 * native Chrome context menus (issue #17). The controller triggers a context
 * query at a viewport point; the host inspects the element under it and reports
 * the available actions, then executes the chosen one. `targetUrl` is the
 * link href or image src the action applies to.
 *
 * Limitation (SPEC-2): `copy-link` and `copy-image-address` write through
 * `navigator.clipboard.writeText` evaluated in the page, which requires
 * transient activation the controller's CDP input does not reliably provide.
 * The source surfaces each copy outcome (ok/not-ok) through its
 * `onContextActionResult` callback rather than silently swallowing failures,
 * so the host can disclose that a copy did not land; v1 does not guarantee
 * delivery to the controller's clipboard.
 */
export const browserContextActionKindSchema = z.enum([
  "open-link-new-tab",
  "copy-link",
  "open-image-new-tab",
  "copy-image-address",
  "save-image",
]);
export type BrowserContextActionKind = z.infer<
  typeof browserContextActionKindSchema
>;

export const browserContextActionSchema = z
  .object({
    actionId: z.string().min(1),
    kind: browserContextActionKindSchema,
    label: z.string().min(1).max(80),
    targetUrl: z.string().min(1),
  })
  .strict();
export type BrowserContextAction = z.infer<typeof browserContextActionSchema>;

/** Panel → host request for the actions available under a viewport point. */
export const browserContextQueryMessageSchema = z
  .object({
    type: z.literal("context_query"),
    queryId: z.string().min(1),
    x: z.number(),
    y: z.number(),
  })
  .strict();
export type BrowserContextQueryMessage = z.infer<
  typeof browserContextQueryMessageSchema
>;

/** Panel → host request to perform a chosen context action. */
export const browserContextActionMessageSchema = z
  .object({
    type: z.literal("context_action"),
    actionId: z.string().min(1),
  })
  .strict();
export type BrowserContextActionMessage = z.infer<
  typeof browserContextActionMessageSchema
>;

/**
 * Explicit clipboard exchange (issue #19). Text clipboard moves only through
 * an explicit owner copy or paste action; the plugin never continuously
 * synchronizes clipboards. `copy` reads the active page selection into the
 * controller's clipboard and `paste` writes the controller's clipboard into
 * the page. Both are discrete controller-only actions; no ambient sync path
 * exists. Outcomes carry privacy-safe metadata (byte counts, not contents) so
 * the panel and CLI can report results without retaining clipboard data.
 */
export const browserClipboardCopyMessageSchema = z
  .object({
    type: z.literal("clipboard_copy"),
    copyId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserClipboardCopyMessage = z.infer<
  typeof browserClipboardCopyMessageSchema
>;

export const browserClipboardPasteMessageSchema = z
  .object({
    type: z.literal("clipboard_paste"),
    pasteId: z.string().min(1).max(120),
    bytes: z.number().int().nonnegative().max(BROWSER_CLIPBOARD_MAX_BYTES),
  })
  .strict();
export type BrowserClipboardPasteMessage = z.infer<
  typeof browserClipboardPasteMessageSchema
>;

export const browserClipboardOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("copied"),
      copyId: z.string().min(1).max(120),
      bytes: z.number().int().nonnegative().max(BROWSER_CLIPBOARD_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("pasted"),
      pasteId: z.string().min(1).max(120),
      bytes: z.number().int().nonnegative().max(BROWSER_CLIPBOARD_MAX_BYTES),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("not-ok"),
      id: z.string().min(1).max(120),
      reason: z.enum([
        "no-selection",
        "clipboard-empty",
        "controller-mismatch",
        "busy",
        "denied",
      ]),
    })
    .strict(),
]);
export type BrowserClipboardOutcome = z.infer<
  typeof browserClipboardOutcomeSchema
>;

/**
 * Transfer Staging request shapes (issue #19, ADR 0011). An upload may come
 * from the displaying client (`client`) or an explicitly selected workspace
 * file (`workspace`). Workspace selections resolve through BB environment
 * file APIs and must remain inside the environment after realpath resolution;
 * the broker rejects traversal, symlink escape, special files,
 * changed-after-selection files, oversized files, and low-disk conditions.
 * Responses carry privacy-safe metadata and never expose the staged path or
 * any unrelated workspace path.
 */
export const browserUploadKindSchema = z.enum(["client", "workspace"]);
export type BrowserUploadKind = z.infer<typeof browserUploadKindSchema>;

export const browserTransferRejectionSchema = z.enum([
  "outside-environment",
  "traversal",
  "symlink-escape",
  "special-file",
  "not-found",
  "changed-after-selection",
  "oversized",
  "quota-exceeded",
  "low-disk",
  "cancelled",
  "unauthorized",
]);
export type BrowserTransferRejection = z.infer<
  typeof browserTransferRejectionSchema
>;

export const browserTransferActorSchema = z.enum(["owner", "agent"]);
export type BrowserTransferActor = z.infer<typeof browserTransferActorSchema>;

export const browserTransferStagingRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("client"),
        transferId: z.string().min(1).max(120),
        fileName: z.string().min(1).max(255),
        contentType: z.string().min(1).max(200).optional(),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(BROWSER_TRANSFER_MAX_FILE_BYTES),
        /**
         * Who initiated the transfer. Enforced through {@link authorizeFileTransfer}
         * before the host stages anything; agents additionally need the
         * file-transfer grant and an active Control Lease. Defaults to `owner`
         * when omitted.
         */
        actor: browserTransferActorSchema.optional(),
        /**
         * The Browser Profile the transfer targets (used to enforce the
         * Control Lease for agent transfers). Defaults to the default profile.
         */
        profileId: z.string().min(1).max(120).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("workspace"),
        transferId: z.string().min(1).max(120),
        sourcePath: z.string().min(1).max(4096),
        environmentRoot: z.string().min(1).max(4096),
        contentType: z.string().min(1).max(200).optional(),
        actor: browserTransferActorSchema.optional(),
        profileId: z.string().min(1).max(120).optional(),
      })
      .strict(),
  ],
);
export type BrowserTransferStagingRequest = z.infer<
  typeof browserTransferStagingRequestSchema
>;

/**
 * Host-targeted staging input: the staging request plus the workspace host to
 * run the broker on. The host strips `hostId` before invoking the manager.
 */
export const browserTransferStageInputSchema = z.discriminatedUnion("kind", [
  browserTransferStagingRequestSchema.options[0]
    .extend({
      hostId: z.string().min(1),
      /**
       * Base64-encoded file bytes for a displaying-client upload received
       * through the active browser file chooser. The host decodes and routes
       * to `stageClientFile`; the staging request itself never carries raw
       * bytes so the manager policy stays byte-oriented and testable.
       */
      data: z.string(),
    })
    .strict(),
  browserTransferStagingRequestSchema.options[1]
    .extend({ hostId: z.string().min(1) })
    .strict(),
]);
export type BrowserTransferStageInput = z.infer<
  typeof browserTransferStageInputSchema
>;

export const browserTransferConsumeInputSchema = z
  .object({
    hostId: z.string().min(1),
    transferId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserTransferConsumeInput = z.infer<
  typeof browserTransferConsumeInputSchema
>;

export const browserTransferReleaseInputSchema = z
  .object({
    hostId: z.string().min(1),
    transferId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserTransferReleaseInput = z.infer<
  typeof browserTransferReleaseInputSchema
>;

export const browserTransferReleaseOutcomeSchema = z
  .object({
    outcome: z.enum(["released", "missing"]),
    transferId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserTransferReleaseOutcome = z.infer<
  typeof browserTransferReleaseOutcomeSchema
>;

export const browserTransferCancelInputSchema = z
  .object({
    hostId: z.string().min(1),
    transferId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserTransferCancelInput = z.infer<
  typeof browserTransferCancelInputSchema
>;

export const browserTransferCancelOutcomeSchema = z
  .object({
    outcome: z.enum(["cancelled", "missing"]),
    transferId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserTransferCancelOutcome = z.infer<
  typeof browserTransferCancelOutcomeSchema
>;

export const browserTransferProgressInputSchema = z
  .object({
    hostId: z.string().min(1),
    transferId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserTransferProgressInput = z.infer<
  typeof browserTransferProgressInputSchema
>;

/**
 * Control Lease state query (issue #19). Used by the transfer path to enforce
 * that an agent-initiated transfer holds an active Control Lease. The host is
 * the source of truth for lease state.
 */
export const browserControlLeaseStateInputSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .strict();
export type BrowserControlLeaseStateInput = z.infer<
  typeof browserControlLeaseStateInputSchema
>;

export const browserControlLeaseStateSchema = z
  .object({
    active: z.boolean(),
    actor: z.enum(["owner", "agent"]).nullable(),
    purpose: z.string().nullable(),
  })
  .strict();
export type BrowserControlLeaseState = z.infer<
  typeof browserControlLeaseStateSchema
>;

export const browserTransferStagingResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("staged"),
        transferId: z.string().min(1).max(120),
        kind: browserUploadKindSchema,
        sizeBytes: z.number().int().nonnegative(),
        contentType: z.string().min(1).max(200).nullable(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("rejected"),
        transferId: z.string().min(1).max(120),
        reason: browserTransferRejectionSchema,
        message: z.string().min(1).max(200),
      })
      .strict(),
  ],
);
export type BrowserTransferStagingResponse = z.infer<
  typeof browserTransferStagingResponseSchema
>;

export const browserTransferProgressPhaseSchema = z.enum([
  "validating",
  "copying",
  "completed",
  "cancelled",
  "failed",
]);
export type BrowserTransferProgressPhase = z.infer<
  typeof browserTransferProgressPhaseSchema
>;

export const browserTransferProgressSchema = z
  .object({
    transferId: z.string().min(1).max(120),
    phase: browserTransferProgressPhaseSchema,
    bytesCopied: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserTransferProgress = z.infer<
  typeof browserTransferProgressSchema
>;

export const browserTransferProgressResultSchema =
  browserTransferProgressSchema.nullable();
export type BrowserTransferProgressResult = z.infer<
  typeof browserTransferProgressResultSchema
>;

export const browserTransferCancelMessageSchema = z
  .object({
    type: z.literal("transfer_cancel"),
    transferId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserTransferCancelMessage = z.infer<
  typeof browserTransferCancelMessageSchema
>;

export const browserTransferOutcomeSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("used"),
      transferId: z.string().min(1).max(120),
      /**
       * The host-local staged path the browser must read before the host
       * releases it. The path leaves the host so the browser process (CDP)
       * can read the file; the caller invokes `transfer_release` after the
       * read so the one-use copy is removed.
       */
      stagedPath: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("cancelled"),
      transferId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("expired"),
      transferId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("removed"),
      transferId: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("missing"),
      transferId: z.string().min(1).max(120),
    })
    .strict(),
]);
export type BrowserTransferOutcome = z.infer<
  typeof browserTransferOutcomeSchema
>;

/**
 * Agent-initiated transfer authorization (issue #19). An agent upload
 * additionally requires the file-transfer elevated grant and an active
 * Control Lease; owner transfers require neither because the owner already
 * holds the browser. The decision is privacy-safe and never echoes paths.
 */
export const browserFileTransferAuthorizationSchema = z
  .object({
    actor: z.enum(["owner", "agent"]),
    fileTransferGranted: z.boolean(),
    leaseActive: z.boolean(),
  })
  .strict();
export type BrowserFileTransferAuthorization = z.infer<
  typeof browserFileTransferAuthorizationSchema
>;

export const browserFileTransferDecisionSchema = z.discriminatedUnion(
  "authorized",
  [
    z.object({ authorized: z.literal(true) }).strict(),
    z
      .object({
        authorized: z.literal(false),
        reason: z.enum([
          "file-transfer-grant-required",
          "control-lease-required",
        ]),
      })
      .strict(),
  ],
);
export type BrowserFileTransferDecision = z.infer<
  typeof browserFileTransferDecisionSchema
>;

/**
 * Host Downloads (issue #20). Browser downloads enter a profile-scoped
 * quarantine owned by `bb-browser` with restrictive permissions and are never
 * opened, executed, or exported automatically. The owner may explicitly
 * export a quarantined download to the displaying client or workspace; an
 * existing workspace target requires a separate overwrite confirmation, and
 * an agent export additionally requires the file-transfer grant. Rejections,
 * progress, and listing are metadata-only: they never carry file contents,
 * full URLs, page data, or clipboard data.
 */
export const browserDownloadRejectionSchema = z.enum([
  "invalid-name",
  "oversized",
  "quota-exceeded",
  "low-disk",
  "not-found",
  "already-completed",
  "cancelled",
  "unauthorized",
  "outside-environment",
  "exists-without-confirmation",
  "failed",
]);
export type BrowserDownloadRejection = z.infer<
  typeof browserDownloadRejectionSchema
>;

export const browserDownloadPhaseSchema = z.enum([
  "downloading",
  "quarantined",
  "cancelled",
  "failed",
  "expired",
  "exported",
]);
export type BrowserDownloadPhase = z.infer<typeof browserDownloadPhaseSchema>;

export const browserDownloadStartRequestSchema = z
  .object({
    downloadId: z.string().min(1).max(120),
    profileId: z.string().min(1).max(120),
    /** Untrusted suggested filename from the browser; normalized safely. */
    suggestedName: z.string().min(1).max(1024),
    contentType: z.string().min(1).max(200).nullable(),
    /** Declared total bytes when known; null when unknown (streamed). */
    totalBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type BrowserDownloadStartRequest = z.infer<
  typeof browserDownloadStartRequestSchema
>;

export const browserDownloadStartInputSchema =
  browserDownloadStartRequestSchema.extend({
    hostId: z.string().min(1),
  });
export type BrowserDownloadStartInput = z.infer<
  typeof browserDownloadStartInputSchema
>;

export const browserDownloadAppendInputSchema = z
  .object({
    hostId: z.string().min(1),
    downloadId: z.string().min(1).max(120),
    /** Base64-encoded chunk bytes appended to the quarantined file. */
    data: z.string(),
    /** Declared chunk byte length; must match the decoded bytes. */
    chunkBytes: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserDownloadAppendInput = z.infer<
  typeof browserDownloadAppendInputSchema
>;

export const browserDownloadCompleteInputSchema = z
  .object({
    hostId: z.string().min(1),
    downloadId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserDownloadCompleteInput = z.infer<
  typeof browserDownloadCompleteInputSchema
>;

export const browserDownloadFailInputSchema = z
  .object({
    hostId: z.string().min(1),
    downloadId: z.string().min(1).max(120),
    /** Privacy-safe reason text; never file contents or a full URL. */
    reason: z.string().min(1).max(200),
  })
  .strict();
export type BrowserDownloadFailInput = z.infer<
  typeof browserDownloadFailInputSchema
>;

/**
 * Outcome of failing a quarantined download (issue #20 findings, S1). Carries
 * the real result from the manager — not a fabricated purge outcome. A
 * `failed` outcome removes the quarantine file (`removed: 1`) and reports the
 * owning profile; a `missing` outcome reports `removed: 0` and `profileId:
 * null` because no record existed to clean up.
 */
export const browserDownloadFailOutcomeSchema = z
  .object({
    outcome: z.enum(["failed", "missing"]),
    downloadId: z.string().min(1).max(120),
    profileId: z.string().min(1).max(120).nullable(),
    removed: z.number().int().min(0).max(1),
  })
  .strict();
export type BrowserDownloadFailOutcome = z.infer<
  typeof browserDownloadFailOutcomeSchema
>;

export const browserDownloadCancelInputSchema = z
  .object({
    hostId: z.string().min(1),
    downloadId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserDownloadCancelInput = z.infer<
  typeof browserDownloadCancelInputSchema
>;

export const browserDownloadTargetInputSchema = z
  .object({
    hostId: z.string().min(1),
    downloadId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserDownloadTargetInput = z.infer<
  typeof browserDownloadTargetInputSchema
>;

export const browserDownloadListingEntrySchema = z
  .object({
    downloadId: z.string().min(1).max(120),
    profileId: z.string().min(1).max(120),
    safeName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(200).nullable(),
    sizeBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().nullable(),
    phase: browserDownloadPhaseSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    error: z.string().min(1).max(200).nullable(),
  })
  .strict();
export type BrowserDownloadListingEntry = z.infer<
  typeof browserDownloadListingEntrySchema
>;

export const browserDownloadListInputSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserDownloadListInput = z.infer<
  typeof browserDownloadListInputSchema
>;

export const browserDownloadLimitsSchema = z
  .object({
    maxFileBytes: z.number().int().positive(),
    maxProfileBytes: z.number().int().positive(),
    expiryMs: z.number().int().positive(),
  })
  .strict();
export type BrowserDownloadLimits = z.infer<typeof browserDownloadLimitsSchema>;

export const browserDownloadListResultSchema = z
  .object({
    downloads: z.array(browserDownloadListingEntrySchema),
    limits: browserDownloadLimitsSchema,
    freeSpaceBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type BrowserDownloadListResult = z.infer<
  typeof browserDownloadListResultSchema
>;

export const browserDownloadLimitsInputSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1).max(120),
    maxFileBytes: z.number().int().positive().optional(),
    maxProfileBytes: z.number().int().positive().optional(),
    expiryMs: z.number().int().positive().optional(),
  })
  .strict();
export type BrowserDownloadLimitsInput = z.infer<
  typeof browserDownloadLimitsInputSchema
>;

export const browserDownloadProgressSchema = z
  .object({
    downloadId: z.string().min(1).max(120),
    phase: browserDownloadPhaseSchema,
    bytesDownloaded: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type BrowserDownloadProgress = z.infer<
  typeof browserDownloadProgressSchema
>;
export const browserDownloadProgressResultSchema =
  browserDownloadProgressSchema.nullable();
export type BrowserDownloadProgressResult = z.infer<
  typeof browserDownloadProgressResultSchema
>;

export const browserDownloadStartResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("quarantined"),
        downloadId: z.string().min(1).max(120),
        safeName: z.string().min(1).max(255),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("rejected"),
        downloadId: z.string().min(1).max(120),
        reason: browserDownloadRejectionSchema,
        message: z.string().min(1).max(200),
      })
      .strict(),
  ],
);
export type BrowserDownloadStartResponse = z.infer<
  typeof browserDownloadStartResponseSchema
>;

export const browserDownloadAppendOutcomeSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("appended"),
        downloadId: z.string().min(1).max(120),
        bytesDownloaded: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("rejected"),
        downloadId: z.string().min(1).max(120),
        reason: browserDownloadRejectionSchema,
        message: z.string().min(1).max(200),
      })
      .strict(),
  ],
);
export type BrowserDownloadAppendOutcome = z.infer<
  typeof browserDownloadAppendOutcomeSchema
>;

export const browserDownloadCancelOutcomeSchema = z
  .object({
    outcome: z.enum(["cancelled", "missing"]),
    downloadId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserDownloadCancelOutcome = z.infer<
  typeof browserDownloadCancelOutcomeSchema
>;

export const browserDownloadCompleteOutcomeSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("quarantined"),
        downloadId: z.string().min(1).max(120),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("rejected"),
        downloadId: z.string().min(1).max(120),
        reason: browserDownloadRejectionSchema,
        message: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("missing"),
        downloadId: z.string().min(1).max(120),
      })
      .strict(),
  ],
);
export type BrowserDownloadCompleteOutcome = z.infer<
  typeof browserDownloadCompleteOutcomeSchema
>;

export const browserDownloadExportActorSchema = z.enum(["owner", "agent"]);
export type BrowserDownloadExportActor = z.infer<
  typeof browserDownloadExportActorSchema
>;

export const browserDownloadExportClientInputSchema = z
  .object({
    hostId: z.string().min(1),
    downloadId: z.string().min(1).max(120),
    actor: browserDownloadExportActorSchema.optional(),
    profileId: z.string().min(1).max(120).optional(),
  })
  .strict();
export type BrowserDownloadExportClientInput = z.infer<
  typeof browserDownloadExportClientInputSchema
>;

export const browserDownloadExportWorkspaceInputSchema = z
  .object({
    hostId: z.string().min(1),
    downloadId: z.string().min(1).max(120),
    actor: browserDownloadExportActorSchema.optional(),
    profileId: z.string().min(1).max(120).optional(),
    /**
     * Resolved environment root path (the server resolves the BB environment
     * id to its workspace path before calling the host).
     */
    environmentRoot: z.string().min(1).max(4096),
    /** Path relative to the environment root after realpath containment. */
    relativePath: z.string().min(1).max(4096),
    /**
     * Separate owner confirmation that an existing workspace target may be
     * overwritten. The export is rejected with `exists-without-confirmation`
     * when the target exists and this is not explicitly true.
     */
    overwriteConfirmed: z.boolean().optional(),
  })
  .strict();
export type BrowserDownloadExportWorkspaceInput = z.infer<
  typeof browserDownloadExportWorkspaceInputSchema
>;

export const browserDownloadExportOutcomeSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("exported"),
        downloadId: z.string().min(1).max(120),
        destination: z.enum(["client", "workspace"]),
        safeName: z.string().min(1).max(255),
        contentType: z.string().min(1).max(200).nullable(),
        sizeBytes: z.number().int().nonnegative(),
        /**
         * Present only for a client export: base64-encoded file bytes so the
         * displaying client may save them. The bytes leave quarantine only on
         * this explicit owner decision. Workspace exports copy host-to-host and
         * never return bytes.
         */
        data: z.string().optional(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("rejected"),
        downloadId: z.string().min(1).max(120),
        reason: browserDownloadRejectionSchema,
        message: z.string().min(1).max(200),
      })
      .strict(),
  ],
);
export type BrowserDownloadExportOutcome = z.infer<
  typeof browserDownloadExportOutcomeSchema
>;

export const browserDownloadPurgeInputSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1).max(120).optional(),
  })
  .strict();
export type BrowserDownloadPurgeInput = z.infer<
  typeof browserDownloadPurgeInputSchema
>;
export const browserDownloadPurgeOutcomeSchema = z
  .object({
    outcome: z.literal("purged"),
    profileId: z.string().min(1).max(120).nullable(),
    removed: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserDownloadPurgeOutcome = z.infer<
  typeof browserDownloadPurgeOutcomeSchema
>;

/** Panel → host request to cancel a quarantined download. */
export const browserDownloadCancelMessageSchema = z
  .object({
    type: z.literal("download_cancel"),
    downloadId: z.string().min(1).max(120),
  })
  .strict();
export type BrowserDownloadCancelMessage = z.infer<
  typeof browserDownloadCancelMessageSchema
>;

/**
 * Accessible-chrome constants (issue #17). Plugin chrome targets WCAG AA,
 * honors reduced motion, and yields BB global shortcuts; the streamed webpage
 * canvas is not fully screen-reader accessible in v1 and is disclosed as such.
 */
export const BROWSER_PANEL_DIALOG_RECONNECT_REPUSH_MS = PANEL_RECLAIM_WINDOW_MS;
/** AA-contrast fallback colors used when theme tokens are unavailable. */
export const BROWSER_PANEL_TEXT_CONTRAST = "#111827";
export const BROWSER_PANEL_BORDER_CONTRAST = "#9ca3af";
export const BROWSER_PANEL_ACCENT_CONTRAST = "#1d4ed8";
/**
 * The host-status dot in the browser toolbar (issue #50). Colour is never the
 * only signal — the control carries the state in its accessible name — but it
 * is what the owner reads at a glance, so the three live here with the rest of
 * the AA-audited chrome rather than as literals in the toolbar.
 */
export const BROWSER_PANEL_STATUS_READY_CONTRAST = "#15803d";
export const BROWSER_PANEL_STATUS_SETTLING_CONTRAST = "#b45309";
export const BROWSER_PANEL_STATUS_BLOCKED_CONTRAST = "#b91c1c";
export const BROWSER_PANEL_STREAM_DISCLOSURE =
  "Streamed webpage pixels are not fully screen-reader accessible in version one.";

export const browserNavigationResponseSchema = z
  .object({
    address: z.object({ kind: z.literal("address"), url: z.string().url() }),
    location: z.unknown(),
    tabId: z.string().min(1),
  })
  .strict();

export type BrowserPanelNavigationRequest = z.infer<
  typeof browserPanelNavigationRequestSchema
>;
export type BrowserPanelNavigationInput = z.input<
  typeof browserPanelNavigationRequestSchema
>;
export type BrowserPanelHistoryRequest = z.infer<
  typeof browserPanelHistoryRequestSchema
>;
export type BrowserPanelHistoryInput = z.input<
  typeof browserPanelHistoryRequestSchema
>;
export type BrowserHistoryRequest = z.infer<typeof browserHistoryRequestSchema>;
export type BrowserNavigationRequest = z.infer<
  typeof browserNavigationRequestSchema
>;
export type BrowserNavigationResponse = z.infer<
  typeof browserNavigationResponseSchema
>;

export const rpcContract = defineRpcContract({
  browser_status: {
    input: browserStatusInputSchema,
    output: browserStatusSchema,
  },
  browser_navigate: {
    input: browserPanelNavigationRequestSchema,
    output: browserNavigationResponseSchema,
  },
  browser_history: {
    input: browserPanelHistoryRequestSchema,
    output: browserNavigationResponseSchema,
  },
  browser_panel_visibility: {
    input: browserPanelVisibilityRequestSchema,
    output: browserStatusSchema,
  },
  browser_panel_capability: {
    input: browserPanelCapabilityRequestSchema,
    output: browserPanelCapabilityResponseSchema,
  },
  browser_panel_release: {
    input: browserPanelReleaseRequestSchema,
    output: browserPanelReleaseResponseSchema,
  },
  browser_tabs: {
    input: browserTabsRequestSchema,
    output: browserTabStripSchema,
  },
  browser_tab_action: {
    input: browserPanelTabActionRequestSchema,
    output: browserTabStripSchema,
  },
  browser_panel_control: {
    input: browserPanelControlRequestSchema,
    output: browserPanelControlResponseSchema,
  },
  browser_panel_take_control: {
    input: browserPanelTakeControlRequestSchema,
    output: browserPanelControlResponseSchema,
  },
  browser_panel_reclaim_control: {
    input: browserPanelReclaimControlRequestSchema,
    output: browserPanelControlResponseSchema,
  },
  browser_panel_release_control: {
    input: browserPanelReleaseControlRequestSchema,
    output: browserPanelControlResponseSchema,
  },
  browser_settings_status: {
    input: z.object({ profileId: z.string().min(1) }).strict(),
    output: z.array(browserStatusSchema),
  },
  browser_diagnostics: {
    input: browserStatusTargetSchema,
    output: browserDiagnosticsSchema,
  },
  browser_activity_records: {
    input: browserHostTargetSchema,
    output: browserActivityRecordsSchema,
  },
  browser_activity_export: {
    input: browserHostTargetSchema,
    output: browserActivityExportSchema,
  },
  browser_activity_clear: {
    input: browserActivityClearRequestSchema,
    output: browserActivityClearResponseSchema,
  },
  browser_setup_plan: {
    input: browserHostTargetSchema,
    output: browserSetupPlanSchema,
  },
  browser_setup: {
    input: browserSetupRequestSchema,
    output: browserSetupResponseSchema,
  },
  browser_disable: {
    input: browserLifecycleRequestSchema,
    output: browserLifecycleResponseSchema,
  },
  browser_uninstall: {
    input: browserLifecycleRequestSchema,
    output: browserLifecycleResponseSchema,
  },
  browser_purge_plan: {
    input: browserHostTargetSchema,
    output: browserPurgePlanSchema,
  },
  browser_purge: {
    input: browserPurgeRequestSchema,
    output: browserPurgeResponseSchema,
  },
  browser_profiles: {
    input: browserProfileQuerySchema,
    output: browserProfileInventorySchema,
  },
  browser_grants: {
    input: browserProfileGrantQuerySchema,
    output: browserProfileGrantsSchema,
  },
  browser_grant_create: {
    input: browserProfileGrantCreateRequestSchema,
    output: browserProfileGrantSchema,
  },
  browser_grant_inspect: {
    input: z.object({ grantId: browserProfileGrantIdSchema }).strict(),
    output: browserProfileGrantSchema.nullable(),
  },
  browser_grant_revoke: {
    input: browserProfileGrantRevokeRequestSchema,
    output: browserProfileGrantRevokeResponseSchema,
  },
  browser_grant_requests: {
    input: browserGrantRequestQuerySchema,
    output: browserGrantRequestsSchema,
  },
  browser_grant_request_inspect: {
    input: z.object({ requestId: browserGrantRequestIdSchema }).strict(),
    output: browserGrantRequestSchema.nullable(),
  },
  browser_grant_request_decide: {
    input: browserGrantRequestDecisionRequestSchema,
    output: browserGrantRequestDecisionResponseSchema,
  },
  browser_grant_request_revoke: {
    input: browserGrantRequestRevokeRequestSchema,
    output: browserGrantRequestDecisionResponseSchema,
  },
  browser_profile_create: {
    input: browserProfileCreateRequestSchema,
    output: browserProfileSchema,
  },
  browser_profile_rename: {
    input: browserProfileRenameRequestSchema,
    output: browserProfileSchema,
  },
  browser_profile_select: {
    input: browserProfileSelectionRequestSchema,
    output: browserProfileInventorySchema,
  },
  browser_profile_archive: {
    input: browserProfileTargetSchema,
    output: browserProfileLifecycleResponseSchema,
  },
  browser_profile_restore_archived: {
    input: browserProfileTargetSchema,
    output: browserProfileLifecycleResponseSchema,
  },
  browser_profile_reset: {
    input: browserProfileResetRequestSchema,
    output: browserProfileLifecycleResponseSchema,
  },
  browser_profile_delete: {
    input: browserProfileDeleteRequestSchema.omit({ defaultProfileId: true }),
    output: browserProfileLifecycleResponseSchema,
  },
  browser_profile_backup: {
    input: browserProfileBackupRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  browser_profile_restore: {
    input: browserProfileRestoreRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  browser_profile_import: {
    input: browserProfileImportRequestSchema,
    output: browserProfileRecoveryResponseSchema,
  },
  browser_host_choices: {
    input: browserHostChoicesInputSchema,
    output: z.array(browserHostChoiceSchema),
  },
  browser_transfer_stage: {
    input: browserTransferStageInputSchema,
    output: browserTransferStagingResponseSchema,
  },
  browser_transfer_consume: {
    input: browserTransferConsumeInputSchema,
    output: browserTransferOutcomeSchema,
  },
  browser_transfer_release: {
    input: browserTransferReleaseInputSchema,
    output: browserTransferReleaseOutcomeSchema,
  },
  browser_transfer_cancel: {
    input: browserTransferCancelInputSchema,
    output: browserTransferCancelOutcomeSchema,
  },
  browser_transfer_progress: {
    input: browserTransferProgressInputSchema,
    output: browserTransferProgressResultSchema,
  },
  browser_control_lease_state: {
    input: browserControlLeaseStateInputSchema,
    output: browserControlLeaseStateSchema,
  },
  browser_file_transfer_authorize: {
    input: browserFileTransferAuthorizationSchema,
    output: browserFileTransferDecisionSchema,
  },
  browser_download_start: {
    input: browserDownloadStartInputSchema,
    output: browserDownloadStartResponseSchema,
  },
  browser_download_append: {
    input: browserDownloadAppendInputSchema,
    output: browserDownloadAppendOutcomeSchema,
  },
  browser_download_complete: {
    input: browserDownloadCompleteInputSchema,
    output: browserDownloadCompleteOutcomeSchema,
  },
  browser_download_fail: {
    input: browserDownloadFailInputSchema,
    output: browserDownloadFailOutcomeSchema,
  },
  browser_download_cancel: {
    input: browserDownloadCancelInputSchema,
    output: browserDownloadCancelOutcomeSchema,
  },
  browser_download_list: {
    input: browserDownloadListInputSchema,
    output: browserDownloadListResultSchema,
  },
  browser_download_limits: {
    input: browserDownloadLimitsInputSchema,
    output: browserDownloadLimitsSchema,
  },
  browser_download_progress: {
    input: browserDownloadTargetInputSchema,
    output: browserDownloadProgressResultSchema,
  },
  browser_download_export_client: {
    input: browserDownloadExportClientInputSchema,
    output: browserDownloadExportOutcomeSchema,
  },
  browser_download_export_workspace: {
    input: browserDownloadExportWorkspaceInputSchema,
    output: browserDownloadExportOutcomeSchema,
  },
  browser_download_purge: {
    input: browserDownloadPurgeInputSchema,
    output: browserDownloadPurgeOutcomeSchema,
  },
});

export const browserScriptParametersSchema = z
  .object({
    purpose: z.string().trim().min(1).max(200),
    code: z.string().min(1),
    destinationOrigin: browserActivityOriginSchema.optional(),
    fileTransfer: z.boolean().default(false),
    invalidCertificate: z.boolean().default(false),
    profileId: z.string().min(1).optional(),
    tabId: z.string().min(1).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(BROWSER_SCRIPT_MIN_TIMEOUT_MS)
      .max(BROWSER_SCRIPT_MAX_TIMEOUT_MS)
      .default(BROWSER_SCRIPT_MAX_TIMEOUT_MS),
    screenshot: z.boolean().default(false),
  })
  .strict();

export const browserScriptRequestSchema = browserScriptParametersSchema
  .extend({
    hostId: z.string().min(1),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    activityEventId: browserActivityEventIdSchema,
    activityOccurredAt: z.string().datetime(),
    profileId: z.string().min(1),
    /**
     * The resolved Profile Grant Origin Scope the host must enforce during
     * real browser navigation. The server resolves it from the active grant
     * so top-level navigations, redirects, popups, and relevant frame
     * navigations are checked before commit using the same normalized policy
     * as the grant store. Omitting it disables enforcement (owner browsing).
     */
    originScope: browserOriginScopeSchema.optional(),
    /**
     * The per-origin invalid-certificate opt-ins resolved from the active
     * grant. The host carries them into its navigation guard so navigation
     * to a granted origin can load despite a bad TLS certificate, using the
     * same normalized policy the grant store approved.
     */
    invalidCertificateOrigins: z
      .array(browserExactOriginSchema)
      .max(100)
      .optional(),
  })
  .strict();

export const browserScriptRuntimeErrorSchema = z
  .object({
    state: z.literal("runtime-error"),
    code: z.enum([
      "browser_busy",
      "browser_timeout",
      "result_too_large",
      "lease_revoked",
      "tab_invalid",
      "sandbox_violation",
      "script_failed",
      "safe_login_denied",
    ]),
    label: z.string().trim().min(1).max(80),
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    message: z.string().trim().min(1).max(500),
    grantRequest: z.never().optional(),
  })
  .strict();

export const browserScriptFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.union([
      browserStatusSchema,
      browserOriginDeniedErrorSchema,
      browserScriptRuntimeErrorSchema,
    ]),
  })
  .strict();

export const browserScriptSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

export const browserScriptResponseSchema = z.discriminatedUnion("ok", [
  browserScriptSuccessSchema,
  browserScriptFailureSchema,
]);

export const browserNativeScreenshotSchema = z
  .object({
    data: z.string().min(1).max(BROWSER_SCRIPT_MAX_SCREENSHOT_BASE64_LENGTH),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict();

export const browserScriptResultSchema = z
  .object({
    output: z.string(),
    screenshots: z
      .array(browserNativeScreenshotSchema)
      .max(BROWSER_SCRIPT_MAX_SCREENSHOTS),
  })
  .strict();

export type BrowserScriptRequest = z.infer<typeof browserScriptRequestSchema>;
export type BrowserScriptFailure = z.infer<typeof browserScriptFailureSchema>;
export type BrowserScriptResponse = z.infer<typeof browserScriptResponseSchema>;
export type BrowserControlLease = z.infer<typeof browserControlLeaseSchema>;
export type BrowserScriptRuntimeError = z.infer<
  typeof browserScriptRuntimeErrorSchema
>;
export type BrowserNativeScreenshot = z.infer<
  typeof browserNativeScreenshotSchema
>;
export type BrowserScriptResult = z.infer<typeof browserScriptResultSchema>;
