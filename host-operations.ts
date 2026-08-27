import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  BROWSER_CONFIGURATION_ROOT,
  BROWSER_STORAGE_ROOT,
  SETUP_STEP_DEFINITIONS,
  STOP_BROWSER_CONFIRMATION,
  browserHostStorageSegment,
  browserPurgePlanSchema,
  browserSetupPlanSchema,
  type BrowserHostTarget,
  type BrowserLifecycleRequest,
  type BrowserLifecycleResponse,
  type BrowserPurgePlan,
  type BrowserPurgeRequest,
  type BrowserPurgeResponse,
  type BrowserSetupPlan,
  type BrowserSetupRequest,
  type BrowserSetupResponse,
  type BrowserStatus,
  type SetupStepId,
} from "./contracts.js";
import type { HostReadinessBoundary } from "./readiness.js";

export const BROWSER_USER = "bb-browser";
export const BROWSER_USER_HOME = BROWSER_STORAGE_ROOT;
export const BROWSER_USER_SHELL = "/usr/sbin/nologin";

export const BROWSER_SYSTEM_PACKAGES = [
  {
    name: "google-chrome-stable",
    purpose: "Official Chrome Stable for compatible owner login flows.",
  },
  {
    name: "xvfb",
    purpose: "Owner-only Safe Login display isolation.",
  },
  {
    name: "x11vnc",
    purpose: "Owner-only Safe Login display transport.",
  },
  {
    name: "novnc",
    purpose: "Owner-only Safe Login browser stream.",
  },
] as const;

export interface BrowserRuntimePolicy {
  runAsUser: string;
  homeDirectory: string;
  shell: string;
  sandbox: "required" | "disabled";
  noSandbox: boolean;
}

export function browserRuntimePolicy(): BrowserRuntimePolicy {
  return {
    runAsUser: BROWSER_USER,
    homeDirectory: BROWSER_USER_HOME,
    shell: BROWSER_USER_SHELL,
    sandbox: "required",
    noSandbox: false,
  };
}

export function validateBrowserRuntimePolicy(
  policy: BrowserRuntimePolicy,
): void {
  if (
    policy.runAsUser !== BROWSER_USER ||
    policy.homeDirectory !== BROWSER_USER_HOME ||
    policy.shell !== BROWSER_USER_SHELL ||
    policy.sandbox !== "required" ||
    policy.noSandbox
  ) {
    throw new Error(
      "Browser runtime must use bb-browser with Chrome sandboxing enabled.",
    );
  }
}

export type PrivilegedOperation =
  | {
      kind: "create-dedicated-user";
      username: typeof BROWSER_USER;
      homeDirectory: typeof BROWSER_USER_HOME;
      shell: typeof BROWSER_USER_SHELL;
      privilege: "unprivileged";
      confirmation: string;
    }
  | {
      kind: "install-system-packages";
      packages: readonly string[];
      repository: "signed-system-repository";
      confirmation: string;
    }
  | {
      kind: "configure-protected-storage";
      path: string;
      owner: typeof BROWSER_USER;
      mode: 0o700;
      installationId: string;
      hostId: string;
      confirmation: string;
    }
  | {
      kind: "stop-owned-processes";
      owner: typeof BROWSER_USER;
      hostId: string;
      installationId: string;
      confirmation: string;
    }
  | {
      kind: "remove-browser-data";
      path: string;
      installationId: string;
      hostId: string;
      confirmation: string;
    }
  | {
      kind: "remove-installation-configuration";
      path: string;
      installationId: string;
      confirmation: string;
    }
  | {
      kind: "remove-dedicated-user";
      username: typeof BROWSER_USER;
      hostId: string;
      installationId: string;
      guard: {
        type: "last-installation-only";
        hostId: string;
        installationId: string;
      };
      confirmation: string;
    };

export interface PrivilegedExecutor {
  execute(operation: PrivilegedOperation): void | Promise<void>;
}

export interface SimulatedPrivilegedExecutor extends PrivilegedExecutor {
  failNext(kind: PrivilegedOperation["kind"], message?: string): void;
  readonly attemptedOperations: readonly PrivilegedOperation[];
  readonly successfulOperations: readonly PrivilegedOperation[];
}

