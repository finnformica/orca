// Pasted/dropped files, instance-independent. The upload stores the bytes in the shared database and
// answers a REFERENCE (`orca-attachment://<id>/<name>`), never a host path: the message carrying it
// may be queued, proxied to the orchestrator's instance or launched by a workstream's home, and a
// laptop's /var/folders path means nothing on the box. Whichever bridge launches the run swaps each
// reference for a file in its own state dir (`resolvePrompt`, called from `agent.launch` — the one
// place every launch path goes through), cached by id so a re-read costs no query.
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import * as db from "./db";
import { statePath } from "./state";

export const ATTACHMENT_PREFIX = "orca-attachment://";
/** Per file. A screenshot is well under this; anything bigger doesn't belong in a prompt. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const REF = /orca-attachment:\/\/([0-9a-f-]{36})(?:\/([\w.-]+))?/g;
const HEADER = "Attached files (Read these for extra context):";

export class AttachmentTooLarge extends Error {}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 120) || "file";

export const attachmentRef = (id: string, filename: string) => `${ATTACHMENT_PREFIX}${id}/${safeName(filename)}`;

/** Store each file in the database; refuses the whole upload if any file is over the cap. */
export async function store(files: File[]): Promise<string[]> {
  const big = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (big) throw new AttachmentTooLarge(`${big.name} is ${(big.size / 1024 / 1024).toFixed(1)} MB; attachments are capped at ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  const refs: string[] = [];
  for (const f of files) {
    const id = crypto.randomUUID();
    await db.addAttachment({ id, filename: f.name || "file", mimeType: f.type || "application/octet-stream", bytes: new Uint8Array(await f.arrayBuffer()) });
    refs.push(attachmentRef(id, f.name || "file"));
  }
  return refs;
}

/** The local path of attachment `id` on THIS instance, written from the database on first use;
 *  undefined if the database no longer has it (pruned past 30 days). */
export async function materialise(id: string): Promise<string | undefined> {
  const row = await db.attachment(id);
  if (!row) return undefined;
  const path = statePath("attachments", id, safeName(row.filename));
  if (!existsSync(path)) await writeFile(path, row.bytes);
  return path;
}

// Cache by id, so the database is not asked again for a file already on disk here.
async function localPath(id: string, name?: string): Promise<string | undefined> {
  if (name) {
    const cached = statePath("attachments", id, name);
    if (existsSync(cached)) return cached;
  }
  return materialise(id);
}

const unavailable = (what: string) => `${what} (unavailable on this machine — it was attached elsewhere and is gone; ask the user to attach it again)`;

/** The prompt the agent sees: every attachment reference replaced by a real local path, and a
 *  legacy plain path (from before references) kept when the file exists here, else replaced by its
 *  name marked unavailable rather than handed over as a path the agent will fail to open. Never throws: a
 *  database hiccup degrades to the "unavailable" note, it does not cost the run. */
export async function resolvePrompt(prompt: string): Promise<string> {
  const found = new Map<string, string>();
  for (const m of prompt.matchAll(REF)) {
    if (found.has(m[0])) continue;
    const path = await localPath(m[1]!, m[2]).catch((e) => { console.error("[attachments]", e instanceof Error ? e.message : e); return undefined; });
    found.set(m[0], path ?? unavailable(m[0]));
  }
  const out = found.size ? prompt.replace(REF, (ref) => found.get(ref) ?? ref) : prompt;
  if (!out.includes(HEADER)) return out;
  // Legacy entries: only lines of the attachment list itself, and only absolute paths.
  let inList = false;
  return out.split("\n").map((line) => {
    if (line === HEADER) { inList = true; return line; }
    const path = inList ? line.match(/^- (\/\S.*)$/)?.[1] : undefined;
    if (!path) { if (line.trim()) inList = false; return line; }
    // Only the name: another machine's temp path (a laptop's /var/folders/…) must never reach the agent.
    return existsSync(path) ? line : `- ${unavailable(path.split("/").pop() || "file")}`;
  }).join("\n");
}
