# Personal Orca box for SMF Studio: hosting, database and setup

**Status:** Research report for Finn. Captured 2026-10-16. No box is ordered yet.

Written in ASD-STE100 Simplified Technical English (short sentences, active voice).

## 0. Summary

- The 2026 RAM shortage changed the market. Many cheap plans cost more now, or you cannot order them.
- Hetzner raised prices on 1 April and 15 June 2026. All Hetzner CX and CAX (cost-optimized) plans show "currently unavailable" today.
- Best pick: **OVH VPS-2** (4 vCore, 8 GB, x86, about £7.55/month with VAT). This price is a 12-month price.
- Best free pick: **Oracle Cloud Always Free A1**. The free limit is now 2 OCPU and 12 GB, not 4 and 24. Account risk and idle-reclaim risk are real.
- Best fallback: **Contabo Cloud VPS (4 vCPU, 8 GB)** for about £4-£5/month. Or use a spare PC at home for £0 hosting cost.
- Database: use **local PostgreSQL 16 on each box**, with a nightly `pg_dump` to Cloudflare R2. Do not use a shared database.

## 1. Basis for prices

- Exchange rates (mid-market, 16 Oct 2026, poundsterlinglive.com): **£1 = €1.1834**, **£1 = $1.3272**.
- All GBP values are conversions. Prices are rounded to the nearest penny.
- **UK VAT:** You are a private UK customer. A non-UK seller of a VPS (an electronic service) must charge UK VAT at 20%. Most listed prices exclude VAT. The "with VAT" column adds 20%. If SMF Studio gets VAT registration, the rules change.
- "Unconfirmed" (U) means that the price came only from a third-party site, an old page, or an estimate.

## 2. Workload sizing

| Item | RAM |
|---|---|
| 3 Claude Code agents (300-800 MB each) | 1.0-2.4 GB |
| One Chromium screenshot (peak) | 0.5 GB |
| One Vite/Astro build | 0.5-1.0 GB |
| Orca server (Bun) and Discord bot | 0.2-0.4 GB |
| PostgreSQL 16 (small) | 0.1-0.25 GB |
| OS, Tailscale | 0.3 GB |
| **Total peak** | **about 2.6-4.9 GB** |

Result: 4 GB is too tight for 3 agents. Get **8 GB**. CPU load is low, because agents mostly wait on the API. 2-4 vCPU is sufficient. Use 40 GB or more of disk for worktrees and `node_modules`.

## 3. Hosting comparison (about 2-4 vCPU, 4-8 GB)

### 3.1 VPS and IaaS (good fit: full Linux, systemd, persistent disk)

