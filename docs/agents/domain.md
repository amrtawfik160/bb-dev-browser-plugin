# Domain Docs

This repository uses a single-context domain layout. Engineering skills must consume its domain documentation as follows.

## Before exploring

- Read CONTEXT.md at the repository root.
- Read the ADRs in docs/adr/ that touch the area being changed.
- If either location does not exist, proceed silently rather than creating placeholder documentation.

The domain-modeling workflow creates or changes domain documentation only when terminology or architectural decisions are actually resolved.

## Layout

    /
    ├── CONTEXT.md
    ├── docs/
    │   └── adr/
    │       ├── 0001-run-browser-profiles-on-workspace-hosts.md
    │       └── ...
    └── src/

## Use the glossary vocabulary

When an issue, specification, test, implementation, or review names a domain concept, use the term defined in CONTEXT.md. Do not drift to a synonym the glossary explicitly rejects.

If a required concept is absent, first reconsider whether existing vocabulary already covers it. Record a genuine gap for the domain-modeling workflow rather than inventing terminology ad hoc.

## Flag ADR conflicts

If proposed work contradicts an accepted ADR, surface the conflict explicitly and identify the ADR. Never silently override an architectural decision.
