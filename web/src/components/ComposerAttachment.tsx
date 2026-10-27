// ONE attachment chip for everything a message carries: an image, a file and a stored secret. The
// composer draws each as a 56px tile in one row inside its box, with a Remove ✕ (`look="tile"`); a
// sent, sending or queued message draws the same items under its bubble (`look="chip"`, no ✕). The
// lifecycle is the composer's: an item is added (paste, drop, the picker, "Save as secret"), removed
// by its ✕, and cleared from the box on send, when it moves to the message.
// A secret chip never holds the value: only the stored name and a lock icon.
import { FileText, Lock, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExpandableImage } from "@/components/ExpandableImage";
import { cn } from "@/lib/utils";

export type AttachmentItem =
  // `src`: a blob: URL in the composer (empty until it is made), /api/attachments/<id> on a message.
  | { kind: "image"; name: string; src: string; gallery?: { images: { src: string; alt: string }[]; index: number } }
  | { kind: "file"; name: string; href?: string }
  // `name`: the secret's reference, e.g. `chat/stripe_key`.
  | { kind: "secret"; name: string };

/** The label a secret chip shows: the stored name, without its scope. */
export const secretLabel = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

export function ComposerAttachment({ item, onRemove, look = "tile" }: { item: AttachmentItem; onRemove?: () => void; look?: "tile" | "chip" }) {
  const label = item.kind === "secret" ? `Secret ${item.name}` : item.name;
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
        <span {...slot} title={`Stored secret ${item.name}. The message holds only its name.`} aria-label={label} className={pill}>
          <Lock className="size-3 shrink-0" aria-hidden /><span className="truncate font-mono">{secretLabel(item.name)}</span>
        </span>
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
      title={item.kind === "secret" ? `Stored secret ${item.name}. The message holds only its name.` : undefined}
      // An image is a square; a file or a secret grows to show its name, up to a cap.
      className={cn("group relative h-14 overflow-hidden rounded-md border", item.kind === "image" ? "w-14" : "max-w-36 min-w-14")}>
      {item.kind === "image"
        // The blob: URL is not made yet on the very first render, so the lightbox waits for it.
        ? (item.src && <ExpandableImage src={item.src} alt={item.name} downloadName={item.name} className="size-full" imgClassName="size-full object-cover" cornerClassName="bottom-1 right-1" />)
        : (
          <div data-slot={item.kind === "secret" ? "chat-composer-secret" : "chat-composer-file"}
            className={cn("text-muted-foreground flex size-full flex-col items-center justify-center gap-0.5 px-2 py-1", item.kind === "secret" && "bg-muted/40")}>
            {item.kind === "secret" ? <Lock className="size-4 shrink-0" aria-hidden /> : <FileText className="size-4 shrink-0" aria-hidden />}
            <span className={cn("max-w-full truncate text-center text-[10px]", item.kind === "secret" && "font-mono")}>{item.kind === "secret" ? secretLabel(item.name) : item.name}</span>
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