| Provider / plan | vCPU / RAM / disk | Arch | £/month excl. VAT | £/month with VAT | Promo vs renewal | Backups and snapshots | Notes |
|---|---|---|---|---|---|---|---|
| **OVH VPS-2** | 4 / 8 GB / 75 GB | x86 | £6.29 | £7.55 | Price is for a 12-month upfront term. Month-to-month price not shown (U) | Daily backup (last 24 h) included | Unlimited traffic. UK and EU locations (confirm at order). 2026 price rise on 1 Apr |
| OVH VPS-1 | 2 / 4 GB / 40 GB | x86 | £3.31 | £3.97 | Same as above | Same | 4 GB is tight |
| **Hetzner CX33** | 4 / 8 GB / 80 GB | x86 | £7.60 (€8.99, incl. IPv4) | £9.12 | No promo. Hourly billing | Backups +20% of price; snapshots per GB | **Unavailable to order now**. Locations: DE, FI |
| Hetzner CAX21 | 4 / 8 GB / 80 GB | ARM64 | Unknown (U). Was €7.99 before +33% rise | U | - | Same | **Unavailable to order now** |
| Hetzner CX23 / CAX11 | 2 / 4 GB / 40 GB | x86 / ARM | £5.06 / £5.48 (U) | £6.07 / £6.58 | - | Same | **Unavailable** |
| Hetzner CPX22 / CPX32 | 2 / 4 GB; 4 / 8 GB | x86 | £16.89 / £30.41 | £20.27 / £36.49 | - | Same | Can order. Too expensive |
| **Contabo Cloud VPS** (4 vCPU, 8 GB) | 4 / 8 GB / 100 GB | x86 | £3.72 (24-month term) | Page says price includes tax (U) | £4.65 on other terms or renewal (U) | 1 snapshot free. Auto Backup is a paid add-on (price U) | Oversold CPU, slower disk, weaker support. UK location exists |
| Netcup VPS 1000 G12.5 (x86 or ARM) | 4 / 8 GB / 128 GB | x86 or ARM64 | £12.25 (12-month term) | £14.70 (page shows €16.68 with German VAT) | 1-month term costs more (U) | Snapshots included (count U) | Prices rose in 2026. Now over budget. DE, AT, NL |
| Netcup VPS 500 G12.5 | 2 / 4 GB / 64 GB | x86 or ARM64 | £6.98 | £8.03 | Same | Same | 4 GB is tight |
| Hostinger KVM 2 | 2 / 8 GB / 100 GB | x86 | £6.99 promo | U (page has no VAT note) | **Renewal £12.99** | Weekly backup free | Pay upfront for a long term. Renewal doubles |
| Hostinger KVM 4 | 4 / 16 GB / 200 GB | x86 | £9.99 promo | U | **Renewal £24.99** | Weekly backup free | Same |
| IONOS VPS L+ | 4 / 8 GB / 240 GB | x86 | £7 for 3 months | £8.40 | **Then £22**, plus £10 setup | U | Promo is too short to be useful |
| DigitalOcean Basic | 2 / 4 GB / 80 GB; 4 / 8 GB / 160 GB | x86 | £18.08; £36.17 | £21.70; £43.40 | No promo | Backups +20% (weekly) or +30% (daily); snapshots $0.06/GB | Reliable. Over budget |
| Vultr Regular | 2 / 4 GB / 80 GB | x86 | £15.07 (U) | £18.08 | - | Backups about +20% (U) | Over budget. London location |
| Linode/Akamai Shared 4 GB | 2 / 4 GB / 80 GB | x86 | £18.08 | £21.70 | - | Backups paid (U) | Over budget. London location |
| Scaleway BASIC2-A2C-4G | 2 / 4 GB | ARM64 | £18.26, plus disk and IPv4 | £21.91+ | - | Paid | Paris, Amsterdam only. Over budget |
| AWS Lightsail | 2 / 4 GB / 80 GB; 2 / 8 GB / 160 GB | x86 | £18.08; £33.15 | £21.70; £39.78 | - | Snapshots paid | Over budget |
| AWS EC2 t4g.medium (London, on demand) | 2 / 4 GB | ARM64 | about £20.90 + IPv4 £2.75 + 30 GB EBS about £2.10 (U) | about £31 | t4g.small (2 GB) is free 750 h/month **until 31 Dec 2026** only | EBS snapshots paid | New AWS accounts get $100-$200 credits for 6 months. Expensive after that |
| Google Cloud e2-micro (free) | 0.25-2 / 1 GB | x86 | £0 | £0 | Free only in 3 US regions | - | **Too small**. Not in London |
| Google Cloud e2-medium (London) | 2 / 4 GB | x86 | about £20+ (U) | U | - | Paid | T2A (ARM) is not in London (U) |
| Azure B2pts v2 (free 12 months) | 2 / 1 GB | ARM64 | £0 for 12 months (U); then about £5.17 (U) | U | - | Paid | **Too small** (1 GB) |
| **Oracle Always Free A1** | 2 OCPU / 12 GB / up to 200 GB | ARM64 | £0 | £0 | Free | 5 volume backups free | See section 3.3 |

### 3.2 PaaS (most are a bad fit)

Orca needs: a long-lived server, a persistent disk for git worktrees and Claude Code login files, many child processes (agents, git, builds, Chromium), Postgres, and outbound websockets. systemd is useful for the agent lifecycle.

| Platform | Long-lived server? | Persistent disk? | Child processes / worktrees? | Postgres? | Cost for 4 GB | Verdict |
|---|---|---|---|---|---|---|
| **Vercel** | No. Functions only. Max 300 s on Hobby, 800-1800 s on Pro | No | No | External only | - | **Bad fit**. Serverless only. Agent runs last longer than the time limit. The disk does not persist |
| **Netlify** | No. Functions run in an ephemeral runtime | No | No | External only | - | **Bad fit**. Same reasons as Vercel |
| **Render** free | Spins down after 15 min idle | No disk on free | Container only | Paid add-on | Free tier is useless here. Paid 4 GB plan price U | **Bad fit** on free. Paid works but is over budget |
| **Railway** | Yes (container) | Yes (volume, $0.15/GB-month) | Yes, inside one container. No systemd | Yes (add-on, billed by use) | RAM $10/GB-month, so about £15-£30+ | Possible, but over budget. Usage billing is hard to predict |
| **Fly.io** | Yes (Machine) | Yes (volume, $0.15/GB-month) | Yes, inside the Machine. No systemd | Self-run or paid | about £21.72 (shared-cpu-2x, 4 GB, London) | Possible, but over budget |

