import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  browserExactOriginSchema,
  browserOriginScopeSchema,
  browserProfileGrantIdSchema,
  browserProfileGrantSchema,
  normalizeBrowserOrigin,
  type BrowserProfileGrant,
} from "./contracts.js";

const GRANT_ID_PREFIX = "grant-";
const PROJECT_ALIAS_LENGTH = 12;
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

export const BROWSER_AUTHORIZATION_MIGRATIONS = [
  authorizationMigration,
] as const;

export type BrowserAuthorizationRequest = {
  projectId: string;
  hostId: string;
  installationId: string;
  profileId: string;
  origin: string;
  fileTransfer?: boolean;
  invalidCertificate?: boolean;
};

export type BrowserAuthorizationFailure = {
  allowed: false;
  code: "origin_denied";
  message: string;
};

export type BrowserAuthorizationSuccess = {
  allowed: true;
  grant: BrowserProfileGrant;
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
  "grantId" | "createdAt" | "updatedAt" | "revokedAt"
> & {
  grantId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ProfileGrantStoreOptions = {
  clock?: () => Date;
  idFactory?: () => string;
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
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type GrantStore = {
  create(input: BrowserProfileGrantInput): BrowserProfileGrant;
  list(query?: BrowserProfileGrantQuery): BrowserProfileGrant[];
  inspect(grantId: string): BrowserProfileGrant | null;
  revoke(grantId: string): BrowserProfileGrantRevokeResult;
  authorize(request: BrowserAuthorizationRequest): BrowserAuthorizationDecision;
  revokeProject(projectId: string): BrowserProfileGrant[];
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

function isRawLocalhost(origin: string) {
  const hostname = new URL(origin).hostname.toLowerCase();
  return RAW_LOCALHOST_HOSTS.has(hostname) || isIpv4Loopback(hostname);
}

function isIpv4Loopback(hostname: string) {
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => /^\d+$/u.test(octet))
  );
}

function denial(message: string): BrowserAuthorizationFailure {
  return { allowed: false, code: "origin_denied", message };
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
              invalid_certificate_origins, created_at, updated_at, revoked_at
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
  const originScope = browserOriginScopeSchema.parse(input.originScope);
  const invalidOrigins = normalizeInvalidCertificateOrigins(
    input.invalidCertificateOrigins,
  );
  validateGrantPolicy(originScope, input.wholeWeb, invalidOrigins);
  return {
    ...input,
    originScope,
    invalidCertificateOrigins: invalidOrigins,
  };
}

function grantForInsert(
  input: BrowserProfileGrantInput,
  clock: () => Date,
  idFactory: () => string,
) {
  const normalized = normalizeGrant(input);
  const now = clock().toISOString();
  return browserProfileGrantSchema.parse({
    ...normalized,
    grantId: normalized.grantId ?? `${GRANT_ID_PREFIX}${idFactory()}`,
    createdAt: normalized.createdAt ?? now,
    updatedAt: normalized.updatedAt ?? now,
    revokedAt: null,
  });
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
          invalid_certificate_origins, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(...grantStorageValues(grant));
}

function insertGrant(
  database: Database.Database,
  input: BrowserProfileGrantInput,
  clock: () => Date,
  idFactory: () => string,
) {
  const grant = grantForInsert(input, clock, idFactory);
  persistGrant(database, grant);
  return grant;
}

function permitsRequestedElevations(
  grant: BrowserProfileGrant,
  request: BrowserAuthorizationRequest,
  origin: string,
) {
  return (
    (request.fileTransfer !== true || grant.fileTransfer) &&
    (request.invalidCertificate !== true ||
      grant.invalidCertificateOrigins.includes(origin))
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
    permitsRequestedElevations(grant, request, origin),
  );
  if (permitted === undefined) {
    return denial(
      `The Browser Profile Grant does not allow elevated access to ${origin}.`,
    );
  }
  return { allowed: true, grant: permitted };
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

function revokeStoredGrant(
  database: Database.Database,
  clock: () => Date,
  grantId: string,
): BrowserProfileGrantRevokeResult {
  const normalizedGrantId = browserProfileGrantIdSchema.parse(grantId);
  const existingRevokedAt = storedGrantRevokedAt(database, normalizedGrantId);
  if (existingRevokedAt === undefined) {
    return { grantId: normalizedGrantId, outcome: "not-found" };
  }
  if (existingRevokedAt !== null) {
    return { grantId: normalizedGrantId, outcome: "already-revoked" };
  }
  return {
    grantId: normalizedGrantId,
    outcome: updateGrantRevocation(database, clock, normalizedGrantId),
  };
}

function updateGrantRevocation(
  database: Database.Database,
  clock: () => Date,
  grantId: string,
) {
  const revokedAt = clock().toISOString();
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
  request: BrowserAuthorizationRequest,
) {
  const grants = activeGrantRows(database, {
    projectId: request.projectId,
    hostId: request.hostId,
    installationId: request.installationId,
    profileId: request.profileId,
  }).map((row) => grantFromRow(row));
  return authorizeAgainstGrants(grants, request);
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
  return {
    create: (input) => insertGrant(database, input, clock, idFactory),
    list: (query = {}) =>
      activeGrantRows(database, query).map((row) => grantFromRow(row)),
    inspect: (grantId) => inspectStoredGrant(database, grantId),
    revoke: (grantId) => revokeStoredGrant(database, clock, grantId),
    authorize: (request) => authorizeStoredRequest(database, request),
    revokeProject: (projectId) =>
      revokeMatchingGrants(database, clock, { projectId }),
    revokeProfile: (target) => revokeMatchingGrants(database, clock, target),
  };
}

function revokeMatchingGrants(
  database: Database.Database,
  clock: () => Date,
  query: BrowserProfileGrantQuery,
) {
  const grants = activeGrantRows(database, query).map((row) =>
    grantFromRow(row),
  );
  if (grants.length === 0) return [];
  const revokedAt = clock().toISOString();
  const revoke = database.prepare(
    "UPDATE browser_profile_grants SET revoked_at = ?, updated_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
  );
  return database.transaction(() =>
    grants.filter(
      (grant) => revoke.run(revokedAt, revokedAt, grant.grantId).changes === 1,
    ),
  )();
}

export type ProfileGrantStore = GrantStore;
