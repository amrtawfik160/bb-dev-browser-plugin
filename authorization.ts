import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  browserExactOriginSchema,
  browserOriginScopeSchema,
  browserProfileGrantIdSchema,
  browserProfileGrantSchema,
  normalizeBrowserOrigin,
  PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
  type BrowserAuthorizationRequest,
  type BrowserGrantRequest,
  type BrowserGrantRequestDecisionRequest,
  type BrowserGrantRequestDecisionResponse,
  type BrowserGrantRequestQuery,
  type BrowserProfileGrant,
  type BrowserTemporaryGrant,
} from "./contracts.js";
import {
  createGrantRequestStore,
  emitRequestEvents,
  type GrantRequestAuthorizationDecision,
  type GrantRequestEvent,
  type GrantRequestStore,
} from "./grant-requests.js";

const GRANT_ID_PREFIX = "grant-";
const PROJECT_ALIAS_LENGTH = 12;
const ELEVATION_DURATION_MS = 60 * 60 * 1000;
const RAW_LOCALHOST_HOSTS = new Set([
  "localhost",
  "localhost.",
  "127.0.0.1",
  "[::1]",
  "0.0.0.0",
  "[::]",
]);

const authorizationMigration = `
CREATE TABLE browser_profile_grants (
  grant_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  origin_scope TEXT NOT NULL,
  whole_web INTEGER NOT NULL CHECK (whole_web IN (0, 1)),
  file_transfer INTEGER NOT NULL CHECK (file_transfer IN (0, 1)),
  invalid_certificate_origins TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX browser_profile_grants_binding
  ON browser_profile_grants (project_id, host_id, installation_id, profile_id);
CREATE INDEX browser_profile_grants_active_scope
  ON browser_profile_grants (host_id, profile_id, revoked_at, origin_scope);
`;

const authorizationElevationMigration = `
ALTER TABLE browser_profile_grants
  ADD COLUMN persistent_elevations INTEGER NOT NULL DEFAULT 0
  CHECK (persistent_elevations IN (0, 1));
ALTER TABLE browser_profile_grants
  ADD COLUMN whole_web_expires_at TEXT;
ALTER TABLE browser_profile_grants
  ADD COLUMN file_transfer_expires_at TEXT;
ALTER TABLE browser_profile_grants
  ADD COLUMN invalid_certificate_expires_at TEXT;
UPDATE browser_profile_grants
SET whole_web_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 hour')
WHERE whole_web = 1;
UPDATE browser_profile_grants
SET file_transfer_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 hour')
WHERE file_transfer = 1;
UPDATE browser_profile_grants
SET invalid_certificate_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 hour')
WHERE invalid_certificate_origins <> '[]';
`;

const authorizationProjectMigration = `
CREATE TABLE browser_profile_grant_projects (
  project_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  deleted_at TEXT
);
`;

export const BROWSER_AUTHORIZATION_MIGRATIONS = [
  authorizationMigration,
  authorizationElevationMigration,
  authorizationProjectMigration,
] as const;

export type { BrowserAuthorizationRequest } from "./contracts.js";

export type BrowserAuthorizationFailure = {
  allowed: false;
  code: "origin_denied";
  message: string;
  grantRequest: BrowserGrantRequest | null;
};

export type BrowserAuthorizationSuccess = {
  allowed: true;
  grant: BrowserProfileGrant;
  temporaryGrant?: BrowserTemporaryGrant;
  grantRequest: BrowserGrantRequest | null;
};

export type BrowserAuthorizationDecision =
  BrowserAuthorizationFailure | BrowserAuthorizationSuccess;

export type BrowserProfileGrantQuery = {
  grantId?: string;
  projectId?: string;
  hostId?: string;
  installationId?: string;
  profileId?: string;
  includeRevoked?: boolean;
};

export type BrowserProfileGrantRevokeResult = {
  grantId: string;
  outcome: "revoked" | "already-revoked" | "not-found";
};

