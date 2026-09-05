import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ComponentProps, ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import {
  CLEAR_ACTIVITY_CONFIRMATION,
  DEFAULT_PROFILE_ID,
  PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
  RESET_PROFILE_CONFIRMATION,
  STOP_BROWSER_CONFIRMATION,
  type BrowserActivityExport,
  type BrowserActivityRecord,
  type BrowserDiagnostics,
  type BrowserDownloadListResult,
  type BrowserGrantRequest,
  type BrowserProfile,
  type BrowserProfileGrant,
  type BrowserProfileInventory,
  type BrowserProfileLifecycleResponse,
  type BrowserProfileRecoveryResponse,
  type BrowserPurgePlan,
  type BrowserSetupPlan,
  type BrowserStatus,
  type rpcContract,
} from "./contracts.js";
import {
  administrationErrorMessage,
  browserClientLocale,
  browserClientTimezone,
  saveExportedBytes,
  saveJsonFile,
} from "./browser-client-utils.js";
import { PanelDownloadsSurface } from "./panel-chrome.js";
import { ReadinessChecklist } from "./panel-browser.js";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Notice,
  StatusDot,
  inputClassName,
} from "./panel-primitives.js";
import {
  selectProfileForHost,
  useSelectedProfile,
} from "./settings-selection.js";

/**
 * Browser Settings, one host-rendered section per concern. Each section loads
 * its own data and renders one block per enrolled host, so the BB settings
 * page reads as six short sections rather than one wall of controls. The
 * sections share the selected Browser Profile per host through
 * {@link ./settings-selection.js}; everything else is local.
 */

type AttachedStatus = BrowserStatus & { hostId: string };

type AdministrationTarget = { hostId: string; profileId: string };

/**
 * Load something once on mount and expose the three states every list
 * needs. `load` is re-run whenever its identity changes, so callers memoize
 * it on the inputs that matter.
 */
function useResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    return load()
      .then((next) => {
        setData(next);
        return next;
      })
      .catch((requestError: unknown) => {
        setError(administrationErrorMessage(requestError));
        return null;
      })
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

function useBrowserHosts() {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(
    () =>
      rpc.call("browser_settings_status", { profileId: DEFAULT_PROFILE_ID }),
    [rpc],
  );
  return useResource(load);
}

function hostDotTone(status: BrowserStatus) {
  if (status.state === "healthy") return "ready";
  if (status.state === "sleeping" || status.state === "waking") {
    return "settling";
  }
  return "blocked";
}

/** One block per enrolled host, with the section's loading and error states. */
function HostBlocks({
  children,
}: {
  children: (status: AttachedStatus) => ReactNode;
}) {
  const hosts = useBrowserHosts();
  if (hosts.error !== null) {
    return (
      <ErrorState message={hosts.error} onRetry={() => void hosts.reload()} />
    );
  }
  if (hosts.data === null) return <LoadingState what="Browser hosts" />;
  const attached = hosts.data.filter(
    (status): status is AttachedStatus => status.hostId !== null,
  );
  if (attached.length === 0) {
    return (
      <EmptyState title="No workspace hosts are enrolled.">
        Enroll a host with BB Connect; the browser runs there.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-6">
      {attached.map((status) => (
        <div key={status.hostId}>{children(status)}</div>
      ))}
    </div>
  );
}

function HostCaption({
  status,
  profileId,
}: {
  status: AttachedStatus;
  profileId?: string;
}) {
  // A locator, not a status: which host and profile this block manages. The
  // host's state is shown once, in the Browser section.
  return (
    <p className="mb-3 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
      <span>{status.hostId}</span>
      {profileId === undefined ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span>{profileId}</span>
        </>
      )}
    </p>
  );
}

