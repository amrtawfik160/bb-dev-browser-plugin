# Split control state from browser state

The BB server plugin database owns Profile Grants, Grant Requests, preferences, and Activity Records, while the workspace host owns browser profiles, Host Downloads, runtime manifests, and a bounded durable outbox for host events awaiting server acknowledgement. Host inventory is reconciled on reconnect and credential-bearing Chrome data never crosses to the BB server; this split accepts reconciliation complexity so authorization follows BB projects without centralizing browser sessions.
