# Orca logo ideas

These files are proposals only. The live favicon and icons in `web/public/` do not change.

Open `index.html` to compare each idea with the current mark. The page shows each idea at 16, 32, 64, 180 and 512 px, on light and dark backgrounds, in a browser tab and on a phone home screen.

Each SVG has the same form as `favicon.svg`: a black circle, then the white mark. The page makes the full-bleed tile (`icon.svg`, the maskable icon and the PNGs) from the same mark at 0.857 scale. That is the scale `icon.svg` uses today.

## Ideas

1. **Trued** (`1-trued.svg`). The current shape with clean geometry. The chin is round. The fin is centred on its base. The flukes are mirrors about the notch, and the tail stock has the same depth above and below. The mark sits at its optical centre.
2. **Bold** (`2-bold.svg`). Trued, made for 16 px. The fin base is wider, the tail stock and flukes are thicker, the eye is larger, and the mark is 3% larger.
3. **Soft** (`3-soft.svg`). Trued with round joins. A same-colour round stroke softens each tip. The eye is larger to keep the same visible hole.
4. **Saddle** (`4-saddle.svg`). Trued with a tilted oval eye patch, as on a real orca, in place of the round eye.
5. **Grid** (`5-grid.svg`). Drawn in a 16-unit box. The fin tip, tail stock, notch and eye fall on pixel or half-pixel lines, so the mark is crisp at 16 and 32 px.
6. **Adaptive** (`6-adaptive.svg`). The Trued mark. In a dark browser the favicon becomes a white disc with a black mark. The home-screen tiles stay black, because iOS tints them itself.

## To adopt an idea

1. Copy the path into `OrcaMark` in `web/src/components/Shell.tsx`.
2. Copy the SVG to `web/public/favicon.svg`.
3. Make `icon.svg` and `icon-maskable.svg` from the same mark at 0.857 scale.
4. Make the PNGs again from those SVGs.
