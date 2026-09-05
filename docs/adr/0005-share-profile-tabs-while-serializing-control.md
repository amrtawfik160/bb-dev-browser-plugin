# Share profile tabs while serializing control

Browser Tabs, one active tab, and one Browser Instance belong to a Browser Profile rather than to a BB thread, so Browser Panels across threads and BB clients observe the same ordered tab set, tab selection, and controller-driven logical viewport; popup windows are normalized into that tab set. Input remains serialized through a Control Lease: owner interaction has priority, an agent script receives a visible, interruptible lease lasting no more than 30 seconds, and a second owner client remains view-only until it explicitly takes control. Agent work is rejected while an owner controls the profile and waits at most 30 seconds behind other agents. Waiting calls are served in arrival order and discarded on cancellation, expiry, or owner takeover; they are never persisted or executed after a busy response.

On 4 September 2026, the wait limit changed from five to 30 seconds after two
threads using one profile reproduced repeated `browser_busy` failures behind a
successful 20-second operation. Matching the maximum script lease lets ordinary
overlapping calls finish in order. The wait is separate from the script's
execution timeout, so contention can increase total call latency. A busy
response states that the waiting call did not run; callers may retry after the
active operation ends.
