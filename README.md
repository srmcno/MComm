# NUKEHAUS

**The last six cities.**

A first-person raycast shooter in the Wolfenstein 3D lineage, fused with Missile
Command. You are the last warden of Bunker Sieben. The launch-control
intelligence that runs the complex has decided the six cities it was built to
protect are the threat, and it is firing your own arsenal at them.

Every pixel, every sound and every note of music in this game is generated from
code at load time. There are no image files. There are no audio files. The
announcer is a formant synthesiser.

## Run it

Any modern browser. It needs to be served over HTTP (it uses ES modules), not
opened as a `file://` URL.

```
cd nukehaus
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Click once to wake the audio, and go.

Tested in Chromium. Runs comfortably at 60fps on Apple silicon; the renderer
adapts its internal resolution to whatever hardware it lands on.

## The mechanic

Your flak does **no contact damage**. Only the airburst kills. That turns every
shot into a three-axis problem instead of a two-axis one:

| Axis | Control |
|---|---|
| Azimuth, elevation | Mouse |
| **Range — the fuse** | Mouse wheel, or `Z` / `X` |

The ring around your crosshair *is* the armed range. Dial out and it grows. When
a warhead is in your sights the ranger paints a lock bracket on the **intercept
point** — not on the warhead, on where it is going to be — with the true range
above it. Match your fuse to that and you get an `AIRBURST` bonus worth double.

A warhead caught in a burst cooks off its own payload, and that second burst is
**bigger than the shell that lit it**. Warheads arrive in salvos, so a burst
placed in the middle of a flight cascades. Chains are where the score is.

## Controls

```
W A S D / arrows   move                SHIFT     run
mouse              look                LMB       fire
wheel, Z / X       fuse range          C / RMB   auto-ranging on/off
SPACE / F          open doors, shove suspicious walls
1 - 5              weapons             TAB / M   automap
ESC / P            pause
```

Manual fuses score double on a clean burst. Auto-ranging is there for when the
sky is too busy to count.

## The arsenal

| | | |
|---|---|---|
| **THE WIDOW** | flak pistol | Regenerates. Never leaves you empty. |
| **THE SPLITTER** | triple launcher | Three shells, one fuse. Brackets instead of threading. |
| **THE NAILDRIVER** | rivet chaingun | For the things walking on your deck. Hopeless against the sky. |
| **THE HALO** | ring launcher | Blooms into a ring of bursts at your fuse range. Sweeps a whole altitude. |
| **DEADMAN'S SWITCH** | you don't want to know | Scrubs the sky. Scrubs your instruments for six seconds too. |

## The bunker

Five levels: **INTAKE**, **THE ORGAN LOFT**, **SALT CATHEDRAL**, **THE FURNACE**,
and **MUTTER**. Each is a Wolfenstein-shaped maze of keycards, blast doors and
pushwall secrets, opening onto **silo decks** where the roof grinds back and the
sky fills up.

The six cities on the horizon — VERITY, ASHGROVE, LOW SABBATH, CANDLEMARK,
HOLLOW BAY, SAINT ERROL — persist across the whole game. Each one dies to a
single warhead and does not come back. Lose all six and it is over regardless of
your health.

## How it is built

```
src/core/       pixel format, maths, input
src/engine/     raycaster, WebGL post chain, sky dome, procedural textures,
                sprites, weapon viewmodels, asset loader
src/game/       level runtime, player, weapons, enemies, the sky war, particles
src/audio/      Web Audio music + SFX synthesiser, formant announcer
src/ui/         title screen, HUD, text rasteriser
```

The renderer is a software raycaster written for this game. It is a grid caster
in the classic mould, extended with the things this game actually needs:

- **Pitch** as a y-shear, which is an exact projection for an off-centre
  principal point, so walls, floors, sprites and sky all stay consistent while
  you crane your neck at the sky.
- **Half-height parapet walls** with real sky above them. Any wall touching an
  open-roof cell drops to parapet height automatically, which is what lets you
  stand on a silo deck and see the horizon without a portal renderer.
- **Coloured dynamic lighting** sampled at cell corners and bilinearly
  interpolated, so an airburst paints the concrete around you.
- **Sliding doors** on the cell mid-plane with proper jambs, and pushwall
  secrets.
- **Z-buffered billboards** carrying a real world height, so a warhead 90 units
  out and 60 up projects honestly.

The software framebuffer goes to the GPU once per frame, where a WebGL2 chain
does two-level bloom, chromatic aberration, barrel warp, aperture-grille
scanlines, vignette, grain and the screen-wide flash and damage tints. If WebGL2
isn't available it falls back to a plain 2D blit and keeps playing.

Internal resolution adapts to the real frame interval, so it stays at 60fps on
modest hardware and sharpens up when it can.

## Tests

```
node tools/playtest.js    # 28 gameplay assertions in a real browser
node tools/smoke.js       # boots, drives the UI, screenshots, reports frame cost
node tools/beauty.js      # composes specific scenes and photographs them
node tools/preview-textures.js / preview-sprites.js / preview-vm.js / preview-maps.js
```

`playtest.js` drives the actual game systems and checks the things that matter:
that contact alone does not kill, that a burst chains through a flight, that a
leaked warhead takes its city, that keycards gate their doors, that a wave can
be fought and cleared, that every level is fully reachable with live collision
in place, and that two minutes of continuous combat leaks no memory and produces
no NaN.

## With respect to

MISSILE COMMAND (1980) and WOLFENSTEIN 3D (1992), which between them worked out
most of what makes a game feel like this.
