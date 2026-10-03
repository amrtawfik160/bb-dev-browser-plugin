# Minimize browser-derived persistence

Chrome's own profile provides tab and session restoration, so the plugin does not duplicate visited URLs or durable tab identifiers into its database. Audit data is limited to Activity Records for agent operations and security administration, retained for at most 30 days or 10,000 records per profile, and excludes ordinary owner browsing, full URLs, complete scripts, agent-supplied purposes, keystrokes, passwords, and clipboard contents; the owner may export or clear those records. Explicit Browser Results may persist in their BB thread but are never copied into plugin audit storage. Archived Profiles are grant-free and retained for 30 days unless explicitly purged. Profile backups are explicit stopped-profile, mode-600, same-installation artifacts treated as credentials rather than automatic or portable sync. Text clipboard and file transfer require explicit owner actions. Host Downloads expire after seven days, with configurable defaults of 1 GiB per file and 5 GiB per profile, while camera, microphone, geolocation, notifications, and device permissions are denied in v1.

Amended by [ADR 0020](0020-discover-and-reuse-confirmed-sign-ins.md): saved
profiles expose dated sign-in confirmations, use a named automation tab per
thread, and survive the deletion of their originating thread.

The host also keeps bounded operation traces in memory for troubleshooting:
30 minutes, 200 traces per profile, and 1,000 per worker. They record random
trace IDs, operation and error codes, timings, reconnect counts, and tab counts;
they exclude scripts, purposes, page data, URLs, tab IDs, and exception text.
Existing owner diagnostic exports include them. A worker restart clears them;
the plugin adds no durable browsing or trace store.