interface SimulationState {
  attemptedOperations: PrivilegedOperation[];
  successfulOperations: PrivilegedOperation[];
  queuedFailures: Map<PrivilegedOperation["kind"], string[]>;
}

export function createSimulatedPrivilegedExecutor(): SimulatedPrivilegedExecutor {
  const simulationState: SimulationState = {
    attemptedOperations: [],
    successfulOperations: [],
    queuedFailures: new Map(),
  };

  function failNext(
    kind: PrivilegedOperation["kind"],
    message = `Simulated failure for ${kind}.`,
  ) {
    const failures = simulationState.queuedFailures.get(kind) ?? [];
    failures.push(message);
    simulationState.queuedFailures.set(kind, failures);
  }

  async function execute(operation: PrivilegedOperation) {
    simulationState.attemptedOperations.push(operation);
    const failures = simulationState.queuedFailures.get(operation.kind);
    const failure = failures?.shift();
    if (failure !== undefined) throw new Error(failure);
    simulationState.successfulOperations.push(operation);
  }

  return {
    execute,
    failNext,
    get attemptedOperations() {
      return [...simulationState.attemptedOperations];
    },
    get successfulOperations() {
      return [...simulationState.successfulOperations];
    },
  };
}

export function createUnavailablePrivilegedExecutor(): PrivilegedExecutor {
  return {
    execute: async () => {
      throw new Error("No privileged Browser executor is configured.");
    },
  };
}

export type SetupProgressState = "pending" | "completed" | "failed";
export type PurgeTargetId =
  "stop-owned-processes" | "browser-data" | "configuration" | "dedicated-user";

export interface HostAdministrationState {
  setup: Record<
    SetupStepId,
    { state: SetupProgressState; failure: string | null }
  >;
  processesStopped: boolean;
  purge: Record<
    PurgeTargetId,
    { state: SetupProgressState; failure: string | null }
  >;
}

const progressRecordSchema = z
  .object({
    state: z.enum(["pending", "completed", "failed"]),
    failure: z.string().min(1).nullable(),
  })
  .strict();

const persistedStateSchema = z
  .object({
    setup: z
      .object({
        "dedicated-user": progressRecordSchema,
        "system-packages": progressRecordSchema,
        "protected-storage": progressRecordSchema,
      })
      .strict(),
    processesStopped: z.boolean(),
    purge: z
      .object({
        "stop-owned-processes": progressRecordSchema,
        "browser-data": progressRecordSchema,
        configuration: progressRecordSchema,
        "dedicated-user": progressRecordSchema,
      })
      .strict(),
  })
  .strict();

export interface HostAdministrationStateStore {
  read(
    hostId: string,
  ): HostAdministrationState | Promise<HostAdministrationState | null> | null;
  write(hostId: string, state: HostAdministrationState): void | Promise<void>;
}

function emptyProgressRecord() {
  return { state: "pending" as const, failure: null };
}

export function emptyHostAdministrationState(): HostAdministrationState {
  return {
    setup: {
      "dedicated-user": emptyProgressRecord(),
      "system-packages": emptyProgressRecord(),
      "protected-storage": emptyProgressRecord(),
    },
    processesStopped: false,
    purge: {
      "stop-owned-processes": emptyProgressRecord(),
      "browser-data": emptyProgressRecord(),
      configuration: emptyProgressRecord(),
      "dedicated-user": emptyProgressRecord(),
    },
  };
}

function cloneState(state: HostAdministrationState): HostAdministrationState {
  return {
    setup: {
      "dedicated-user": { ...state.setup["dedicated-user"] },
      "system-packages": { ...state.setup["system-packages"] },
      "protected-storage": { ...state.setup["protected-storage"] },
    },
    processesStopped: state.processesStopped,
    purge: {
      "stop-owned-processes": { ...state.purge["stop-owned-processes"] },
      "browser-data": { ...state.purge["browser-data"] },
      configuration: { ...state.purge.configuration },
      "dedicated-user": { ...state.purge["dedicated-user"] },
    },
  };
}

export function createMemoryHostAdministrationStateStore(): HostAdministrationStateStore {
  const states = new Map<string, HostAdministrationState>();
  return {
    read: (hostId) => {
      const state = states.get(hostId);
      return state === undefined ? null : cloneState(state);
    },
    write: (hostId, state) => {
      states.set(hostId, cloneState(state));
    },
  };
}

function missingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function administrationStatePath(stateDirectory: string, hostId: string) {
  return join(stateDirectory, `${encodeURIComponent(hostId)}.json`);
}

async function readPersistedAdministrationState(statePath: string) {
  try {
    const serializedState = await readFile(statePath, "utf8");
    return persistedStateSchema.parse(JSON.parse(serializedState));
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
}

async function writePersistedAdministrationState(
  statePath: string,
  state: HostAdministrationState,
) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, statePath);
}

export function createFileHostAdministrationStateStore(
  dataDir: string,
): HostAdministrationStateStore {
  const stateDirectory = join(dataDir, "administration-state");

  return {
    read: (hostId) =>
      readPersistedAdministrationState(
        administrationStatePath(stateDirectory, hostId),
      ),
    async write(hostId, state) {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await writePersistedAdministrationState(
        administrationStatePath(stateDirectory, hostId),
        state,
      );
    },
  };
}

export interface BrowserInstallationPaths {
  storageRoot: string;
  hostStoragePath: string;
  configurationPath: string;
}

export function browserInstallationPaths(
  installationId: string,
  hostId: string,
): BrowserInstallationPaths {
  if (!/^[A-Za-z0-9_-]+$/u.test(installationId)) {
    throw new Error("Browser installation identifiers must be path-safe.");
  }
  return {
    storageRoot: BROWSER_STORAGE_ROOT,
    hostStoragePath: join(
      BROWSER_STORAGE_ROOT,
      "installations",
      installationId,
      "hosts",
      browserHostStorageSegment(hostId),
    ),
    configurationPath: join(
      BROWSER_CONFIGURATION_ROOT,
      "installations",
      installationId,
    ),
  };
}

const PURGE_TARGET_ORDER = [
  "stop-owned-processes",
  "browser-data",
  "configuration",
  "dedicated-user",
] as const satisfies readonly PurgeTargetId[];

function setupState(steps: BrowserSetupPlan["steps"]) {
  if (steps.some((step) => step.state === "failed")) {
    return "partial-failure" as const;
  }
  if (steps.every((step) => step.state === "completed")) {
    return "ready" as const;
  }
  if (steps.some((step) => step.state === "completed")) {
    return "in-progress" as const;
  }
  return "pending" as const;
}

function setupSteps(state: HostAdministrationState) {
  return SETUP_STEP_DEFINITIONS.map((definition) => ({
    ...definition,
    state: state.setup[definition.id].state,
    failure: state.setup[definition.id].failure,
  }));
}

function setupRuntime() {
  const runtime = browserRuntimePolicy();
  validateBrowserRuntimePolicy(runtime);
  return runtime;
}

function setupPlan(
  target: BrowserHostTarget,
  installationId: string,
  state: HostAdministrationState,
): BrowserSetupPlan {
  const steps = setupSteps(state);
  return browserSetupPlanSchema.parse({
    ...target,
    installationId,
    state: setupState(steps),
    nextStepId: steps.find((step) => step.state !== "completed")?.id ?? null,
    ...browserInstallationPaths(installationId, target.hostId),
    storageOwner: BROWSER_USER,
    storageMode: "0700",
    runtime: setupRuntime(),
    packages: BROWSER_SYSTEM_PACKAGES,
    steps,
  });
}

function createDedicatedUserOperation(
  confirmation: string,
): PrivilegedOperation {
  return {
    kind: "create-dedicated-user",
    username: BROWSER_USER,
    homeDirectory: BROWSER_USER_HOME,
    shell: BROWSER_USER_SHELL,
    privilege: "unprivileged",
    confirmation,
  };
}

function installSystemPackagesOperation(
  confirmation: string,
): PrivilegedOperation {
  return {
    kind: "install-system-packages",
    packages: BROWSER_SYSTEM_PACKAGES.map((packageSpec) => packageSpec.name),
    repository: "signed-system-repository",
    confirmation,
  };
}