export type BrowserProfileGrantInput = Omit<
  BrowserProfileGrant,
  | "grantId"
  | "createdAt"
  | "updatedAt"
  | "revokedAt"
  | "persistentElevations"
  | "wholeWebExpiresAt"
  | "fileTransferExpiresAt"
  | "invalidCertificateExpiresAt"
> & {
  grantId?: string;
  createdAt?: string;
  updatedAt?: string;
  persistentElevations?: boolean;
  persistenceConfirmation?: string;
};

export type ProfileGrantStoreOptions = {
  clock?: () => Date;
  idFactory?: () => string;
  onGrantRequestEvent?: (event: GrantRequestEvent) => void;
};

type GrantRow = {
  grant_id: string;
  project_id: string;
  host_id: string;
  installation_id: string;
  profile_id: string;
  origin_scope: string;
  whole_web: number;
  file_transfer: number;
  invalid_certificate_origins: string;
  persistent_elevations: number;
  whole_web_expires_at: string | null;
  file_transfer_expires_at: string | null;
  invalid_certificate_expires_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type GrantStore = {
  create(input: BrowserProfileGrantInput): BrowserProfileGrant;
  list(query?: BrowserProfileGrantQuery): BrowserProfileGrant[];
  inspect(grantId: string): BrowserProfileGrant | null;
  revoke(grantId: string): BrowserProfileGrantRevokeResult;
  expireTemporaryGrant(grantId: string, expirationTime?: Date): void;
  authorize(request: BrowserAuthorizationRequest): BrowserAuthorizationDecision;
  listRequests(query?: BrowserGrantRequestQuery): BrowserGrantRequest[];
  inspectRequest(requestId: string): BrowserGrantRequest | null;
  inspectTemporaryGrant(grantId: string): BrowserTemporaryGrant | null;
  decideRequest(
    input: BrowserGrantRequestDecisionRequest,
  ): BrowserGrantRequestDecisionResponse;
  revokeRequest(requestId: string): BrowserGrantRequestDecisionResponse;
  revokeProject(projectId: string): BrowserProfileGrant[];
  projectDeleted(projectId: string): BrowserProfileGrant[];
  projectGeneration(projectId: string): number;
  projectCreated(projectId: string): number;
  revokeProfile(target: {
    hostId: string;
    installationId: string;
    profileId: string;
  }): BrowserProfileGrant[];
};

function isGrantRow(row: unknown): row is GrantRow {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Partial<GrantRow>;
  return (
    typeof candidate.grant_id === "string" &&
    typeof candidate.project_id === "string" &&
    typeof candidate.host_id === "string" &&
    typeof candidate.installation_id === "string" &&
    typeof candidate.profile_id === "string" &&
    typeof candidate.origin_scope === "string" &&
    (candidate.whole_web === 0 || candidate.whole_web === 1) &&
    (candidate.file_transfer === 0 || candidate.file_transfer === 1) &&
    typeof candidate.invalid_certificate_origins === "string" &&
    (candidate.persistent_elevations === 0 ||
      candidate.persistent_elevations === 1) &&
    (candidate.whole_web_expires_at === null ||
      typeof candidate.whole_web_expires_at === "string") &&
    (candidate.file_transfer_expires_at === null ||
      typeof candidate.file_transfer_expires_at === "string") &&
    (candidate.invalid_certificate_expires_at === null ||
      typeof candidate.invalid_certificate_expires_at === "string") &&
    typeof candidate.created_at === "string" &&
    typeof candidate.updated_at === "string" &&
    (candidate.revoked_at === null || typeof candidate.revoked_at === "string")
  );
}

function grantRow(row: unknown): GrantRow {
  if (isGrantRow(row)) return row;
  throw new Error("Browser Profile Grant storage returned an invalid row.");
}

function storedRevokedAt(row: unknown): string | null | undefined {
  if (row === undefined) return undefined;
  if (typeof row !== "object" || row === null) {
    throw new Error("Browser Profile Grant storage returned an invalid row.");
  }
  const revokedAt = (row as { revoked_at?: unknown }).revoked_at;
  if (revokedAt !== null && typeof revokedAt !== "string") {
    throw new Error("Browser Profile Grant storage returned an invalid row.");
  }
  return revokedAt;
}

function invalidCertificateOrigins(serialized: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new Error(
      "Browser Profile Grant contains invalid certificate metadata.",
    );
  }
  if (!Array.isArray(decoded)) {
    throw new Error(
      "Browser Profile Grant contains invalid certificate metadata.",
    );
  }
  return decoded.map((origin) => browserExactOriginSchema.parse(origin));
}

