# Dual-instance architecture: decisions

**Status:** Decision notes from Finn, captured 2026-10-16. The switcher ships as PR 270 (API) and
PR 271 (UI). See also [backend.md](backend.md) and [integrations.md](integrations.md), from the
same notes.

## Architecture

Two Orca instances stay fully separate: a work box (AWS, `orca-box`, later renamed to
`orca-flow-box`) and a personal box (`orca-personal-box`). No link exists between the boxes. Each
box has:

- its own orchestrator
- its own Postgres, local to the box, with a nightly `pg_dump` backup
- its own repos
- its own GitHub and Claude logins

A Tailscale ACL lets the user's devices reach both boxes. The ACL blocks box-to-box traffic. Both
boxes carry the tag `tag:orca`.

## The switcher (PR 270 and PR 271)

Orca uses a client-side switcher, Option B. PR 270 adds the API. PR 271 adds the UI.

- The phone or the laptop loads the app from one home server.
- When the user picks a different server in the header menu, the app calls that server directly
  over Tailscale.
- CORS allows the listed origins. A cross-origin call also runs a Tailscale `whois` check.
- The switcher sits behind a setting. It is off by default.
- Discovery uses the Tailscale API (an OAuth client with the `devices:core:read` scope), because
  the ACL hides peers from the local netmap.

## Rejected options

- **A shared database.** It links the boxes, mixes their data, and breaks the per-instance bridge
  lock.
- **A relay to hide traffic between the boxes.**
- **One orchestrator that controls both boxes.**

## Later work

A merged view (one board, one chat that routes to the right repo) is possible later. Build it only
if the switcher trial goes well.

## Rename plan

The rename of `orca-box` is postponed. Bookmarks and the phone home-screen app use its MagicDNS
name. Orca's own config uses Tailscale IPs, so the rename is safe for Orca itself whenever it
happens.
