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
export const BROWSER_SCRIPT_MAX_TIMEOUT_MS = 30_000;
export const BROWSER_SCRIPT_RESULT_LIMIT_BYTES = 256 * 1024;
export const BROWSER_SCRIPT_MAX_SCREENSHOTS = 3;
export const BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES = 1 * 1024 * 1024;
export const BROWSER_SCRIPT_MAX_SCREENSHOT_BASE64_LENGTH =
  4 * Math.ceil(BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES / 3);

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

const browserNavigationFields = {
  input: z.string().min(1).max(2048),
  tabId: z.string().min(1).optional(),
  rawLocalhost: z.boolean().default(false),
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
  })
  .strict();

export const browserPanelVisibilityRequestSchema = z
  .object({
    hostId: z.string().min(1),
    profileId: z.string().min(1),
    panelId: z.string().min(1),
    visibility: z.enum(["visible", "hidden"]),
  })
  .strict();

export type BrowserPanelVisibilityRequest = z.infer<
  typeof browserPanelVisibilityRequestSchema
>;

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
  browser_panel_visibility: {
    input: browserPanelVisibilityRequestSchema,
    output: browserStatusSchema,
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
      .positive()
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
