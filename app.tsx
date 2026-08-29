import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginNewThreadPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  CLEAR_ACTIVITY_CONFIRMATION,
  DEFAULT_PROFILE_ID,
  STOP_BROWSER_CONFIRMATION,
  type BrowserHostChoice,
  type BrowserHostChoicesInput,
  type BrowserDiagnostics,
  type BrowserActivityExport,
  type BrowserActivityRecord,
  type BrowserProfile,
  type BrowserProfileInventory,
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

function ReadinessView({
  status,
  children,
}: {
  status: BrowserStatus;
  children?: ReactNode;
}) {
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
        {children}
      </section>
    </main>
  );
}

function hostChoicesRequest(
  request: BrowserStatusInput,
): BrowserHostChoicesInput {
  return request.surface === "thread"
    ? { surface: "thread", threadId: request.threadId }
    : { surface: "new-thread", projectId: request.projectId };
}

function PanelHostPicker({
  choices,
  onChange,
}: {
  choices: readonly BrowserHostChoice[];
  onChange: (hostId: string) => void;
}) {
  const [hostId, setHostId] = useState("");
  return (
    <div className="mt-5 text-left">
      <label className="block text-sm" htmlFor="browser-workspace-host">
        Workspace host
      </label>
      <select
        id="browser-workspace-host"
        aria-label="Workspace host"
        className="mt-2 w-full rounded border px-3 py-2 text-sm"
        value={hostId}
        onChange={(event) => {
          setHostId(event.target.value);
          onChange(event.target.value);
        }}
      >
        <option value="" disabled>
          Select a host
        </option>
        {choices.map((choice) => (
          <option key={choice.hostId} value={choice.hostId}>
            {choice.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function PanelProfilePicker({
  inventory,
  onChange,
}: {
  inventory: BrowserProfileInventory;
  onChange: (profileId: string) => void;
}) {
  return (
    <div className="mt-5 text-left">
      <label className="block text-sm" htmlFor="browser-profile-selection">
        Browser Profile
      </label>
      <select
        id="browser-profile-selection"
        aria-label="Browser Profile"
        className="mt-2 w-full rounded border px-3 py-2 text-sm"
        value={inventory.selectedProfileId}
        onChange={(event) => onChange(event.target.value)}
      >
        {inventory.profiles.map((profile) => (
          <option key={profile.profileId} value={profile.profileId}>
            {profile.name}
          </option>
        ))}
      </select>
      <p className="mt-2 text-xs text-muted-foreground">
        Locale: {inventory.profiles.find((profile) => profile.selected)?.locale}
        {" · "}
        Timezone:{" "}
        {inventory.profiles.find((profile) => profile.selected)?.timezone}
      </p>
    </div>
  );
}

function BrowserPanel({ request }: { request: BrowserStatusInput }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [selectedHostId, setSelectedHostId] = useState(request.hostId);
  const [hostChoices, setHostChoices] = useState<BrowserHostChoice[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfileInventory | null>(
    null,
  );
  const [profileError, setProfileError] = useState<string | null>(null);

  const statusRequest: BrowserStatusInput =
    selectedHostId === undefined
      ? { ...request, profileSelection: "selected" }
      : {
          ...request,
          hostId: selectedHostId,
          profileSelection: "selected",
        };

  function profileContext() {
    return request.surface === "thread"
      ? { threadId: request.threadId }
      : { projectId: request.projectId };
  }

  useEffect(() => {
    setStatus(null);
    void rpc.call("browser_status", statusRequest).then(setStatus);
  }, [request, selectedHostId, rpc]);

  useEffect(() => {
    if (status?.hostId !== null || status === null) {
      setHostChoices([]);
      return;
    }
    void rpc
      .call("browser_host_choices", hostChoicesRequest(request))
      .then(setHostChoices)
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }, [request, rpc, status]);

  useEffect(() => {
    const hostId = status?.hostId;
    if (
      hostId === undefined ||
      hostId === null ||
      status?.state === "host-offline"
    ) {
      setProfiles(null);
      return;
    }
    void rpc
      .call("browser_profiles", { hostId, ...profileContext() })
      .then(setProfiles)
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }, [rpc, status]);

  function selectProfile(profileId: string) {
    const hostId = status?.hostId;
    if (hostId === null || hostId === undefined) return;
    setProfileError(null);
    void rpc
      .call("browser_profile_select", {
        hostId,
        profileId,
        ...profileContext(),
      })
      .then((inventory) => {
        setProfiles(inventory);
        return rpc.call("browser_status", {
          ...request,
          hostId,
          profileId,
          profileSelection: "selected",
        });
      })
      .then(setStatus)
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }

  if (status === null) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Checking Browser setup…
      </div>
    );
  }
  return (
    <ReadinessView status={status}>
      {status.hostId === null && hostChoices.length > 0 ? (
        <PanelHostPicker choices={hostChoices} onChange={setSelectedHostId} />
      ) : null}
      {profiles === null || status.hostId === null ? null : (
        <PanelProfilePicker inventory={profiles} onChange={selectProfile} />
      )}
      {profileError === null ? null : <p role="alert">{profileError}</p>}
    </ReadinessView>
  );
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

function browserClientLocale() {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
}

function browserClientTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function ProfileRow({
  profile,
  renameName,
  locale,
  timezone,
  pendingAction,
  onRenameNameChange,
  onLocaleChange,
  onTimezoneChange,
  onRename,
  onSelect,
}: {
  profile: BrowserProfile;
  renameName: string;
  locale: string;
  timezone: string;
  pendingAction: string | null;
  onRenameNameChange: (name: string) => void;
  onLocaleChange: (locale: string) => void;
  onTimezoneChange: (timezone: string) => void;
  onRename: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="rounded border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong>{profile.name}</strong>
        {profile.selected ? <span>Selected</span> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {profile.profileId} · Locale: {profile.locale} · Timezone:{" "}
        {profile.timezone}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-48 grow text-sm">
          Rename {profile.name}
          <input
            aria-label={"Rename Browser Profile " + profile.name}
            className="mt-1 block w-full rounded border px-3 py-2 text-sm"
            value={renameName}
            onChange={(event) => onRenameNameChange(event.target.value)}
          />
        </label>
        <label className="min-w-32 text-sm">
          Locale
          <input
            aria-label={"Locale for Browser Profile " + profile.name}
            className="mt-1 block w-full rounded border px-3 py-2 text-sm"
            value={locale}
            onChange={(event) => onLocaleChange(event.target.value)}
          />
        </label>
        <label className="min-w-32 text-sm">
          Timezone
          <input
            aria-label={"Timezone for Browser Profile " + profile.name}
            className="mt-1 block w-full rounded border px-3 py-2 text-sm"
            value={timezone}
            onChange={(event) => onTimezoneChange(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null || renameName.trim().length === 0}
          onClick={onRename}
        >
          Rename {profile.name}
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={onRename}
        >
          Save settings {profile.name}
        </button>
        {profile.selected ? null : (
          <button
            type="button"
            className="rounded border px-3 py-2 text-sm"
            disabled={pendingAction !== null}
            onClick={onSelect}
          >
            Select {profile.name}
          </button>
        )}
      </div>
    </div>
  );
}

type ProfileSettingsDraft = { locale: string; timezone: string };

function ProfileInventoryView({
  inventory,
  renameNames,
  profileSettings,
  pendingAction,
  onRenameNameChange,
  onLocaleChange,
  onTimezoneChange,
  onRename,
  onSelect,
}: {
  inventory: BrowserProfileInventory;
  renameNames: Record<string, string>;
  profileSettings: Record<string, ProfileSettingsDraft>;
  pendingAction: string | null;
  onRenameNameChange: (profileId: string, name: string) => void;
  onLocaleChange: (profile: BrowserProfile, locale: string) => void;
  onTimezoneChange: (profile: BrowserProfile, timezone: string) => void;
  onRename: (profile: BrowserProfile) => void;
  onSelect: (profile: BrowserProfile) => void;
}) {
  return (
    <>
      <p className="mt-3 text-sm">Selected: {inventory.selectedProfileId}</p>
      {inventory.profiles.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Default Browser Profile: <code>{inventory.selectedProfileId}</code>
        </p>
      ) : null}
      <div className="mt-3 space-y-3">
        {inventory.profiles.map((profile) => (
          <ProfileRow
            key={profile.profileId}
            profile={profile}
            renameName={renameNames[profile.profileId] ?? profile.name}
            locale={
              profileSettings[profile.profileId]?.locale ?? profile.locale
            }
            timezone={
              profileSettings[profile.profileId]?.timezone ?? profile.timezone
            }
            pendingAction={pendingAction}
            onRenameNameChange={(name) =>
              onRenameNameChange(profile.profileId, name)
            }
            onLocaleChange={(locale) => onLocaleChange(profile, locale)}
            onTimezoneChange={(timezone) => onTimezoneChange(profile, timezone)}
            onRename={() => onRename(profile)}
            onSelect={() => onSelect(profile)}
          />
        ))}
      </div>
    </>
  );
}

function ProfileCreateForm({
  name,
  locale,
  timezone,
  pending,
  onNameChange,
  onLocaleChange,
  onTimezoneChange,
  onSubmit,
}: {
  name: string;
  locale: string;
  timezone: string;
  pending: boolean;
  onNameChange: (name: string) => void;
  onLocaleChange: (locale: string) => void;
  onTimezoneChange: (timezone: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-5 space-y-2" onSubmit={onSubmit}>
      <h5 className="font-medium">Create a Browser Profile</h5>
      <label className="block text-sm">
        New Browser Profile name
        <input
          aria-label="New Browser Profile name"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Locale
        <input
          aria-label="New Browser Profile locale"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={locale}
          onChange={(event) => onLocaleChange(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Timezone
        <input
          aria-label="New Browser Profile timezone"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={timezone}
          onChange={(event) => onTimezoneChange(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="rounded border px-3 py-2 text-sm"
        disabled={pending || name.trim().length === 0}
      >
        Create Browser Profile
      </button>
    </form>
  );
}

function ProfileControls({
  hostId,
  available,
  onProfileSelected,
}: {
  hostId: string;
  available: boolean;
  onProfileSelected: (hostId: string, profileId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [inventory, setInventory] = useState<BrowserProfileInventory | null>(
    null,
  );
  const [newName, setNewName] = useState("");
  const [newLocale, setNewLocale] = useState(browserClientLocale);
  const [newTimezone, setNewTimezone] = useState(browserClientTimezone);
  const [renameNames, setRenameNames] = useState<Record<string, string>>({});
  const [profileSettings, setProfileSettings] = useState<
    Record<string, ProfileSettingsDraft>
  >({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refreshProfiles() {
    return rpc.call("browser_profiles", { hostId }).then((nextInventory) => {
      setInventory(nextInventory);
      onProfileSelected(hostId, nextInventory.selectedProfileId);
      return nextInventory;
    });
  }

  useEffect(() => {
    if (!available) {
      setInventory(null);
      return;
    }
    void rpc
      .call("browser_profiles", { hostId })
      .then((nextInventory) => {
        setInventory(nextInventory);
        onProfileSelected(hostId, nextInventory.selectedProfileId);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }, [available, hostId, onProfileSelected, rpc]);

  function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingAction("create");
    setError(null);
    void rpc
      .call("browser_profile_create", {
        hostId,
        name: newName,
        locale: newLocale,
        timezone: newTimezone,
      })
      .then(() => refreshProfiles())
      .then(() => setNewName(""))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  function saveProfile(profile: BrowserProfile) {
    setPendingAction(profile.profileId);
    setError(null);
    const settings = profileSettings[profile.profileId] ?? {
      locale: profile.locale,
      timezone: profile.timezone,
    };
    void rpc
      .call("browser_profile_rename", {
        hostId,
        profileId: profile.profileId,
        name: renameNames[profile.profileId] ?? profile.name,
        ...settings,
      })
      .then(() => refreshProfiles())
      .then((nextInventory) => {
        const savedProfile = nextInventory.profiles.find(
          (candidate) => candidate.profileId === profile.profileId,
        );
        if (savedProfile === undefined) return;
        setRenameNames((current) => ({
          ...current,
          [profile.profileId]: savedProfile.name,
        }));
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  function selectProfile(profile: BrowserProfile) {
    setPendingAction(profile.profileId);
    setError(null);
    void rpc
      .call("browser_profile_select", {
        hostId,
        profileId: profile.profileId,
      })
      .then((nextInventory) => {
        setInventory(nextInventory);
        onProfileSelected(hostId, nextInventory.selectedProfileId);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  function changeRenameName(profileId: string, name: string) {
    setRenameNames((current) => ({ ...current, [profileId]: name }));
  }

  function changeLocale(profile: BrowserProfile, locale: string) {
    setProfileSettings((current) => ({
      ...current,
      [profile.profileId]: {
        locale,
        timezone: current[profile.profileId]?.timezone ?? profile.timezone,
      },
    }));
  }

  function changeTimezone(profile: BrowserProfile, timezone: string) {
    setProfileSettings((current) => ({
      ...current,
      [profile.profileId]: {
        locale: current[profile.profileId]?.locale ?? profile.locale,
        timezone,
      },
    }));
  }

  return (
    <section
      aria-label={"Browser Profiles for host " + hostId}
      className="mt-6 border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Browser Profiles</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Profiles stay on this workspace host. Authenticated browser data never
        enters BB server storage.
      </p>
      {!available ? (
        <p className="mt-3 text-sm">
          Profiles are unavailable while this host is offline.
        </p>
      ) : inventory === null ? (
        <p role="status" className="mt-3 text-sm">
          Loading Browser Profiles…
        </p>
      ) : (
        <>
          <ProfileInventoryView
            inventory={inventory}
            renameNames={renameNames}
            profileSettings={profileSettings}
            pendingAction={pendingAction}
            onRenameNameChange={changeRenameName}
            onLocaleChange={changeLocale}
            onTimezoneChange={changeTimezone}
            onRename={saveProfile}
            onSelect={selectProfile}
          />
          <ProfileCreateForm
            name={newName}
            locale={newLocale}
            timezone={newTimezone}
            pending={pendingAction !== null}
            onNameChange={setNewName}
            onLocaleChange={setNewLocale}
            onTimezoneChange={setNewTimezone}
            onSubmit={createProfile}
          />
        </>
      )}
      <AdministrationFeedback message={null} error={error} />
    </section>
  );
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

function ActivityControls({ target }: { target: BrowserAdministrationTarget }) {
  const rpc = useRpc<typeof rpcContract>();
  const [records, setRecords] = useState<BrowserActivityRecord[] | null>(null);
  const [exported, setExported] = useState<BrowserActivityExport | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reviewActivity() {
    setPendingAction("review");
    setError(null);
    void rpc
      .call("browser_activity_records", target)
      .then(setRecords)
      .finally(() => setPendingAction(null))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function exportActivity() {
    setPendingAction("export");
    setError(null);
    void rpc
      .call("browser_activity_export", target)
      .then((payload) => {
        setExported(payload);
        setRecords(payload.records);
      })
      .finally(() => setPendingAction(null))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function clearActivity() {
    setPendingAction("clear");
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_activity_clear", { ...target, confirmation })
      .then((response) => {
        setRecords([]);
        setExported(null);
        setConfirmation("");
        setMessage(response.message);
      })
      .finally(() => setPendingAction(null))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  return (
    <section
      aria-label={`Browser activity controls for host ${target.hostId}`}
      className="border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Browser Activity</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Review only allow-listed metadata retained for 30 days and up to 10,000
        records per profile. Owner browsing is not recorded.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={reviewActivity}
        >
          Review Browser activity
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={exportActivity}
        >
          Export Browser activity
        </button>
      </div>
      <label className="mt-3 block text-sm">
        Type <code>{CLEAR_ACTIVITY_CONFIRMATION}</code> to clear
        <input
          aria-label="Activity clear confirmation"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="mt-3 rounded border px-3 py-2 text-sm"
        disabled={pendingAction !== null}
        onClick={clearActivity}
      >
        Clear Browser activity
      </button>
      {records === null ? null : (
        <pre aria-label="Browser activity records" className="mt-3 text-xs">
          {JSON.stringify(records, null, 2)}
        </pre>
      )}
      {exported === null ? null : (
        <pre aria-label="Browser activity export" className="mt-3 text-xs">
          {JSON.stringify(exported, null, 2)}
        </pre>
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
  const [selectedProfileIds, setSelectedProfileIds] = useState<
    Record<string, string>
  >({});
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics | null>(
    null,
  );

  const handleProfileSelected = useCallback(
    (hostId: string, profileId: string) => {
      setSelectedProfileIds((current) => ({ ...current, [hostId]: profileId }));
    },
    [],
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
          {status.hostId === null ? null : (
            <ProfileControls
              hostId={status.hostId}
              available={status.state !== "host-offline"}
              onProfileSelected={handleProfileSelected}
            />
          )}
          {status.hostId === null ? null : (
            <ActivityControls
              target={{
                hostId: status.hostId,
                profileId:
                  selectedProfileIds[status.hostId] ?? status.profileId,
              }}
            />
          )}
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
