// Launch the bridge + Vite dev server together. Vite proxies /api to the bridge.
// The children get this process's environment MINUS its ORCA_* variables: Bun loaded .env into this
// launcher at ITS start, and an inherited variable beats the child's own .env load — so an edit to
// .env (the database, the instance name, the bind address) never reached a watch-restarted bridge
// until `bun run dev` itself was restarted. Now each (re)start of the bridge reads .env afresh.
import { supervise, watchSources } from "./supervise";

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_")));
// The bridge runs SUPERVISED, not under `bun --watch`: when it died at startup (the cloud box's
// database hung and `db.open()` threw), `bun --watch` sat idle waiting for an edit and never re-ran
// it — and the launcher, seeing no exit, sat there too. Now a crash comes back after a short backoff
// (scripts/supervise.ts), and our own watch restarts it on an edit to its sources or .env. A restart
// under in-flight runs is survivable (agent.adoptLeases finishes them from the session file) — but it
// is still a restart, so the rule stands: never edit or pull THIS checkout while the bridge serves
// it; work in a worktree and merge by PR, and pull main here deliberately.
const bridge = supervise(["bun", "run", "server/index.ts"], { env, name: "bridge" });
const unwatch = watchSources(["server", "shared", "web/src/workstream.ts", "orca.config.ts", ".env"], (file) => {
  console.log(`orca dev: ${file} changed — restarting the bridge`);
  bridge.restart();
});
const vite = Bun.spawn(["bunx", "--bun", "vite"], { cwd: "web", stdout: "inherit", stderr: "inherit", env: env() });

// Reap children on exit — otherwise every restart orphans the bridge + Vite (killing this launcher
// doesn't cascade), they pile up over days and squat ports (8788→8789, 5173→5176…). We also pkill
// the Vite by path because `bunx` spawns node as a grandchild that a plain kill() would miss.
let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return; // a signal and a child-exit can race; only tear down once
  shuttingDown = true;
  unwatch();
  void bridge.stop();
  try { vite.kill(); } catch { /* already gone */ }
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

// If Vite exits — a crash, an external kill — tear the whole launcher down and exit, instead of
// `await new Promise(() => {})`-ing forever as an orphan that spins on a dead event loop (the 14-day
// zombie that burned CPU with no children left). The bridge is not in this race: it is restarted.
await vite.exited;
// A Ctrl-C also kills the children, so guard: don't print the scary line (or exit non-zero) when a
// signal already began the teardown — only a genuine unexpected exit reaches this.
if (!shuttingDown) {
  console.error("orca dev: vite exited — shutting down. Re-run `bun run dev`.");
  shutdown(1);
}

export {};
