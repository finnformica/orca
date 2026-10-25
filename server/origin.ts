// The request origin of a workstream turn, joined for display. A turn the orchestrator started
// stores only references (`turn.origin`: the wake's run id and the `queued_message` ids a person
// wrote); this reads those rows and attaches the words as `turn.originMessages`. A row that is gone
// reads as `missing` ("message no longer stored"). One query for all the turns.
import type { AgentTurn } from "../shared/agent";
import { joinOrigin } from "../web/src/workstream";
import * as db from "./db";

export async function linkOrigins(turns: AgentTurn[]): Promise<void> {
  const ids = [...new Set(turns.flatMap((t) => t.origin?.messageIds ?? []))];
  const rows = ids.length ? await db.originRows(ids) : [];
  for (const t of turns) if (t.origin) t.originMessages = joinOrigin(t.origin.messageIds, rows);
}
