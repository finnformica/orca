// The `orca-shot` screenshots a workstream's workers reported, as thumbnails: a row of them under a
// worker report in the chat, and the agent page's Screenshots card (every turn's, newest first).
// Each is the shared ExpandableImage — click for the lightbox, hover for Copy.
import { useEffect, useState } from "react";
import { api } from "../api";
import { VCard } from "@/components/console";
import { ExpandableImage } from "@/components/ExpandableImage";
import { ago, shotUrl as shotPath, type ShotRef, type TurnShots } from "../workstream";
import { apiUrl } from "@/lib/server";

const shotUrl = (id: string) => apiUrl(shotPath(id));
import { Tip } from "@/components/ui/tip";

const clock = (ms?: number) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** A wrapping row of shot thumbnails, each captioned with its label and time. Siblings in the row
 *  are one lightbox gallery — Left/Right in the opened lightbox moves between them. */
export function ShotThumbs({ shots, className }: { shots: ShotRef[]; className?: string }) {
  if (!shots.length) return null;
  const images = shots.map((s) => ({ src: shotUrl(s.id), alt: s.label ?? "screenshot" }));
  return (
    <div data-slot="shot-thumbs" className={`flex flex-wrap gap-3 ${className ?? ""}`}>
      {shots.map((s, i) => (
        <figure key={s.id} data-slot="shot" className="m-0 w-40">
          <ExpandableImage src={shotUrl(s.id)} alt={s.label ?? "screenshot"} downloadName={`${s.id}.png`}
            gallery={shots.length > 1 ? { images, index: i } : undefined}
            className="block" imgClassName="h-24 w-40 rounded-md border object-cover object-top" />
          <figcaption className="text-muted-foreground mt-1 flex gap-1.5 truncate text-xs">
            {s.label && <span className="text-foreground font-medium">{s.label}</span>}
            {s.at ? <Tip label={new Date(s.at).toLocaleString()}><span>{clock(s.at)}</span></Tip> : <span>{clock(s.at)}</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The agent page's Screenshots: every shot the branch's turns reported, grouped by turn, newest
 *  first. Nothing at all while there are none — most workstreams never take one. `version` re-reads
 *  it (the row's agent status, so a run that just finished shows its shots). */
export function ScreenshotsCard({ repo, branch, version }: { repo: string; branch: string; version?: unknown }) {
  const [groups, setGroups] = useState<TurnShots[]>([]);
  useEffect(() => {
    let live = true;
    api.shots(repo, branch).then((g) => { if (live) setGroups(Array.isArray(g) ? g : []); }).catch(() => {});
    return () => { live = false; };
  }, [repo, branch, version]);
  const count = groups.reduce((n, g) => n + g.shots.length, 0);
  if (!count) return null;
  return (
    <VCard slot="screenshots" title={`Screenshots (${count})`}>
      <div className="divide-y">
        {groups.map((g) => (
          <div key={g.runId} data-slot="shot-turn" className="space-y-2 p-4">
            <div className="text-muted-foreground text-xs">Run {g.at ? <Tip label={new Date(g.at).toLocaleString()}><span>{ago(g.at)}</span></Tip> : null}</div>
            <ShotThumbs shots={g.shots} />
          </div>
        ))}
      </div>
    </VCard>
  );
}
