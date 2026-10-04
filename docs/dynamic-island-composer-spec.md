# Design decision: Dynamic Island docks (liquid-fused UI)

**Decided 2026-09-24, applies to the whole project.** UI that belongs to a control (a pill, a bubble, a dock) never floats beside it as a separate chip. It grows out of that control, stays fused to it while visible, and sinks back into it, the way iPhone's Dynamic Island extends into a larger rounded shape. The two read as one liquid body joined by a soft neck, not two boxes with a gap.

The reference implementation is the time / copy / revert dock under your own chat message (`.msg-group-user .msg-actions`): hover, and it drips out from under the bubble through a liquid neck.

## Technique: the goo filter

One SVG filter does the fusing (`#msg-goo`, defined once in `tools/ai-chat-panel/media/main.js`):

1. `feGaussianBlur` (stdDeviation 5) smears the shapes into each other;
2. `feColorMatrix` sharpens the alpha (`18a - 7`), so anything above roughly 40% coverage becomes one hard-edged silhouette, which is where the neck comes from;
3. `feComposite atop` draws the untouched original back on top, so text and icons never pass through the blur.

Put the filter on the **container** that holds the control and its buds, never on the pieces. Rules that make it work:

- **Opaque, identical fill.** Every fused shape uses the same charcoal (`rgb(26, 28, 34)`: message bubbles, model menu, the composer dock). The threshold works on alpha, so translucent glass breaks it, and a `backdrop-filter` can't see through a filtered ancestor anyway.
- **Small gaps.** Shapes 4 to 8px apart fuse through a neck; wider than about 12px and they separate.
- **Shadows go after the goo:** `filter: url(#msg-goo) drop-shadow(...)`. A shape's own outer `box-shadow` inside the goo smears into a halo, so fused shapes use inset hairlines only.
- **Stay inside the filter region.** The filter clips to its region (`x/y -10%`, `130%` tall). Anything that sticks far out of the container (a tall menu) lives outside it in its own filtered stage (the model menu's `.model-menu-stage`) or unfiltered (`.mention-menu`, fixed-positioned).
- **Containing block.** A filtered element becomes the containing block for `position: fixed` descendants; keep fixed popovers out of it.

## Motion

- **Emerge:** from sunk into the parent's edge and squashed (`translateY(60%) scale(0.7, 0.2)`, opacity 0) to full size on a spring, `cubic-bezier(0.34, 1.36, 0.64, 1)`, about 0.5s, `transform-origin` on the joining edge. The goo draws the neck stretching as it moves (`@keyframes island-bud`).
- **Retract:** the reverse, quicker and without overshoot (the model menu does this; the dock buds don't yet, they vanish on `hidden`).
- **Morph, don't swap:** when a bud changes state, animate the existing shape's size and content rather than removing it and spawning another.
- `prefers-reduced-motion`: no emerge or retract motion; shapes still fuse.

## Where it's applied (AI chat panel)

| Element | How |
|---|---|
| Your message + its time/copy/revert dock | `.msg-group-user`, the original |
| Model menu + the composer | `.model-menu-stage`: the menu rests on the composer's top edge, two concave fillets (`.model-menu-fillets`) plus a clipped root below the seam |
| Composer dock: queued turns, attachments tray, @-mention chips, context warning, all fused to the pill | `.compose-row` carries the goo; buds have `.island-bud` (`media/style.css`, "The dock is a Dynamic Island") |

## Next candidates

- In the chat panel: the @-mention menu as a bud of the dock (needs its own stage like the model menu); the Thinking pill's context gauge; the voice recording state morphing the pill itself; the scheduled-prompt countdown; "Compacting…" as the context warning's next state; retract animations for the dock buds.
- In the editor studio (`astro-integration/client/src/`): `LiquidGlassDefs.tsx` already defines a matching goo filter (`#liquid-gooey-meniscus`) that nothing uses yet. First targets: the Edit Mode dock and its menus, the text format toolbar with its dropdowns, the Done bar. The editor's top-layer law still applies (`z-index: 2147483647`).
