# Discover and reuse confirmed sign-ins

Private default profiles avoid agents navigating each other's pages, but
also hide reusable authentication. Another agent should be able to discover
an existing Salesforce login on its host and use it without repeating the
owner's sign-in.

Keep private defaults. Add `browser_sessions` and `bb plugin run browser sessions` with
list, select, and report actions. Discovery lists every profile on the
calling thread's host, filters by site, and paginates results. It reads saved
metadata and recent successful agent Activity Record origins without waking
Browser Instances or scanning cookies. Activity origins are explicitly
unverified hints for old profiles.

A Sign-in Handoff's Done action records an owner-confirmed hint for its exact
origin and notifies the waiting thread. An agent may record signed-in or
signed-out after checking an authenticated page through its Profile Grant.
Each hint contains only origin, status, source, and time. It is a dated hint,
not an assertion of current authentication. If multiple accounts could fit,
the agent asks which profile to use; the plugin stores no account identity.

The host manifest keeps the 100 most recently checked origins and a saved
reuse flag. Optional fields preserve compatibility with existing version-one
manifests. Updates run under the existing storage mutation lock, with the
manifest's existing private file modes and ownership. Profile resets create
a new identity with no confirmations. This amends ADR 0009's persistence
policy only for explicit sign-in metadata; ordinary owner browsing remains
unrecorded and Chrome retains sole ownership of credentials.

Selection writes the calling thread's profile preference. It does not change
other threads or project defaults, or bypass Default Access revocation and
Profile Grants. Same-host projects can deliberately share a profile; profiles
remain bound to their workspace host as in ADRs 0001 and 0012.

On every profile, automation binds `page` to a named tab derived from project
and thread identity, starting with the thread's first script call. Waiting
until a profile is saved changes its binding mid-workflow; an unsaved default
can also be explicitly shared while its originating thread still uses the
active tab. A stable binding prevents both cases. Private default profiles
retain separate cookies. Tabs within a profile share one BrowserContext and cookies,
but default automation resumes its own tab between calls. An explicit tab
ID takes precedence. Browser Panels retain the shared tab inventory and
active tab; agents can explicitly manipulate other permitted tabs, so this
is workflow preservation rather than a security isolation boundary. Closed
or unrestored named tabs are recreated at the requested origin. This amends
ADR 0017's tab binding while preserving private default profiles and amends
ADR 0005's active-tab automation default.

A profile becomes saved for reuse after any confirmed sign-in. Saved profiles
survive their originating thread's deletion, amending ADR 0018; archiving the
thread may still sleep its Browser Instance. Automatic deletion checks the
saved flag under the same host storage mutation lock as sign-in confirmation;
only an actual archive revokes grants and releases profile resources. A stale
inventory must not archive a newly saved login. The owner can archive or delete
the profile in Browser Settings. Expired sign-in hints do not remove profile
data automatically. The Control Lease, Safe Login Mode, three-instance
ceiling, idle sleep, and 12-tab retention cap remain effective. Metadata
failures during Done must not prevent notifying the agent.

Automatic deletion also rechecks whether another thread selected the profile
inside the grant-state serialization queue. A selection that committed while
cleanup waited must preserve that shared profile.

Done uses the host and profile opened by that Sign-in Handoff, even when the
thread's selected profile changes before the owner finishes signing in.
