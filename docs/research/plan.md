# Dual-instance plan

> **Status:** 16 October 2026. Decisions are final unless marked **Open**.

---

## At a glance

| Item | Decision |
|---|---|
| Instances | Two separate Orca instances: **work box** and **personal box** |
| Data | Each box has its own Orca, orchestrator, Postgres, repos and logins |
| Database | Local Postgres on each box, nightly `pg_dump` backup. No shared database |
| Network | **One personal tailnet** for phone, laptop and both boxes |
| Box-to-box | Blocked by a Tailscale ACL |
| Server change in the app | Server switcher (PRs 270 and 271, merged). Off by default |
| Add a server | By URL in the app. Tailscale discovery is optional |
| GitHub login | `gh auth login` on each box |
| Claude login | `hydra login <name>` for each Claude account on each box |
| Box names | Rename later: `orca-flow-box` and `orca-personal-box` |
| Integrations | Later. Slack becomes an adapter. Discord stays stopped |
| GitHub calls | Move from the `gh` CLI to the GitHub API (in progress) |

---

## High-level steps

1. **Network** – Move Tailscale to your personal account.
2. **Box** – Buy the personal box.
3. **Install** – Set up the box and install Orca.
4. **Logins** – Log in to GitHub and Claude on the box.
5. **Connect** – Add both servers to the app.
6. **Move work** – Move the personal repos to the personal box.
7. **Tidy** – Rename the boxes.
8. **Integrations** – Build the integration layer, then Discord and the other sources.

---

## Immediate next steps

### A. Tailnet

1. Create a personal Tailscale account (tailnet).
2. Join your phone and your laptop to the personal tailnet.
3. Move the work box into the personal tailnet:
   ```sh
   sudo tailscale logout
   sudo tailscale up   # log in with the personal account
   ```
4. Add the ACL that blocks box-to-box traffic.
5. Test the ACL in the **tests** section before you save it.
6. Open the app on the phone and the laptop. Make sure it loads.
7. Give Orca the new Tailscale IP of the work box. Orca updates the instance URLs in the config.

### B. Personal box

1. Choose and buy the box (see the options below).
2. Tell Orca when the box is ready.
3. Orca writes the setup steps for the box.

---

## Box options

| Option | Cost (GBP / month) | Notes |
|---|---|---|
| **OVH VPS-2** (recommended) | about 7.55 | 4 vCore, 8 GB, daily backup included |
| Contabo Cloud VPS | about 4–5 | Cheapest. Weaker CPU, disk and support |
| Oracle Always Free | 0 | Can reclaim idle boxes. Capacity limits |
| Home PC or Raspberry Pi | 0 after purchase | Depends on home internet |

---

## Open decisions

- [x] **Decided:** the personal box provider is OVH VPS-2. The box is ordered. See
  [../personal-box.md](../personal-box.md) for the facts and the setup runbook.
- [ ] **Open:** the Claude plan for SMF work: personal subscription, API key or Team plan.

---

## Related documents

- [Hosting research](hosting.md)
- [Integrations and channels](integrations.md)
- [Dual-instance architecture](dual-instance.md)
- [Backend notes](backend.md)