function grantFromRow(row: unknown): BrowserProfileGrant {
  const parsed = grantRow(row);
  const originScope = browserOriginScopeSchema.parse(parsed.origin_scope);
  const origins = invalidCertificateOrigins(parsed.invalid_certificate_origins);
  return browserProfileGrantSchema.parse({
    grantId: parsed.grant_id,
    projectId: parsed.project_id,
    hostId: parsed.host_id,
    installationId: parsed.installation_id,
    profileId: parsed.profile_id,
    originScope,
    wholeWeb: parsed.whole_web === 1,
    fileTransfer: parsed.file_transfer === 1,
    invalidCertificateOrigins: origins,
    persistentElevations: parsed.persistent_elevations === 1,
    wholeWebExpiresAt: parsed.whole_web_expires_at,
    fileTransferExpiresAt: parsed.file_transfer_expires_at,
    invalidCertificateExpiresAt: parsed.invalid_certificate_expires_at,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    revokedAt: parsed.revoked_at,
  });
}

function scopeMatchesOrigin(scope: string, origin: string) {
  if (scope === "*") return !isRawLocalhost(origin);
  if (!scope.includes("://*.")) return scope === origin;
  const scopeParts = /^([^:]+):\/\/\*\.([^:/]+)(?::(\d+))?$/u.exec(scope);
  if (scopeParts === null) return false;
  const destination = new URL(origin);
  const protocol = `${scopeParts[1]}:`;
  const baseHost = scopeParts[2]!;
  const scopePort = scopeParts[3] ?? "";
  const destinationPort = destination.port;
  return (
    destination.protocol === protocol &&
    (scopePort === destinationPort ||
      (scopePort === "" && destinationPort === "")) &&
    destination.hostname !== baseHost &&
    destination.hostname.endsWith(`.${baseHost}`)
  );
}

export function isBrowserLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "localhost." ||
    isIpv4Loopback(normalized) ||
    isIpv6Loopback(normalized)
  );
}

export function isRawLocalhostHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    RAW_LOCALHOST_HOSTS.has(normalized) || isBrowserLoopbackHostname(normalized)
  );
}

function isRawLocalhost(origin: string) {
  const hostname = new URL(origin).hostname.toLowerCase();
  return isRawLocalhostHostname(hostname);
}

function isIpv4Loopback(hostname: string) {
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^\d+$/u.test(octet) && Number(octet) >= 0 && Number(octet) <= 255,
    )
  );
}

function ipv6Hextets(hostname: string): number[] | null {
  const value =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (!value.includes(":")) return null;

  const parsePart = (part: string) => {
    if (part === "") return [];
    const segments = part.split(":");
    const hextets: number[] = [];
    for (const [index, segment] of segments.entries()) {
      if (segment.includes(".")) {
        if (index !== segments.length - 1) return null;
        const octets = segment.split(".");
        if (
          octets.length !== 4 ||
          octets.some(
            (octet) =>
              !/^\d+$/u.test(octet) || Number(octet) < 0 || Number(octet) > 255,
          )
        ) {
          return null;
        }
        hextets.push(
          Number(octets[0]) * 256 + Number(octets[1]),
          Number(octets[2]) * 256 + Number(octets[3]),
        );
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(segment)) return null;
      hextets.push(Number.parseInt(segment, 16));
    }
    return hextets;
  };

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = parsePart(halves[0]!);
  const right = parsePart(halves.length === 2 ? halves[1]! : "");
  if (left === null || right === null) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  if (left.length + right.length >= 8) return null;
  return [
    ...left,
    ...new Array(8 - left.length - right.length).fill(0),
    ...right,
  ];
}

