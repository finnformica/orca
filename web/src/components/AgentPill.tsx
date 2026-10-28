// The ONE look of a named agent wherever it shows (Finn's call): its identicon and its name, in a
// tinted round chip. The chat header's agent menu, a room's item and header, an agent's message,
// the composer's `@` picker and recipient chip, the Integrations link Select and the Memory page all
// draw this, so an agent reads the same everywhere. The text is the label alone, so a test or a
// screen reader reads just the name.
import { AgentAvatar } from "@/components/AgentAvatar";
import { cn } from "@/lib/utils";

export type AgentPillSize = "sm" | "md";

const SIZE: Record<AgentPillSize, { avatar: 16 | 20; className: string }> = {
  sm: { avatar: 16, className: "h-5 gap-1 pr-2 pl-0.5 text-[12px]" },
  md: { avatar: 20, className: "h-6 gap-1.5 pr-2.5 pl-0.5 text-[13px]" },
};

/** `name`: the agent's name (the identicon's seed, e.g. `chief`); `label`: what it is called
 *  (`Chief of Staff`). */
export function AgentPill({ name, label, size = "sm", className }: { name: string; label: string; size?: AgentPillSize; className?: string }) {
  const s = SIZE[size];
  return (
    <span data-slot="agent-pill" data-agent={name}
      className={cn("bg-muted text-foreground inline-flex max-w-full min-w-0 shrink-0 items-center rounded-full font-medium", s.className, className)}>
      <AgentAvatar name={name} size={s.avatar} className="rounded-full" />
      <span className="truncate">{label}</span>
    </span>
  );
}
