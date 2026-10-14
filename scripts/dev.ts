// Launch the bridge + Vite dev server together. Vite proxies /api to the bridge.
// The children get this process's environment MINUS its ORCA_* variables: Bun loaded .env into this
// launcher at ITS start, and an inherited variable beats the child's own .env load — so an edit to
// .env (the database, the instance name, the bind address) never reached a watch-restarted bridge
// until `bun run dev` itself was restarted. Now each (re)start of the bridge reads .env afresh.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_")));
const opts = { stdout: "inherit", stderr: "inherit", env } as const;
// --watch so editing server code restarts the bridge. A restart under in-flight runs is survivable
// now (agent.adoptLeases finishes them from the session file) — but it is still a restart, so the
// rule is: never edit or pull THIS checkout while the bridge serves it; work in a worktree and
// merge by PR, and pull main here deliberately.
// A bridge that CRASHES (the database unreachable at boot, an uncaught throw) is respawned after a
// pause — `bun --watch` restarts on file edits only, and a dead laptop bridge each time the box's
// tailnet blipped meant a manual `bun run dev` every time (systemd gives the box Restart=always).
const RESPAWN_MS = 3000;
let bridge = spawnBridge();
function spawnBridge(): Bun.Subprocess {
  const p = Bun.spawn(["bun", "--watch", "run", "server/index.ts"], opts);
  void p.exited.then((code) => {
    if (shuttingDown) return;
    console.error(`orca dev: bridge exited (${code}) — restarting in ${RESPAWN_MS / 1000}s`);
    setTimeout(() => { bridge = spawnBridge(); }, RESPAWN_MS);
  });
  return p;
}
const vite = Bun.spawn(["bunx", "--bun", "vite"], { cwd: "web", ...opts });

// Reap children on exit — otherwise every restart orphans the bridge + Vite (killing this launcher
// doesn't cascade), they pile up over days and squat ports (8788→8789, 5173→5176…). We also pkill
// the Vite by path because `bunx` spawns node as a grandchild that a plain kill() would miss.
let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return; // a signal and a child-exit can race; only tear down once
  shuttingDown = true;
  for (const c of [bridge, vite]) { try { c.kill(); } catch { /* already gone */ } }
  try { Bun.spawnSync(["pkill", "-f", "orca/node_modules/.bin/vite"]); } catch { /* none running */ }
  process.exit(code);
};
// A little send-off when you quit the dev server by hand. Pod's-eye view of an Orca shutting down.
const GOODBYES = [
  "🐋  Orca diving deep — pod's asleep. See you on the next tide.",
  "🌊  Surfacing for air. `bun run dev` when you're back.",
  "🐋  Fluke up, agents parked, previews down. Git's still the source of truth. Bye!",
  "👋  Orca out. May your CI be green and your conflicts few.",
  "🐳  Whale, that's a wrap. Catch you on the flip-fluke.",
];
const farewell = () => GOODBYES[Math.floor(Math.random() * GOODBYES.length)]!;

// A signal handler is called with the SIGNAL NAME, not a number — passing it straight to `shutdown`
// made `process.exit("SIGINT")` throw. Wrap so a Ctrl-C / SIGTERM always exits 0 (with a wave).
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { console.log(`\n${farewell()}`); shutdown(0); });

// If Vite exits — a crash or an external kill — tear the whole launcher down and exit, instead of
// `await new Promise(() => {})`-ing forever as an orphan that spins on a dead event loop (the 14-day
// zombie that burned CPU with no children left). The bridge is respawned above instead.
await vite.exited;
// A Ctrl-C also kills the children, so guard: don't print the scary line (or exit non-zero) when a
// signal already began the teardown — only a genuine unexpected child exit reaches this.
if (!shuttingDown) {
  console.error("orca dev: vite exited — shutting down. Re-run `bun run dev`.");
  shutdown(1);
}

export {};