function configureProtectedStorageOperation(
  target: BrowserHostTarget,
  installationId: string,
  confirmation: string,
): PrivilegedOperation {
  const paths = browserInstallationPaths(installationId, target.hostId);
  return {
    kind: "configure-protected-storage",
    path: paths.hostStoragePath,
    owner: BROWSER_USER,
    mode: 0o700,
    installationId,
    hostId: target.hostId,
    confirmation,
  };
}

function setupOperation(
  stepId: SetupStepId,
  target: BrowserHostTarget,
  installationId: string,
  confirmation: string,
): PrivilegedOperation {
  if (stepId === "dedicated-user") {
    return createDedicatedUserOperation(confirmation);
  }
  if (stepId === "system-packages") {
    return installSystemPackagesOperation(confirmation);
  }
  return configureProtectedStorageOperation(
    target,
    installationId,
    confirmation,
  );
}

function operationFailure(scope: string) {
  return `${scope} failed; no later operation was run. Retry this operation.`;
}

function setupResponse(
  outcome: BrowserSetupResponse["outcome"],
  message: string,
  plan: BrowserSetupPlan,
): BrowserSetupResponse {
  return { outcome, message, plan };
}

function setupConfirmationResponse(
  plan: BrowserSetupPlan,
  step: BrowserSetupPlan["steps"][number],
): BrowserSetupResponse {
  return setupResponse(
    "confirmation-required",
    `Type exactly: ${step.confirmationText}`,
    plan,
  );
}

function setupOrderResponse(plan: BrowserSetupPlan): BrowserSetupResponse {
  const nextStep = plan.steps.find(({ id }) => id === plan.nextStepId);
  return setupResponse(
    "blocked",
    `Complete ${nextStep?.label ?? "the remaining setup step"} first.`,
    plan,
  );
}

function purgeConfirmationText(installationId: string, hostId: string) {
  return `PURGE Browser installation ${installationId} on host ${hostId}`;
}

type PurgeProgress = HostAdministrationState["purge"][PurgeTargetId];
type PurgeTarget = BrowserPurgePlan["targets"][number];

function purgeProgress(
  id: PurgeTargetId,
  state: HostAdministrationState,
): PurgeProgress {
  const progress = state.purge[id];
  if (id === "stop-owned-processes" && state.processesStopped) {
    return { state: "completed", failure: null };
  }
  return progress;
}

function processPurgeTarget(progress: PurgeProgress): PurgeTarget {
  return {
    kind: "processes",
    id: "stop-owned-processes",
    scope: "Browser-owned processes",
    ...progress,
  };
}

function browserDataPurgeTarget(
  progress: PurgeProgress,
  paths: BrowserInstallationPaths,
): PurgeTarget {
  return {
    kind: "browser-data",
    id: "browser-data",
    path: paths.hostStoragePath,
    ...progress,
  };
}

function configurationPurgeTarget(
  progress: PurgeProgress,
  paths: BrowserInstallationPaths,
): PurgeTarget {
  return {
    kind: "configuration",
    id: "configuration",
    path: paths.configurationPath,
    ...progress,
  };
}

function userPurgeTarget(progress: PurgeProgress): PurgeTarget {
  return {
    kind: "system-user",
    id: "dedicated-user",
    username: BROWSER_USER,
    ...progress,
  };
}

function purgeTarget(
  id: PurgeTargetId,
  state: HostAdministrationState,
  paths: BrowserInstallationPaths,
): PurgeTarget {
  const progress = purgeProgress(id, state);
  if (id === "stop-owned-processes") return processPurgeTarget(progress);
  if (id === "browser-data") return browserDataPurgeTarget(progress, paths);
  if (id === "configuration") return configurationPurgeTarget(progress, paths);
  return userPurgeTarget(progress);
}

function purgeState(targets: BrowserPurgePlan["targets"]) {
  if (targets.some((target) => target.state === "failed")) {
    return "partial-failure" as const;
  }
  if (targets.every((target) => target.state === "completed")) {
    return "purged" as const;
  }
  if (targets.some((target) => target.state === "completed")) {
    return "in-progress" as const;
  }
  return "pending" as const;
}

function purgePlan(
  target: BrowserHostTarget,
  installationId: string,
  state: HostAdministrationState,
): BrowserPurgePlan {
  const paths = browserInstallationPaths(installationId, target.hostId);
  const targets = PURGE_TARGET_ORDER.map((id) => purgeTarget(id, state, paths));
  return browserPurgePlanSchema.parse({
    ...target,
    installationId,
    state: purgeState(targets),
    confirmationText: purgeConfirmationText(installationId, target.hostId),
    targets,
  });
}

