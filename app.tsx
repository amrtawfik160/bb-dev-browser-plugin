import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginNewThreadPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_PROFILE_ID,
  STOP_BROWSER_CONFIRMATION,
  type BrowserDiagnostics,
  type BrowserPurgePlan,
  type BrowserSetupPlan,
  type BrowserStatus,
  type BrowserStatusInput,
  type rpcContract,
} from "./contracts.js";

const panelParams = { profileId: DEFAULT_PROFILE_ID } as const;

function ReadinessChecklist({ status }: { status: BrowserStatus }) {
  return (
    <ul
      aria-label="Host readiness checklist"
      className="mt-5 space-y-3 text-left"
    >
      {status.capabilities.map((capability) => (
        <li key={capability.id} className="text-sm text-foreground">
          <span aria-hidden="true">
            {capability.status === "ready" ? "✓" : "–"}
          </span>{" "}
          <strong>{capability.label}</strong>
          <p className="ml-5 text-muted-foreground">{capability.reason}</p>
        </li>
      ))}
    </ul>
  );
}

function ReadinessView({ status }: { status: BrowserStatus }) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center bg-background p-6">
      <section
        role="status"
        aria-label={status.label}
        className="max-w-md text-center"
      >
        <h2 className="text-lg font-semibold text-foreground">
          {status.label}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{status.message}</p>
        <p className="mt-3 font-mono text-xs text-muted-foreground">
          {status.profileId}
        </p>
        <ReadinessChecklist status={status} />
      </section>
    </main>
  );
}

function BrowserPanel({ request }: { request: BrowserStatusInput }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<BrowserStatus | null>(null);

  useEffect(() => {
    void rpc.call("browser_status", request).then(setStatus);
  }, [request, rpc]);

  if (status === null) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Checking Browser setup…
      </div>
    );
  }
  return <ReadinessView status={status} />;
}

function administrationErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Browser administration failed.";
}

function setupStepStatus(step: BrowserSetupPlan["steps"][number]) {
  if (step.state === "completed") return "Complete";
  if (step.state === "failed") return `Failed: ${step.failure}`;
  return "Pending";
}

function purgeTargetLocation(target: BrowserPurgePlan["targets"][number]) {
  if ("path" in target) return target.path;
  if ("scope" in target) return target.scope;
  return target.username;
}

type BrowserAdministrationTarget = {
  hostId: string;
  profileId: string;
};

function AdministrationFeedback({
  message,
  error,
}: {
  message: string | null;
  error: string | null;
}) {
  return (
    <>
      {message === null ? null : <p role="status">{message}</p>}
      {error === null ? null : <p role="alert">{error}</p>}
    </>
  );
}