function isIpv6Loopback(hostname: string) {
  const hextets = ipv6Hextets(hostname);
  if (hextets === null) return false;
  if (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) {
    return true;
  }
  const isIpv4Mapped =
    hextets.slice(0, 5).every((hextet) => hextet === 0) &&
    hextets[5] === 0xffff;
  if (!isIpv4Mapped) return false;
  return hextets[6]! >= 0x7f00 && hextets[6]! <= 0x7fff;
}

function denial(
  message: string,
  grantRequest: BrowserGrantRequest | null = null,
): BrowserAuthorizationFailure {
  return { allowed: false, code: "origin_denied", message, grantRequest };
}

function queryWhere(query: BrowserProfileGrantQuery) {
  const clauses = [
    query.includeRevoked === true ? "1 = 1" : "revoked_at IS NULL",
  ];
  const values: string[] = [];
  for (const [column, value] of [
    ["grant_id", query.grantId],
    ["project_id", query.projectId],
    ["host_id", query.hostId],
    ["installation_id", query.installationId],
    ["profile_id", query.profileId],
  ] as const) {
    if (value === undefined) continue;
    clauses.push(`${column} = ?`);
    values.push(value);
  }
  return { where: clauses.join(" AND "), values };
}

function activeGrantRows(
  database: Database.Database,
  query: BrowserProfileGrantQuery,
) {
  const selection = queryWhere(query);
  return database
    .prepare(
      `SELECT grant_id, project_id, host_id, installation_id, profile_id,
              origin_scope, whole_web, file_transfer,
              invalid_certificate_origins, persistent_elevations,
              whole_web_expires_at, file_transfer_expires_at,
              invalid_certificate_expires_at, created_at, updated_at, revoked_at
       FROM browser_profile_grants
       WHERE ${selection.where}
       ORDER BY created_at ASC, grant_id ASC`,
    )
    .all(...selection.values);
}

function normalizeInvalidCertificateOrigins(origins: readonly string[]) {
  return [
    ...new Set(origins.map((origin) => normalizeBrowserOrigin(origin))),
  ].sort();
}

function validateGrantPolicy(
  originScope: string,
  wholeWeb: boolean,
  invalidOrigins: readonly string[],
) {
  if (wholeWeb !== (originScope === "*")) {
    throw new Error("Whole-web grants must use the * origin scope.");
  }
  if (
    invalidOrigins.some((origin) => !scopeMatchesOrigin(originScope, origin))
  ) {
    throw new Error(
      "Invalid-certificate approvals must be within the grant scope.",
    );
  }
}

function normalizeGrant(
  input: BrowserProfileGrantInput,
): BrowserProfileGrantInput {
  const { persistenceConfirmation, ...grantInput } = input;
  if (
    grantInput.persistentElevations === true &&
    persistenceConfirmation !== PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION
  ) {
    throw new Error(
      "Persistent elevated access requires a second confirmation.",
    );
  }
  const originScope = browserOriginScopeSchema.parse(input.originScope);
  const invalidOrigins = normalizeInvalidCertificateOrigins(
    input.invalidCertificateOrigins,
  );
  validateGrantPolicy(originScope, input.wholeWeb, invalidOrigins);
  return {
    ...grantInput,
    originScope,
    invalidCertificateOrigins: invalidOrigins,
    persistentElevations: grantInput.persistentElevations === true,
  };
}

function grantForInsert(
  input: BrowserProfileGrantInput,
  clock: () => Date,
  idFactory: () => string,
) {
  const normalized = normalizeGrant(input);
  const now = clock();
  const nowIso = now.toISOString();
  const elevationExpiry = normalized.persistentElevations
    ? null
    : new Date(now.getTime() + ELEVATION_DURATION_MS).toISOString();
  return browserProfileGrantSchema.parse({
    ...normalized,
    grantId: normalized.grantId ?? `${GRANT_ID_PREFIX}${idFactory()}`,
    wholeWebExpiresAt: normalized.wholeWeb ? elevationExpiry : null,
    fileTransferExpiresAt: normalized.fileTransfer ? elevationExpiry : null,
    invalidCertificateExpiresAt:
      normalized.invalidCertificateOrigins.length > 0 ? elevationExpiry : null,
    createdAt: normalized.createdAt ?? nowIso,
    updatedAt: normalized.updatedAt ?? nowIso,
    revokedAt: null,
  });
}

