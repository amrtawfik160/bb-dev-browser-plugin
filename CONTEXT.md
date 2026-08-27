# Embedded Browser

This context defines the authenticated browser workspace shared by a BB owner and authorized agents while working across repositories.

## Language

**Browser Panel**:
The interactive browsing surface opened as a tab in BB's right panel for either a new or existing thread.
_Avoid_: Right sidebar, browser sidebar

**Panel Capability**:
A single-use, short-lived authorization bound to one owner session, Browser Panel, host, and Browser Profile. It bootstraps a renewable stream connection but never grants agent access.
_Avoid_: Profile Grant, public browser URL

**Workspace Browser**:
A browser running on the enrolled machine that hosts the repository currently being worked on.
_Avoid_: Client browser, server browser

**Browser Profile**:
A named, host-local browser identity containing site authentication and storage. A profile may be reused across repositories on the same host but is never synchronized to another host.
_Avoid_: Account, global session

**Archived Profile**:
A stopped, grant-free Browser Profile retained temporarily for recovery before permanent deletion.
_Avoid_: Deleted profile, sleeping profile

**Profile Grant**:
A persistent authorization allowing agents from one BB project to fully automate one Browser Profile within its Origin Scope. Owner interaction needs no grant, while unrestricted origins and file transfer require separate owner opt-ins.
_Avoid_: Host access, blanket browser permission

**Grant Request**:
A non-blocking request for an owner to expand one project's Profile Grant for a specific profile, origin, and elevated permission set after an agent operation is denied.
_Avoid_: Approval prompt, automatic permission

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
The single disposable running browser process backed by one Browser Profile on a workspace host. Stopping an instance does not discard the profile or its Restorable Session.
_Avoid_: Browser Profile, persistent process

**Restorable Session**:
The durable site authentication, storage, and open-tab locations restored after a Browser Instance restarts; transient form state and exact navigation history are best-effort.
_Avoid_: Always-on session, exact process snapshot

**Control Lease**:
The exclusive, temporary right of either the owner or an agent to send input to a Workspace Browser. The owner has priority, may revoke an agent's lease, and explicitly transfers control between owner clients.
_Avoid_: Shared cursor, simultaneous control

**Browser Tab**:
A page belonging to a Browser Profile's shared tab set and visible from every Browser Panel using that profile. Each profile has one active tab shared across its panels; tabs are not owned by BB threads.
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