### 3.3 Oracle Always Free: details and risks

- Free limit (official docs, checked at report time): 1,500 OCPU hours and 9,000 GB hours per month. This is **2 OCPU and 12 GB** in total. Oracle cut it from 4 OCPU and 24 GB in mid-2026.
- 200 GB block storage, 5 volume backups, 10 TB/month egress.
- **Idle reclaim:** Oracle can reclaim an instance if, for 7 days, the 95th-percentile CPU is below 20%, network is below 20%, **and** memory is below 20% (A1 only). An Orca box that waits most of the day can meet all three. To decrease the risk, upgrade the account to Pay As You Go (PAYG) and set a budget alert. Reports say PAYG accounts are not reclaimed, but this is not an official statement (U).
- **Capacity:** Popular regions (for example London) often show "Out of capacity". You must try again many times.
- **Account risk:** Users report suspended or terminated free accounts with no support access. Keep all backups off Oracle.
- ARM64 only. See section 6.4. ARM is not a problem for this stack.

### 3.4 Home option

| Option | Purchase (U) | Power cost (U) | Notes |
|---|---|---|---|
| Old laptop or spare PC | £0 | about £1-£3/month | Best value. Has a built-in battery (laptop) |
| Mini PC (Intel N100, 16 GB) | about £150-£250 | about £1.50/month | RAM prices are high in 2026 |
| Raspberry Pi 5, 8 GB | from $125 (about £94). Maybe higher after the April 2026 rise | about £0.80/month | Use an NVMe HAT, not an SD card |

Power cost assumes about 4-15 W and about 26p/kWh. This is an estimate.
- Pros: no monthly fee, much RAM, all data stays with you.
- Cons: home broadband and power cuts stop the box. You must do all hardware repair. Tailscale works behind home NAT, so you need no open ports.

## 4. Recommendation

| Rank | Box | £/month (with VAT) | Why |
|---|---|---|---|
| **1. Best pick** | **OVH VPS-2** (4 vCore, 8 GB, 75 GB, x86) | about £7.55 (12-month term) | 8 GB in budget. x86, so no ARM risk. Daily backup included. Large EU provider with UK presence. Unlimited traffic |
| **2. Fallback** | **Contabo Cloud VPS** (4 vCPU, 8 GB) | about £3.72-£4.65 (U) | Cheapest 8 GB. Performance and support are weaker, but this load is light. **Or** a spare home PC for £0 |
| **3. Best free** | **Oracle Always Free A1** (2 OCPU, 12 GB) | £0 | Most RAM for £0. But: idle reclaim, capacity problems, account risk. Use it only with off-site backups and a PAYG upgrade |

Watch list: if Hetzner CX33 or CAX21 becomes available again (about £9/month with VAT), it is a good choice. It has hourly billing, a good API, and cloud firewalls. Existing Hetzner servers keep their old prices. A resize uses the new prices.

Do not use: Vercel, Netlify, Render free (serverless or sleeping, no disk). Do not use GCP or Azure free VMs (1 GB is too small).

## 5. Database

### 5.1 Local Postgres on the same box

- Cost: **£0 extra**. Postgres 16 is in Ubuntu 24.04 `main` (x86 and ARM64).
- RAM: about 100-250 MB at this size (default `shared_buffers` = 128 MB).
- Disk: under 1 GB data, plus about 1 GB WAL. Reserve 5 GB.
- Latency: under 1 ms (Unix socket). No cold start.
- Session advisory locks, `LISTEN/NOTIFY`, and long sessions all work. This matters if the Orca bridge lock uses a session lock.

### 5.2 Managed options