function stopOwnedProcessesOperation(
  installationId: string,
  hostId: string,
  confirmation: string,
): PrivilegedOperation {
  return {
    kind: "stop-owned-processes",
    owner: BROWSER_USER,
    hostId,
    installationId,
    confirmation,
  };
}

function removeBrowserDataOperation(
  target: BrowserHostTarget,
  installationId: string,
  confirmation: string,
): PrivilegedOperation {
  const paths = browserInstallationPaths(installationId, target.hostId);
  return {
    kind: "remove-browser-data",
    path: paths.hostStoragePath,
    installationId,
    hostId: target.hostId,
    confirmation,
  };
}

function removeConfigurationOperation(
  target: BrowserHostTarget,
  installationId: string,
  confirmation: string,
): PrivilegedOperation {
  const paths = browserInstallationPaths(installationId, target.hostId);
  return {
    kind: "remove-installation-configuration",
    path: paths.configurationPath,
    installationId,
    confirmation,
  };
}

function removeDedicatedUserOperation(
  target: BrowserHostTarget,
  installationId: string,
  confirmation: string,
): PrivilegedOperation {
  return {
    kind: "remove-dedicated-user",
    username: BROWSER_USER,
    hostId: target.hostId,
    installationId,
    guard: {
      type: "last-installation-only",
      hostId: target.hostId,
      installationId,
    },
    confirmation,
  };
}

function purgeOperation(
  id: PurgeTargetId,
  target: BrowserHostTarget,
  installationId: string,
  confirmation: string,
): PrivilegedOperation {
  if (id === "stop-owned-processes") {
    return stopOwnedProcessesOperation(
      installationId,
      target.hostId,
      confirmation,
    );
  }
  if (id === "browser-data") {
    return removeBrowserDataOperation(target, installationId, confirmation);
  }
  if (id === "configuration") {
    return removeConfigurationOperation(target, installationId, confirmation);
  }
  return removeDedicatedUserOperation(target, installationId, confirmation);
}

function purgeResponse(
  outcome: BrowserPurgeResponse["outcome"],
  message: string,
  plan: BrowserPurgePlan,
): BrowserPurgeResponse {
  return { outcome, message, plan };
}

export interface HostAdministrationBoundary extends HostReadinessBoundary {
  setupPlan(
    target: BrowserHostTarget,
  ): BrowserSetupPlan | Promise<BrowserSetupPlan>;
  setup(
    request: BrowserSetupRequest,
  ): BrowserSetupResponse | Promise<BrowserSetupResponse>;
  disable(
    request: BrowserLifecycleRequest,
  ): BrowserLifecycleResponse | Promise<BrowserLifecycleResponse>;
  uninstall(
    request: BrowserLifecycleRequest,
  ): BrowserLifecycleResponse | Promise<BrowserLifecycleResponse>;
  purgePlan(
    target: BrowserHostTarget,
  ): BrowserPurgePlan | Promise<BrowserPurgePlan>;
  purge(
    request: BrowserPurgeRequest,
  ): BrowserPurgeResponse | Promise<BrowserPurgeResponse>;
}

export interface HostAdministrationOptions {
  readiness: HostReadinessBoundary;
  installationId: string;
  executor: PrivilegedExecutor;
  stateStore?: HostAdministrationStateStore;
}

interface HostAdministrationRuntime {
  readiness: HostReadinessBoundary;
  installationId: string;
  executor: PrivilegedExecutor;
  stateStore: HostAdministrationStateStore;
  mutationQueues: Map<string, Promise<void>>;
}

async function withHostMutationLock<T>(
  runtime: HostAdministrationRuntime,
  hostId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = runtime.mutationQueues.get(hostId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.mutationQueues.set(hostId, current);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (runtime.mutationQueues.get(hostId) === current) {
      runtime.mutationQueues.delete(hostId);
    }
  }
}

async function readState(
  stateStore: HostAdministrationStateStore,
  hostId: string,
) {
  return (await stateStore.read(hostId)) ?? emptyHostAdministrationState();
}