function SetupControls({
  target,
  autoLoad,
}: {
  target: BrowserAdministrationTarget;
  autoLoad: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [setupPlan, setSetupPlan] = useState<BrowserSetupPlan | null>(null);
  const [setupConfirmation, setSetupConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    if (!autoLoad) return;
    void rpc
      .call("browser_setup_plan", target)
      .then(setSetupPlan)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }, [autoLoad, rpc, target]);

  function loadSetupPlan() {
    setError(null);
    void rpc
      .call("browser_setup_plan", target)
      .then(setSetupPlan)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function applySetupStep() {
    const stepId = setupPlan?.nextStepId;
    if (stepId === null || stepId === undefined) return;
    setPendingAction(stepId);
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_setup", {
        ...target,
        stepId,
        confirmation: setupConfirmation,
      })
      .then((response) => {
        setSetupPlan(response.plan);
        setMessage(response.message);
        setSetupConfirmation("");
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  const nextStep =
    setupPlan === null
      ? undefined
      : setupPlan.steps.find((step) => step.id === setupPlan.nextStepId);

  return (
    <section aria-label={`Browser setup controls for host ${target.hostId}`}>
      <h4 className="font-semibold">Browser setup plan</h4>
      {setupPlan === null ? (
        <button
          type="button"
          className="mt-3 rounded border px-3 py-2 text-sm"
          onClick={loadSetupPlan}
        >
          Show Browser setup plan
        </button>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            State: {setupPlan.state}. Runtime runs as{" "}
            {setupPlan.runtime.runAsUser}
            with the Chrome sandbox required.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Protected storage: <code>{setupPlan.hostStoragePath}</code>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Storage owner: <code>{setupPlan.storageOwner}</code>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Storage permissions: <code>{setupPlan.storageMode}</code>
          </p>
          <ol aria-label="Browser setup steps" className="mt-3 space-y-3">
            {setupPlan.steps.map((step) => (
              <li key={step.id} className="rounded border p-3">
                <p className="font-medium">{step.label}</p>
                <p className="text-sm text-muted-foreground">
                  {step.description}
                </p>
                <p className="mt-1 text-sm">Status: {setupStepStatus(step)}</p>
                <p className="text-sm">
                  Confirmation: <code>{step.confirmationText}</code>
                </p>
              </li>
            ))}
          </ol>
          {nextStep === undefined ? null : (
            <div className="mt-4 space-y-2">
              <label
                className="block text-sm"
                htmlFor={`setup-confirmation-${target.hostId}`}
              >
                Type the confirmation for {nextStep.label}
              </label>
              <input
                id={`setup-confirmation-${target.hostId}`}
                aria-label={`Setup confirmation for ${nextStep.id}`}
                className="w-full rounded border px-3 py-2 text-sm"
                value={setupConfirmation}
                onChange={(event) => setSetupConfirmation(event.target.value)}
              />
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm"
                disabled={pendingAction !== null}
                onClick={applySetupStep}
              >
                Confirm {nextStep.confirmationText}
              </button>
            </div>
          )}
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function LifecycleControls({
  target,
}: {
  target: BrowserAdministrationTarget;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  function stopBrowser(action: "disable" | "uninstall") {
    setPendingAction(action);
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
      .finally(() => setPendingAction(null));
  }

  return (
    <section
      aria-label={`Browser lifecycle controls for host ${target.hostId}`}
    >
      <h4 className="font-semibold">Disable or uninstall Browser</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Both actions stop Browser-owned processes and retain profiles and
        authenticated state.
      </p>
      <label
        className="mt-2 block text-sm"
        htmlFor={`lifecycle-confirmation-${target.hostId}`}
      >
        Type <code>{STOP_BROWSER_CONFIRMATION}</code>
      </label>
      <input
        id={`lifecycle-confirmation-${target.hostId}`}
        aria-label="Browser lifecycle confirmation"
        className="w-full rounded border px-3 py-2 text-sm"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={() => stopBrowser("disable")}
        >
          Disable Browser
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={() => stopBrowser("uninstall")}
        >
          Uninstall Browser
        </button>
      </div>
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function PurgeControls({ target }: { target: BrowserAdministrationTarget }) {
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
      <h4 className="font-semibold">Destructive purge</h4>
      {purgePlan === null ? (
        <button
          type="button"
          className="mt-3 rounded border px-3 py-2 text-sm"
          onClick={loadPurgePlan}
        >
          Show destructive purge plan
        </button>
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
              <div key={purgeTarget.id} className="rounded border p-2 text-sm">
                <strong>{purgeTarget.id}</strong>:{" "}
                {purgeTargetLocation(purgeTarget)}({purgeTarget.state})
              </div>
            ))}
          </div>
          {purgePlan.state === "purged" ? null : (
            <div className="mt-4 space-y-2">
              <label
                className="block text-sm"
                htmlFor={`purge-confirmation-${target.hostId}`}
              >
                Type the destructive confirmation
              </label>
              <input
                id={`purge-confirmation-${target.hostId}`}
                aria-label="Purge confirmation"
                className="w-full rounded border px-3 py-2 text-sm"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm"
                disabled={pending}
                onClick={purgeBrowser}
              >
                Purge Browser installation
              </button>
            </div>
          )}
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function HostAdministrationControls({ status }: { status: BrowserStatus }) {
  if (
    status.hostId === null ||
    status.state === "host-offline" ||
    status.state === "unsupported"
  ) {
    return null;
  }

  const target: BrowserAdministrationTarget = {
    hostId: status.hostId,
    profileId: status.profileId,
  };
  return (
    <div className="mt-6 space-y-5 border-t pt-5 text-left">
      <SetupControls
        target={target}
        autoLoad={status.state === "setup-required"}
      />
      <LifecycleControls target={target} />
      <PurgeControls target={target} />
    </div>
  );
}

function BrowserSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [statuses, setStatuses] = useState<BrowserStatus[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics | null>(
    null,
  );

  useEffect(() => {
    void rpc
      .call("browser_settings_status", { profileId: DEFAULT_PROFILE_ID })
      .then(setStatuses);
  }, [rpc]);

  if (statuses === null) {
    return <p role="status">Checking Browser hosts…</p>;
  }
  if (statuses.length === 0) {
    return <p>No workspace hosts are enrolled.</p>;
  }
  return (
    <div className="space-y-6">
      {statuses.map((status) => (
        <section key={status.hostId} aria-label={`Host ${status.hostId}`}>
          <h3 className="font-semibold">{status.label}</h3>
          <p className="text-sm text-muted-foreground">{status.message}</p>
          <ReadinessChecklist status={status} />
          <HostAdministrationControls status={status} />
          <button
            type="button"
            className="mt-4 rounded border px-3 py-2 text-sm"
            onClick={() => {
              void rpc
                .call("browser_diagnostics", {
                  hostId: status.hostId,
                  profileId: status.profileId,
                })
                .then(setDiagnostics);
            }}
          >
            Generate redacted diagnostics
          </button>
        </section>
      ))}
      {diagnostics === null ? null : (
        <pre
          aria-label="Redacted diagnostics"
          className="overflow-auto text-xs"
        >
          {JSON.stringify(diagnostics, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ThreadBrowserPanel({ threadId }: PluginThreadPanelProps) {
  return (
    <BrowserPanel
      request={{ surface: "thread", threadId, profileId: DEFAULT_PROFILE_ID }}
    />
  );
}

function NewThreadBrowserPanel({ projectId }: PluginNewThreadPanelProps) {
  return (
    <BrowserPanel
      request={{
        surface: "new-thread",
        projectId,
        profileId: DEFAULT_PROFILE_ID,
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "host-readiness",
    title: "Host readiness",
    description:
      "Review Browser readiness and apply explicitly confirmed host actions.",
    component: BrowserSettings,
  });

  app.slots.threadPanelAction({
    id: "browser",
    title: "Browser",
    icon: "Globe",
    component: ThreadBrowserPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "Browser", params: panelParams });
    },
  });

  app.slots.experimental_newThreadPanelAction({
    id: "browser",
    title: "Browser",
    icon: "Globe",
    component: NewThreadBrowserPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "Browser", params: panelParams });
    },
  });
});
