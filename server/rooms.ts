// A chat's room entries (docs/design/agent-rooms.md): read from its own turns and from the other
// named agents' chats, classified by the pure rules in shared/rooms.ts. A read view: nothing here
// writes, routes or delivers.
import { chatOwner, turnRoomEntry, type RoomEntry } from "../shared/rooms";
import { AGENTS_REPO, agentOfBranch } from "../shared/agents";
import { WORKER_EVENT_MARKER } from "../web/src/workstream";
import * as db from "./db";
import { linkOrigins } from "./origin";

export async function roomEntries(repo: string, branch: string): Promise<RoomEntry[]> {
  const viewer = chatOwner(repo, branch);
  const needle = repo === AGENTS_REPO ? `[from ${agentOfBranch(branch)}] ` : `${WORKER_EVENT_MARKER} ${repo}/${branch}`;
  const rows = await db.roomTurns(repo, branch, viewer, needle);
  // A brief shows the person's words that caused it (the origin's rows, joined as /api/turns does).
  await linkOrigins(rows.map((r) => r.turn));
  return rows.flatMap((r) => turnRoomEntry(chatOwner(r.repo, r.branch), r.turn, viewer) ?? []);
}
