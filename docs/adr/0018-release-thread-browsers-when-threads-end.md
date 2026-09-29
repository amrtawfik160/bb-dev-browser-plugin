# Release thread browsers when threads end

ADR 0017 gives every thread its own default Browser Profile, but nothing ended
them. Profiles and running Browser Instances accumulated for threads nobody
would return to.

The plugin now observes BB thread lifecycle events. When a thread is archived,
its default profile's Browser Instance sleeps: the process stops and control
is released as it is when a profile stops, but the profile is not marked
stopped. Storage, restorable tab locations, and grants survive, so an
unarchived thread wakes the same profile. When a thread is deleted, its default
profile becomes an Archived Profile through the same path as an owner archive:
grants are revoked, the profile expires later, and it can be recovered before
then. BB performs the deletion, so the Activity Records name the system as the
actor, not the owner, and do not require owner settings authority.

Only the profile derived from the thread identity is touched. Explicit,
named, project-default, and Personal profiles are never released. If an owner
has selected a thread's default profile for another project or thread, the
profile is shared and remains untouched. Absent or already archived profiles
are no-ops.

Events are observed without blocking the thread transition. The plugin acts on
each connected host that holds the profile. Disconnected hosts are skipped
with a content-free warning and are not retried later. An instance on such a
host still sleeps when idle, and its profile remains stored until the owner
archives it.

Amended by [ADR 0020](0020-discover-and-reuse-confirmed-sign-ins.md): saved
profiles expose dated sign-in confirmations, use a named automation tab per
thread, and survive the deletion of their originating thread.
