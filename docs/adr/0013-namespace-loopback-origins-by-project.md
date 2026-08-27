# Namespace loopback origins by project

Local applications should open through a stable Project Loopback Alias such as `p-<project-hash>.localhost:<port>` instead of raw `localhost`, so repositories reusing a port do not silently share cookies, site storage, or agent Origin Scopes. Raw localhost remains an explicit compatibility fallback for dev servers and OAuth callbacks that reject the alias; the extra hostname behavior is accepted in exchange for safer cross-repository profile reuse.
