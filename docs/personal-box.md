# The personal Orca box

> This document uses ASD-STE100 Simplified Technical English (STE).
> Status: 17 October 2026. The box is ordered and delivered. Setup has not started yet.
> Values in `<angle brackets>` are yours. Do not commit them to this repo, because this repo is
> public. Where this guide needs a stand-in for a secret, it uses a placeholder in capital letters,
> for example `VPS_NAME`.

This guide has three parts:

1. [What the box is, and why it is separate](#what-the-box-is-and-why-it-is-separate)
2. [The box: provider and plan](#the-box-provider-and-plan)
3. [Restore from an OVH backup](#restore-from-an-ovh-backup)
4. [Setup runbook: Phase 0 to Phase 8](#setup-runbook-phase-0-to-phase-8)

For the general Orca setup steps (not specific to this box), see [SETUP.md](SETUP.md). For the
decision that led to this box, see [research/plan.md](research/plan.md) and
[research/hosting.md](research/hosting.md).

---

## What the box is and why it is separate

This box runs a **second, separate Orca instance**, for personal repos. It is not a second node of
the work instance. The two instances share no data and no process:

- **Its own Orca bridge and orchestrator.** The code is the same Orca checkout, but each instance
  runs its own `orca.service` and its own orchestrator conversation.
- **Its own Postgres.** Each instance has a local database on its own box. There is no shared
  database between the work box and this box. A database outage on one box cannot affect the other,
  and a bug or a leak on one box cannot reach the other box's chat history, logins or config.
- **No network link to the work box.** Both boxes join **one personal Tailscale tailnet**, so your
  phone and laptop can reach each box directly. The tailnet access control list (ACL) lets your
  devices reach each box, but it does not let one box reach the other box. [Phase 1](#phase-1-tailscale-and-the-firewall)
  sets this ACL, and [Phase 8](#phase-8-checks) checks it.
- **Previews are off.** Previews exist so a worker can run a repo's own dev server for review. The
  personal repos this box runs do not need that: they deploy their preview and staging
  environments on Cloudflare. Turning previews off also keeps this 8 GB box within its memory
  budget, because a preview build is one more process competing for RAM.

## The box: provider and plan

| Fact | Value |
| --- | --- |
| Provider | OVH |
| Plan | VPS-2 2027 |
| Location | UK (Erith) |
| vCore | 4 |
| RAM | 8 GB |
| Disk | 75 GB NVMe |
| OS | Ubuntu 26.04 |
| Backup | OVH Automated Backup Standard (on) |
| Price | about £8.88 a month, with VAT |
| Term | monthly |
| Ordered | 2026-10-17 |

See [research/hosting.md](research/hosting.md) for how this plan was chosen, and
[research/plan.md](research/plan.md) for the wider dual-instance plan that this box is part of.

## Restore from an OVH backup

OVH Automated Backup Standard keeps one daily image of the disk. Use a restore only when the box is
in a bad state that you cannot fix another way: a restore replaces the whole disk with the state at
the restore point, so work done after that point is lost.

1. Find the box's OVH service name in the OVH control panel (its URL and its **VPS** page show it).
   This guide calls it `VPS_NAME`. It is not the Tailscale name or the Linux hostname.
2. List the restore points. Call the OVH API at `eu.api.ovh.com`, with your OVH API credentials:
   ```
   GET /vps/VPS_NAME/automatedBackup/restorePoints
   ```
   You can also run this call from the **API** page of the OVH control panel, with no extra setup.
3. Pick a restore point from the result.
4. Start the restore:
   ```
   POST /vps/VPS_NAME/automatedBackup/restore
   ```
   Pass the restore point in the request body, in the form that the API page shows.
5. Wait for the restore to finish. The box reboots during the restore.
6. After the restore, sign in and run the [Phase 8 checks](#phase-8-checks) again.

**Emergency access.** If Tailscale and SSH are both unreachable, open the **KVM** console for this
box in the OVH control panel. It shows the box's screen and keyboard in the browser, over no
network path of its own. Sign in as `ubuntu`, with the password from [Phase 0](#phase-0-first-login-and-the-orca-user).

---

## Setup runbook: Phase 0 to Phase 8

This runbook sets up Orca on the box above. Phases run in order. Do not start a phase before the
checks of the phase before it pass.

Each step has one tag:

- **[HAND]**: a person must do this step. Usually it is a browser login, a device code, or a
  console in a web page.
- **[SCRIPT]**: copy the command into a shell, or put it in a script. It needs no person.

Commands with `sudo` run as the user `orca` (after Phase 0) or `ubuntu` (in Phase 0).

### Values you need while you run this

| Name | Where it comes from |
| --- | --- |
| Public IPv4 of the box | The order email from OVH. This guide calls it `<ipv4>`. |
| Box hostname and Tailscale name | Your own choice, made once in Phase 0 and Phase 1. Do not write it in this repo: [Phase 7](#phase-7-https-with-tailscale-serve) explains why it becomes public on its own. |
| Tailnet DNS suffix | Tailscale admin console → DNS. This guide calls it `<tailnet>.ts.net`. |
| Tailnet IPv4 of the box | `tailscale ip -4`, in Phase 1. This guide calls it `<ts-ip>`. |
| Postgres password of the role `orca` | You make it in step 2.10. This guide calls it `<db-pw>`. |
| GitHub account for this box | `finnformica` |
| Claude accounts | One hydra profile for each personal Claude account you want to use. |

### Memory budget for 8 GB

| Item | Limit |
| --- | --- |
| Each agent run | 2–3 GB, no swap |
| The orchestrator | 4 GB (fixed in the code) |
| All agent runs together | 5 GB, on the `orca` user's own slice |
| The bridge, and the processes it starts directly (`git`, `gh`, the repo's own check command) | 3 GB |
| Postgres | protected from the OOM killer first |
| Tailscale | protected from the OOM killer second |
| Swap | 4 GB, used only when RAM is almost full |

### Phase 0: first login and the `orca` user

Do Phase 0 over public SSH, as the user `ubuntu`.

1. **[HAND]** Find the public IPv4 address and the password for `ubuntu` in the OVH order email.
2. **[HAND]** On your laptop, connect to the box:
   ```sh
   ssh ubuntu@<ipv4>
   ```
   If the box asks you to change the password, change it. Keep the new password in your password
   manager. The OVH KVM console (emergency access) needs it.
3. **[SCRIPT]** Get the package lists:
   ```sh
   sudo apt-get update
   ```
4. **[SCRIPT]** Install all updates:
   ```sh
   sudo apt-get -y full-upgrade
   ```
5. **[SCRIPT]** Set the hostname. Put your own chosen name in place of `<box-name>`:
   ```sh
   sudo hostnamectl set-hostname <box-name>
   ```
6. **[SCRIPT]** Stop cloud-init from a reset of the hostname at the next boot:
   ```sh
   echo 'preserve_hostname: true' | sudo tee /etc/cloud/cloud.cfg.d/99-orca-hostname.cfg
   ```
7. **[SCRIPT]** Optional. Set the time zone, because the backup timer in Phase 6 uses local time:
   ```sh
   sudo timedatectl set-timezone Europe/London
   ```
8. **[SCRIPT]** Make the user `orca`:
   ```sh
   sudo adduser --disabled-password --gecos "" orca
   ```
9. **[SCRIPT]** Give `orca` sudo with no password:
   ```sh
   echo 'orca ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-orca
   ```
10. **[SCRIPT]** Set the file mode:
    ```sh
    sudo chmod 440 /etc/sudoers.d/90-orca
    ```
11. **[SCRIPT]** Check the sudoers files. The result must be "parsed OK", or show no error:
    ```sh
    sudo visudo -c
    ```
12. **[SCRIPT]** Make the Orca directory:
    ```sh
    sudo install -d -o orca -g orca /opt/orca
    ```
13. **[SCRIPT]** Restart the box if the upgrade installed a new kernel:
    ```sh
    [ -f /var/run/reboot-required ] && sudo reboot
    ```

### Phase 1: Tailscale and the firewall

1. **[HAND]** In the Tailscale admin console of your **personal** tailnet, open **DNS**. Turn on
   **MagicDNS**. Turn on **HTTPS Certificates**, because Phase 7 needs it.
2. **[HAND]** In **Access controls**, add a tag for Orca boxes, a grant that lets your devices reach
   a tagged box, and an SSH rule. Merge these with your current policy. Do not remove the rules for
   your other devices. Tag the work box the same way, so one rule covers both boxes. No rule here
   lets a box reach another box:
   ```jsonc
   {
     "tagOwners": { "tag:orca": ["autogroup:admin"] },
     "grants": [
       { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] },
       { "src": ["autogroup:member"], "dst": ["tag:orca"], "ip": ["tcp:22", "tcp:443", "tcp:8787"] }
     ],
     "ssh": [
       { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:orca"], "users": ["orca", "ubuntu"] }
     ],
     "tests": [
       { "src": "<your-login>@gmail.com", "accept": ["tag:orca:443", "tag:orca:8787"] },
       { "src": "tag:orca", "deny": ["tag:orca:8787", "tag:orca:22", "tag:orca:443"] }
     ]
   }
   ```
3. **[HAND]** Save the policy. The **tests** block must pass before the console saves it.
4. **[SCRIPT]** On the box, install Tailscale:
   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   ```
   If the script stops with "unsupported OS version" for Ubuntu 26.04, add the Tailscale apt repo
   for `noble` by hand (see the Tailscale Ubuntu install page), then install `tailscale`.
5. **[HAND]** Start Tailscale. Turn on Tailscale SSH, and ask for the tag. Put your chosen name in
   place of `<box-name>`:
   ```sh
   sudo tailscale up --ssh --hostname=<box-name> --advertise-tags=tag:orca
   ```
   The command shows a login URL. Open it in a browser. Log in with your **personal** Tailscale
   account. As an alternative, make a tagged auth key in the admin console, and add
   `--auth-key=<tskey-auth-…>` to the command, so this step needs no browser.
6. **[SCRIPT]** Record the tailnet IPv4 address. You need it in step 4.3:
   ```sh
   tailscale ip -4
   ```
7. **[HAND]** On your laptop, connect over Tailscale SSH as `orca`:
   ```sh
   tailscale ssh orca@<box-name>
   ```
   **Do not continue until this works.** Use this session for every step after this one. Close the
   public SSH session.
8. **[SCRIPT]** Make sure that `ufw` is installed:
   ```sh
   sudo apt-get install -y ufw
   ```
9. **[SCRIPT]** Block all incoming traffic by default:
   ```sh
   sudo ufw default deny incoming
   ```
10. **[SCRIPT]** Allow all outgoing traffic:
    ```sh
    sudo ufw default allow outgoing
    ```
11. **[SCRIPT]** Allow all traffic that comes in on the tailnet:
    ```sh
    sudo ufw allow in on tailscale0
    ```
12. **[SCRIPT]** Optional. Allow direct WireGuard connections. Without this rule, Tailscale can use
    a relay, which is slower:
    ```sh
    sudo ufw allow 41641/udp
    ```
13. **[SCRIPT]** Turn on the firewall:
    ```sh
    sudo ufw --force enable
    ```
14. **[SCRIPT]** Check the rules. Only `tailscale0` (and `41641/udp`, if you added it) must show:
    ```sh
    sudo ufw status verbose
    ```
15. **[SCRIPT]** Stop password login and root login in OpenSSH. Use the prefix `00-`, because
    OpenSSH reads the **first** value it finds, and `50-cloud-init.conf` can set
    `PasswordAuthentication yes`:
    ```sh
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/00-orca.conf
    ```
16. **[SCRIPT]** Apply the change:
    ```sh
    sudo systemctl reload ssh
    ```
17. **[SCRIPT]** Check that the values apply. The result must show `no` for all three settings:
    ```sh
    sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)'
    ```
18. **[HAND]** On your laptop, check that public SSH is closed. The command must time out:
    ```sh
    nc -vz -w 5 <ipv4> 22
    ```
19. **[HAND]** Optional. The OVH network firewall is a second layer. `ufw` is already sufficient. If
    you turn on the OVH firewall, allow established TCP and UDP replies, or Tailscale cannot
    connect.

Emergency access: if Tailscale stops, use the **KVM** console in the OVH control panel. Sign in as
`ubuntu`, with the password from step 0.2.

### Phase 2: system (swap, packages, Postgres, OOM)

**Swap**

1. **[SCRIPT]** Make a 4 GB swap file:
   ```sh
   sudo fallocate -l 4G /swapfile
   ```
2. **[SCRIPT]** Set the file mode:
   ```sh
   sudo chmod 600 /swapfile
   ```
3. **[SCRIPT]** Format the file as swap:
   ```sh
   sudo mkswap /swapfile
   ```
4. **[SCRIPT]** Turn on the swap:
   ```sh
   sudo swapon /swapfile
   ```
5. **[SCRIPT]** Turn on the swap at each boot:
   ```sh
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
6. **[SCRIPT]** Use swap only when RAM is almost full:
   ```sh
   echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-orca-swap.conf
   ```
7. **[SCRIPT]** Apply the setting:
   ```sh
   sudo sysctl --system
   ```

An agent run cannot use swap, by design. Swap here protects the bridge, Postgres and Tailscale, not
agent runs.

**Packages**

8. **[SCRIPT]** Install the packages:
   ```sh
   sudo apt-get install -y git jq curl unzip build-essential postgresql postgresql-contrib rclone
   ```

**Postgres**

9. **[SCRIPT]** Show the cluster. Record the version (probably `18`) and the name (`main`):
   ```sh
   pg_lsclusters
   ```
10. **[SCRIPT]** Make a random password for the role `orca`. Keep it in your password manager:
    ```sh
    openssl rand -hex 16
    ```
11. **[SCRIPT]** Make the role. Put the password from step 10 in place of `<db-pw>`:
    ```sh
    sudo -u postgres psql -c "CREATE ROLE orca LOGIN PASSWORD '<db-pw>'"
    ```
12. **[SCRIPT]** Make the database:
    ```sh
    sudo -u postgres psql -c "CREATE DATABASE orca OWNER orca"
    ```
13. **[SCRIPT]** Check that Postgres listens on `localhost` only. The result must be `localhost`. Do
    not change `listen_addresses` or `pg_hba.conf`:
    ```sh
    sudo -u postgres psql -Atc "SHOW listen_addresses"
    ```

**OOM protection**

14. **[SCRIPT]** Check the OOM value of the Postgres cluster unit. Put the version from step 9 in
    place of `<ver>`:
    ```sh
    systemctl show postgresql@<ver>-main -p OOMScoreAdjust
    ```
15. **[SCRIPT]** Do this step only if step 14 does not show `-900`. Put the value on
    `postgresql@.service`, which is the unit that runs the server. Do not put it on
    `postgresql.service`, which is only a wrapper:
    ```sh
    sudo mkdir -p /etc/systemd/system/postgresql@.service.d && printf '[Service]\nOOMScoreAdjust=-900\n' | sudo tee /etc/systemd/system/postgresql@.service.d/90-orca-oom.conf
    ```
    Then run `sudo systemctl daemon-reload` and `sudo systemctl restart postgresql`.
16. **[SCRIPT]** Protect Tailscale too. Do not restart `tailscaled` now, because your SSH session
    goes through it. The value applies at the restart in step 18:
    ```sh
    sudo mkdir -p /etc/systemd/system/tailscaled.service.d && printf '[Service]\nOOMScoreAdjust=-800\n' | sudo tee /etc/systemd/system/tailscaled.service.d/90-orca-oom.conf
    ```
17. **[SCRIPT]** Recommended. Put one memory limit on all agent runs together. Agent runs are user
    scopes of `orca`, so they sit in `user-<uid>.slice`. With this limit, the kernel kills an agent
    before it kills Postgres, Tailscale or the bridge. The command keeps the value after a reboot.
    Note: your interactive `orca` SSH sessions sit in this slice too:
    ```sh
    sudo systemctl set-property "user-$(id -u orca).slice" MemoryMax=5G
    ```
18. **[SCRIPT]** Restart the box. Then connect again with `tailscale ssh orca@<box-name>`:
    ```sh
    sudo reboot
    ```

### Phase 3: Bun, Claude CLI, hydra, `gh`

Steps 1–3 need `sudo`. Steps 4–12 run as `orca`, with no `sudo`.

1. **[SCRIPT]** Get the key of the GitHub CLI apt repo:
   ```sh
   sudo curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
   ```
2. **[SCRIPT]** Add the repo:
   ```sh
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list
   ```
3. **[SCRIPT]** Install `gh`:
   ```sh
   sudo apt-get update && sudo apt-get install -y gh
   ```
4. **[SCRIPT]** Install Bun:
   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```
5. **[SCRIPT]** Install the Claude CLI. Pin the version, the same version the work box runs. Read
   [SETUP.md](SETUP.md) §3 (the `--bare` warning) before you use a newer version:
   ```sh
   curl -fsSL https://claude.ai/install.sh | bash -s 2.1.296
   ```
6. **[SCRIPT]** Put the CLI directories on the `PATH` of bash:
   ```sh
   printf '\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"\n' >> ~/.bashrc
   ```
7. **[SCRIPT]** Stop automatic updates of Claude Code in your shell. Step 4.4 does the same for the
   service:
   ```sh
   echo 'export DISABLE_AUTOUPDATER=1' >> ~/.bashrc
   ```
8. **[SCRIPT]** Get hydra. The repo is public:
   ```sh
   git clone https://github.com/finnformica/claude-hydra ~/.local/share/claude-hydra
   ```
9. **[SCRIPT]** Install hydra and its `claude` shim. `HYDRA_RC` is necessary, because the default is
   `~/.zshrc` and the shell of the box is bash:
   ```sh
   HYDRA_RC=~/.bashrc ~/.local/share/claude-hydra/install.sh --shim
   ```
   Result: `~/.local/bin/hydra` → `~/.local/share/claude-hydra/hydra`, and
   `~/.hydra/bin/claude` → `~/.local/share/claude-hydra/claude-shim`.
10. **[SCRIPT]** Load the new shell settings:
    ```sh
    exec bash -l
    ```
11. **[SCRIPT]** Check the shim. It must be installed and first on `PATH`:
    ```sh
    hydra doctor
    ```
12. **[SCRIPT]** Check the versions:
    ```sh
    bun --version && claude --version && gh --version
    ```

### Phase 4: Orca install and config (previews off, memory caps)

1. **[SCRIPT]** Clone Orca. The repo is public, so you do not need a GitHub login for this step:
   ```sh
   git clone https://github.com/finnformicaflow/orca.git /opt/orca
   ```
2. **[SCRIPT]** Get the tailnet address again, the same value as step 1.6:
   ```sh
   tailscale ip -4
   ```
3. **[SCRIPT]** Write `.env` **before** you run `bootstrap.sh`. Put your values in place of
   `<ts-ip>` and `<db-pw>`. The file has no preview values, no Slack token and no Tailscale OAuth
   values:
   ```sh
   printf '%s\n' 'ORCA_DEV_ROOT=/opt' 'ORCA_INSTANCE=personal' 'ORCA_BIND=127.0.0.1,<ts-ip>' 'ORCA_DATABASE_URL=postgres://orca:<db-pw>@localhost:5432/orca' 'ORCA_TEST_DATABASE_URL=postgres://orca:<db-pw>@localhost:5432/postgres' > /opt/orca/.env && chmod 600 /opt/orca/.env
   ```
4. **[SCRIPT]** Add a drop-in for the bridge **before** `bootstrap.sh` starts it. It sets the memory
   limit for this 8 GB box, and stops Claude Code updates inside agent runs:
   ```sh
   sudo mkdir -p /etc/systemd/system/orca.service.d && printf '[Service]\nMemoryMax=3G\nEnvironment=DISABLE_AUTOUPDATER=1\n' | sudo tee /etc/systemd/system/orca.service.d/90-personal-box.conf
   ```
5. **[SCRIPT]** Run the bootstrap. It installs dependencies, builds the UI, turns on lingering for
   `orca` (the per-run memory caps need it), keeps your `.env`, installs and starts `orca.service`,
   and installs the auto-deploy timer:
   ```sh
   /opt/orca/deploy/bootstrap.sh
   ```
6. **[SCRIPT]** The first start seeds the work repos from the checked-in config. Keep a copy of the
   seed for reference, before you replace it in step 10:
   ```sh
   curl -s http://127.0.0.1:8787/api/config/document > ~/orca-config.seed.json
   ```
7. **[HAND]** Clone each personal repo under `/opt`. Do steps 5.1–5.3 first if a repo is private:
   ```sh
   git clone https://github.com/finnformica/<repo>.git /opt/<repo>
   ```
8. **[HAND]** Write the personal config document to `~/orca-config.personal.json`. Use the template
   below. Add one entry in `repos` for each repo from step 7. The write in step 10 needs one repo or
   more:
   - Set `features.previews` to `false` and `previewServices` to `[]` for each repo.
   - Set `agentMemoryMaxGb` to `3` for a repo with builds or type checks. Set `2` for a small repo.
   - Remove `checkCommand` if the repo has no check. An empty string is not valid.
   - Do not add `slackChannel`, `instances`, `orchestratorOn` or `serverSwitcher`. This box is one
     instance.
   - `instanceHourlyUsd` is an estimate from this box's monthly price.
   ```json
   {
     "repos": [
       {
         "name": "<repo>",
         "repoPath": "${ORCA_DEV_ROOT}/<repo>",
         "worktreeRoot": "${ORCA_DEV_ROOT}/<repo>/.worktrees",
         "baseBranch": "main",
         "githubUser": "finnformica",
         "providers": ["claude"],
         "agentPermissionMode": "bypass",
         "agentMemoryMaxGb": 3,
         "checkCommand": "<the repo's own check>",
         "features": {
           "previews": false,
           "slack": false,
           "aiTitles": true,
           "aiPrDescription": true,
           "followAutomation": true,
           "autoMerge": false
         },
         "mergePolicy": { "whenGreen": "small", "denyPaths": [], "autoPr": true },
         "previewServices": []
       }
     ],
     "portRange": [10000, 65000],
     "staleHours": 24,
     "agentTimeoutMinutes": 45,
     "agentModel": "claude-opus-5-5",
     "orchestratorShell": true,
     "autoUpkeepConcurrency": 1,
     "agentCpuWeight": 50,
     "instanceHourlyUsd": { "personal": 0.014 }
   }
   ```
9. **[SCRIPT]** Check that the file is valid JSON:
   ```sh
   jq . ~/orca-config.personal.json > /dev/null && echo ok
   ```
10. **[SCRIPT]** Write the document to Orca. The document is the unit: Orca removes each repo that
    is not in it, so this step removes the seeded work repos. The answer must be `{"ok":true,…}`.
    If it is `{"errors":[…]}`, correct the file and do the step again:
    ```sh
    curl -s -X PUT -H 'content-type: application/json' --data @$HOME/orca-config.personal.json http://127.0.0.1:8787/api/config/document
    ```
11. **[SCRIPT]** Check the result. Each repo must show `previews: false` and the memory cap:
    ```sh
    curl -s http://127.0.0.1:8787/api/config | jq '.repos[] | {name, previews: .features.previews, agentMemoryMaxGb}'
    ```

### Phase 5: logins (all by hand)

1. **[HAND]** Log in to GitHub. The command shows a device code. Open `github.com/login/device` in
   a browser that is signed in as `finnformica`:
   ```sh
   gh auth login --hostname github.com --git-protocol https --web
   ```
2. **[SCRIPT]** Let `git` use the `gh` login for HTTPS push:
   ```sh
   gh auth setup-git
   ```
3. **[SCRIPT]** Check that the account is correct. The result must be `finnformica`:
   ```sh
   gh api user --jq .login
   ```
4. **[HAND]** Do step 4.7 now, if you did not do it before, for each private repo.
5. **[HAND]** If you added repos in step 5.4, add them to the config document. Do steps 4.8–4.11
   again.
6. **[HAND]** Add one hydra profile for each personal Claude account. Each command shows a URL. Open
   it, log in to that Claude account, and paste the code back into the terminal. Do this step once
   for each account. To log in again later, use `hydra login <name>`:
   ```sh
   hydra add <name>
   ```
7. **[SCRIPT]** Check the profiles. Each profile must show its 5-hour and weekly windows:
   ```sh
   hydra status
   ```
8. **[SCRIPT]** Trust each repo in each hydra profile. Without this, a worker fails with an
   untrusted-workspace error. Do this once for each repo path:
   ```sh
   for f in ~/.hydra/profiles/*/.claude.json; do t=$(mktemp) && jq --arg p /opt/<repo> '.projects[$p].hasTrustDialogAccepted = true' "$f" > "$t" && mv "$t" "$f"; done
   ```
   If `~/.claude.json` exists too (a login with no hydra profile), do the same for that file.
9. **[SCRIPT]** Check that the bridge sends runs through the hydra shim. The result must show
   `"shim": true`:
   ```sh
   curl -s http://127.0.0.1:8787/api/usage | jq '.routing'
   ```
10. **[HAND]** Tailscale is already up, from step 1.5. Do nothing more for Tailscale here.

### Phase 6: backups

OVH Automated Backup (one daily image of the disk) is already on. Check this in the OVH control
panel. The steps below add a second, independent backup: a nightly `pg_dump` sent off the box, to
Cloudflare R2.

1. **[HAND]** In the Cloudflare dashboard, open **R2**. Make a bucket, for example `orca-backups`.
2. **[HAND]** In **R2 → Manage API tokens**, make a token with **Object Read & Write** for that
   bucket only. Record the Access Key ID, the Secret Access Key and the account ID.
3. **[HAND]** Optional. Add a lifecycle rule to the bucket that deletes objects after 30 days.
4. **[HAND]** As `orca`, add the rclone remote. Put a leading space before the command, so bash does
   not keep it in the history:
   ```sh
    rclone config create r2 s3 provider=Cloudflare access_key_id=<key-id> secret_access_key=<secret> endpoint=https://<account-id>.r2.cloudflarestorage.com acl=private no_check_bucket=true
   ```
5. **[SCRIPT]** Check that rclone can reach the bucket:
   ```sh
   rclone lsd r2:orca-backups
   ```
6. **[SCRIPT]** Make the local backup directory:
   ```sh
   sudo install -d -o orca -g orca -m 700 /var/backups/orca
   ```
7. **[SCRIPT]** Write the backup script. It dumps the database, saves the config document, copies
   both to R2, and deletes local copies older than 7 days and R2 copies older than 30 days:
   ```sh
   sudo tee /usr/local/bin/orca-pg-backup >/dev/null <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   dir=/var/backups/orca
   stamp=$(date -u +%Y%m%dT%H%MZ)
   url=$(grep '^ORCA_DATABASE_URL=' /opt/orca/.env | cut -d= -f2-)
   pg_dump -Fc --no-owner "$url" > "$dir/orca-$stamp.dump"
   curl -fsS http://127.0.0.1:8787/api/config/document > "$dir/config-$stamp.json" || true
   rclone copy "$dir" r2:orca-backups/personal-box --include "*-$stamp.*"
   find "$dir" -type f -mtime +7 -delete
   rclone delete r2:orca-backups/personal-box --min-age 30d
   EOF
   ```
8. **[SCRIPT]** Make the script executable:
   ```sh
   sudo chmod 755 /usr/local/bin/orca-pg-backup
   ```
9. **[SCRIPT]** Write the service unit:
   ```sh
   printf '[Unit]\nDescription=Orca nightly pg_dump to R2\nAfter=postgresql.service network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nUser=orca\nExecStart=/usr/local/bin/orca-pg-backup\n' | sudo tee /etc/systemd/system/orca-backup.service
   ```
10. **[SCRIPT]** Write the timer unit, for each night at 03:30, with a random delay of up to 15
    minutes. `Persistent=true` runs a missed backup after a reboot:
    ```sh
    printf '[Unit]\nDescription=Run the Orca backup each night\n\n[Timer]\nOnCalendar=*-*-* 03:30:00\nRandomizedDelaySec=15m\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' | sudo tee /etc/systemd/system/orca-backup.timer
    ```
11. **[SCRIPT]** Load and start the timer:
    ```sh
    sudo systemctl daemon-reload && sudo systemctl enable --now orca-backup.timer
    ```
12. **[SCRIPT]** Run one backup now:
    ```sh
    sudo systemctl start orca-backup.service
    ```
13. **[SCRIPT]** Check that the files are in R2:
    ```sh
    rclone ls r2:orca-backups/personal-box
    ```
14. **[SCRIPT]** Test a restore into a temporary database, then delete that database:
    ```sh
    sudo -u postgres createdb -O orca orca_restore_test && pg_restore --no-owner -d "postgres://orca:<db-pw>@localhost:5432/orca_restore_test" "$(ls -t /var/backups/orca/orca-*.dump | head -1)" && sudo -u postgres dropdb orca_restore_test
    ```

Do not back up worktrees, because git already holds them. Do not back up login files
(`~/.hydra/profiles`, `~/.config/gh`). After a full loss, log in again, as in Phase 5.

### Phase 7: HTTPS with `tailscale serve`

The web app registers its service worker only in a secure context. The plain
`http://…:8787` tailnet URL is not a secure context, so browser notifications and the installed app
(PWA) on a phone both need HTTPS.

1. **[HAND]** Check that step 1.1 is done: MagicDNS on, HTTPS Certificates on.
2. **[SCRIPT]** Serve the bridge on HTTPS port 443 of the tailnet name. Tailscale gets the
   certificate, and sends the traffic to `http://127.0.0.1:8787`. `--bg` keeps the setting after a
   reboot:
   ```sh
   sudo tailscale serve --bg 8787
   ```
3. **[SCRIPT]** Check the setting. It must show `https://<box-name>.<tailnet>.ts.net` →
   `http://127.0.0.1:8787`:
   ```sh
   tailscale serve status
   ```
4. **[HAND]** On the phone, open `https://<box-name>.<tailnet>.ts.net`. The first load can take a
   few seconds while Tailscale gets the certificate.
5. **[HAND]** On an iPhone, add the page to the Home Screen (Share → Add to Home Screen). Open it
   from the Home Screen. iOS shows web notifications only for an installed web app.
6. **[HAND]** In the app, allow notifications when it asks.
7. **[SCRIPT]** Optional. If you use the server switcher later, set the HTTPS URL as the URL of this
   server:
   ```sh
   echo 'ORCA_SERVER_URL=https://<box-name>.<tailnet>.ts.net' >> /opt/orca/.env && sudo systemctl restart orca
   ```

Note: the certificate name goes into the public Certificate Transparency logs. The box's Tailscale
name becomes public this way, even though the box itself stays unreachable from the open internet.
This is why this guide keeps that name out of its own text, and asks you to choose and record it
yourself.

### Phase 8: checks

Do these checks as `orca` on the box, unless the step says "laptop" or "phone".

1. **[SCRIPT]** Swap is on (4 GB):
   ```sh
   swapon --show
   ```
2. **[SCRIPT]** The services run:
   ```sh
   systemctl is-active orca postgresql tailscaled orca-autodeploy.timer orca-backup.timer
   ```
3. **[SCRIPT]** The bridge limits apply. The result must be `MemoryMax=3221225472` and
   `OOMScoreAdjust=-500`:
   ```sh
   systemctl show orca -p MemoryMax -p OOMScoreAdjust
   ```
4. **[SCRIPT]** The OOM values of Postgres (`-900`) and Tailscale (`-800`):
   ```sh
   systemctl show postgresql@<ver>-main tailscaled -p OOMScoreAdjust
   ```
5. **[SCRIPT]** The limit on all agent runs together (`5368709120`):
   ```sh
   systemctl show "user-$(id -u).slice" -p MemoryMax
   ```
6. **[SCRIPT]** Lingering is on. The result must be `Linger=yes`. Without it, agent runs have no
   memory cap:
   ```sh
   loginctl show-user orca -p Linger
   ```
7. **[SCRIPT]** The listeners. Postgres must be on `127.0.0.1` only. The bridge must be on
   `127.0.0.1:8787` and `<ts-ip>:8787` only:
   ```sh
   sudo ss -tlnp
   ```
8. **[SCRIPT]** The firewall:
   ```sh
   sudo ufw status verbose
   ```
9. **[SCRIPT]** The config. Each repo has previews off and a cap of 2 or 3 GB:
   ```sh
   curl -s http://127.0.0.1:8787/api/config | jq '.repos[] | {name, previews: .features.previews, agentMemoryMaxGb}'
   ```
10. **[SCRIPT]** The health of the box and the database migrations:
    ```sh
    curl -s 'http://127.0.0.1:8787/api/diagnostics?format=text'
    ```
11. **[SCRIPT]** The logins:
    ```sh
    gh api user --jq .login && hydra status && curl -s http://127.0.0.1:8787/api/usage | jq '.routing'
    ```
12. **[SCRIPT]** Auto-deploy works. The last line must be `up to date at …` or `deployed …`:
    ```sh
    tail -n 3 ~/.orca/autodeploy.log
    ```
13. **[SCRIPT]** The last backup:
    ```sh
    rclone ls r2:orca-backups/personal-box | tail -n 4
    ```
14. **[HAND]** Laptop: public SSH is closed. The command must time out:
    ```sh
    nc -vz -w 5 <ipv4> 22
    ```
15. **[HAND]** Laptop: the app loads on HTTPS and on the tailnet port:
    ```sh
    curl -s -o /dev/null -w '%{http_code}\n' https://<box-name>.<tailnet>.ts.net/api/config
    ```
16. **[HAND]** On the box: the work box is **not** reachable, because the ACL blocks box-to-box
    traffic. The command must time out:
    ```sh
    curl -s -m 5 http://<work-box-ts-ip>:8787/api/config || echo blocked
    ```
17. **[HAND]** Phone: open the HTTPS URL from the Home Screen. Check that a notification shows when
    a run finishes.
18. **[HAND]** First end-to-end run: push `C`, select a personal repo, and ask for a very small
    change. Watch the card go from running to done. Check that the PR author is `finnformica`.
19. **[SCRIPT]** After the run, look for OOM kills. The result must be empty:
    ```sh
    journalctl --user | grep -i oom-kill
    ```
