import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  browserExactOriginSchema,
  browserGrantRequestDecisionRequestSchema,
  browserGrantRequestDecisionResponseSchema,
  browserGrantRequestIdSchema,
  browserGrantRequestSchema,
  browserGrantRequestStatusSchema,
  browserTemporaryGrantSchema,
  normalizeBrowserOrigin,
  type BrowserGrantRequest,
  type BrowserGrantRequestDecisionRequest,
  type BrowserGrantRequestDecisionResponse,
  type BrowserGrantRequestQuery,
  type BrowserProfileGrant,
  type BrowserTemporaryGrant,
} from "../shared/contracts.js";

const REQUEST_ID_PREFIX = "grant-request-";
const TEMPORARY_GRANT_ID_PREFIX = "temporary-";
const REQUEST_EXPIRY_MS = 15 * 60 * 1000;
const RETRY_EXPIRY_MS = 5 * 60 * 1000;
const ONE_HOUR_EXPIRY_MS = 60 * 60 * 1000;

export const GRANT_REQUEST_MIGRATION = `
CREATE TABLE browser_grant_request_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'requested', 'denied', 'approved', 'consumed', 'expired', 'revoked'
  )),
  project_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  requested_file_transfer INTEGER NOT NULL CHECK (requested_file_transfer IN (0, 1)),
  requested_invalid_certificate INTEGER NOT NULL CHECK (requested_invalid_certificate IN (0, 1)),
  request_expires_at TEXT NOT NULL,
  decision TEXT,
  temporary_mode TEXT CHECK (temporary_mode IN ('retry', 'one-hour') OR temporary_mode IS NULL),
  temporary_expires_at TEXT,
  event_at TEXT NOT NULL,
  grant_id TEXT
);
CREATE INDEX browser_grant_request_events_request
  ON browser_grant_request_events (request_id, event_sequence);
CREATE INDEX browser_grant_request_events_binding
  ON browser_grant_request_events (
    project_id, host_id, installation_id, profile_id, origin,
    requested_file_transfer, requested_invalid_certificate, event_sequence
  );
CREATE TRIGGER browser_grant_request_events_no_update
  BEFORE UPDATE ON browser_grant_request_events
BEGIN
  SELECT RAISE(ABORT, 'Browser Grant Request events are append-only.');
END;
CREATE TRIGGER browser_grant_request_events_no_delete
  BEFORE DELETE ON browser_grant_request_events
BEGIN
  SELECT RAISE(ABORT, 'Browser Grant Request events are append-only.');
END;
`;

export type GrantRequestAuthorizationInput = {
  projectId: string;
  hostId: string;
  installationId: string;
  profileId: string;
  origin: string;
  fileTransfer?: boolean;
  invalidCertificate?: boolean;
};

export type GrantRequestAuthorizationFailure = {
  allowed: false;
  code: "origin_denied";
  message: string;
  grantRequest: BrowserGrantRequest | null;
};

export type GrantRequestAuthorizationSuccess = {
  allowed: true;
  temporaryGrant: BrowserTemporaryGrant;
};

export type GrantRequestAuthorizationDecision =
  GrantRequestAuthorizationFailure | GrantRequestAuthorizationSuccess;

