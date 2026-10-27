// A named agent's avatar: its identicon (shared/identicon) as one inline SVG — no image request, no
// defs or ids, so it draws the same in the tab and in the orchestrator's PiP window. The cells are
// crisp squares on a faint tile of the same hue, which frames the icon on the light and the dark theme.
import { useMemo } from "react";
import { identicon } from "../../../shared/identicon";
import { cn } from "@/lib/utils";

export type AgentAvatarSize = 16 | 20 | 24;

export function AgentAvatar({ name, size = 20, className }: { name: string; size?: AgentAvatarSize; className?: string }) {
  const icon = useMemo(() => identicon(name), [name]);
  return (
    <svg data-slot="agent-avatar" data-agent={name} width={size} height={size} viewBox="-1 -1 7 7" aria-hidden
      className={cn("shrink-0", className)}>
      <rect x={-1} y={-1} width={7} height={7} rx={1.2} fill={icon.color} fillOpacity={0.16} />
      <g fill={icon.color} shapeRendering="crispEdges">
        {icon.cells.map((on, i) => on && <rect key={i} x={i % 5} y={Math.floor(i / 5)} width={1} height={1} />)}
      </g>
    </svg>
  );
}