| Service | Free storage | Compute on free | Cold start / pause | Backups on free | Price after free | Fit for Orca |
|---|---|---|---|---|---|---|
| Neon | 1 GB per project (20 GB total) | 100 CU-hours/month | Suspends after 5 min idle. Cannot disable on free. Wake-up is about 0.5-1 s (U) | 6 h restore history, 1 snapshot | $0.106/CU-hour + $0.35/GB-month | **Poor.** A 5-min poll and a Discord bot keep it awake. 0.25 CU x 730 h = 182 CU-h. That is more than 100, so compute suspends mid-month |
| Supabase | 500 MB | Shared CPU, 500 MB RAM | Pauses after 1 week inactive | **No automatic backups** | $25/month (Pro) | Poor. No backups. 500 MB limit is close |
| Railway Postgres | No free tier (trial credit) | Usage based | No sleep | Volume only | about $5-$10/month (U) | Over budget for no gain |
| Aiven free | Small free plan (limits U) | Single node | Free services can be powered off when idle (U) | Limited (U) | Paid from about $20+ (U) | Not confirmed. Not needed |
| Crunchy Bridge | None | - | - | Yes | from about $35/month (U) | Over budget |
| Xata | Free tier (limits U) | U | U | U | U | Not confirmed |

Other points:
- Latency from an EU VPS to a managed DB in the same city is about 1-5 ms per query (U). Across regions it is about 10-30 ms. Orca makes many small queries, so this adds up.
- Poolers (PgBouncer in transaction mode) break session advisory locks and `LISTEN/NOTIFY`. You must use the direct connection.
- Lock-in is low for all of them (plain Postgres, `pg_dump` works). Branching (Neon) is useful for apps, but Orca does not need it.

### 5.3 Shared database for both Orca instances: no

| Factor | Effect of a shared DB |
|---|---|
| Separation goal | It creates a direct link between the work server and personal infra. That is what you want to avoid |
| Data mixing | Work and SMF transcripts, workstreams and notifications go into one store. A work audit could reach SMF data, and SMF data could reach work |
| Credentials | The work box would hold credentials to a personal third party (or the reverse). Agents run with wide permissions, so any agent could read them |
| Orca design | Each instance has its own primary bridge lock, its own orchestrator and its own repos. Shared tables can cause lock conflicts and mixed state. You would need schema-per-instance, which gives no benefit |
| Availability | One DB outage stops both boxes |
| Cost | A managed DB that is always on costs money. Two local DBs cost £0 |

### 5.4 Decision

| Option | Pros | Cons |
|---|---|---|
| **Per-instance local Postgres (recommended)** | £0. No cold start. Full feature set. Full separation | You must make backups yourself |
| Per-instance managed DB | Managed backups (on paid plans) | Free tiers suspend or have no backups. Paid costs £20+/month. Adds latency |
| Shared DB | One place to look | Breaks separation. Lock conflicts. Single point of failure |

Backup plan: a nightly `pg_dump -Fc`, compressed with `zstd`, sent to off-site storage. Keep 14 daily and 8 weekly copies. Also back up `/etc/orca`, the systemd units and the repo list. Do not back up worktrees (git has them).

| Backup target | Price | Cost for under 5 GB | Notes |
|---|---|---|---|
| **Cloudflare R2** | $0.015/GB-month (£0.011). First 10 GB free. Free egress | **£0** | Already used for SMF. Use a token for one bucket only |
| Backblaze B2 | $6.95/TB-month (£5.24). First 10 GB free | **£0** | Good second copy |
| Hetzner Storage Box BX11 | €3.20 (£2.70) excl. VAT for 1 TB (U for 2026) | £3.24 with VAT | Good with `restic` or `borg` over SSH. Too large for this need |

## 6. Further areas

### 6.1 Two Orca instances on Tailscale

- Names: `orca-flow-box` (work, AWS) and `orca-personal-box` (personal).
- Tag both boxes `tag:orca`. Tagged devices are not part of `autogroup:member`. Their key expiry is off by default.
- Tailscale is deny-by-default. The grant below lets your user devices reach both boxes. It does not let a box reach the other box, because no grant has `tag:orca` as a source.

```json
{
  "tagOwners": { "tag:orca": ["autogroup:admin"] },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["tag:orca"], "ip": ["*"] }
  ],
  "ssh": [
    { "action": "check", "src": ["autogroup:member"], "dst": ["tag:orca"], "users": ["orca"] }
  ]
}
```

- Discovery: make an OAuth client (trust credential) with only the `devices:core:read` scope. It can list devices. It cannot change, tag or remove them.
- Caution: a work server in your personal tailnet is still a link at the network level. Also, a discovery token on one box can see the other box's name and IP. If your employer has rules about this, a separate work tailnet is cleaner. The Tailscale client can switch between tailnets.

### 6.2 Claude Code login on the personal box