async function writeState(
  stateStore: HostAdministrationStateStore,
  hostId: string,
  state: HostAdministrationState,
) {
  await stateStore.write(hostId, state);
}

function setupGateResponse(
  plan: BrowserSetupPlan,
  step: BrowserSetupPlan["steps"][number],
  request: BrowserSetupRequest,
): BrowserSetupResponse | null {
  if (request.confirmation !== step.confirmationText) {
    return setupConfirmationResponse(plan, step);
  }
  if (step.state === "completed") {
    return setupResponse(
      "already-complete",
      `${step.label} is complete.`,
      plan,
    );
  }
  if (plan.nextStepId !== request.stepId) {
    return setupOrderResponse(plan);
  }
  return null;
}

function setupReadinessBlock(readiness: BrowserStatus): string | null {
  if (
    readiness.state === "unsupported" ||
    readiness.state === "repair-required" ||
    readiness.state === "host-offline"
  ) {
    return readiness.message;
  }
  const connectCapability = readiness.capabilities.find(
    ({ id }) => id === "bb-connect",
  );
  if (connectCapability?.status === "missing") {
    return connectCapability.reason;
  }
  return null;
}

interface SetupExecutionContext {
  request: BrowserSetupRequest;
  target: BrowserHostTarget;
  step: BrowserSetupPlan["steps"][number];
  state: HostAdministrationState;
  runtime: HostAdministrationRuntime;
}

async function recordSetupFailure(
  context: SetupExecutionContext,
): Promise<BrowserSetupResponse> {
  const { request, target, step, state, runtime } = context;
  const failure = operationFailure(step.label);
  state.setup[request.stepId] = { state: "failed", failure };
  await writeState(runtime.stateStore, request.hostId, state);
  return setupResponse(
    "partial-failure",
    failure,
    setupPlan(target, runtime.installationId, state),
  );
}

async function recordSetupCompletion(
  context: SetupExecutionContext,
): Promise<BrowserSetupResponse> {
  const { request, target, step, state, runtime } = context;
  state.setup[request.stepId] = { state: "completed", failure: null };
  await writeState(runtime.stateStore, request.hostId, state);
  const completedPlan = setupPlan(target, runtime.installationId, state);
  const outcome = completedPlan.state === "ready" ? "completed" : "progressed";
  return setupResponse(outcome, `${step.label} is complete.`, completedPlan);
}

