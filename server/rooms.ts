// A chat's room messages (docs/design/agent-rooms.md): read from its own turns and from the other
// named agents' chats, classified by the pure rules in shared/rooms.ts. Nothing is stored.
import { chatOwner, turnRoomMessages, type RoomMessage } from "../shared/rooms";
import { AGENTS_REPO, agentOfBranch } from "../shared/agents";
import { WORKER_EVENT_MARKER } from "../web/src/workstream";
import * as db from "./db";
import { linkOrigins } from "./origin";

export async function roomMessages(repo: string, branch: string): Promise<RoomMessage[]> {
  const viewer = chatOwner(repo, branch);
  const agent = repo === AGENTS_REPO;
  const needle = agent ? `[from ${agentOfBranch(branch)}] ` : `${WORKER_EVENT_MARKER} ${repo}/${branch}`;
  const rows = await db.roomTurns(repo, branch, agent ? "markers" : "origin", needle);
  // A brief shows who asked the orchestrator for it (the origin's rows, joined as /api/turns does).
  if (!agent) await linkOrigins(rows.map((r) => r.turn));
  return rows.flatMap((r) => turnRoomMessages(chatOwner(r.repo, r.branch), r.turn, viewer));
}