type ProjectRow = {
  project_id: string;
  generation: number;
  deleted_at: string | null;
};

function isProjectRow(row: unknown): row is ProjectRow {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Partial<ProjectRow>;
  return (
    typeof candidate.project_id === "string" &&
    typeof candidate.generation === "number" &&
    Number.isInteger(candidate.generation) &&
    candidate.generation >= 0 &&
    (candidate.deleted_at === null || typeof candidate.deleted_at === "string")
  );
}

function normalizedProjectId(projectId: string) {
  if (projectId.trim().length === 0) {
    throw new Error("Browser Profile Grant project IDs cannot be empty.");
  }
  return projectId;
}

function storedProject(
  database: Database.Database,
  projectId: string,
): ProjectRow | null {
  const row = database
    .prepare(
      "SELECT project_id, generation, deleted_at FROM browser_profile_grant_projects WHERE project_id = ?",
    )
    .get(projectId);
  if (row === undefined) return null;
  if (!isProjectRow(row)) {
    throw new Error(
      "Browser Profile Grant project storage returned an invalid row.",
    );
  }
  return row;
}

function insertActiveProject(
  database: Database.Database,
  projectId: string,
  generation = 0,
) {
  database
    .prepare(
      "INSERT INTO browser_profile_grant_projects (project_id, generation, deleted_at) VALUES (?, ?, NULL)",
    )
    .run(projectId, generation);
}

function grantStorageValues(grant: BrowserProfileGrant) {
  return [
    grant.grantId,
    grant.projectId,
    grant.hostId,
    grant.installationId,
    grant.profileId,
    grant.originScope,
    grant.wholeWeb ? 1 : 0,
    grant.fileTransfer ? 1 : 0,
    JSON.stringify(grant.invalidCertificateOrigins),
    grant.persistentElevations === true ? 1 : 0,
    grant.wholeWebExpiresAt ?? null,
    grant.fileTransferExpiresAt ?? null,
    grant.invalidCertificateExpiresAt ?? null,
    grant.createdAt,
    grant.updatedAt,
  ];
}

