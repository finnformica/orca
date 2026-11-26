# Recovery: a box that does not answer

## Harden a box (one time)

```bash title=Harden
cd /opt/orca && deploy/harden.sh --check   # report only
cd /opt/orca && sudo deploy/harden.sh      # apply
cd /opt/orca && sudo deploy/harden.sh --undo  # remove every file it wrote
```

It adds swap when there is none, protects `orca`, `postgres` and the user manager from the OOM
killer, and installs the health watchdog. It also stops needrestart from restarting PostgreSQL
after a library upgrade (`/etc/needrestart/conf.d/50-orca-postgres.conf`). It restarts no service.

The watchdog checks `GET /api/health/db` each minute. That route runs one `SELECT 1` through the
bridge's own pool. No answer, or a status that is not 2xx, is a failure. Three failures in a row
restart `orca`. Deploy the bridge before you run `harden.sh`: an older bridge has no such route.

## Look at the box

```bash title=Checks
systemctl status orca postgresql "user@$(id -u orca).service" --no-pager
journalctl -k --no-pager | grep -iE 'out of memory|oom-kill' | tail -5
journalctl -t orca-health --no-pager | tail -20
```

## Restart by hand

```bash title=Restart
sudo systemctl restart orca
sudo systemctl restart "user@$(id -u orca).service"
```

Hold the deploy lock for a manual deploy, so that the watchdog does not restart the bridge:

```bash title=Manual deploy
flock ~/.orca/deploy.lock sh -c 'cd /opt/orca && git pull --ff-only && bun run build && sudo systemctl restart orca'
```

## Reboot from the phone

- OVH VPS: OVHcloud app → **Bare Metal Cloud** → **VPS** → the VPS → **Reboot**.
- AWS EC2: AWS Console app → **EC2** → **Instances** → the instance → **Instance state** →
  **Reboot**. If it does not come back in 5 minutes, stop the instance, then start it.

## When the box starts but does not answer

- OVH: Control Panel → **VPS** → **KVM**, and sign in as `ubuntu`. **Reboot in rescue mode** is
  on the same page.
- AWS: **Connect** → **Session Manager**, else **EC2 serial console**.

## Outages

### 2026-11-26: Postgres restart, 06:21–08:15 UTC (personal box)

What happened:

1. unattended-upgrades upgraded libkrb5 and libgssapi.
2. needrestart restarted `postgresql@18-main`: a fast shutdown at 06:21:52, up again at 06:21:54.
3. A live query got `terminating connection due to administrator command` (SQLSTATE 57P01).
4. Orca reopened the pool at once, while Postgres was still shutting down. The connect got
   `the database system is shutting down` (SQLSTATE 57P03).
5. Every query after that failed with the same 57P03 for 2 hours. Postgres was healthy from
   06:21:54. Only `systemctl restart orca` fixed it.

Root cause: `server/db.ts` kept a pool whose first connect had failed. `db()` keeps the pool's
migrate promise (`ready`). `open()` rethrew an error that `isConnectFailure` did not know, but kept
the pool. So every later `open()` awaited the same rejected promise and threw the old 57P03 again.

The watchdog did not act: it checked `/api/config`, which answered 200 from the cached config.

Fixes:

- `open()` drops a pool whose connect or migrations failed. The next query connects again. Only a
  refused migration ledger (`MigrationRefused`) stays final.
- 57P03 (shutting down, starting up, recovery) is an outage: degraded mode, and the background
  probe retries with backoff (1 s, doubled, at most 30 s). 57P01 and 57P02 are a dropped connection.
- The watchdog checks `/api/health/db`, which answers 503 when the bridge cannot reach its database.
- `harden.sh` writes the needrestart rule. Restart PostgreSQL by hand in a quiet window after an
  upgrade:

```bash title=Restart Postgres after an upgrade
sudo needrestart -r l          # list what needs a restart
sudo systemctl restart postgresql@18-main
```
