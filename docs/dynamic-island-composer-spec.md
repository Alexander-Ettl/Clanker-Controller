# Design decision: Dynamic Island docks (liquid-fused UI)

**Decided 2026-09-24, applies to the whole project.** UI that belongs to a control (a pill, a bubble, a dock) never floats beside it as a separate chip. It grows out of that control, stays fused to it while visible, and sinks back into it, the way iPhone's Dynamic Island extends into a larger rounded shape. The two read as one liquid body joined by a soft neck, not two boxes with a gap.

The reference implementation is the time / copy / revert dock under your own chat message (`.msg-group-user .msg-actions`): hover, and it drips out from under the bubble through a liquid neck.

## Technique: the goo filter

**Glass variant (the composer dock and the model menu).** Under `body.lg-island` the shapes are transparent: `media/liquid-glass.js` updates a persistent SVG blur-and-threshold mask from their live rectangles for the backdrop-blur layer behind the row (`.island-glass`), plus an inline lighting SVG (rim, bloom, inner shade, shadow). Filter graphs persist during motion; a positioned silhouette image is generated only when rim refraction settles. The rules below still hold for everything that is not part of the dock (message bubbles, the Edit-mode docks elsewhere): they stay opaque charcoal under a real goo filter. A new dock shape needs nothing but being a child of `.compose-row` (or the model menu); a new fused element elsewhere should copy the charcoal rules.

One SVG filter does the fusing (`#msg-goo`, defined once in `tools/ai-chat-panel/media/main.js`):

1. `feGaussianBlur` (stdDeviation 5) smears the shapes into each other;
2. `feColorMatrix` sharpens the alpha (`18a - 7`), so anything above roughly 40% coverage becomes one hard-edged silhouette, which is where the neck comes from;
3. `feComposite atop` draws the untouched original back on top, so text and icons never pass through the blur.

Put the filter on the **container** that holds the control and its buds, never on the pieces. Rules that make it work:

- **Opaque, identical fill.** Every fused shape uses the same charcoal (`rgb(26, 28, 34)`: message bubbles, model menu, the composer dock). The threshold works on alpha, so translucent glass breaks it, and a `backdrop-filter` can't see through a filtered ancestor anyway.
- **Small gaps.** Shapes 4 to 8px apart fuse through a neck; wider than about 12px and they separate.
- **Shadows go after the goo:** `filter: url(#msg-goo) drop-shadow(...)`. A shape's own outer `box-shadow` inside the goo smears into a halo, so fused shapes use inset hairlines only.
- **Stay inside the filter region.** The filter clips to its region (`x/y -10%`, `130%` tall). Anything that sticks far out of the container (a tall menu) lives outside it in its own filtered stage (the model menu's `.model-menu-stage`) or, since 2026-11-18, every menu that rests on the composer (model picker, permissions, the @ and / lists) is a `.model-menu` in its own `.model-menu-stage`.
- **Containing block.** A filtered element becomes the containing block for `position: fixed` descendants; keep fixed popovers out of it.

## Motion

### Optical layers across the chat and sidebar (2026-11-17)

Glass samples the already-painted layers below it. A sidebar preview must therefore own a backdrop in the shared page stack, outside filtered rail ancestors; a translucent fill alone cannot refract chat text. `.rail-glass` supplies that backdrop for usage, queue, update, project and Recent previews. The rail keeps the sharp labels and icons above it. When multiple previews are eligible, the pointer's preview takes precedence over keyboard focus elsewhere.

| Plane, back to front | Surface | Fusion rule |
|---|---|---|
| Chat content | Transcript, message bubbles and their action docks | A bubble and its dock share one contour |
| Lower composer slab | Composer plus queue/attachments | Same-plane buds share the dock silhouette |
| Upper composer slab | Composer plus model menu | Menu fuses into this slab, refracting the lower queue |
| Dialogs (z50) | Settings, Loops, history sheets | Controls sit on the sheet; content remains sharp |
| Sidebar lens (z54) | Open sidebar preview's backdrop | The source control and expanded card form one continuous footprint |
| Sidebar labels (z55) | Preview text, controls and source icon | Above their own lens, so they are never refracted by it |
| Viewer/editor overlays (z1000/1100) | Image preview and markup | Above the sidebar and chat |

Touching members on the same optical plane must use one silhouette, avoiding doubled tint and internal rims. Overlaps between different planes remain separate: the upper glass bends the lower content instead of fusing with it. This is an explicit surface relationship, not a rule that merges unrelated controls merely because their CSS z-index matches.

Settings use a restrained version of this hierarchy: the dialog is the glass sheet, while cards and controls are quiet surfaces on it. Use neutral tint, subtle card hairlines and matte controls; avoid coloured sheet washes, repeated rim lighting, bevels and glow on every nested element. Selection and keyboard focus must remain clear in both themes.

During sidebar emergence the shared backdrop uses a small ordinary blur. Once dimensions settle for 100ms it uses the cached lens map, with clear interior and curved-edge displacement. No lens map is built per animation frame, and the geometry-follow loop stops after the transition. Active hover tint is 24% opaque so the interaction with the chat is visible; fallbacks keep the earlier material. High contrast and reduced transparency retain their existing presentation.

### Composer glass depth (2026-11-17)

The composer is two slabs thick. Queued/scheduled prompts occupy the lower slab; the model menu occupies the upper slab. Each slab independently fuses with the composer through the same goo silhouette. Never union the queue and menu into a single silhouette: that places both sets of text above one backdrop and makes them collide visibly.

Paint order, back to front:

| Order | Surface / content | CSS z-index |
|---|---|---|
| 1 | Lower glass: composer plus queued/scheduled prompts and other buds | 1 |
| 2 | Queue and bud content | 2 |
| 3 | Upper glass: composer plus model menu; blurs the queue beneath it | 3 |
| 4 | Composer input and controls, above both slabs | 4 |
| 5 | Model menu options and scroll controls | 45 |

`.compose-row` must not create a stacking context in glass mode: its children straddle the upper slab. Both slabs retain independent rim, bloom, shadow and refraction, with persistent SVG graphs during motion. High contrast and reduced transparency retain the existing opaque fallback. The upper slab samples the lower slab and queue text as its backdrop; it does not blur its own menu labels.

- **Emerge:** from sunk into the parent's edge and squashed (`translateY(60%) scale(0.7, 0.2)`, opacity 0) to full size on a spring, `cubic-bezier(0.34, 1.36, 0.64, 1)`, normally 240–320ms, `transform-origin` on the joining edge. The goo draws the neck stretching as it moves (`@keyframes island-bud`). Menus take 300ms; composer buds and scheduling pickers take 320ms. Keep immediate feedback and the spring curve rather than adding a reveal delay.
- **Retract:** the reverse, quicker and without overshoot (the model menu does this; the dock buds don't yet, they vanish on `hidden`).
- **Morph, don't swap:** when a bud changes state, animate the existing shape's size and content rather than removing it and spawning another.
- `prefers-reduced-motion`: no emerge or retract motion; shapes still fuse.

### One shape, one slot, menus on the upper slab (2026-11-18)

The composer is the squircle at every width; there is no pill state. The text spans the width on top and `.composer-bar` runs below it: `+`, model, agents and the permission chip on the left; the clock, dictate and the single stop/send slot on the right. Stop and send never show together and share the slot, so the bar does not reshuffle when a turn starts. While dictating, send is disabled until the recording is finished or cancelled (Esc).

Every menu that rests on the composer (model picker, permission picker, the @ file list, the / command list) is a `.model-menu` in its own `.model-menu-stage`, built by `createIslandMenu` in `media/main.js`. They share the upper slab (z 3 in the paint-order table above): the menu sits on the composer's top edge over any queued or scheduled prompts, fused to it by two fillets, blurring the queue beneath. `liquid-glass.js` draws the silhouette from the composer plus whichever `.model-menu` is open and re-measures when a list changes height. Only one is open at a time. The @ and / lists run nearly the composer's width (`placeListMenu`); the others centre on their button.

## Where it's applied (AI chat panel)

| Element | How |
|---|---|
| Your message + its time/copy/revert dock | `.msg-group-user`, the original |
| Model menu + the composer | `.model-menu-stage`: the menu rests on the composer's top edge, two concave fillets (`.model-menu-fillets`) plus a clipped root below the seam |
| Composer dock: queued turns, attachments tray and @-mention chips, all fused to the composer | `.compose-row` carries the goo; buds have `.island-bud` (`media/style.css`, "The dock is a Dynamic Island") |
| @ file list, / command list, permission menu | `.model-menu` with `.list-menu` / `.perm-menu`, same stage and upper slab as the model menu |

## Next candidates

Secondary glass surfaces (2026-11-17): scheduling pickers, preview/markup controls, Investigations forms/editors/status bars and attachment-file tiles share the `glass-ui.css` rim, sheen and recessed-control tokens. User-message bubbles and their fused action docks read `--user-bubble-rim` and `--user-bubble-sheen`; their fill stays continuous to avoid dark seams where translucent shapes overlap. These surfaces use paint-only glass lighting, with no added refraction filters or motion loops; image pixels, colour swatches and code/document content stay unmodified.

Sidebar hover motion (2026-11-17): queue previews open even for one chat. Hover cards use 240ms reveals with a 40ms label delay; project and Recent cards keep their final SVG dimensions and reveal through a rounded clip, avoiding path redraws during motion. Their material is 86% opaque, with fully opaque labels/icons; no new backdrop filters are added. Reduced-motion and high-contrast fallbacks remain in place.

Scrollbar treatment (2026-11-17): transcript and queued/scheduled prompts share a 12px native drag gutter with a 6px pill thumb, transparent track, subtle inset highlight and stronger hover/drag contrast. Tracks stop 18px before either end so they sit inside rounded shoulders rather than touching the glass rim or composer neck. The transcript runs under the dock, so under glass its track also stops 18px above the dock's top edge (`--dock-h`, the whole row including queued and scheduled prompts): the thumb follows the queue as it grows, up to the strip's own 34vh cap, and never ends up behind the frost, while the text still scrolls on beneath it. Scrollbars are surface details, above their own slab and below any overlaid menu; they add no backdrop filters, SVG maps or animation loops. High contrast retains native styling.

- In the chat panel: the Thinking pill's context gauge, the voice recording state, the scheduled-prompt countdown and retract animations for the dock buds.
- In the editor studio (`astro-integration/client/src/`): `LiquidGlassDefs.tsx` already defines a matching goo filter (`#liquid-gooey-meniscus`) that nothing uses yet. First targets: the Edit Mode dock and its menus, the text format toolbar with its dropdowns, the Done bar. The editor's top-layer law still applies (`z-index: 2147483647`).
