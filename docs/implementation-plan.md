# Browser Plugin Implementation Plan

Status: accepted planning input for the ready-for-agent local tracker specification. Ticket decomposition is next; privileged host setup still requires its own later confirmation.

## Phase 0: repository and contracts

- Initialize the current workspace as the `bb-plugin-browser` Git repository with no remote.
- Scaffold the BB backend, frontend, host entry, CLI, native agent tool, and bundled skill.
- Pin the BB SDK and `dev-browser` 0.2.9; establish formatting, linting, type checking, tests, and production build scripts.
- Add typed server/frontend/host contracts and append-only server database migrations.

Gate: the empty plugin loads in the BB test harness and every build-quality command passes.

## Phase 1: policy, state, and setup diagnostics

- Implement profiles, grants, requests, activity retention, capability state, lease state, and server/host reconciliation.
- Implement host capability probing, setup planning, health reporting, unsupported-platform states, and non-destructive repair diagnostics.
- Implement profile manifests, installation scoping, secure path checks, quotas, archive/reset/import/backup state machines, and the event outbox without launching a browser.

Gate: unit, migration, property-boundary, and host lifecycle tests pass without privileged host changes.

## Phase 2: browser runtime and agent interface

- Launch Chrome or fallback Chromium as the dedicated unprivileged user through the retained host worker.
- Implement profile locks, native session restore, crash-loop handling, sleep/wake, disk guards, Project Loopback Aliases, and runtime-only tab identities.
- Add `browser_script`, `bb browser`, the bundled skill, QuickJS delegation to `dev-browser`, Origin Scope enforcement, Control Leases, Grant Requests, and bounded Browser Results.

Gate: a local authenticated fixture preserves login and tabs across browser and worker restarts; authorization and revocation tests pass.

## Phase 3: Automation Mode and Browser Panel

- Implement the loopback gateway, Panel Capability redemption/rotation, bounded WebSocket protocol, CDP screencast, input, viewport control, dialogs, tabs, reconnect, and congestion policy.
- Register existing-thread and New thread actions and build the themed, responsive, accessible panel states and Settings UI.
- Add downloads/activity surfaces, profile selection, badges, toasts, and controller transfer.

Gate: frontend, gateway-security, multi-client, and real-Chromium interaction tests pass; local performance targets are met.

## Phase 4: Safe Login and file transfers

- Add the owner-only Xvfb/x11vnc/noVNC path and graceful mode transitions.
- Prove that other clients and agents receive neither Safe Login pixels nor DOM access.
- Add explicit clipboard exchange, Transfer Staging, quarantined Host Downloads, workspace/client transfer, path containment, overwrite confirmation, retention, and quotas.

Gate: Safe Login isolation, interrupted transition, upload/download, symlink, traversal, and cleanup tests pass.

## Phase 5: hardening and handoff

- Exercise all crash, reconnect, low-disk, corruption, expiry, downgrade, partial-setup, and cleanup scenarios.
- Write the threat model, guides, references, limitations, notices, and verification report.
- Run formatting, linting, type checking, the complete test suite, production build, clean-code guard, test guard, docs guard, and blast-radius review; fix confirmed findings and rerun affected gates.
- Present the exact privileged setup plan for owner confirmation, provision the current host only after approval, install the plugin from its path, and execute remote end-to-end acceptance.
- Offer an owner-driven third-party login smoke test without collecting credentials.

Gate: every requirement in the design spec has evidence or an explicit documented v1 limitation. Partial slices are not called complete.
