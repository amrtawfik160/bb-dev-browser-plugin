# Embedded Browser

This context defines the authenticated browser workspace shared by a BB owner and authorized agents while working across repositories.

## Language

**Browser Panel**:
The interactive browsing surface opened as a tab in BB's right panel for either a new or existing thread.
_Avoid_: Right sidebar, browser sidebar

**Browser Card**:
A live summary of one Browser Profile that an agent embeds in a BB chat reply. It shows current browser state read through owner access and opens the Browser Panel; it is neither a stream nor an agent-authored screenshot.
_Avoid_: Live view, browser embed

**Sign-in Handoff**:
A Browser Card in which an agent asks the owner to sign in to one exact origin themselves in the Browser Panel, then click Done to send a reply in the thread and let the agent continue. The agent never receives or types the credentials.
_Avoid_: Login request, credential prompt

**Panel Capability**:
A single-use, short-lived authorization bound to one owner session, Browser Panel, host, and Browser Profile. It bootstraps a renewable stream connection but never grants agent access.
_Avoid_: Profile Grant, public browser URL

**Workspace Browser**:
A browser running on the enrolled machine that hosts the repository currently being worked on.
_Avoid_: Client browser, server browser

**Browser Profile**:
A named, host-local browser identity containing site authentication and storage. A profile may be reused across repositories on the same host but is never synchronized to another host.
Threads receive separate default profiles; calls without a thread receive a project default. Explicit profile selections, including an agent's thread selection through `browser_sessions`, opt into sharing cookies. Automation gives each thread a named Browser Tab from its first script call, so saving or sharing a profile preserves its multi-call workflow. Browser processes remain bounded independently of the number of stored profiles.
When its thread is archived, a thread's default profile sleeps, and an unsaved one becomes an Archived Profile seven days later; when the thread is deleted, an unsaved profile becomes an Archived Profile at once. Profiles of threads archived before this rule existed are released only by an owner-run sweep that reports them first. Profiles with a confirmed sign-in are saved for reuse and stay active until the owner archives or deletes them. Explicitly selected profiles are never released by thread lifecycle.
_Avoid_: Account, global session

**Sign-in Confirmation**:
A dated hint for one exact origin in a Browser Profile, recorded by the owner clicking Done or an agent reporting an authenticated page. It records origin, status, source, and time, excludes account details, and must be rechecked before use.
_Avoid_: Live authentication inventory, cookie scan

**Archived Profile**:
A stopped, grant-free Browser Profile retained temporarily for recovery before permanent deletion.
_Avoid_: Deleted profile, sleeping profile

**Profile Grant**:
A persistent authorization allowing agents from one BB project to fully automate one Browser Profile within its Origin Scope. Owner interaction needs no grant. A project receives a whole-web grant through Default Access; file transfer and invalid-certificate access require separate owner opt-ins.
_Avoid_: Host access, blanket browser permission

**Default Access**:
The whole-web Profile Grant a BB project receives automatically the first time one of its agents operates on a Browser Profile. Revoking that grant in Browser Settings withdraws Default Access for the project and profile, so later agent operations go through Grant Requests; granting the whole web again restores it.
_Avoid_: Auto-approval, implicit permission

**Grant Request**:
A non-blocking request for an owner to expand one project's Profile Grant for a specific profile, origin, and elevated permission set after an agent operation is denied.
_Avoid_: Approval prompt, automatic permission

**Origin Auto-Approval**:
An owner setting, on unless the owner turns it off in Browser Settings, that approves an agent's Grant Request for an origin outside its grants (such as raw localhost) at once as a persistent exact-origin Profile Grant, recorded as a system approval in the request history and Activity. It never approves file transfer or invalid-certificate access, and it does not apply to a project whose Default Access the owner withdrew.
_Avoid_: Default Access, request bypass

**Browser Result**:
Text, structured data, or an explicitly requested screenshot returned from browser automation as ordinary BB thread tool output. It is not an Activity Record and the browser plugin keeps no additional copy.
_Avoid_: Audit log, automatic screenshot

**Origin Scope**:
The exact web origins and subdomain patterns within which a Profile Grant permits agent-controlled top-level browsing. It excludes URL paths, unrelated popups, and cross-origin frames.
_Avoid_: URL allowlist, network filter

**Project Loopback Alias**:
A stable project-specific `.localhost` hostname used to isolate cookies, site data, and Origin Scopes when different repositories serve applications on the same host port.
_Avoid_: Raw localhost, public development URL

**Browser Instance**:
The single disposable running browser process backed by one Browser Profile on a workspace host. Stopping an instance does not discard the profile or its Restorable Session. Sleeping stops the instance without marking its profile stopped; the next use wakes it.
_Avoid_: Browser Profile, persistent process

**Restorable Session**:
The durable site authentication, storage, and open-tab locations restored after a Browser Instance restarts; transient form state and exact navigation history are best-effort.
_Avoid_: Always-on session, exact process snapshot

**Control Lease**:
The temporary right to drive a Workspace Browser within one lane. The owner has one lane and each agent session has its own, so the owner and agents act at the same time without cancelling each other; calls within one lane run in order. Profile stop, Safe Login, and revoked access end every lane.
_Avoid_: Exclusive control, owner takeover

**Agent Session**:
One thread's work on a Browser Profile: its named tab, any popups that tab opens, and its own lane and Session CDP Proxy. An agent session sees and drives only its own tabs and runs in the background beside the owner.
_Avoid_: Shared cursor, agent takeover

**Session CDP Proxy**:
The loopback DevTools endpoint an agent session's helper connects through. It exposes only that session's targets, so the owner's and other sessions' tabs are invisible and unreachable to the agent.
_Avoid_: Raw automation endpoint

**axi Session**:
One agent session's chrome-devtools-axi bridge, named per thread and connected to that session's Session CDP Proxy. Agents drive it with `bb plugin run browser axi <command>`, exactly as `chrome-devtools-axi <command>`.
_Avoid_: Browser command, BB browser dialect

**Browser Tab**:
A page belonging to a Browser Profile's shared tab set and visible from every Browser Panel using that profile. Each profile has one active tab shared across its panels, chosen only by the owner. Automation binds each thread to a named tab from its first call; that tab works in the background, and every panel can still select and watch it. An explicit tab ID overrides that binding.
_Avoid_: Thread tab, panel-local page

**Automation Mode**:
The normal browser mode in which the owner and authorized agents can share observation and control.
_Avoid_: Agent-only mode

**Safe Login Mode**:
A renewable, time-bounded owner-only browser mode for sign-in flows that reject automation; agents cannot inspect or control the browser while this mode is active.
_Avoid_: Incognito mode, unrestricted compatibility mode

**Host Download**:
A quarantined file downloaded by a Workspace Browser and retained on that workspace host until it expires, is deleted, or the owner explicitly transfers it elsewhere; it is never opened or executed automatically.
_Avoid_: Client download, workspace file

**Transfer Staging**:
One-use host storage that brokers an explicitly selected file between a workspace or displaying client and a Workspace Browser without granting browser processes direct repository access.
_Avoid_: Workspace mount, shared downloads folder

**Activity Record**:
A metadata-only audit entry for an agent operation or browser security-administration event, identifying its actor, authorization context, origin when applicable, timing, outcome, and interruption state without retaining sensitive input or ordinary owner browsing.
_Avoid_: Script transcript, keystroke log
