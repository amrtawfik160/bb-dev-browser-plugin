# Run browser profiles on workspace hosts

Browser processes and named profiles live on the enrolled machine that owns the current repository, rather than on the BB server or displaying client. Profiles may be reused across repositories within the same BB installation on that machine and shared by the owner and authorized agents, but they are namespaced by installation and host identity and never synchronized across machines or attached by another BB installation; this preserves access to repository-local services while limiting the spread of authenticated state.