- Use your **personal** Claude subscription (Pro or Max). Do not use the work account or work API key.
- Log in with the unmodified `claude` CLI, through Anthropic's own sign-in flow. Over SSH, `claude` prints a URL. Open it on your laptop. `claude setup-token` makes a long-lived token for headless use.
- Terms (Claude Code legal page, checked at report time): OAuth is "designed to support ordinary use of Claude Code". Plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". Run the official binary yourself, for yourself. That is in scope. Do not copy the token into other tools. Do not let other people use it.
- Uncertainty 1: in May 2026 Anthropic announced a separate credit pool for headless `claude -p` use. Reports say Anthropic paused this change. It can return with notice.
- Uncertainty 2: SMF Studio is a business. Consumer plans may not be the correct terms for business use. For certainty, use an API key (Commercial Terms) or a Team plan.

### 6.3 Security hardening (Tailscale-only VPS)

1. Provider firewall: block all inbound traffic. Tailscale works with outbound traffic only (NAT traversal or DERP relay).
2. `ufw default deny incoming`; `ufw allow in on tailscale0`.
3. Use Tailscale SSH, or bind `sshd` to the Tailscale IP only. Disable password login and root login.
4. fail2ban is not necessary when no port is public.
5. Enable `unattended-upgrades` with automatic security updates and a nightly reboot window.
6. Postgres: `listen_addresses = 'localhost'`.
7. Run Orca and agents as user `orca` with **no sudo**. Agents run with wide permissions, so keep root out of their reach.
8. Keep secrets in `/etc/orca/orca.env` (mode 600). Use fine-grained GitHub tokens for SMF repos only. Keep no work secrets on this box.
9. Turn on 2FA for the provider, Tailscale, GitHub, Cloudflare and Anthropic accounts.

### 6.4 ARM64 compatibility

| Component | Linux ARM64 | Source |
|---|---|---|
| Claude Code CLI | Yes (linux-arm64 and musl) | code.claude.com setup docs |
| Bun | Yes (Linux ARM64 glibc and musl) | bun.com installation docs |
| Playwright Chromium | Yes on Debian 12/13 and Ubuntu 22.04/24.04/26.04 arm64. Use the bundled `chromium`. The `chrome` channel install fails on arm64 | playwright.dev, GitHub issue #1515 |
| PostgreSQL 16 | Yes (Ubuntu 24.04 `main`, arm64) | Ubuntu archive |

Result: ARM64 is safe for this stack. x86 is still simpler for unknown npm native modules.

## 7. Setup checklist for OVH VPS-2 (top pick)

1. Order VPS-2 with **Ubuntu 24.04 LTS** (Postgres 16 is native). Choose a UK or EU location. Add your SSH key.
2. In the OVH control panel, enable the network firewall. Block all inbound traffic except, for now, SSH from your IP.
3. Log in. Run `apt update && apt full-upgrade`. Set the hostname to `orca-personal-box`. Set the timezone to Europe/London.
4. Install Tailscale. Run `tailscale up --ssh --advertise-tags=tag:orca --hostname=orca-personal-box`. Apply the ACL from section 6.1.
5. Test SSH over Tailscale. Then remove the public SSH rule. Set `ufw` as in section 6.3. Disable password login in `sshd`.
6. Add 4 GB of swap (`/swapfile`). This protects builds and Chromium from the OOM killer.
7. Create user `orca` (no sudo). Install `git`, `gh`, `zstd`, `build-essential`, `unattended-upgrades`.
8. As `orca`: install Bun (`curl -fsSL https://bun.sh/install | bash`). Install Node LTS if builds need it. Run `bunx playwright install --with-deps chromium` (run the deps step with an admin account).
9. Install Postgres 16 (`apt install postgresql-16`). Create role and database `orca`. Keep `listen_addresses = 'localhost'`.
10. As `orca`: install Claude Code. Run `claude` and log in with your personal subscription. Run `gh auth login` with a personal account or a fine-grained token for SMF repos only.
11. Clone Orca. Write `/etc/orca/orca.env` (mode 600): DB URL, Discord bot token, Tailscale OAuth client (`devices:core:read`), instance name.
12. Make systemd units: `orca.service` (Restart=always, User=orca, MemoryMax for safety), `orca-poll.timer` (every 5 min) if Orca does not schedule the poll itself, and `orca-backup.timer` (nightly).
13. Backup script: `pg_dump -Fc orca | zstd` and upload to Cloudflare R2 with `rclone`. Use a bucket-scoped token. Keep 14 daily and 8 weekly copies. Do a test restore once.
14. Enable `unattended-upgrades`. Set a calendar reminder for the OVH 12-month renewal date and price.
15. Do a final check: `ss -tlnp` must show no public listener except Tailscale. Run one agent, one build and one screenshot. Check memory with `free -h`.

