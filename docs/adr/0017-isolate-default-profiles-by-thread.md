# Isolate default Browser Profiles by thread

An agent's Control Lease lasts for one call. Serializing calls in a shared
profile cannot preserve a multi-call workflow: another thread can navigate
the active tab, close it, or change its authentication between calls.

Default profile selection now derives from the BB project and thread identity,
falling back to project identity when no thread is present. Tool, CLI, and
panel selections agree. The host creates the profile lazily under its storage
mutation lock using a deterministic opaque identifier, so concurrent first
calls and plugin restarts reuse one profile. This does not copy credentials.
Renaming a profile does not change its association, and ensuring an archived
profile does not restore it.

This amends ADR 0005's default sharing behavior, while retaining one active
tab and Control Lease per profile. An explicit profile parameter or owner
selection opts into that profile's shared tabs and cookies. A thread selection
overrides a project selection. Settings without project context retain Personal.
Existing explicit project selections remain effective; unselected threads
receive their own defaults. Profiles are kept on their workspace hosts as in
ADRs 0001 and 0012.

The existing limit of three awake instances remains. Visible panels and active
scripts pin their instances; otherwise the least recently used instance can
sleep to make room. When every instance is pinned, a fourth wake fails with
`awake-limit` without interrupting ongoing work. Idle sleep becomes five
minutes and the tab retention cap becomes 12 pages per instance. Sleeping
preserves durable storage and restorable tab locations, not transient forms.
These are process and page bounds, not a total-memory guarantee. Stored
profiles consume disk until the owner archives or deletes them.
