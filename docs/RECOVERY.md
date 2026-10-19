# Recovery: a box that does not answer

## Harden a box (one time)

```bash title=Harden
cd /opt/orca && deploy/harden.sh --check   # report only
cd /opt/orca && sudo deploy/harden.sh      # apply
cd /opt/orca && sudo deploy/harden.sh --undo  # remove every file it wrote
```

It adds swap when there is none, protects `orca`, `postgres` and the user manager from the OOM
killer, and installs the health watchdog. It restarts no service.

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