## 8. Sources

(all accessed 2026-10-16 unless noted)

- Exchange rates: https://www.poundsterlinglive.com/history/GBP-EUR-2026 and https://www.poundsterlinglive.com/history/GBP-USD-2026
- Hetzner cost-optimized page ("currently unavailable"): https://www.hetzner.com/cloud/cost-optimized
- Hetzner June 2026 price rise: https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do
- Hetzner availability and CX33/CPX32 prices (checked 7-8 Sep 2026): https://www.vincentschmalbach.com/hetzner-cheap-cloud-unavailable-price-increases/
- Hetzner price analysis (Aug 2026): https://findstack.com/resources/hetzner-price-increase-2026
- Multi-provider price snapshot (Aug 2026): https://kimmo.suominen.com/stuff/cpc-2026-08.txt
- Oracle Always Free limits and idle rule: https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm
- Oracle 2026 changes and PAYG notes: https://terminalbytes.com/oracle-cloud-free-tier-changes-2026 ; https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- OVH UK VPS: https://www.ovhcloud.com/en-gb/vps/ ; 2026 rise: https://next.ink/225720/ovhcloud-augmente-fortement-le-prix-de-ses-vps-2026-et-ipv4/
- Netcup: https://www.netcup.com/en/server/vps and https://www.netcup.com/en/server/arm-server
- Contabo: https://contabo.com/en/vps/ ; price history: https://pricingsaas.com/companies/contabo.main/diffs/2026W25
- Hostinger UK: https://www.hostinger.com/uk/vps-hosting
- IONOS UK: https://www.ionos.co.uk/servers/vps
- DigitalOcean: https://www.digitalocean.com/pricing/droplets
- Vultr (third-party, U): https://vpsbenchmarks.com/hosters/vultr/plans/regular_4gb_2cores
- Scaleway June 2026 prices: https://www.scaleway.com/en/blog/a-transparent-update-on-scaleway-pricing/
- AWS Lightsail (third-party, Jul-Sep 2026): https://onedollarvps.com/pricing/aws-lightsail-pricing
- AWS t4g.small free until 31 Dec 2026: https://aws.amazon.com/ec2/instance-types/t4/
- AWS t4g.medium London (third-party, U): https://www.devzero.io/instances/aws/t4g.medium
- AWS free plan credits: https://aws.amazon.com/free
- Azure free VMs and UK South prices (U): https://www.azurespeed.com/AzureVmPricing/Regions/uksouth
- GCP free tier (U): https://agentdeals.dev/gcp-free-tier-2026
- Fly.io: https://docs.fly.io/about/pricing
- Railway (third-party): https://www.budgetforge.dev/tools/railway-pricing-2026
- Render free: https://render.com/docs/free
- Vercel limits: https://vercel.com/docs/functions/limitations
- Netlify functions: https://docs.netlify.com/build/functions/overview/
- Raspberry Pi prices: https://www.omgubuntu.co.uk/2026/02/raspberry-pi-annouce-more-price-rises ; https://www.gigazine.net/gsc_news/en/20260402-raspberry-pi-price-increases
- Neon free limits: https://neon.com/faqs/free-plan-limits-and-quotas ; https://neon.com/pricing
- Supabase: https://supabase.com/pricing
- Crunchy Bridge (third-party, U): https://www.costbench.com/software/database-as-service/crunchy-bridge/
- Cloudflare R2: https://developers.cloudflare.com/r2/pricing/
- Backblaze B2: https://www.backblaze.com/cloud-storage/pricing
- Hetzner Storage Box (third-party, U): https://www.whtop.com/compare/hetzner,webtropia
- Tailscale grants: https://tailscale.com/kb/1324/grants ; scopes: https://tailscale.com/docs/reference/trust-credentials
- Claude Code terms: https://code.claude.com/docs/en/legal-and-compliance ; headless billing pause (third-party): https://tryuncle.com/learn/claude-code/how-much-does-claude-code-cost
- Claude Code ARM64: https://code.claude.com/docs/en/getting-started/installation
- Bun: https://bun.com/docs/installation
- Playwright: https://playwright.dev/docs/intro ; arm64 chrome issue: https://github.com/microsoft/playwright-mcp/issues/1515
