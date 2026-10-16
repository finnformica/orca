# Dual-instance plan: summary and next steps

Status: 2026-10-16. Decisions are final unless this file says "open".

## Decisions

- Run two separate Orca instances: the work box (orca-box, AWS) and a new personal box.
- Each box has its own Orca, orchestrator, Postgres, repos and logins. The boxes do not share data.
- Use local Postgres on each box. Back it up each night with pg_dump. Do not use a shared or managed database.
- Use one tailnet, owned by your personal Tailscale account. Put your phone, your laptop and both boxes in it.
- Use a Tailscale ACL. It lets your devices reach both boxes. It blocks traffic from one box to the other box.
- Use the server switcher (PRs 270 and 271) to change server in the app. It is off by default. Turn it on in Settings.
- Add the other server by URL in the app. Tailscale discovery (OAuth client and tag:orca) is optional. Do not set it up now.
- Log in to GitHub with gh auth login on each box.
- Log in to each Claude account with hydra login on each box.
- Keep the finnformica Claude profile on the work box. It is disabled in hydra.
- Rename orca-box later. Proposed names: orca-flow-box and orca-personal-box.
- Integrations (Slack, Discord, email and others) come later. Slack moves into the integration layer as an adapter. The Discord work stays stopped.
- GitHub calls move from the gh CLI to the GitHub API. This work is in progress.

## High-level steps

1. Move Tailscale to your personal account.
2. Buy the personal box.
3. Set up the personal box and install Orca.
4. Log in to GitHub and Claude on the personal box.
5. Connect the app to both boxes.
6. Move the personal repos to the personal box.
7. Rename the boxes.
8. Build the integration layer, then Discord and the other integrations.

## Immediate next steps

1. Create a personal Tailscale account (tailnet).
2. Join your phone and your laptop to the personal tailnet.
3. Join the work box to the personal tailnet. Run tailscale logout, then tailscale up on the box, and log in with the personal account.
4. Add the ACL that blocks box-to-box traffic. Test it with the ACL tests section before you save it.
5. Check that the app still opens on the phone and the laptop. The work box gets a new Tailscale address, so update the Orca instance URLs in the config.
6. Choose and buy the personal box. Recommended: OVH VPS-2 (about 7.55 GBP each month). Other choices: Contabo, Oracle Always Free, a home PC.
7. Tell Orca when the box is ready. Orca then writes the setup steps for the box.

## Open decisions

- The personal box provider.
- The Claude plan for SMF work: a personal subscription, an API key, or a Team plan.

## Related documents

- docs/research/hosting.md
- docs/research/integrations.md
- docs/research/dual-instance.md
- docs/research/backend.md
