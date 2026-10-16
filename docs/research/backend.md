# Backend notes: CLI use, the GitHub API, and the Agent SDK

**Status:** Decision notes from Finn, captured 2026-10-16. Planned work; not started yet. See also
[dual-instance.md](dual-instance.md), from the same notes.

## CLI use stays normal

The CLI use in Orca is normal and does not change: `claude` runs headless, `git` runs as usual, and
the `orca` CLI is a thin HTTP client, similar to `kubectl`.

## Planned: move GitHub calls to the GitHub API

Orca's GitHub calls move from the `gh` CLI to the GitHub API. This gives:

- ETag support, so a repeat check does not count against the rate limit
- clearer errors
- no new process for each call

## Later trial: Claude Agent SDK for the orchestrator

Orca plans a later trial of the Claude Agent SDK for the orchestrator, before any wider move to it.