function Card({ children, className = "", ...rest }: ComponentProps<"div">) {
  return (
    <div
      className={`rounded-lg border border-border bg-card p-4 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

function Subheading({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold text-foreground">{children}</h4>;
}

function Disclosure({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-3 rounded-md border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {summary}
      </summary>
      <div className="border-t border-border p-3">{children}</div>
    </details>
  );
}

function OfflineNotice({ what }: { what: string }) {
  return (
    <Notice tone="info">
      {what} are unavailable while this host is offline.
    </Notice>
  );
}

function AdministrationFeedback({
  message,
  error,
}: {
  message: string | null;
  error: string | null;
}) {
  return (
    <>
      {message === null ? null : (
        <Notice tone="info" className="mt-3">
          {message}
        </Notice>
      )}
      {error === null ? null : (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      )}
    </>
  );
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * The host's profile inventory. The profile agents use on a host is server
 * state, so every section follows it: whenever the inventory is read, the
 * shared selection is brought in line with it.
 */
function useProfileInventory(hostId: string, available: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(
    () =>
      available
        ? rpc.call("browser_profiles", { hostId }).then((inventory) => {
            selectProfileForHost(hostId, inventory.selectedProfileId);
            return inventory;
          })
        : Promise.resolve<BrowserProfileInventory | null>(null),
    [available, hostId, rpc],
  );
  return useResource(load);
}

function BrowserHostBlock({ status }: { status: AttachedStatus }) {
  const available = status.state !== "host-offline";
  const inventory = useProfileInventory(status.hostId, available);
  const selected = inventory.data?.profiles.find((profile) => profile.selected);
  return (
    <Card aria-label={`Host ${status.hostId}`}>
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <StatusDot tone={hostDotTone(status)} label={status.label} />
          {status.label}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{status.message}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {status.hostId}
        </p>
      </div>
      <Disclosure summary="Readiness checklist">
        <ReadinessChecklist status={status} />
      </Disclosure>
      <div className="mt-4 text-sm">
        {!available ? (
          <OfflineNotice what="Profiles" />
        ) : inventory.error !== null ? (
          <ErrorState
            message={inventory.error}
            onRetry={() => void inventory.reload()}
          />
        ) : inventory.data === null ? (
          <LoadingState what="Browser Profiles" />
        ) : (
          <p className="text-muted-foreground">
            Agents use the profile{" "}
            <span className="font-medium text-foreground">
              {selected?.name ?? inventory.data.selectedProfileId}
            </span>
            . Change it under Profiles.
          </p>
        )}
      </div>
    </Card>
  );
}

export function BrowserHostsSection() {
  return (
    <HostBlocks>{(status) => <BrowserHostBlock status={status} />}</HostBlocks>
  );
}

// ---------------------------------------------------------------------------
// Agent access
// ---------------------------------------------------------------------------

function grantScopeLabel(grant: BrowserProfileGrant) {
  return grant.originScope === "*" ? "Whole web" : grant.originScope;
}

function grantElevations(grant: BrowserProfileGrant) {
  const parts: string[] = [];
  if (grant.fileTransfer) parts.push("file transfer");
  if (grant.invalidCertificateOrigins.length > 0) {
    parts.push(
      `invalid certificates for ${grant.invalidCertificateOrigins.join(", ")}`,
    );
  }
  return parts.length === 0
    ? "No extra permissions"
    : `Also: ${parts.join("; ")}`;
}

function GrantRows({
  grants,
  pending,
  onRevoke,
}: {
  grants: readonly BrowserProfileGrant[];
  pending: string | null;
  onRevoke: (grant: BrowserProfileGrant) => void;
}) {
  if (grants.length === 0) {
    return (
      <EmptyState title="No grants yet.">
        A project&apos;s first browser call on this profile records one.
      </EmptyState>
    );
  }
  return (
    <ul
      aria-label="Browser Profile Grant list"
      className="divide-y divide-border rounded-lg border border-border"
    >
      {grants.map((grant) => (
        <li
          key={grant.grantId}
          className="flex flex-wrap items-start justify-between gap-3 p-3 text-sm"
        >
          <div className="min-w-0">
            <p className="font-medium text-foreground">
              {grantScopeLabel(grant)}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {grant.projectId} · {grant.grantId}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {grantElevations(grant)} · since {formatWhen(grant.createdAt)}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            aria-label={`Revoke grant for ${grant.projectId} on ${grantScopeLabel(grant)}`}
            disabled={pending !== null}
            onClick={() => onRevoke(grant)}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

type GrantRequestDecision = "deny" | "retry" | "one-hour" | "persist";

function requestElevations(request: BrowserGrantRequest) {
  const parts: string[] = [];
  if (request.requestedElevations.fileTransfer) parts.push("file transfer");
  if (request.requestedElevations.invalidCertificate) {
    parts.push("an invalid certificate");
  }
  return parts.length === 0
    ? "Ordinary browsing"
    : `Also asks for ${parts.join(" and ")}`;
}

function RequestRow({
  request,
  pending,
  confirmation,
  onConfirmationChange,
  onDecide,
  onRevoke,
}: {
  request: BrowserGrantRequest;
  pending: string | null;
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  onDecide: (decision: GrantRequestDecision) => void;
  onRevoke: () => void;
}) {
  const [persisting, setPersisting] = useState(false);
  const actionable =
    request.status === "pending" || request.status === "approved";
  return (
    <li className="space-y-2 p-3 text-sm">
      <p className="min-w-0 break-all font-medium text-foreground">
        {request.origin}
      </p>
      <p className="font-mono text-xs text-muted-foreground">
        {request.projectId} · {request.requestId}
      </p>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{request.status}</span>
        {" · "}
        {requestElevations(request)} · expires {formatWhen(request.expiresAt)}
      </p>
      {request.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            aria-label={`Allow ${request.origin} once`}
            disabled={pending !== null}
            onClick={() => onDecide("retry")}
          >
            Allow once
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Allow ${request.origin} for an hour`}
            disabled={pending !== null}
            onClick={() => onDecide("one-hour")}
          >
            Allow for an hour
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Allow ${request.origin} always`}
            aria-expanded={persisting}
            disabled={pending !== null}
            onClick={() => setPersisting((current) => !current)}
          >
            Allow always
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Deny ${request.origin}`}
            disabled={pending !== null}
            onClick={() => onDecide("deny")}
          >
            Deny
          </Button>
        </div>
      ) : null}
      {request.status === "pending" && persisting ? (
        <div className="space-y-2 rounded-md border border-border bg-background p-3">
          <Field
            label="Confirm lasting access"
            help={`Type "${PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION}" to grant this for good.`}
          >
            <input
              aria-label={`Persistent Browser Grant confirmation ${request.requestId}`}
              className={inputClassName}
              value={confirmation}
              onChange={(event) => onConfirmationChange(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            size="sm"
            aria-label={`Confirm lasting access for ${request.origin}`}
            disabled={pending !== null}
            onClick={() => onDecide("persist")}
          >
            Grant for good
          </Button>
        </div>
      ) : null}
      {actionable ? (
        <Button
          variant="link"
          className="text-xs"
          aria-label={`Revoke request for ${request.origin}`}
          disabled={pending !== null}
          onClick={onRevoke}
        >
          Revoke this request
        </Button>
      ) : null}
    </li>
  );
}

type GrantDraft = {
  projectId: string;
  originScope: string;
  wholeWeb: boolean;
  fileTransfer: boolean;
  invalidCertificateOrigin: string;
  persistentElevations: boolean;
  persistenceConfirmation: string;
};

