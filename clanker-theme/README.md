# Clanker Paper & Ink

Two colour themes taken from [clankercontroller.com](https://clankercontroller.com/theme/), so the editor and the site look like one thing.

- **Clanker Paper** (light): warm paper `#eeebe3`, ink `#121212`, hard 1px ink rules, orange `#ff5a1f` for the one thing that matters on screen. The title bar and status bar are ink, like the dark band on the site.
- **Clanker Ink** (dark): the same page after dark. The site's own colours are used unchanged.

Pick one with **Preferences: Color Theme** (`Ctrl+K Ctrl+T`).

## How the colours were chosen

Surfaces, rules, the accent and the selection colour are the values from the site's stylesheet. Syntax text has to reach a 4.5:1 contrast ratio on the editor background. The site's orange, violet and blue do not do that on paper, so Clanker Paper darkens them until they do. Clanker Ink needs no change. The build script (`clanker-theme/build.mjs` in the repository) fails if any syntax colour drops below 4.5:1.

| Role | Paper | Ink |
|---|---|---|
| Background | `#eeebe3` | `#121212` |
| Text | `#121212` | `#eeebe3` |
| Keywords | `#b3431b` | `#ff5a1f` |
| Strings | `#995741` | `#d97757` |
| Functions | `#655ac4` | `#7a6cf0` |
| Types | `#256c9a` | `#2f9be0` |

## Font

The site uses JetBrains Mono for code. A theme cannot set a font, so to match, install it and set `"editor.fontFamily": "'JetBrains Mono', Consolas, monospace"`.

## Source and licence

[Clanker Controller repository](https://github.com/Alexander-Ettl/Clanker-Controller), folder `clanker-theme`. MPL-2.0.