async function executeSetupStep(
  context: SetupExecutionContext,
): Promise<BrowserSetupResponse> {
  const { request, target, runtime } = context;
  try {
    await runtime.executor.execute(
      setupOperation(
        request.stepId,
        target,
        runtime.installationId,
        request.confirmation,
      ),
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return recordSetupFailure(context);
  }
  return recordSetupCompletion(context);
}

async function runSetup(
  request: BrowserSetupRequest,
  runtime: HostAdministrationRuntime,
): Promise<BrowserSetupResponse> {
  const state = await readState(runtime.stateStore, request.hostId);
  const target = { hostId: request.hostId, profileId: request.profileId };
  const currentPlan = setupPlan(target, runtime.installationId, state);
  const step = currentPlan.steps.find(({ id }) => id === request.stepId);
  if (step === undefined) {
    return setupResponse("blocked", "Unknown Browser setup step.", currentPlan);
  }
  const gateResponse = setupGateResponse(currentPlan, step, request);
  if (gateResponse !== null) return gateResponse;
  const hostReadiness = await runtime.readiness.inspect(target);
  const readinessBlock = setupReadinessBlock(hostReadiness);
  if (readinessBlock !== null) {
    return setupResponse("blocked", readinessBlock, currentPlan);
  }
  return executeSetupStep({ request, target, step, state, runtime });
}

function lifecycleResponse(
  action: BrowserLifecycleResponse["action"],
  outcome: BrowserLifecycleResponse["outcome"],
  message: string,
): BrowserLifecycleResponse {
  return {
    action,
    outcome,
    message,
    confirmationText: STOP_BROWSER_CONFIRMATION,
    profilesRetained: true,
  };
}

async function tryStopOwnedProcesses(
  request: BrowserLifecycleRequest,
  runtime: HostAdministrationRuntime,
): Promise<boolean> {
  try {
    await runtime.executor.execute(
      stopOwnedProcessesOperation(
        runtime.installationId,
        request.hostId,
        request.confirmation,
      ),
    );
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function recordStoppedProcesses(
  request: BrowserLifecycleRequest,
  action: BrowserLifecycleResponse["action"],
  state: HostAdministrationState,
  runtime: HostAdministrationRuntime,
): Promise<BrowserLifecycleResponse> {
  state.processesStopped = true;
  await writeState(runtime.stateStore, request.hostId, state);
  return lifecycleResponse(
    action,
    "stopped",
    "Browser-owned processes were stopped; profiles and authenticated state are retained.",
  );
}

async function stopProcessesAfterConfirmation(
  request: BrowserLifecycleRequest,
  action: BrowserLifecycleResponse["action"],
  runtime: HostAdministrationRuntime,
): Promise<BrowserLifecycleResponse> {
  const state = await readState(runtime.stateStore, request.hostId);
  if (state.processesStopped) {
    return lifecycleResponse(
      action,
      "already-stopped",
      "Browser-owned processes are already stopped; profiles are retained.",
    );
  }
  if (!(await tryStopOwnedProcesses(request, runtime))) {
    return lifecycleResponse(
      action,
      "failed",
      "Browser-owned processes could not be stopped; profiles are retained.",
    );
  }
  return recordStoppedProcesses(request, action, state, runtime);
}

async function stopProcesses(
  request: BrowserLifecycleRequest,
  action: BrowserLifecycleResponse["action"],
  runtime: HostAdministrationRuntime,
): Promise<BrowserLifecycleResponse> {
  if (request.confirmation !== STOP_BROWSER_CONFIRMATION) {
    return lifecycleResponse(
      action,
      "confirmation-required",
      `Type exactly: ${STOP_BROWSER_CONFIRMATION}`,
    );
  }
  return stopProcessesAfterConfirmation(request, action, runtime);
}

interface PurgeExecutionContext {
  request: BrowserPurgeRequest;
  target: BrowserHostTarget;
  targetId: PurgeTargetId;
  state: HostAdministrationState;
  runtime: HostAdministrationRuntime;
}

async function tryPurgeOperation(context: PurgeExecutionContext) {
  try {
    await context.runtime.executor.execute(
      purgeOperation(
        context.targetId,
        context.target,
        context.runtime.installationId,
        context.request.confirmation,
      ),
    );
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function recordPurgeFailure(context: PurgeExecutionContext) {
  const failure = operationFailure(`Purge target ${context.targetId}`);
  context.state.purge[context.targetId] = { state: "failed", failure };
  await writeState(
    context.runtime.stateStore,
    context.request.hostId,
    context.state,
  );
}

async function recordPurgeCompletion(context: PurgeExecutionContext) {
  context.state.purge[context.targetId] = {
    state: "completed",
    failure: null,
  };
  if (context.targetId === "stop-owned-processes") {
    context.state.processesStopped = true;
  }
  await writeState(
    context.runtime.stateStore,
    context.request.hostId,
    context.state,
  );
}

async function executePurgeTarget(
  context: PurgeExecutionContext,
): Promise<"skipped" | "completed" | "failed"> {
  if (context.state.purge[context.targetId].state === "completed") {
    return "skipped";
  }
  if (
    context.targetId === "stop-owned-processes" &&
    context.state.processesStopped
  ) {
    await recordPurgeCompletion(context);
    return "completed";
  }
  if (!(await tryPurgeOperation(context))) {
    await recordPurgeFailure(context);
    return "failed";
  }
  await recordPurgeCompletion(context);
  return "completed";
}

function purgeGateResponse(
  plan: BrowserPurgePlan,
  request: BrowserPurgeRequest,
): BrowserPurgeResponse | null {
  if (request.confirmation !== plan.confirmationText) {
    return purgeResponse(
      "confirmation-required",
      `Type exactly: ${plan.confirmationText}`,
      plan,
    );
  }
  if (plan.state === "purged") {
    return purgeResponse(
      "already-purged",
      "Browser installation is already purged.",
      plan,
    );
  }
  return null;
}

function purgeCompletionResponse(
  plan: BrowserPurgePlan,
  progressed: boolean,
): BrowserPurgeResponse {
  const purged = plan.state === "purged";
  return purgeResponse(
    purged ? "purged" : progressed ? "progressed" : "already-purged",
    purged
      ? "Browser installation, configuration, and authenticated browser data were purged."
      : "Purge progress was recorded; retry with the same typed confirmation to continue.",
    plan,
  );
}

interface PurgeRunContext {
  request: BrowserPurgeRequest;
  target: BrowserHostTarget;
  state: HostAdministrationState;
  runtime: HostAdministrationRuntime;
}

interface PurgeRunResult {
  progressed: boolean;
  failedTarget: PurgeTargetId | null;
}

async function executePurgeTargets(
  context: PurgeRunContext,
): Promise<PurgeRunResult> {
  let progressed = false;
  for (const targetId of PURGE_TARGET_ORDER) {
    const execution = await executePurgeTarget({ ...context, targetId });
    if (execution === "failed") return { progressed, failedTarget: targetId };
    progressed ||= execution === "completed";
  }
  return { progressed, failedTarget: null };
}

async function runPurge(
  request: BrowserPurgeRequest,
  runtime: HostAdministrationRuntime,
): Promise<BrowserPurgeResponse> {
  const state = await readState(runtime.stateStore, request.hostId);
  const target = { hostId: request.hostId, profileId: request.profileId };
  const currentPlan = purgePlan(target, runtime.installationId, state);
  const gateResponse = purgeGateResponse(currentPlan, request);
  if (gateResponse !== null) return gateResponse;
  const execution = await executePurgeTargets({
    request,
    target,
    state,
    runtime,
  });
  if (execution.failedTarget !== null) {
    const failure = operationFailure(`Purge target ${execution.failedTarget}`);
    return purgeResponse(
      "partial-failure",
      failure,
      purgePlan(target, runtime.installationId, state),
    );
  }
  return purgeCompletionResponse(
    purgePlan(target, runtime.installationId, state),
    execution.progressed,
  );
}

function createAdministrationRuntime(
  options: HostAdministrationOptions,
): HostAdministrationRuntime {
  return {
    readiness: options.readiness,
    installationId: options.installationId,
    executor: options.executor,
    stateStore:
      options.stateStore ?? createMemoryHostAdministrationStateStore(),
    mutationQueues: new Map(),
  };
}

async function readSetupPlan(
  target: BrowserHostTarget,
  runtime: HostAdministrationRuntime,
) {
  return setupPlan(
    target,
    runtime.installationId,
    await readState(runtime.stateStore, target.hostId),
  );
}

async function readPurgePlan(
  target: BrowserHostTarget,
  runtime: HostAdministrationRuntime,
) {
  return purgePlan(
    target,
    runtime.installationId,
    await readState(runtime.stateStore, target.hostId),
  );
}

export function createHostAdministrationBoundary(
  options: HostAdministrationOptions,
): HostAdministrationBoundary {
  const runtime = createAdministrationRuntime(options);
  return {
    inspect: (target) => runtime.readiness.inspect(target),
    diagnostics: (target) => runtime.readiness.diagnostics(target),
    setupPlan: (target) => readSetupPlan(target, runtime),
    setup: (request) =>
      withHostMutationLock(runtime, request.hostId, () =>
        runSetup(request, runtime),
      ),
    disable: (request) =>
      withHostMutationLock(runtime, request.hostId, () =>
        stopProcesses(request, "disable", runtime),
      ),
    uninstall: (request) =>
      withHostMutationLock(runtime, request.hostId, () =>
        stopProcesses(request, "uninstall", runtime),
      ),
    purgePlan: (target) => readPurgePlan(target, runtime),
    purge: (request) =>
      withHostMutationLock(runtime, request.hostId, () =>
        runPurge(request, runtime),
      ),
  };
}

export function createReadOnlyHostAdministrationBoundary(options: {
  readiness: HostReadinessBoundary;
  installationId: string;
  stateStore?: HostAdministrationStateStore;
}): HostAdministrationBoundary {
  return createHostAdministrationBoundary({
    ...options,
    executor: createUnavailablePrivilegedExecutor(),
  });
}

export { STOP_BROWSER_CONFIRMATION };
