// `bun run memory:move-notes [--confirm]` — move the orchestrator's notes into memory, once
// (server/memory.ts migrateNotes; docs/design/named-agents-and-memory.md §8). Run it by hand, from the
// main checkout, after the memory PR is merged and deployed: nothing runs it at boot.
// Without --confirm it is a dry run: it prints the parts it would write and changes nothing. The
// notes blob is never changed, so `orca notes` still prints the old text, read-only.
import * as db from "../server/db";
import { migrateNotes } from "../server/memory";

const confirm = process.argv.includes("--confirm");
try {
  const r = await migrateNotes({ confirm });
  if (r.already) {
    console.log(`already moved on ${new Date(r.already).toISOString()}: nothing to do`);
  } else if (r.dryRun) {
    console.log(`dry run: the notes make ${r.parts.length} memor${r.parts.length === 1 ? "y" : "ies"} (owner chief, tagged from-notes):`);
    for (const p of r.parts) console.log(`  - ${p.title}  [${p.tags.join(", ")}]  ${p.body.length} chars`);
    console.log("run again with --confirm to write them");
  } else {
    console.log(`moved: ${r.written.length} written, ${r.skipped.length} skipped`);
    for (const w of r.written) console.log(`  m${w.id} ${w.title}`);
    for (const s of r.skipped) console.log(`  skipped "${s.title}": ${s.why}`);
    process.exitCode = r.skipped.length ? 1 : 0;
  }
} finally {
  await db.close();
}