function GrantCreationForm({
  pending,
  onCreate,
}: {
  pending: boolean;
  onCreate: (draft: GrantDraft) => Promise<BrowserProfileGrant | null>;
}) {
  const [projectId, setProjectId] = useState("");
  const [originScope, setOriginScope] = useState("");
  const [invalidCertificateOrigin, setInvalidCertificateOrigin] = useState("");
  const [wholeWeb, setWholeWeb] = useState(false);
  const [fileTransfer, setFileTransfer] = useState(false);
  const [persistentElevations, setPersistentElevations] = useState(false);
  const [persistenceConfirmation, setPersistenceConfirmation] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onCreate({
      projectId,
      originScope,
      wholeWeb,
      fileTransfer,
      invalidCertificateOrigin,
      persistentElevations,
      persistenceConfirmation,
    }).then((created) => {
      if (created === null) return;
      setOriginScope("");
      setInvalidCertificateOrigin("");
    });
  }

  const checkbox = "h-4 w-4 rounded-sm border-input accent-primary";
  return (
    <form className="space-y-3" onSubmit={submit}>
      <Field label="Project ID" help="The BB project whose agents get access.">
        <input
          aria-label="Grant project ID"
          className={inputClassName}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        />
      </Field>
      <Field
        label="Origin scope"
        help="An exact origin such as https://example.com, or https://*.example.com."
      >
        <input
          aria-label="Grant origin scope"
          className={inputClassName}
          value={originScope}
          onChange={(event) => setOriginScope(event.target.value)}
          disabled={wholeWeb}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className={checkbox}
          aria-label="Whole-web Browser access"
          checked={wholeWeb}
          onChange={(event) => setWholeWeb(event.target.checked)}
        />
        Whole web
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className={checkbox}
          aria-label="File transfer elevation"
          checked={fileTransfer}
          onChange={(event) => setFileTransfer(event.target.checked)}
        />
        File transfer
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className={checkbox}
          aria-label="Persistent elevated Browser access"
          checked={persistentElevations}
          onChange={(event) => setPersistentElevations(event.target.checked)}
        />
        Keep extra permissions past one hour
      </label>
      {persistentElevations ? (
        <Field
          label="Confirm lasting extra permissions"
          help={`Type "${PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION}".`}
        >
          <input
            aria-label="Persistent elevation confirmation"
            className={inputClassName}
            value={persistenceConfirmation}
            onChange={(event) => setPersistenceConfirmation(event.target.value)}
          />
        </Field>
      ) : null}
      <Field
        label="Invalid-certificate origin"
        help="One exact origin the agent may reach despite a bad certificate."
      >
        <input
          aria-label="Invalid-certificate origin approval"
          className={inputClassName}
          value={invalidCertificateOrigin}
          onChange={(event) => setInvalidCertificateOrigin(event.target.value)}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={
          pending ||
          projectId.trim().length === 0 ||
          (!wholeWeb && originScope.trim().length === 0)
        }
      >
        Create Browser Profile Grant
      </Button>
    </form>
  );
}