type PersistentGrantInput = {
  projectId: string;
  hostId: string;
  installationId: string;
  profileId: string;
  originScope: string;
  wholeWeb: false;
  fileTransfer: boolean;
  invalidCertificateOrigins: string[];
  persistentElevations: boolean;
  persistenceConfirmation?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GrantRequestStoreOptions = {
  clock?: () => Date;
  idFactory?: () => string;
  createPersistentGrant?: (input: PersistentGrantInput) => BrowserProfileGrant;
  revokePersistentGrant?: (grantId: string) => void;
  onEvent?: (event: GrantRequestEvent) => void;
};

export type GrantRequestEventType =
  "requested" | "denied" | "approved" | "consumed" | "expired" | "revoked";

export type GrantRequestEventActor = "agent" | "owner" | "system";

export type GrantRequestEventCause =
  | "agent-requested"
  | "agent-consumed"
  | "owner-decision"
  | "request-expired"
  | "owner-revoked"
  | "persistent-grant-revoked"
  | "project-deleted"
  | "profile-deleted";

function defaultEventMetadata(
  eventType: GrantRequestEventType,
): Pick<GrantRequestEvent, "actor" | "cause"> {
  if (eventType === "requested") {
    return { actor: "agent", cause: "agent-requested" };
  }
  if (eventType === "consumed") {
    return { actor: "agent", cause: "agent-consumed" };
  }
  if (eventType === "expired") {
    return { actor: "system", cause: "request-expired" };
  }
  if (eventType === "revoked") {
    return { actor: "owner", cause: "owner-revoked" };
  }
  return { actor: "owner", cause: "owner-decision" };
}

export type GrantRequestEvent = {
  eventType: GrantRequestEventType;
  actor: GrantRequestEventActor;
  cause: GrantRequestEventCause;
  occurredAt: string;
  request: BrowserGrantRequest;
  temporaryGrant: BrowserTemporaryGrant | null;
  grantId: string | null;
};

type EventType = GrantRequestEventType;

type EventRow = {
  event_sequence: number;
  request_id: string;
  event_type: EventType;
  project_id: string;
  host_id: string;
  installation_id: string;
  profile_id: string;
  origin: string;
  requested_file_transfer: number;
  requested_invalid_certificate: number;
  request_expires_at: string;
  decision: string | null;
  temporary_mode: "retry" | "one-hour" | null;
  temporary_expires_at: string | null;
  event_at: string;
  grant_id: string | null;
};

function isEventRow(row: unknown): row is EventRow {
  if (typeof row !== "object" || row === null) return false;
  const candidate = row as Partial<EventRow>;
  return (
    typeof candidate.event_sequence === "number" &&
    Number.isInteger(candidate.event_sequence) &&
    typeof candidate.request_id === "string" &&
    typeof candidate.event_type === "string" &&
    [
      "requested",
      "denied",
      "approved",
      "consumed",
      "expired",
      "revoked",
    ].includes(candidate.event_type) &&
    typeof candidate.project_id === "string" &&
    typeof candidate.host_id === "string" &&
    typeof candidate.installation_id === "string" &&
    typeof candidate.profile_id === "string" &&
    typeof candidate.origin === "string" &&
    (candidate.requested_file_transfer === 0 ||
      candidate.requested_file_transfer === 1) &&
    (candidate.requested_invalid_certificate === 0 ||
      candidate.requested_invalid_certificate === 1) &&
    typeof candidate.request_expires_at === "string" &&
    (candidate.decision === null || typeof candidate.decision === "string") &&
    (candidate.temporary_mode === null ||
      candidate.temporary_mode === "retry" ||
      candidate.temporary_mode === "one-hour") &&
    (candidate.temporary_expires_at === null ||
      typeof candidate.temporary_expires_at === "string") &&
    typeof candidate.event_at === "string" &&
    (candidate.grant_id === null || typeof candidate.grant_id === "string")
  );
}

function eventRow(row: unknown): EventRow {
  if (isEventRow(row)) return row;
  throw new Error("Browser Grant Request storage returned an invalid row.");
}

function eventRowsForRequest(
  database: Database.Database,
  requestId: string,
): EventRow[] {
  return database
    .prepare(
      `SELECT event_sequence, request_id, event_type, project_id,
              host_id, installation_id, profile_id, origin,
              requested_file_transfer, requested_invalid_certificate,
              request_expires_at, decision, temporary_mode,
              temporary_expires_at, event_at, grant_id
       FROM browser_grant_request_events
       WHERE request_id = ?
       ORDER BY event_sequence ASC`,
    )
    .all(requestId)
    .map(eventRow);
}

function latestEventRows(database: Database.Database): EventRow[] {
  return database
    .prepare(
      `SELECT event_sequence, request_id, event_type, project_id,
              host_id, installation_id, profile_id, origin,
              requested_file_transfer, requested_invalid_certificate,
              request_expires_at, decision, temporary_mode,
              temporary_expires_at, event_at, grant_id
       FROM browser_grant_request_events
       WHERE event_sequence IN (
         SELECT MAX(event_sequence)
         FROM browser_grant_request_events
         GROUP BY request_id
       )
       ORDER BY event_sequence ASC`,
    )
    .all()
    .map(eventRow);
}

function eventStorageValues(
  row: Pick<
    EventRow,
    | "request_id"
    | "project_id"
    | "host_id"
    | "installation_id"
    | "profile_id"
    | "origin"
    | "requested_file_transfer"
    | "requested_invalid_certificate"
    | "request_expires_at"
    | "decision"
    | "temporary_mode"
    | "temporary_expires_at"
    | "grant_id"
  >,
  eventType: EventType,
  eventAt: string,
) {
  return [
    row.request_id,
    eventType,
    row.project_id,
    row.host_id,
    row.installation_id,
    row.profile_id,
    row.origin,
    row.requested_file_transfer,
    row.requested_invalid_certificate,
    row.request_expires_at,
    row.decision,
    row.temporary_mode,
    row.temporary_expires_at,
    eventAt,
    row.grant_id,
  ];
}

function appendEvent(
  database: Database.Database,
  row: Pick<
    EventRow,
    | "request_id"
    | "project_id"
    | "host_id"
    | "installation_id"
    | "profile_id"
    | "origin"
    | "requested_file_transfer"
    | "requested_invalid_certificate"
    | "request_expires_at"
    | "decision"
    | "temporary_mode"
    | "temporary_expires_at"
    | "grant_id"
  >,
  eventType: EventType,
  eventAt: string,
) {
  database
    .prepare(
      `INSERT INTO browser_grant_request_events
       (request_id, event_type, project_id, host_id, installation_id,
        profile_id, origin, requested_file_transfer,
        requested_invalid_certificate, request_expires_at, decision,
        temporary_mode, temporary_expires_at, event_at, grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...eventStorageValues(row, eventType, eventAt));
}

function statusForEvent(eventType: EventType) {
  return browserGrantRequestStatusSchema.parse(
    eventType === "requested"
      ? "pending"
      : eventType === "approved"
        ? "approved"
        : eventType,
  );
}

function requestFromHistory(history: readonly EventRow[]): BrowserGrantRequest {
  const latest = history[history.length - 1];
  if (latest === undefined) {
    throw new Error("Browser Grant Request storage returned no events.");
  }
  const decisionEvent = history.find(
    (event) => event.event_type === "denied" || event.event_type === "approved",
  );
  const consumedEvent = history.find(
    (event) => event.event_type === "consumed",
  );
  const expiredEvent = history.find((event) => event.event_type === "expired");
  const revokedEvent = history.find((event) => event.event_type === "revoked");
  return browserGrantRequestSchema.parse({
    requestId: latest.request_id,
    projectId: latest.project_id,
    hostId: latest.host_id,
    installationId: latest.installation_id,
    profileId: latest.profile_id,
    origin: latest.origin,
    requestedElevations: {
      fileTransfer: latest.requested_file_transfer === 1,
      invalidCertificate: latest.requested_invalid_certificate === 1,
    },
    status: statusForEvent(latest.event_type),
    decision:
      decisionEvent?.decision === null || decisionEvent?.decision === undefined
        ? null
        : decisionEvent.decision,
    expiresAt: latest.request_expires_at,
    decisionAt: decisionEvent?.event_at ?? null,
    consumedAt: consumedEvent?.event_at ?? null,
    expiredAt: expiredEvent?.event_at ?? null,
    revokedAt: revokedEvent?.event_at ?? null,
  });
}

function temporaryGrantFromHistory(
  history: readonly EventRow[],
): BrowserTemporaryGrant | null {
  const approval = [...history]
    .reverse()
    .find(
      (event) =>
        event.event_type === "approved" && event.temporary_mode !== null,
    );
  if (approval === undefined || approval.temporary_mode === null) return null;
  const consumed = history.find((event) => event.event_type === "consumed");
  const revoked = history.find((event) => event.event_type === "revoked");
  if (approval.temporary_expires_at === null) {
    throw new Error("Browser Grant Request temporary approval has no expiry.");
  }
  return browserTemporaryGrantSchema.parse({
    grantId: `${TEMPORARY_GRANT_ID_PREFIX}${approval.request_id}`,
    requestId: approval.request_id,
    projectId: approval.project_id,
    hostId: approval.host_id,
    installationId: approval.installation_id,
    profileId: approval.profile_id,
    originScope: approval.origin,
    wholeWeb: false,
    fileTransfer: approval.requested_file_transfer === 1,
    invalidCertificateOrigins:
      approval.requested_invalid_certificate === 1 ? [approval.origin] : [],
    mode: approval.temporary_mode,
    createdAt: approval.event_at,
    expiresAt: approval.temporary_expires_at,
    consumedAt: consumed?.event_at ?? null,
    revokedAt: revoked?.event_at ?? null,
  });
}

function requestEventFromDatabase(
  database: Database.Database,
  requestId: string,
  eventType: GrantRequestEventType,
  occurredAt: string,
  actor?: GrantRequestEventActor,
  cause?: GrantRequestEventCause,
): GrantRequestEvent {
  const history = eventRowsForRequest(database, requestId);
  const latest = history[history.length - 1];
  if (latest === undefined) {
    throw new Error("Browser Grant Request event has no request history.");
  }
  const metadata = defaultEventMetadata(eventType);
  return {
    eventType,
    actor: actor ?? metadata.actor,
    cause: cause ?? metadata.cause,
    occurredAt,
    request: requestFromHistory(history),
    temporaryGrant: temporaryGrantFromHistory(history),
    grantId: latest.grant_id,
  };
}

export function emitRequestEvents(
  events: readonly GrantRequestEvent[],
  onEvent: GrantRequestStoreOptions["onEvent"],
) {
  if (onEvent === undefined) return;
  for (const event of events) onEvent(event);
}

type RequestEventCollection = {
  events?: GrantRequestEvent[];
  database: Database.Database;
  requestId: string;
  eventType: GrantRequestEventType;
  occurredAt: string;
  actor?: GrantRequestEventActor;
  cause?: GrantRequestEventCause;
};

function collectRequestEvent({
  events,
  database,
  requestId,
  eventType,
  occurredAt,
  actor,
  cause,
}: RequestEventCollection) {
  events?.push(
    requestEventFromDatabase(
      database,
      requestId,
      eventType,
      occurredAt,
      actor,
      cause,
    ),
  );
}

function response(
  outcome: BrowserGrantRequestDecisionResponse["outcome"],
  history: readonly EventRow[] | null,
  grant: BrowserProfileGrant | null = null,
): BrowserGrantRequestDecisionResponse {
  if (history === null) {
    throw new Error("Browser Grant Request was not found.");
  }
  return browserGrantRequestDecisionResponseSchema.parse({
    outcome,
    request: requestFromHistory(history),
    temporaryGrant: temporaryGrantFromHistory(history),
    grant,
  });
}

function normalizedInput(input: GrantRequestAuthorizationInput) {
  let origin: string;
  try {
    origin = normalizeBrowserOrigin(input.origin);
  } catch {
    return null;
  }
  return {
    projectId: input.projectId,
    hostId: input.hostId,
    installationId: input.installationId,
    profileId: input.profileId,
    origin,
    fileTransfer: input.fileTransfer === true,
    invalidCertificate: input.invalidCertificate === true,
  };
}

function latestRowsForBinding(
  database: Database.Database,
  input: ReturnType<typeof normalizedInput> & object,
) {
  return latestEventRows(database).filter(
    (row) =>
      row.project_id === input.projectId &&
      row.host_id === input.hostId &&
      row.installation_id === input.installationId &&
      row.profile_id === input.profileId,
  );
}

function requestRowMatchesQuery(
  row: EventRow,
  query: BrowserGrantRequestQuery,
) {
  return (
    (query.requestId === undefined || row.request_id === query.requestId) &&
    (query.projectId === undefined || row.project_id === query.projectId) &&
    (query.hostId === undefined || row.host_id === query.hostId) &&
    (query.installationId === undefined ||
      row.installation_id === query.installationId) &&
    (query.profileId === undefined || row.profile_id === query.profileId) &&
    (query.status === undefined ||
      statusForEvent(row.event_type) === query.status)
  );
}

function expireRowsAt(
  database: Database.Database,
  now: Date,
  rows = latestEventRows(database),
  events?: GrantRequestEvent[],
) {
  const nowIso = now.toISOString();
  for (const row of rows) {
    const requestExpired =
      row.event_type === "requested" && row.request_expires_at <= nowIso;
    const temporaryExpired =
      (row.event_type === "approved" || row.event_type === "consumed") &&
      row.temporary_expires_at !== null &&
      row.temporary_expires_at <= nowIso;
    if (requestExpired || temporaryExpired) {
      appendEvent(database, row, "expired", nowIso);
      collectRequestEvent({
        events,
        database,
        requestId: row.request_id,
        eventType: "expired",
        occurredAt: nowIso,
      });
    }
  }
}

function requestHistoryIfPresent(
  database: Database.Database,
  requestId: string,
) {
  const history = eventRowsForRequest(database, requestId);
  return history.length === 0 ? null : history;
}

function persistentGrantInput(
  row: EventRow,
  persistenceConfirmation: string | undefined,
  nowIso: string,
): PersistentGrantInput {
  return {
    projectId: row.project_id,
    hostId: row.host_id,
    installationId: row.installation_id,
    profileId: row.profile_id,
    originScope: browserExactOriginSchema.parse(row.origin),
    wholeWeb: false,
    fileTransfer: row.requested_file_transfer === 1,
    invalidCertificateOrigins:
      row.requested_invalid_certificate === 1 ? [row.origin] : [],
    persistentElevations:
      row.requested_file_transfer === 1 ||
      row.requested_invalid_certificate === 1,
    persistenceConfirmation,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export type GrantRequestStore = {
  authorize(
    input: GrantRequestAuthorizationInput,
    denialMessage: string,
    now?: Date,
  ): GrantRequestAuthorizationDecision;
  listRequests(query?: BrowserGrantRequestQuery): BrowserGrantRequest[];
  inspectRequest(requestId: string): BrowserGrantRequest | null;
  inspectTemporaryGrant(grantId: string): BrowserTemporaryGrant | null;
  expireTemporaryGrant(grantId: string, expirationTime?: Date): void;
  revokeLinkedGrant(grantId: string, revokedAt: string): GrantRequestEvent[];
  decideRequest(
    input: BrowserGrantRequestDecisionRequest,
  ): BrowserGrantRequestDecisionResponse;
  revokeRequest(requestId: string): BrowserGrantRequestDecisionResponse;
  revokeProject(projectId: string): BrowserGrantRequest[];
  revokeProfile(target: {
    hostId: string;
    installationId: string;
    profileId: string;
  }): BrowserGrantRequest[];
};

export function createGrantRequestStore(
  database: Database.Database,
  options: GrantRequestStoreOptions = {},
): GrantRequestStore {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  function createRequest(
    input: ReturnType<typeof normalizedInput>,
    now: Date,
    events?: GrantRequestEvent[],
  ) {
    if (input === null) return null;
    const nowIso = now.toISOString();
    const row = {
      request_id: `${REQUEST_ID_PREFIX}${idFactory()}`,
      project_id: input.projectId,
      host_id: input.hostId,
      installation_id: input.installationId,
      profile_id: input.profileId,
      origin: input.origin,
      requested_file_transfer: input.fileTransfer ? 1 : 0,
      requested_invalid_certificate: input.invalidCertificate ? 1 : 0,
      request_expires_at: new Date(
        now.getTime() + REQUEST_EXPIRY_MS,
      ).toISOString(),
      decision: null,
      temporary_mode: null,
      temporary_expires_at: null,
      grant_id: null,
    } satisfies Omit<EventRow, "event_sequence" | "event_type" | "event_at">;
    appendEvent(database, row, "requested", nowIso);
    collectRequestEvent({
      events,
      database,
      requestId: row.request_id,
      eventType: "requested",
      occurredAt: nowIso,
    });
    return requestFromHistory(eventRowsForRequest(database, row.request_id));
  }

  function authorize(
    input: GrantRequestAuthorizationInput,
    denialMessage: string,
    operationTime?: Date,
  ): GrantRequestAuthorizationDecision {
    const normalized = normalizedInput(input);
    if (normalized === null) {
      return {
        allowed: false,
        code: "origin_denied",
        message: denialMessage,
        grantRequest: null,
      };
    }
    const events: GrantRequestEvent[] = [];
    const authorizationDecision = database.transaction(
      (): GrantRequestAuthorizationDecision => {
        const now = operationTime ?? clock();
        const nowIso = now.toISOString();
        expireRowsAt(database, now, latestEventRows(database), events);
        const candidates = latestRowsForBinding(database, normalized).filter(
          (row) =>
            row.event_type === "approved" &&
            row.temporary_mode !== null &&
            row.temporary_expires_at !== null &&
            row.temporary_expires_at > nowIso &&
            row.origin === normalized.origin &&
            row.requested_file_transfer === (normalized.fileTransfer ? 1 : 0) &&
            row.requested_invalid_certificate ===
              (normalized.invalidCertificate ? 1 : 0),
        );
        const candidate = candidates[0];
        if (candidate !== undefined) {
          const history = eventRowsForRequest(database, candidate.request_id);
          if (candidate.temporary_mode === "retry") {
            appendEvent(database, candidate, "consumed", nowIso);
            collectRequestEvent({
              events,
              database,
              requestId: candidate.request_id,
              eventType: "consumed",
              occurredAt: nowIso,
            });
            return {
              allowed: true as const,
              temporaryGrant: temporaryGrantFromHistory(
                eventRowsForRequest(database, candidate.request_id),
              )!,
            };
          }
          return {
            allowed: true as const,
            temporaryGrant: temporaryGrantFromHistory(history)!,
          };
        }
        const request = createRequest(normalized, now, events);
        return {
          allowed: false,
          code: "origin_denied",
          message: denialMessage,
          grantRequest: request,
        };
      },
    )();
    emitRequestEvents(events, options.onEvent);
    return authorizationDecision;
  }

  function listRequests(query: BrowserGrantRequestQuery = {}) {
    const events: GrantRequestEvent[] = [];
    const requests = database.transaction(() => {
      const expirationQuery = { ...query, status: undefined };
      expireRowsAt(
        database,
        clock(),
        latestEventRows(database).filter((row) =>
          requestRowMatchesQuery(row, expirationQuery),
        ),
        events,
      );
      return latestEventRows(database)
        .filter((row) => requestRowMatchesQuery(row, query))
        .map((row) =>
          requestFromHistory(eventRowsForRequest(database, row.request_id)),
        );
    })();
    emitRequestEvents(events, options.onEvent);
    return requests;
  }

  function inspectRequest(requestId: string) {
    const normalizedRequestId = browserGrantRequestIdSchema.parse(requestId);
    const events: GrantRequestEvent[] = [];
    const request = database.transaction(() => {
      expireRowsAt(
        database,
        clock(),
        latestEventRows(database).filter(
          (row) => row.request_id === normalizedRequestId,
        ),
        events,
      );
      const history = requestHistoryIfPresent(database, normalizedRequestId);
      return history === null ? null : requestFromHistory(history);
    })();
    emitRequestEvents(events, options.onEvent);
    return request;
  }

  function inspectTemporaryGrant(grantId: string) {
    if (!grantId.startsWith(TEMPORARY_GRANT_ID_PREFIX)) return null;
    const requestId = grantId.slice(TEMPORARY_GRANT_ID_PREFIX.length);
    const normalizedRequestId =
      browserGrantRequestIdSchema.safeParse(requestId);
    if (!normalizedRequestId.success) return null;
    const events: GrantRequestEvent[] = [];
    const temporaryGrant = database.transaction(() => {
      const nowIso = clock().toISOString();
      expireRowsAt(
        database,
        new Date(nowIso),
        latestEventRows(database),
        events,
      );
      const history = requestHistoryIfPresent(
        database,
        normalizedRequestId.data,
      );
      if (history === null) return null;
      const request = requestFromHistory(history);
      if (request.status !== "approved" && request.status !== "consumed") {
        return null;
      }
      const temporary = temporaryGrantFromHistory(history);
      if (temporary === null || temporary.revokedAt !== null) return null;
      if (temporary.expiresAt <= nowIso) return null;
      return temporary;
    })();
    emitRequestEvents(events, options.onEvent);
    return temporaryGrant;
  }

  function expireTemporaryGrant(
    grantId: string,
    expirationTime: Date = clock(),
  ) {
    if (!grantId.startsWith(TEMPORARY_GRANT_ID_PREFIX)) return;
    const requestId = grantId.slice(TEMPORARY_GRANT_ID_PREFIX.length);
    const normalizedRequestId =
      browserGrantRequestIdSchema.safeParse(requestId);
    if (!normalizedRequestId.success) return;
    const events: GrantRequestEvent[] = [];
    database.transaction(() => {
      expireRowsAt(
        database,
        expirationTime,
        latestEventRows(database).filter(
          (row) => row.request_id === normalizedRequestId.data,
        ),
        events,
      );
    })();
    emitRequestEvents(events, options.onEvent);
  }

  function decideRequest(input: BrowserGrantRequestDecisionRequest) {
    const normalizedRequestId = browserGrantRequestIdSchema.parse(
      input.requestId,
    );
    const events: GrantRequestEvent[] = [];
    const decisionTransaction = database.transaction(() => {
      const now = clock();
      const nowIso = now.toISOString();
      expireRowsAt(database, now, latestEventRows(database), events);
      const history = requestHistoryIfPresent(database, normalizedRequestId);
      if (history === null) return response("not-found", null);
      const current = history[history.length - 1]!;
      if (current.event_type !== "requested") {
        return response(
          current.event_type === "expired" ? "expired" : "already-decided",
          history,
        );
      }
      const decision = browserGrantRequestDecisionRequestSchema.parse(input);
      if (decision.decision === "deny") {
        appendEvent(
          database,
          { ...current, decision: "deny" },
          "denied",
          nowIso,
        );
        collectRequestEvent({
          events,
          database,
          requestId: normalizedRequestId,
          eventType: "denied",
          occurredAt: nowIso,
        });
        return response(
          "denied",
          eventRowsForRequest(database, normalizedRequestId),
        );
      }
      if (
        decision.decision === "persist" &&
        (current.requested_file_transfer === 1 ||
          current.requested_invalid_certificate === 1) &&
        decision.persistenceConfirmation !== "Persist Browser elevated access"
      ) {
        throw new Error(
          "Persistent elevated access requires a second confirmation.",
        );
      }
      if (decision.decision === "persist") {
        if (options.createPersistentGrant === undefined) {
          throw new Error("Persistent Browser Grant storage is unavailable.");
        }
        const grant = options.createPersistentGrant(
          persistentGrantInput(
            current,
            decision.persistenceConfirmation,
            nowIso,
          ),
        );
        appendEvent(
          database,
          {
            ...current,
            decision: "persist",
            grant_id: grant.grantId,
          },
          "approved",
          nowIso,
        );
        collectRequestEvent({
          events,
          database,
          requestId: normalizedRequestId,
          eventType: "approved",
          occurredAt: nowIso,
        });
        return response(
          "persisted",
          eventRowsForRequest(database, normalizedRequestId),
          grant,
        );
      }
      const temporaryMode = decision.decision;
      const temporaryExpiry = new Date(
        now.getTime() +
          (temporaryMode === "retry" ? RETRY_EXPIRY_MS : ONE_HOUR_EXPIRY_MS),
      ).toISOString();
      appendEvent(
        database,
        {
          ...current,
          decision: decision.decision,
          temporary_mode: temporaryMode,
          temporary_expires_at: temporaryExpiry,
        },
        "approved",
        nowIso,
      );
      collectRequestEvent({
        events,
        database,
        requestId: normalizedRequestId,
        eventType: "approved",
        occurredAt: nowIso,
      });
      return response(
        temporaryMode === "retry" ? "retry-approved" : "one-hour-approved",
        eventRowsForRequest(database, normalizedRequestId),
      );
    });
    const decisionResponse = decisionTransaction.immediate();
    emitRequestEvents(events, options.onEvent);
    return decisionResponse;
  }

  function revokeRequest(requestId: string) {
    const normalizedRequestId = browserGrantRequestIdSchema.parse(requestId);
    const events: GrantRequestEvent[] = [];
    const revocationResponse = database.transaction(() => {
      const now = clock();
      const nowIso = now.toISOString();
      expireRowsAt(database, now, latestEventRows(database), events);
      const history = requestHistoryIfPresent(database, normalizedRequestId);
      if (history === null) return response("not-found", null);
      const current = history[history.length - 1]!;
      if (current.event_type === "revoked") return response("revoked", history);
      if (current.event_type === "expired") return response("expired", history);
      const consumedTemporaryIsActive =
        current.event_type === "consumed" &&
        current.temporary_expires_at !== null &&
        current.temporary_expires_at > nowIso;
      if (
        current.event_type === "denied" ||
        (current.event_type === "consumed" && !consumedTemporaryIsActive)
      ) {
        return response("already-decided", history);
      }
      if (
        current.grant_id !== null &&
        options.revokePersistentGrant !== undefined
      ) {
        options.revokePersistentGrant(current.grant_id);
      }
      const revokedAt = nowIso;
      appendEvent(database, current, "revoked", revokedAt);
      collectRequestEvent({
        events,
        database,
        requestId: normalizedRequestId,
        eventType: "revoked",
        occurredAt: revokedAt,
      });
      return response(
        "revoked",
        eventRowsForRequest(database, normalizedRequestId),
      );
    })();
    emitRequestEvents(events, options.onEvent);
    return revocationResponse;
  }

  function revokeLinkedGrant(grantId: string, revokedAt: string) {
    const linked = latestEventRows(database).find(
      (row) => row.grant_id === grantId && row.event_type === "approved",
    );
    if (linked === undefined) return [];
    appendEvent(database, linked, "revoked", revokedAt);
    return [
      requestEventFromDatabase(
        database,
        linked.request_id,
        "revoked",
        revokedAt,
        "owner",
        "persistent-grant-revoked",
      ),
    ];
  }

  function revokeMatching(
    predicate: (row: EventRow) => boolean,
    actor: GrantRequestEventActor,
    cause: GrantRequestEventCause,
  ): BrowserGrantRequest[] {
    const events: GrantRequestEvent[] = [];
    const requests = database.transaction(() => {
      const now = clock();
      const nowIso = now.toISOString();
      expireRowsAt(database, now, latestEventRows(database), events);
      const revoked: BrowserGrantRequest[] = [];
      for (const row of latestEventRows(database)) {
        if (
          !predicate(row) ||
          (row.event_type !== "requested" &&
            row.event_type !== "approved" &&
            !(
              row.event_type === "consumed" &&
              row.temporary_expires_at !== null &&
              row.temporary_expires_at > nowIso
            ))
        ) {
          continue;
        }
        if (
          row.grant_id !== null &&
          options.revokePersistentGrant !== undefined
        ) {
          options.revokePersistentGrant(row.grant_id);
        }
        appendEvent(database, row, "revoked", nowIso);
        collectRequestEvent({
          events,
          database,
          requestId: row.request_id,
          eventType: "revoked",
          occurredAt: nowIso,
          actor,
          cause,
        });
        revoked.push(
          requestFromHistory(eventRowsForRequest(database, row.request_id)),
        );
      }
      return revoked;
    })();
    emitRequestEvents(events, options.onEvent);
    return requests;
  }

  return {
    authorize,
    listRequests,
    inspectRequest,
    inspectTemporaryGrant,
    expireTemporaryGrant,
    revokeLinkedGrant,
    decideRequest,
    revokeRequest,
    revokeProject: (projectId) =>
      revokeMatching(
        (row) => row.project_id === projectId,
        "system",
        "project-deleted",
      ),
    revokeProfile: (target) =>
      revokeMatching(
        (row) =>
          row.host_id === target.hostId &&
          row.installation_id === target.installationId &&
          row.profile_id === target.profileId,
        "system",
        "profile-deleted",
      ),
  };
}