function persistGrant(database: Database.Database, grant: BrowserProfileGrant) {
  database
    .prepare(
      `INSERT INTO browser_profile_grants
       (grant_id, project_id, host_id, installation_id, profile_id,
          origin_scope, whole_web, file_transfer,
          invalid_certificate_origins, persistent_elevations,
          whole_web_expires_at, file_transfer_expires_at,
          invalid_certificate_expires_at, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(...grantStorageValues(grant));
}

function insertGrant(
  database: Database.Database,
  input: BrowserProfileGrantInput,
  clock: () => Date,
  idFactory: () => string,
) {
  return database.transaction(() => {
    const grant = grantForInsert(input, clock, idFactory);
    const project = storedProject(database, grant.projectId);
    if (project !== null && project.deleted_at !== null) {
      throw new Error(
        `Cannot create a Browser Profile Grant for deleted project ${grant.projectId}.`,
      );
    }
    if (project === null) insertActiveProject(database, grant.projectId);
    persistGrant(database, grant);
    return grant;
  })();
}

function permitsRequestedElevations(
  grant: BrowserProfileGrant,
  request: BrowserAuthorizationRequest,
  origin: string,
  now: Date,
) {
  return (
    (!grant.wholeWeb || elevationIsActive(grant.wholeWebExpiresAt, now)) &&
    (request.fileTransfer !== true ||
      (grant.fileTransfer &&
        elevationIsActive(grant.fileTransferExpiresAt, now))) &&
    (request.invalidCertificate !== true ||
      (grant.invalidCertificateOrigins.includes(origin) &&
        elevationIsActive(grant.invalidCertificateExpiresAt, now)))
  );
}

function elevationIsActive(expiresAt: string | null | undefined, now: Date) {
  return (
    expiresAt === null || expiresAt === undefined || now < new Date(expiresAt)
  );
}

function normalizedAuthorizationOrigin(request: BrowserAuthorizationRequest) {
  try {
    return normalizeBrowserOrigin(request.origin);
  } catch {
    return null;
  }
}

function grantsForOrigin(
  grants: readonly BrowserProfileGrant[],
  origin: string,
) {
  return grants.filter((grant) =>
    scopeMatchesOrigin(grant.originScope, origin),
  );
}

function authorizeAgainstGrants(
  grants: readonly BrowserProfileGrant[],
  request: BrowserAuthorizationRequest,
  now: Date,
): BrowserAuthorizationDecision {
  const origin = normalizedAuthorizationOrigin(request);
  if (origin === null) {
    return denial("The agent destination is not an exact web origin.");
  }
  const matching = grantsForOrigin(grants, origin);
  if (matching.length === 0) {
    return denial(`No Browser Profile Grant allows ${origin}.`);
  }
  const permitted = matching.find((grant) =>
    permitsRequestedElevations(grant, request, origin, now),
  );
  if (permitted === undefined) {
    return denial(
      `The Browser Profile Grant does not allow elevated access to ${origin}.`,
    );
  }
  return { allowed: true, grant: permitted, grantRequest: null };
}

function inspectStoredGrant(
  database: Database.Database,
  grantId: string,
): BrowserProfileGrant | null {
  const rows = activeGrantRows(database, {
    grantId: browserProfileGrantIdSchema.parse(grantId),
    includeRevoked: true,
  });
  return rows.length === 0 ? null : grantFromRow(rows[0]);
}

type StoredGrantRevocationDependencies = {
  database: Database.Database;
  clock: () => Date;
  grantRequests: GrantRequestStore;
  onGrantRequestEvent: ProfileGrantStoreOptions["onGrantRequestEvent"];
};

type StoredGrantRevocationTransaction = {
  revocation: BrowserProfileGrantRevokeResult;
  events: GrantRequestEvent[];
};

function existingGrantRevocationResult(
  grantId: string,
  revokedAt: string | null | undefined,
): BrowserProfileGrantRevokeResult | null {
  if (revokedAt === undefined) {
    return { grantId, outcome: "not-found" };
  }
  if (revokedAt !== null) {
    return { grantId, outcome: "already-revoked" };
  }
  return null;
}

function revokeStoredGrantTransaction(
  dependencies: StoredGrantRevocationDependencies,
  grantId: string,
): StoredGrantRevocationTransaction {
  const currentRevokedAt = storedGrantRevokedAt(dependencies.database, grantId);
  const existingResult = existingGrantRevocationResult(
    grantId,
    currentRevokedAt,
  );
  if (existingResult !== null) {
    return { revocation: existingResult, events: [] };
  }
  const revokedAt = dependencies.clock().toISOString();
  const outcome = updateGrantRevocation(
    dependencies.database,
    grantId,
    revokedAt,
  );
  return {
    revocation: { grantId, outcome },
    events:
      outcome === "revoked"
        ? dependencies.grantRequests.revokeLinkedGrant(grantId, revokedAt)
        : [],
  };
}

function revokeStoredGrant(
  dependencies: StoredGrantRevocationDependencies,
  grantId: string,
): BrowserProfileGrantRevokeResult {
  const normalizedGrantId = browserProfileGrantIdSchema.parse(grantId);
  const revocationTransaction = dependencies.database.transaction(() => {
    return revokeStoredGrantTransaction(dependencies, normalizedGrantId);
  })();
  emitRequestEvents(
    revocationTransaction.events,
    dependencies.onGrantRequestEvent,
  );
  return revocationTransaction.revocation;
}

function updateGrantRevocation(
  database: Database.Database,
  grantId: string,
  revokedAt: string,
): "revoked" | "already-revoked" {
  const update = database
    .prepare(
      "UPDATE browser_profile_grants SET revoked_at = ?, updated_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
    )
    .run(revokedAt, revokedAt, grantId);
  return update.changes === 0 ? "already-revoked" : "revoked";
}

function storedGrantRevokedAt(database: Database.Database, grantId: string) {
  const row = database
    .prepare("SELECT revoked_at FROM browser_profile_grants WHERE grant_id = ?")
    .get(grantId);
  return storedRevokedAt(row);
}

function authorizeStoredRequest(
  database: Database.Database,
  clock: () => Date,
  request: BrowserAuthorizationRequest,
  grantRequests: GrantRequestStore,
) {
  const grants = activeGrantRows(database, {
    projectId: request.projectId,
    hostId: request.hostId,
    installationId: request.installationId,
    profileId: request.profileId,
  }).map((row) => grantFromRow(row));
  const now = clock();
  const decision = authorizeAgainstGrants(grants, request, now);
  if (decision.allowed) return decision;
  const requestDecision: GrantRequestAuthorizationDecision =
    grantRequests.authorize(request, decision.message, now);
  if (!requestDecision.allowed) return requestDecision;
  return {
    allowed: true as const,
    grant: temporaryGrantAsProfileGrant(requestDecision.temporaryGrant),
    temporaryGrant: requestDecision.temporaryGrant,
    grantRequest: null,
  };
}

function temporaryGrantAsProfileGrant(
  temporaryGrant: BrowserTemporaryGrant,
): BrowserProfileGrant {
  return browserProfileGrantSchema.parse({
    grantId: temporaryGrant.grantId,
    projectId: temporaryGrant.projectId,
    hostId: temporaryGrant.hostId,
    installationId: temporaryGrant.installationId,
    profileId: temporaryGrant.profileId,
    originScope: temporaryGrant.originScope,
    wholeWeb: false,
    fileTransfer: temporaryGrant.fileTransfer,
    invalidCertificateOrigins: temporaryGrant.invalidCertificateOrigins,
    persistentElevations: false,
    wholeWebExpiresAt: null,
    fileTransferExpiresAt: temporaryGrant.fileTransfer
      ? temporaryGrant.expiresAt
      : null,
    invalidCertificateExpiresAt:
      temporaryGrant.invalidCertificateOrigins.length > 0
        ? temporaryGrant.expiresAt
        : null,
    createdAt: temporaryGrant.createdAt,
    updatedAt: temporaryGrant.createdAt,
    revokedAt: temporaryGrant.revokedAt,
  });
}

function storedProjectGeneration(
  database: Database.Database,
  projectId: string,
) {
  return (
    storedProject(database, normalizedProjectId(projectId))?.generation ?? 0
  );
}

function markProjectCreated(database: Database.Database, projectId: string) {
  const normalizedProject = normalizedProjectId(projectId);
  return database.transaction(() => {
    const existing = storedProject(database, normalizedProject);
    if (existing === null) {
      insertActiveProject(database, normalizedProject);
      return 0;
    }
    if (existing.deleted_at === null) return existing.generation;
    const generation = existing.generation + 1;
    database
      .prepare(
        "UPDATE browser_profile_grant_projects SET generation = ?, deleted_at = NULL WHERE project_id = ?",
      )
      .run(generation, normalizedProject);
    return generation;
  })();
}

function markProjectDeleted(
  database: Database.Database,
  clock: () => Date,
  projectId: string,
) {
  const normalizedProject = normalizedProjectId(projectId);
  return database.transaction(() => {
    const existing = storedProject(database, normalizedProject);
    if (existing?.deleted_at !== null) return [];
    const deletedAt = clock().toISOString();
    const generation = (existing?.generation ?? 0) + 1;
    if (existing === null) {
      database
        .prepare(
          "INSERT INTO browser_profile_grant_projects (project_id, generation, deleted_at) VALUES (?, ?, ?)",
        )
        .run(normalizedProject, generation, deletedAt);
    } else {
      database
        .prepare(
          "UPDATE browser_profile_grant_projects SET generation = ?, deleted_at = ? WHERE project_id = ? AND deleted_at IS NULL",
        )
        .run(generation, deletedAt, normalizedProject);
    }
    return revokeMatchingGrantsAt(
      database,
      { projectId: normalizedProject },
      deletedAt,
    );
  })();
}

export function projectLoopbackAlias(projectId: string, port: number) {
  if (projectId.trim().length === 0) {
    throw new Error("Project Loopback Alias requires a project ID.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "Project Loopback Alias ports must be between 1 and 65535.",
    );
  }
  const projectHash = createHash("sha256")
    .update(projectId)
    .digest("hex")
    .slice(0, PROJECT_ALIAS_LENGTH);
  return `http://p-${projectHash}.localhost:${port}`;
}

export function createProfileGrantStore(
  database: Database.Database,
  clockOrOptions: (() => Date) | ProfileGrantStoreOptions = {},
): GrantStore {
  const options =
    typeof clockOrOptions === "function"
      ? { clock: clockOrOptions }
      : clockOrOptions;
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const grantRequests = createGrantRequestStore(database, {
    clock,
    idFactory,
    createPersistentGrant: (input) =>
      insertGrant(database, input, clock, idFactory),
    revokePersistentGrant: (grantId) => {
      const existing = storedGrantRevokedAt(database, grantId);
      if (existing === null) {
        updateGrantRevocation(database, grantId, clock().toISOString());
      }
    },
    onEvent: options.onGrantRequestEvent,
  });
  return {
    create: (input) => insertGrant(database, input, clock, idFactory),
    list: (query = {}) =>
      activeGrantRows(database, query).map((row) => grantFromRow(row)),
    inspect: (grantId) => inspectStoredGrant(database, grantId),
    revoke: (grantId) =>
      revokeStoredGrant(
        {
          database,
          clock,
          grantRequests,
          onGrantRequestEvent: options.onGrantRequestEvent,
        },
        grantId,
      ),
    authorize: (request) =>
      authorizeStoredRequest(database, clock, request, grantRequests),
    listRequests: (query = {}) => grantRequests.listRequests(query),
    inspectRequest: (requestId) => grantRequests.inspectRequest(requestId),
    inspectTemporaryGrant: (grantId) =>
      grantRequests.inspectTemporaryGrant(grantId),
    expireTemporaryGrant: (grantId, expirationTime) =>
      grantRequests.expireTemporaryGrant(grantId, expirationTime),
    decideRequest: (input) => grantRequests.decideRequest(input),
    revokeRequest: (requestId) => grantRequests.revokeRequest(requestId),
    revokeProject: (projectId) =>
      (() => {
        const grants = revokeMatchingGrants(database, clock, { projectId });
        grantRequests.revokeProject(projectId);
        return grants;
      })(),
    projectDeleted: (projectId) => {
      const grants = markProjectDeleted(database, clock, projectId);
      grantRequests.revokeProject(projectId);
      return grants;
    },
    projectGeneration: (projectId) =>
      storedProjectGeneration(database, projectId),
    projectCreated: (projectId) => markProjectCreated(database, projectId),
    revokeProfile: (target) => {
      const grants = revokeMatchingGrants(database, clock, target);
      grantRequests.revokeProfile(target);
      return grants;
    },
  };
}

function revokeMatchingGrantsAt(
  database: Database.Database,
  query: BrowserProfileGrantQuery,
  revokedAt: string,
) {
  const grants = activeGrantRows(database, query).map((row) =>
    grantFromRow(row),
  );
  if (grants.length === 0) return [];
  const revoke = database.prepare(
    "UPDATE browser_profile_grants SET revoked_at = ?, updated_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
  );
  return database.transaction(() =>
    grants.filter(
      (grant) => revoke.run(revokedAt, revokedAt, grant.grantId).changes === 1,
    ),
  )();
}

function revokeMatchingGrants(
  database: Database.Database,
  clock: () => Date,
  query: BrowserProfileGrantQuery,
) {
  return database.transaction(() =>
    revokeMatchingGrantsAt(database, query, clock().toISOString()),
  )();
}

export type ProfileGrantStore = GrantStore;