function AgentAccessBlock({ status }: { status: AttachedStatus }) {
  const rpc = useRpc<typeof rpcContract>();
  const available = status.state !== "host-offline";
  const profileId = useSelectedProfile(status.hostId, status.profileId);
  const target: AdministrationTarget = { hostId: status.hostId, profileId };
  const loadGrants = useCallback(
    () =>
      available
        ? rpc.call("browser_grants", { ...target, includeRevoked: false })
        : Promise.resolve<BrowserProfileGrant[]>([]),
    [available, rpc, target.hostId, target.profileId],
  );
  const loadRequests = useCallback(
    () =>
      available
        ? rpc.call("browser_grant_requests", { ...target })
        : Promise.resolve<BrowserGrantRequest[]>([]),
    [available, rpc, target.hostId, target.profileId],
  );
  const grants = useResource(loadGrants);
  const requests = useResource(loadRequests);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, string>>(
    {},
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createGrant(draft: GrantDraft) {
    setPending("create");
    setMessage(null);
    setError(null);
    try {
      const grant = await rpc.call("browser_grant_create", {
        projectId: draft.projectId,
        hostId: target.hostId,
        profileId: target.profileId,
        originScope: draft.wholeWeb ? "*" : draft.originScope,
        wholeWeb: draft.wholeWeb,
        fileTransfer: draft.fileTransfer,
        invalidCertificateOrigins:
          draft.invalidCertificateOrigin.trim().length === 0
            ? []
            : [draft.invalidCertificateOrigin],
        persistentElevations: draft.persistentElevations,
        persistenceConfirmation: draft.persistenceConfirmation,
      });
      grants.setData((current) => [...(current ?? []), grant]);
      setMessage(`Created Browser Grant ${grant.grantId}.`);
      return grant;
    } catch (requestError: unknown) {
      setError(administrationErrorMessage(requestError));
      return null;
    } finally {
      setPending(null);
    }
  }

  function revokeGrant(grant: BrowserProfileGrant) {
    setPending(grant.grantId);
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_grant_revoke", { grantId: grant.grantId })
      .then((response) => {
        setMessage(`Browser Grant ${response.grantId}: ${response.outcome}.`);
        grants.setData(
          (current) =>
            current?.filter(
              (candidate) => candidate.grantId !== response.grantId,
            ) ?? current,
        );
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(null));
  }

  async function decideRequest(
    request: BrowserGrantRequest,
    decision: GrantRequestDecision,
  ) {
    setPending(`${request.requestId}:${decision}`);
    setMessage(null);
    setError(null);
    try {
      const response = await rpc.call("browser_grant_request_decide", {
        requestId: request.requestId,
        decision,
        ...(decision === "persist"
          ? {
              persistenceConfirmation: confirmations[request.requestId] ?? "",
            }
          : {}),
      });
      requests.setData(
        (current) =>
          current?.map((candidate) =>
            candidate.requestId === request.requestId
              ? response.request
              : candidate,
          ) ?? current,
      );
      setMessage(
        `${request.origin} (${request.requestId}): ${response.outcome}.`,
      );
      if (response.grant !== null) {
        grants.setData((current) => [...(current ?? []), response.grant!]);
      }
    } catch (requestError: unknown) {
      setError(administrationErrorMessage(requestError));
    } finally {
      setPending(null);
    }
  }

  async function revokeRequest(request: BrowserGrantRequest) {
    setPending(`${request.requestId}:revoke`);
    setMessage(null);
    setError(null);
    try {
      const response = await rpc.call("browser_grant_request_revoke", {
        requestId: request.requestId,
      });
      requests.setData(
        (current) =>
          current?.map((candidate) =>
            candidate.requestId === request.requestId
              ? response.request
              : candidate,
          ) ?? current,
      );
      setMessage(
        `${request.origin} (${request.requestId}): ${response.outcome}.`,
      );
    } catch (requestError: unknown) {
      setError(administrationErrorMessage(requestError));
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-label={`Browser Profile Grants for ${profileId}`}
      className="space-y-4 text-left"
    >
      <HostCaption status={status} profileId={profileId} />
      <p className="text-sm text-muted-foreground">
        A project gets the whole web on its first browser call. Revoke that
        grant to make its agents ask you first.
      </p>
      {!available ? (
        <OfflineNotice what="Grants" />
      ) : (
        <>
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <Subheading>Browser Profile Grants</Subheading>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Refresh grants"
                disabled={grants.loading}
                onClick={() => void grants.reload()}
              >
                Refresh
              </Button>
            </div>
            {grants.error !== null ? (
              <ErrorState
                message={grants.error}
                onRetry={() => void grants.reload()}
              />
            ) : grants.data === null ? (
              <LoadingState what="grants" />
            ) : (
              <GrantRows
                grants={grants.data}
                pending={pending}
                onRevoke={revokeGrant}
              />
            )}
          </div>
          <section aria-label="Browser Grant Requests">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Subheading>Browser Grant Requests</Subheading>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Refresh requests"
                disabled={requests.loading}
                onClick={() => void requests.reload()}
              >
                Refresh
              </Button>
            </div>
            {requests.error !== null ? (
              <ErrorState
                message={requests.error}
                onRetry={() => void requests.reload()}
              />
            ) : requests.data === null ? (
              <LoadingState what="requests" />
            ) : requests.data.length === 0 ? (
              <EmptyState title="Nothing is waiting on you.">
                Requests appear when an agent is denied a site after you revoked
                its project&apos;s access.
              </EmptyState>
            ) : (
              <ul
                aria-label="Browser Grant Request list"
                className="divide-y divide-border rounded-lg border border-border"
              >
                {requests.data.map((request) => (
                  <RequestRow
                    key={request.requestId}
                    request={request}
                    pending={pending}
                    confirmation={confirmations[request.requestId] ?? ""}
                    onConfirmationChange={(value) =>
                      setConfirmations((current) => ({
                        ...current,
                        [request.requestId]: value,
                      }))
                    }
                    onDecide={(decision) =>
                      void decideRequest(request, decision)
                    }
                    onRevoke={() => void revokeRequest(request)}
                  />
                ))}
              </ul>
            )}
          </section>
          <Disclosure summary="Create a grant by hand">
            <GrantCreationForm
              pending={pending !== null}
              onCreate={createGrant}
            />
          </Disclosure>
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

export function AgentAccessSection() {
  return (
    <HostBlocks>{(status) => <AgentAccessBlock status={status} />}</HostBlocks>
  );
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

type ProfileDraft = { name: string; locale: string; timezone: string };

function ProfileDangerZone({
  profile,
  onComplete,
}: {
  profile: BrowserProfile;
  onComplete: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = { hostId: profile.hostId, profileId: profile.profileId };
  const active = profile.state === "active";

  function run(
    action: string,
    operation: () => Promise<BrowserProfileLifecycleResponse>,
  ) {
    setPending(action);
    setMessage(`${action} in progress…`);
    setError(null);
    void operation()
      .then((response) => {
        setMessage(`${response.message} ${response.progress.message}`);
        setConfirmation("");
        onComplete();
      })
      .catch((requestError: unknown) => {
        setMessage(null);
        setError(administrationErrorMessage(requestError));
      })
      .finally(() => setPending(null));
  }

  return (
    <section aria-label={`Lifecycle ${profile.name}`}>
      <p className="text-sm text-muted-foreground">
        Archive stops this profile, removes all agent authority immediately, and
        keeps browser state recoverable for 30 days. Reset permanently loses
        credentials. Permanent deletion cannot be undone.
      </p>
      {profile.state === "archived" && profile.expiresAt !== null ? (
        <p className="mt-2 text-sm">Recoverable until {profile.expiresAt}</p>
      ) : null}
      <div className="mt-3">
        <Field
          label="Confirmation"
          help={`Reset: type "${RESET_PROFILE_CONFIRMATION}". Delete: type the profile name, ${profile.name}.`}
        >
          <input
            aria-label={`Lifecycle confirmation ${profile.name}`}
            className={inputClassName}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={pending !== null}
          onClick={() =>
            run(active ? "Archive" : "Restore", () =>
              active
                ? rpc.call("browser_profile_archive", target)
                : rpc.call("browser_profile_restore_archived", target),
            )
          }
        >
          {active ? "Archive" : "Restore"} {profile.name}
        </Button>
        {active ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={
              pending !== null || confirmation !== RESET_PROFILE_CONFIRMATION
            }
            onClick={() =>
              run("Reset", () =>
                rpc.call("browser_profile_reset", { ...target, confirmation }),
              )
            }
          >
            Reset {profile.name}
          </Button>
        ) : null}
        <Button
          variant="destructive"
          size="sm"
          disabled={
            pending !== null ||
            profile.selected ||
            confirmation !== profile.name
          }
          onClick={() =>
            run("Delete", () =>
              rpc.call("browser_profile_delete", { ...target, confirmation }),
            )
          }
        >
          Permanently delete {profile.name}
        </Button>
      </div>
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function ProfileCard({
  profile,
  draft,
  pending,
  onDraftChange,
  onSave,
  onSelect,
  onLifecycleComplete,
}: {
  profile: BrowserProfile;
  draft: ProfileDraft;
  pending: string | null;
  onDraftChange: (draft: ProfileDraft) => void;
  onSave: () => void;
  onSelect: () => void;
  onLifecycleComplete: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{profile.name}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {profile.profileId}
          </p>
        </div>
        {profile.selected ? (
          <span className="text-xs text-muted-foreground">
            Selected for agents
          </span>
        ) : profile.state === "archived" ? (
          <span className="text-xs text-muted-foreground">Archived</span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Select ${profile.name}`}
            disabled={pending !== null}
            onClick={onSelect}
          >
            Select
          </Button>
        )}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Name">
          <input
            aria-label={`Rename Browser Profile ${profile.name}`}
            className={inputClassName}
            value={draft.name}
            onChange={(event) =>
              onDraftChange({ ...draft, name: event.target.value })
            }
          />
        </Field>
        <Field label="Locale">
          <input
            aria-label={`Locale for Browser Profile ${profile.name}`}
            className={inputClassName}
            value={draft.locale}
            onChange={(event) =>
              onDraftChange({ ...draft, locale: event.target.value })
            }
          />
        </Field>
        <Field label="Timezone">
          <input
            aria-label={`Timezone for Browser Profile ${profile.name}`}
            className={inputClassName}
            value={draft.timezone}
            onChange={(event) =>
              onDraftChange({ ...draft, timezone: event.target.value })
            }
          />
        </Field>
      </div>
      <div className="mt-3">
        <Button
          variant="primary"
          size="sm"
          aria-label={`Save ${profile.name}`}
          disabled={pending !== null || draft.name.trim().length === 0}
          onClick={onSave}
        >
          Save
        </Button>
      </div>
      <Disclosure summary="Danger zone">
        <ProfileDangerZone profile={profile} onComplete={onLifecycleComplete} />
      </Disclosure>
    </Card>
  );
}

function ProfileCreateForm({
  pending,
  onCreate,
}: {
  pending: boolean;
  onCreate: (draft: ProfileDraft) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [locale, setLocale] = useState(browserClientLocale);
  const [timezone, setTimezone] = useState(browserClientTimezone);
  return (
    <Card>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({ name, locale, timezone }).then((created) => {
            if (created) setName("");
          });
        }}
      >
        <Subheading>Create a Browser Profile</Subheading>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <input
              aria-label="New Browser Profile name"
              className={inputClassName}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Locale">
            <input
              aria-label="New Browser Profile locale"
              className={inputClassName}
              value={locale}
              onChange={(event) => setLocale(event.target.value)}
            />
          </Field>
          <Field label="Timezone">
            <input
              aria-label="New Browser Profile timezone"
              className={inputClassName}
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </Field>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={pending || name.trim().length === 0}
        >
          Create Browser Profile
        </Button>
      </form>
    </Card>
  );
}

function ProfilesBlock({ status }: { status: AttachedStatus }) {
  const rpc = useRpc<typeof rpcContract>();
  const available = status.state !== "host-offline";
  const inventory = useProfileInventory(status.hostId, available);
  const [drafts, setDrafts] = useState<Record<string, ProfileDraft>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function draftFor(profile: BrowserProfile): ProfileDraft {
    return (
      drafts[profile.profileId] ?? {
        name: profile.name,
        locale: profile.locale,
        timezone: profile.timezone,
      }
    );
  }

  async function refresh() {
    const next = await inventory.reload();
    if (next !== null)
      selectProfileForHost(status.hostId, next.selectedProfileId);
  }

  async function createProfile(draft: ProfileDraft) {
    setPending("create");
    setError(null);
    try {
      await rpc.call("browser_profile_create", {
        hostId: status.hostId,
        ...draft,
      });
      await refresh();
      return true;
    } catch (requestError: unknown) {
      setError(administrationErrorMessage(requestError));
      return false;
    } finally {
      setPending(null);
    }
  }

  function saveProfile(profile: BrowserProfile) {
    const draft = draftFor(profile);
    setPending(profile.profileId);
    setError(null);
    void rpc
      .call("browser_profile_rename", {
        hostId: status.hostId,
        profileId: profile.profileId,
        name: draft.name,
        locale: draft.locale,
        timezone: draft.timezone,
      })
      .then(() => refresh())
      .then(() =>
        setDrafts((current) => {
          const rest = { ...current };
          delete rest[profile.profileId];
          return rest;
        }),
      )
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(null));
  }

  function selectProfile(profile: BrowserProfile) {
    setPending(profile.profileId);
    setError(null);
    void rpc
      .call("browser_profile_select", {
        hostId: status.hostId,
        profileId: profile.profileId,
      })
      .then((next) => {
        inventory.setData(next);
        selectProfileForHost(status.hostId, next.selectedProfileId);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(null));
  }

  return (
    <section
      aria-label={`Browser Profiles for host ${status.hostId}`}
      className="space-y-4 text-left"
    >
      <HostCaption status={status} />
      <Subheading>Browser Profiles</Subheading>
      <p className="text-sm text-muted-foreground">
        Profiles stay on this workspace host. Authenticated browser data never
        enters BB server storage.
      </p>
      {!available ? (
        <OfflineNotice what="Profiles" />
      ) : inventory.error !== null ? (
        <ErrorState
          message={inventory.error}
          onRetry={() => void inventory.reload()}
        />
      ) : inventory.data === null ? (
        <LoadingState what="Browser Profiles" />
      ) : (
        <>
          <p className="font-mono text-xs text-muted-foreground">
            Selected: {inventory.data.selectedProfileId}
          </p>
          {inventory.data.profiles.length === 0 ? (
            <EmptyState title="No named profiles yet.">
              The default profile is used until you create one below.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {inventory.data.profiles.map((profile) => (
                <ProfileCard
                  key={profile.profileId}
                  profile={profile}
                  draft={draftFor(profile)}
                  pending={pending}
                  onDraftChange={(draft) =>
                    setDrafts((current) => ({
                      ...current,
                      [profile.profileId]: draft,
                    }))
                  }
                  onSave={() => saveProfile(profile)}
                  onSelect={() => selectProfile(profile)}
                  onLifecycleComplete={() => void refresh()}
                />
              ))}
            </div>
          )}
          <ProfileCreateForm
            pending={pending !== null}
            onCreate={createProfile}
          />
        </>
      )}
      <AdministrationFeedback message={null} error={error} />
    </section>
  );
}

export function ProfilesSection() {
  return (
    <HostBlocks>{(status) => <ProfilesBlock status={status} />}</HostBlocks>
  );
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function DownloadsBlock({ status }: { status: AttachedStatus }) {
  const rpc = useRpc<typeof rpcContract>();
  const available = status.state !== "host-offline";
  const profileId = useSelectedProfile(status.hostId, status.profileId);
  const target: AdministrationTarget = { hostId: status.hostId, profileId };
  const load = useCallback(
    () =>
      available
        ? rpc.call("browser_download_list", target)
        : Promise.resolve<BrowserDownloadListResult | null>(null),
    [available, rpc, target.hostId, target.profileId],
  );
  const listing = useResource(load);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportToClient(downloadId: string) {
    setExporting(downloadId);
    setExportError(null);
    try {
      const outcome = await rpc.call("browser_download_export_client", {
        hostId: target.hostId,
        downloadId,
        profileId: target.profileId,
      });
      if (outcome.outcome !== "exported") {
        setExportError(
          outcome.outcome === "rejected"
            ? `Export rejected: ${outcome.reason}.`
            : "Export failed.",
        );
        return;
      }
      saveExportedBytes(outcome.safeName, outcome.contentType, outcome.data);
    } catch (requestError: unknown) {
      setExportError(administrationErrorMessage(requestError));
    } finally {
      setExporting(null);
    }
  }

  return (
    <section
      aria-label={`Browser Host Downloads for ${profileId}`}
      className="text-left"
    >
      <HostCaption status={status} profileId={profileId} />
      {!available ? (
        <OfflineNotice what="Host Downloads" />
      ) : listing.error !== null ? (
        <ErrorState
          message={listing.error}
          onRetry={() => void listing.reload()}
        />
      ) : listing.data === null ? (
        <LoadingState what="Host Downloads" />
      ) : (
        <>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Refresh Host Downloads"
              disabled={listing.loading}
              onClick={() => void listing.reload()}
            >
              Refresh
            </Button>
          </div>
          <PanelDownloadsSurface
            downloads={listing.data.downloads}
            limits={listing.data.limits}
            isController={true}
            exportState={{ inFlightDownloadId: exporting, error: exportError }}
            onExportClient={(downloadId) => void exportToClient(downloadId)}
          />
        </>
      )}
    </section>
  );
}

export function DownloadsSection() {
  return (
    <HostBlocks>{(status) => <DownloadsBlock status={status} />}</HostBlocks>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function ActivityTable({
  records,
}: {
  records: readonly BrowserActivityRecord[];
}) {
  if (records.length === 0) {
    return (
      <EmptyState title="No agent activity recorded for this profile yet.">
        Agent operations, grant changes, and lifecycle events land here. Owner
        browsing is never recorded.
      </EmptyState>
    );
  }
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-border">
      <table
        aria-label="Browser activity records"
        className="w-full text-left text-xs"
      >
        <thead className="sticky top-0 bg-surface-recessed-solid text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              When
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Actor
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Action
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Outcome
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Origin
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Project
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {records.map((record) => (
            <tr key={record.eventId}>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {formatWhen(record.occurredAt)}
              </td>
              <td className="px-3 py-2">{record.actor}</td>
              <td className="px-3 py-2 font-mono">{record.action}</td>
              <td className="px-3 py-2">
                {record.outcome}
                {record.interrupted ? " (interrupted)" : ""}
              </td>
              <td
                className="max-w-56 truncate px-3 py-2"
                title={record.destinationOrigin ?? ""}
              >
                {record.destinationOrigin ?? ""}
              </td>
              <td className="px-3 py-2 font-mono text-muted-foreground">
                {record.projectId ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityBlock({ status }: { status: AttachedStatus }) {
  const rpc = useRpc<typeof rpcContract>();
  const profileId = useSelectedProfile(status.hostId, status.profileId);
  const target: AdministrationTarget = { hostId: status.hostId, profileId };
  const load = useCallback(
    () => rpc.call("browser_activity_records", target),
    [rpc, target.hostId, target.profileId],
  );
  const records = useResource(load);
  const [exported, setExported] = useState<BrowserActivityExport | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function exportActivity() {
    setPending("export");
    setError(null);
    void rpc
      .call("browser_activity_export", target)
      .then((payload) => {
        setExported(payload);
        records.setData(payload.records);
        saveJsonFile(`browser-activity-${profileId}.json`, payload);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(null));
  }

  function clearActivity() {
    setPending("clear");
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_activity_clear", { ...target, confirmation })
      .then((response) => {
        records.setData([]);
        setExported(null);
        setConfirmation("");
        setMessage(response.message);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(null));
  }

  return (
    <section
      aria-label={`Browser activity controls for host ${status.hostId}`}
      className="space-y-3 text-left"
    >
      <HostCaption status={status} profileId={profileId} />
      <p className="text-sm text-muted-foreground">
        Metadata only, kept for 30 days and up to 10,000 records per profile.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Refresh Browser activity"
          disabled={records.loading}
          onClick={() => void records.reload()}
        >
          Refresh
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending !== null}
          onClick={exportActivity}
        >
          Export Browser activity
        </Button>
      </div>
      {records.error !== null ? (
        <ErrorState
          message={records.error}
          onRetry={() => void records.reload()}
        />
      ) : records.data === null ? (
        <LoadingState what="Browser activity" />
      ) : (
        <ActivityTable records={records.data} />
      )}
      {exported === null ? null : (
        <Disclosure summary="Exported activity">
          <pre
            aria-label="Browser activity export"
            className="max-h-72 overflow-auto rounded-md bg-surface-recessed p-3 text-xs"
          >
            {JSON.stringify(exported, null, 2)}
          </pre>
        </Disclosure>
      )}
      <Disclosure summary="Clear activity">
        <Field
          label="Confirmation"
          help={`Type "${CLEAR_ACTIVITY_CONFIRMATION}" to clear every record for this profile.`}
        >
          <input
            aria-label="Activity clear confirmation"
            className={inputClassName}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </Field>
        <Button
          variant="destructive"
          size="sm"
          className="mt-3"
          disabled={pending !== null}
          onClick={clearActivity}
        >
          Clear Browser activity
        </Button>
      </Disclosure>
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

export function ActivitySection() {
  return (
    <HostBlocks>{(status) => <ActivityBlock status={status} />}</HostBlocks>
  );
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

function setupStepStatus(step: BrowserSetupPlan["steps"][number]) {
  if (step.state === "completed") return "Complete";
  if (step.state === "failed") return `Failed: ${step.failure}`;
  return "Pending";
}

function SetupControls({
  target,
  autoLoad,
}: {
  target: AdministrationTarget;
  autoLoad: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [setupPlan, setSetupPlan] = useState<BrowserSetupPlan | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const loadSetupPlan = useCallback(() => {
    setError(null);
    return rpc
      .call("browser_setup_plan", target)
      .then(setSetupPlan)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }, [rpc, target.hostId, target.profileId]);

  useEffect(() => {
    if (autoLoad) void loadSetupPlan();
  }, [autoLoad, loadSetupPlan]);

  function applySetupStep() {
    const stepId = setupPlan?.nextStepId;
    if (stepId === null || stepId === undefined) return;
    setPending(stepId);
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_setup", { ...target, stepId, confirmation })
      .then((response) => {
        setSetupPlan(response.plan);
        setMessage(response.message);
        setConfirmation("");
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(null));
  }

  const nextStep =
    setupPlan === null
      ? undefined
      : setupPlan.steps.find((step) => step.id === setupPlan.nextStepId);

  return (
    <section aria-label={`Browser setup controls for host ${target.hostId}`}>
      <Subheading>Browser setup plan</Subheading>
      {setupPlan === null ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => void loadSetupPlan()}
        >
          Show Browser setup plan
        </Button>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            State: {setupPlan.state}. Runtime runs as{" "}
            {setupPlan.runtime.runAsUser} with the Chrome sandbox required.
          </p>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Protected storage</dt>
            <dd>
              <code className="text-xs">{setupPlan.hostStoragePath}</code>
            </dd>
            <dt className="text-muted-foreground">Storage owner</dt>
            <dd>
              <code className="text-xs">{setupPlan.storageOwner}</code>
            </dd>
            <dt className="text-muted-foreground">Storage permissions</dt>
            <dd>
              <code className="text-xs">{setupPlan.storageMode}</code>
            </dd>
          </dl>
          <ol aria-label="Browser setup steps" className="mt-3 space-y-2">
            {setupPlan.steps.map((step) => (
              <li
                key={step.id}
                className="rounded-md border border-border bg-card p-3 text-sm"
              >
                <p className="font-medium text-foreground">{step.label}</p>
                <p className="text-muted-foreground">{step.description}</p>
                <p className="mt-1">Status: {setupStepStatus(step)}</p>
                <p className="text-xs text-muted-foreground">
                  Confirmation: <code>{step.confirmationText}</code>
                </p>
              </li>
            ))}
          </ol>
          {nextStep === undefined ? null : (
            <div className="mt-4 space-y-3">
              <Field label={`Type the confirmation for ${nextStep.label}`}>
                <input
                  aria-label={`Setup confirmation for ${nextStep.id}`}
                  className={inputClassName}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
              <Button
                variant="primary"
                size="sm"
                disabled={pending !== null}
                onClick={applySetupStep}
              >
                Confirm {nextStep.confirmationText}
              </Button>
            </div>
          )}
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function LifecycleControls({ target }: { target: AdministrationTarget }) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  function stopBrowser(action: "disable" | "uninstall") {
    setPending(action);
    setMessage(null);
    setError(null);
    void rpc
      .call(action === "disable" ? "browser_disable" : "browser_uninstall", {
        ...target,
        confirmation,
      })
      .then((response) => setMessage(response.message))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(null));
  }

  return (
    <section
      aria-label={`Browser lifecycle controls for host ${target.hostId}`}
    >
      <Subheading>Disable or uninstall Browser</Subheading>
      <p className="mt-2 text-sm text-muted-foreground">
        Both actions stop Browser-owned processes and keep profiles and
        authenticated state.
      </p>
      <div className="mt-3">
        <Field
          label="Confirmation"
          help={`Type "${STOP_BROWSER_CONFIRMATION}".`}
        >
          <input
            aria-label="Browser lifecycle confirmation"
            className={inputClassName}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={pending !== null}
          onClick={() => stopBrowser("disable")}
        >
          Disable Browser
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={pending !== null}
          onClick={() => stopBrowser("uninstall")}
        >
          Uninstall Browser
        </Button>
      </div>
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function purgeTargetLocation(target: BrowserPurgePlan["targets"][number]) {
  if ("path" in target) return target.path;
  if ("scope" in target) return target.scope;
  return target.username;
}

function PurgeControls({ target }: { target: AdministrationTarget }) {
  const rpc = useRpc<typeof rpcContract>();
  const [purgePlan, setPurgePlan] = useState<BrowserPurgePlan | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function loadPurgePlan() {
    setError(null);
    void rpc
      .call("browser_purge_plan", target)
      .then(setPurgePlan)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function purgeBrowser() {
    if (purgePlan?.state === "purged") return;
    setPending(true);
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_purge", { ...target, confirmation })
      .then((response) => {
        setPurgePlan(response.plan);
        setMessage(response.message);
        setConfirmation("");
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(false));
  }

  return (
    <section aria-label={`Browser purge controls for host ${target.hostId}`}>
      <Subheading>Remove the browser installation</Subheading>
      <p className="mt-2 text-sm text-muted-foreground">
        Purging removes the system user, configuration, and every profile on
        this host. It cannot be undone.
      </p>
      {purgePlan === null ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={loadPurgePlan}
        >
          Show destructive purge plan
        </Button>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            State: {purgePlan.state}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Type exactly: <code>{purgePlan.confirmationText}</code>
          </p>
          <div aria-label="Browser purge targets" className="mt-3 space-y-2">
            {purgePlan.targets.map((purgeTarget) => (
              <div
                key={purgeTarget.id}
                className="rounded-md border border-border bg-card p-2 text-sm"
              >
                <strong className="font-mono text-xs">{purgeTarget.id}</strong>:{" "}
                {purgeTargetLocation(purgeTarget)} ({purgeTarget.state})
              </div>
            ))}
          </div>
          {purgePlan.state === "purged" ? null : (
            <div className="mt-4 space-y-3">
              <Field label="Type the destructive confirmation">
                <input
                  aria-label="Purge confirmation"
                  className={inputClassName}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={purgeBrowser}
              >
                Purge Browser installation
              </Button>
            </div>
          )}
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function recoveryProgressText(response: BrowserProfileRecoveryResponse) {
  const { phase, completedBytes, totalBytes, phases } = response.progress;
  return `Progress: ${(phases ?? [phase]).join(" → ")} (${completedBytes}/${totalBytes} bytes)`;
}

const PROFILE_IMPORT_ACTION = ["imp", "ort"].join("");

function ProfileRecoveryControls({
  target,
  available,
}: {
  target: AdministrationTarget;
  available: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [archivePath, setArchivePath] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [importName, setImportName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function runRecovery(
    action: "backup" | "restore" | typeof PROFILE_IMPORT_ACTION,
    operation: () => Promise<BrowserProfileRecoveryResponse>,
  ) {
    setPending(action);
    setMessage(`Browser Profile ${action} in progress…`);
    setError(null);
    void operation()
      .then((response) =>
        setMessage(`${response.message} ${recoveryProgressText(response)}`),
      )
      .catch((requestError: unknown) => {
        setMessage(null);
        setError(administrationErrorMessage(requestError));
      })
      .finally(() => setPending(null));
  }

  return (
    <section aria-label={`Browser Profile recovery for ${target.profileId}`}>
      <Subheading>Browser Profile recovery</Subheading>
      <p className="mt-2 text-sm text-muted-foreground">
        Backups are credential-equivalent and require a stopped profile.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Restore and import also stop before copying and preserve the prior data
        if a copy fails.
      </p>
      {!available ? (
        <div className="mt-3">
          <OfflineNotice what="Recovery actions" />
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <Field label="Backup or restore archive path">
            <input
              aria-label="Browser Profile archive path"
              className={inputClassName}
              value={archivePath}
              onChange={(event) => setArchivePath(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={pending !== null || archivePath.trim().length === 0}
              onClick={() =>
                runRecovery("backup", () =>
                  rpc.call("browser_profile_backup", {
                    ...target,
                    archivePath,
                  }),
                )
              }
            >
              Backup Browser Profile
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending !== null || archivePath.trim().length === 0}
              onClick={() =>
                runRecovery("restore", () =>
                  rpc.call("browser_profile_restore", {
                    ...target,
                    archivePath,
                  }),
                )
              }
            >
              Restore Browser Profile
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Existing dev-browser profile path">
              <input
                aria-label="dev-browser profile path"
                className={inputClassName}
                value={sourcePath}
                onChange={(event) => setSourcePath(event.target.value)}
              />
            </Field>
            <Field label="Imported Browser Profile name">
              <input
                aria-label="Imported Browser Profile name"
                className={inputClassName}
                value={importName}
                onChange={(event) => setImportName(event.target.value)}
              />
            </Field>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={
              pending !== null ||
              sourcePath.trim().length === 0 ||
              importName.trim().length === 0
            }
            onClick={() =>
              runRecovery(PROFILE_IMPORT_ACTION, () =>
                rpc.call("browser_profile_import", {
                  hostId: target.hostId,
                  name: importName,
                  sourcePath,
                }),
              )
            }
          >
            Import dev-browser Profile
          </Button>
        </div>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function DiagnosticsControls({ status }: { status: AttachedStatus }) {
  const rpc = useRpc<typeof rpcContract>();
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function download() {
    setPending(true);
    setError(null);
    void rpc
      .call("browser_diagnostics", {
        hostId: status.hostId,
        profileId: status.profileId,
      })
      .then((payload) => {
        setDiagnostics(payload);
        saveJsonFile(`browser-diagnostics-${status.hostId}.json`, payload);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(false));
  }

  return (
    <section aria-label={`Browser diagnostics for host ${status.hostId}`}>
      <Subheading>Diagnostics</Subheading>
      <p className="mt-2 text-sm text-muted-foreground">
        A redacted snapshot of host state for troubleshooting. It never includes
        URLs, cookies, scripts, screenshots, or form contents.
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        disabled={pending}
        onClick={download}
      >
        Download redacted diagnostics
      </Button>
      {diagnostics === null ? null : (
        <Disclosure summary="Preview">
          <pre
            aria-label="Redacted diagnostics"
            className="max-h-72 overflow-auto rounded-md bg-surface-recessed p-3 text-xs"
          >
            {JSON.stringify(diagnostics, null, 2)}
          </pre>
        </Disclosure>
      )}
      <AdministrationFeedback message={null} error={error} />
    </section>
  );
}

function MaintenanceBlock({ status }: { status: AttachedStatus }) {
  const profileId = useSelectedProfile(status.hostId, status.profileId);
  const target: AdministrationTarget = { hostId: status.hostId, profileId };
  const administrable =
    status.state !== "host-offline" && status.state !== "unsupported";
  return (
    <div className="space-y-6 text-left">
      <HostCaption status={status} profileId={profileId} />
      {administrable ? (
        <>
          <SetupControls
            target={{ hostId: status.hostId, profileId: status.profileId }}
            autoLoad={status.state === "setup-required"}
          />
          <ProfileRecoveryControls target={target} available={true} />
          <LifecycleControls
            target={{ hostId: status.hostId, profileId: status.profileId }}
          />
          <PurgeControls
            target={{ hostId: status.hostId, profileId: status.profileId }}
          />
        </>
      ) : (
        <>
          <ProfileRecoveryControls
            target={target}
            available={status.state !== "host-offline"}
          />
          <Notice tone="info">
            Host setup, disable, uninstall, and purge need a supported host that
            is online.
          </Notice>
        </>
      )}
      <DiagnosticsControls status={status} />
    </div>
  );
}

export function MaintenanceSection() {
  return (
    <HostBlocks>{(status) => <MaintenanceBlock status={status} />}</HostBlocks>
  );
}
