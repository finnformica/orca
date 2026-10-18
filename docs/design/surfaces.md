# Surfaces

These rules tell you which fill, border and shadow each part of the web app uses.
Follow them for every new component. The rules use the tokens in `web/src/styles.css`.
The server theme (`shared/serverIdentity.ts` `themeTones`) tints the same tokens, so a rule that is
correct for one theme is correct for Blue, Green and Neutral.

The base is shadcn (the `components/ui/` primitives) and branch-demo (`/opt/branch-demo/ui`), where
Orca copies it. `tests/console.test.tsx` and `tests/surfaces.test.tsx` check the key rules.

## Levels

Use only these four levels. Each level has one token.

| Level | Token | Class | Parts |
|---|---|---|---|
| 0. Frame | `--sb-bg` (`--sidebar`) | `bg-sidebar`, `data-chrome` | The sidebar, the canvas behind the cards, the phone's top bar. |
| 1. Page | `--background` | `bg-background` | The page card, the dock card, the orchestrator panel, every header on them, the chat log. |
| 2. Raised | `--card` | `bg-card` | Cards in a page, the composer, inputs that need a fill, secondary buttons. |
| 3. Overlay | `--popover` or `--card` | `bg-popover`, `bg-card` | Menus, selects, popovers, hover cards, dialogs, sheets, the Ask pill. |

- Put a level only on a level below it. Do not put a raised card on a raised card. Use dividers in a card.
- The page card and the dock card are TWO cards at level 1. They use the same fill and `shadow-shell`.
- `data-chrome` maps the neutral tokens to the frame's tones. Use it only on the frame. Do not use it on an overlay.

## Headers

- A header uses the same surface as the body under it. Do not give a header its own fill.
- Separate a header from its body with one hairline (`border-b`).
- This applies to the page top bar, the agent page's sticky header (`STICKY_HEADER`), the panel header
  (`PanelHeader`), a card header (`console.tsx` `Card`) and a snippet header.
- A sticky header must be opaque. Give it the fill of its body (`bg-background` on a page, `bg-card` in a card).

## The chat

- The chat log (`data-slot="chat-log"`) has no fill. It takes the surface of its container.
- The composer is a raised card: `bg-card`, `border`, `rounded-lg`. It must differ from the log under it.
- Your message is a bubble: `bg-accent`, `rounded-lg`. The agent's reply has no fill.
- Widgets in the log (activity, the worker report block, a snippet) are tinted fills or cards with a
  hairline. The worker report block uses the blue tint (`bg-geist-blue/5`, `border-geist-blue/20`).

## Overlays

- Menus, selects, popovers and hover cards: `bg-popover`, `border`, `rounded-lg`, `shadow-menu`.
- Dialogs: `bg-card`, `border`, `rounded-lg`, `shadow-modal`, a `bg-black/50` backdrop.
- Toasts: `bg-card`, `border`, `shadow-menu`.
- The Ask pill: `bg-card`, `border`, `shadow-modal`. Use the same classes when it is open and when it is
  closed. Change only its size and radius.
- Tooltips: `bg-foreground`, `text-background`. Use the `Tip` component. Do not use a native `title=`.
- The update bar floats over the page: `bg-primary`, `shadow-modal`. It is the only primary-filled overlay.

## Buttons

Use the `Button` variants from `components/ui/button.tsx`.

- Primary (`default`): the one main action in a view. Merge is primary too.
- Secondary (`secondary` or `outline`): other actions with a label. `bg-card` and a hairline.
- Tertiary (`ghost`): every icon-only button and every toolbar button. No fill until hover.
- Destructive: only for an action that deletes or discards.
- A hand-made control (a switcher trigger, a toolbar button) uses the ghost look: `hover:bg-accent`.

## States

- Hover on a control: `hover:bg-accent`. Do not use a step of it (`/60`) on a control.
- Hover on a row in a card or list: `hover:bg-accent/40`. Keyboard focus on such a row: the same.
- Highlight in a menu, select, palette or picker (the cursor): `bg-accent`.
- Selected (a state that stays): `bg-selected`, `text-selected-foreground`. This applies to tabs, a
  segmented control, a selected list row and a terminal tab.
- The active nav item in the sidebar: `bg-sidebar-active`, `text-sidebar-active-foreground`.
- A pressed filter chip: `border-primary`, `bg-primary`, `text-primary-foreground`.
- Focus ring: `focus-visible:ring-2`, `ring-ring/40`, and `border-ring` on a field.

## Borders and shadows

- Use 1px hairlines (`border`, `border-b`, `divide-y`). Never use 2px.
- The border colour is `--border` everywhere. Do not set a colour on a hairline unless it is a status tint.
- Use only these shadows: `shadow-shell` (the page and dock cards), `shadow-menu` (menus, popovers,
  toasts), `shadow-modal` (dialogs, the Ask pill, the update bar, an overlay side panel).
- Badges are tinted fills with no border.
