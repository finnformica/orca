// The one keyboard-shortcut hint, Vercel's / Linear's keycap: a fixed 20px-high chip that centres
// itself (self-center), so a flex parent of any height — a 32px button, a 36px palette row — never
// stretches it. <Shortcut id> writes a registered shortcut from lib/shortcuts' table with this
// platform's modifier (⌘ on a Mac, Ctrl elsewhere), so a hint can't disagree with its binding.
import * as React from "react";
import { cn } from "@/lib/utils";
import { shortcutKeys, type ShortcutId } from "@/lib/shortcuts";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "text-muted-foreground pointer-events-none inline-flex h-5 min-w-5 shrink-0 items-center justify-center self-center rounded border px-1 font-sans text-[11px] leading-none font-medium select-none",
        className,
      )}
      {...props}
    />
  );
}

/** Keys pressed together (⌘ K): keycaps side by side, centred as one. */
export function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="kbd-group" className={cn("inline-flex shrink-0 items-center gap-0.5 self-center", className)} {...props} />;
}

/** A registered shortcut's keycaps. */
export function Shortcut({ id, mac, className, keyClassName }: { id: ShortcutId; mac?: boolean; className?: string; keyClassName?: string }) {
  return (
    <KbdGroup data-shortcut={id} className={className}>
      {shortcutKeys(id, mac).map((k) => <Kbd key={k} className={keyClassName}>{k}</Kbd>)}
    </KbdGroup>
  );
}

/** The right-aligned shortcut slot of a menu item or a palette row. */
export function MenuShortcut({ id, className }: { id: ShortcutId; className?: string }) {
  return <Shortcut id={id} className={cn("ml-auto pl-3", className)} />;
}
