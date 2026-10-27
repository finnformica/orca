// ONE attachment chip for everything a message carries: an image, a file and a stored secret. The
// composer draws each as a 56px tile in one row inside its box, with a Remove ✕ (`look="tile"`); a
// sent, sending or queued message draws the same items under its bubble (`look="chip"`, no ✕). The
// lifecycle is the composer's: an item is added (paste, drop, the picker, "Save as secret"), removed
// by its ✕, and cleared from the box on send, when it moves to the message.
// A secret chip never holds the value: only the stored name and a lock icon.
// An agent chip is a recipient (`To Research`, its avatar, ✕): a pick from the `@` picker in the
// orchestrator's panel or quick-ask. It is a small pill, not a tile, and a send goes to it.
import { FileText, Lock, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ExpandableImage } from "@/components/ExpandableImage";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";

export type AttachmentItem =
  // `src`: a blob: URL in the composer (empty until it is made), /api/attachments/<id> on a message.
  | { kind: "image"; name: string; src: string; gallery?: { images: { src: string; alt: string }[]; index: number } }
  | { kind: "file"; name: string; href?: string }
  // `name`: the secret's reference, e.g. `chat/stripe_key`.
  | { kind: "secret"; name: string }
  // `name`: the agent's name (`research`); `label`: its display name (`Research`).
  | { kind: "agent"; name: string; label: string };

/** The label a secret chip shows: the stored name, without its scope. */
export const secretLabel = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

/** A secret chip's tooltip. It names the reference, never a value. */
const secretTip = (ref: string) => `Stored secret ${ref}. The message holds only its name.`;

export function ComposerAttachment({ item, onRemove, look = "tile" }: { item: AttachmentItem; onRemove?: () => void; look?: "tile" | "chip" }) {
  const label = item.kind === "secret" ? `Secret ${item.name}` : item.kind === "agent" ? `To ${item.label}` : item.name;
  if (item.kind === "agent") {
    return (
      <span data-slot={look === "tile" ? "composer-attachment" : "attachment-agent"} data-attachment="agent" data-agent={item.name} aria-label={label}
        className="bg-muted/40 text-foreground inline-flex h-7 max-w-48 items-center gap-1.5 self-center rounded-md border pr-1 pl-1.5 text-xs">
        <AgentAvatar name={item.name} size={16} />
        <span className="truncate"><span className="text-muted-foreground">To </span>{item.label}</span>
        {onRemove && (
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${label}`} data-slot="composer-attachment-remove" onClick={onRemove}
            className="text-muted-foreground hover:text-foreground size-5 shrink-0 rounded-sm p-0">
            <X className="size-3" />
          </Button>
        )}
      </span>
    );
  }
  if (look === "chip") {
    const slot = { "data-slot": `attachment-${item.kind}`, "data-attachment": item.kind } as const;
    if (item.kind === "image") {
      return (
        <span {...slot} className="inline-flex">
          <ExpandableImage src={item.src} alt={item.name} downloadName={item.name} gallery={item.gallery}
            imgClassName="max-h-32 max-w-48 rounded-md border object-cover" />
        </span>
      );
    }
    const pill = "bg-muted text-foreground inline-flex max-w-56 self-start items-center gap-1 rounded-md border px-2 py-1 text-[11px]";
    if (item.kind === "secret") {
      return (
        <Tip label={secretTip(item.name)}>
          <span {...slot} aria-label={label} className={pill}>
            <Lock className="size-3 shrink-0" aria-hidden /><span className="truncate font-mono">{secretLabel(item.name)}</span>
          </span>
        </Tip>
      );
    }
    return item.href ? (
      <a {...slot} href={item.href} target="_blank" rel="noreferrer" className={cn(pill, "hover:bg-accent")}>
        <Paperclip className="size-3 shrink-0" /><span className="truncate">{item.name}</span>
      </a>
    ) : (
      <span {...slot} className={pill}><Paperclip className="size-3 shrink-0" /><span className="truncate">{item.name}</span></span>
    );
  }
  return (
    <div data-slot="composer-attachment" data-attachment={item.kind} aria-label={label}
      // An image is a square; a file or a secret grows to show its name, up to a cap.
      className={cn("group relative h-14 overflow-hidden rounded-md border", item.kind === "image" ? "w-14" : "max-w-36 min-w-14")}>
      {item.kind === "image"
        // The blob: URL is not made yet on the very first render, so the lightbox waits for it.
        ? (item.src && <ExpandableImage src={item.src} alt={item.name} downloadName={item.name} className="size-full" imgClassName="size-full object-cover" cornerClassName="bottom-1 right-1" />)
        : item.kind === "secret" ? (
          <Tip label={secretTip(item.name)}>
            <div data-slot="chat-composer-secret" className="text-muted-foreground bg-muted/40 flex size-full flex-col items-center justify-center gap-0.5 px-2 py-1">
              <Lock className="size-4 shrink-0" aria-hidden />
              <span className="max-w-full truncate text-center font-mono text-[10px]">{secretLabel(item.name)}</span>
            </div>
          </Tip>
        ) : (
          <div data-slot="chat-composer-file" className="text-muted-foreground flex size-full flex-col items-center justify-center gap-0.5 px-2 py-1">
            <FileText className="size-4 shrink-0" aria-hidden />
            <span className="max-w-full truncate text-center text-[10px]">{item.name}</span>
          </div>
        )}
      {onRemove && (
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${label}`} data-slot="composer-attachment-remove" onClick={onRemove}
          className="bg-background/80 text-foreground hover:bg-background absolute top-0.5 right-0.5 size-4 rounded-full p-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}
