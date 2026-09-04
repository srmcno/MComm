# NUKEHAUS

**Six cities. One doctor. One boot.**

A first-person raycast shooter in the Wolfenstein 3D lineage, fused with Missile
Command. The launch-control intelligence that runs Bunker Sieben has decided the
six cities it was built to protect are the threat, and it is firing your own
arsenal at them. It has also sealed the chief engineer in the reactor core, and
the radiation has done something unspeakable to the day shift.

You are **WARDEN B. HARDIGAN**, a 1996 action hero who has not noticed it is
2026. **DR. ILSA VANCE** built the interception system you are about to use, is
locked in the core, and is on the radio the whole way down with actual tactical
information, most of which you will ignore. **MUTTER** runs the bunker, is
unfailingly polite about the people it is killing, and has read your personnel
file. It considers your romantic history relevant operational context and will
tell you which of your exes lives in whichever city is currently on fire.

Every pixel, every sound and every note of music in this game is generated from
code at load time. There are no image files. There are no audio files. The
announcer is a formant synthesiser.

## Run it

Any modern browser. It needs to be served over HTTP (it uses ES modules), not
opened as a `file://` URL.

```
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Click once to wake the audio, and go.

### Or as one file

```
npm install && node tools/bundle.js
```

writes `dist/nukehaus.html`: the entire game — engine, art, levels, music,
voice — in a single ~865 KB HTML file that makes no external requests. Open it
directly, mail it to someone, put it anywhere.

Mouse look uses pointer lock where the browser allows it. Where it doesn't (an
embedded frame, a browser setting, a user who said no) the cursor steers the
view instead, so the game plays either way.

Tested in Chromium. Runs comfortably at 60fps on Apple silicon; the renderer
adapts its internal resolution to whatever hardware it lands on.

## The mechanic

Your flak does **no contact damage**. Only the airburst kills. That turns every
shot into a three-axis problem instead of a two-axis one:

| Axis | Mouse | Controller |
|---|---|---|
| Azimuth, elevation | Mouse | Right stick |
| **Range — the fuse** | Wheel, or `Z` / `X` | D-pad up/down |

The ring around your crosshair *is* the armed range. Dial out and it grows. When
a warhead is in your sights the ranger paints a lock bracket on the **intercept
point** — not on the warhead, on where it is going to be — with the true range
above it. Match your fuse to that and you get an `AIRBURST` bonus worth double.

A warhead caught in a burst cooks off its own payload, and that second burst is
**bigger than the shell that lit it**. Warheads arrive in salvos, so a burst
placed in the middle of a flight cascades. Chains are where the score is.

Auto-ranging will dial the fuse for you, and in a busy sky you will want it. It
does not pay the precision bonus. Turning it off doubles a clean burst.

## Controls

```
W A S D / arrows   move                SHIFT     run
mouse              look                LMB       fire
wheel, Z / X       fuse range          C / RMB   auto-ranging on/off
V or middle-click  THE BOOT            B or G    pipe bomb (again to detonate)
SPACE / F          open doors, shove suspicious walls
1 - 6              weapons             TAB / M   automap
ESC / P            pause
```

Manual fuses score double on a clean burst. Auto-ranging is there for when the
sky is too busy to count.

### Controllers

Plug in an Xbox or PlayStation pad and it is picked up on its own — the on-screen
prompts switch to that pad's own glyphs.

```
left stick  move          right stick  look         L2/LT  fine aim
R2/RT       fire          Y/△ or R3    the boot     X/□    pipe bomb
A/✕         use           B/○          auto-ranging
D-pad ↑↓    fuse          LB/RB        weapons      START  pause
```

Sticks use a squared response curve with deadzones, the triggers are analog, and
rumble fires on shots, kicks, damage and explosions.

## The arsenal

| | | |
|---|---|---|
| **THE BOOT** | always in hand | No ammo, no reload, its own button. Shoves things. Hard enough into a wall and the wall finishes the job. |
| **THE WIDOW** | flak pistol | Regenerates. Never leaves you empty. |
| **THE SPLITTER** | triple launcher | Three shells, one fuse. Brackets instead of threading. |
| **THE NAILDRIVER** | rivet chaingun | For the things walking on your deck. Hopeless against the sky. |
| **THE HALO** | ring launcher | Blooms into a ring of bursts at your fuse range. Sweeps a whole altitude. |
| **PIPE BOMBS** | thrown | They bounce, settle, and tick faster as they run down. Press again to detonate. One bursting in the sky counts as flak. |
| **DEADMAN'S SWITCH** | you don't want to know | Scrubs the sky. Scrubs your instruments for six seconds too. |

Punting a live pipe bomb with the boot is available and inadvisable.

## What is down there

The bunker's staff are still on shift, after a fashion. Four of them are no
longer staff, and they are not in the map data — they come through the walls on a
per-floor schedule, always out of your line of sight, and the mix worsens as you
descend.

- **GHOUL** — the day shift, on all fours now, jaw unhinged. Rears up to strike.
- **STALKER** — a bear trap with a gallop. It lunges, and it is faster than you.
- **HOWLER** — mandibles that peel open around an acid gullet. Lobs on an arc.
- **GORGER** — a translucent sac of something boiling. It bursts when it dies and
  leaves a cloud that eats whatever is standing in it.
- **MAW** — a wall of fused screaming bodies. One per deep floor.

## The bunker

Five levels: **INTAKE**, **THE ORGAN LOFT**, **SALT CATHEDRAL**, **THE FURNACE**,
and **MUTTER**. Each is a Wolfenstein-shaped maze of keycards, blast doors and
pushwall secrets, opening onto **silo decks** where the roof grinds back and the
sky fills up.

The six cities on the horizon — VERITY, ASHGROVE, LOW SABBATH, CANDLEMARK,
HOLLOW BAY, SAINT ERROL — persist across the whole game. Each takes two hits:
the first leaves it burning and still worth defending, the second finishes it.
Lose all six and the run is over regardless of your health.

They do not heal on their own, but score rebuilds them. Every 15,000 points the
machine repairs the worst-hurt city and explains that this is not a
contradiction. That is Missile Command's bonus city, and it is the difference
between a hard game and a hopeless one.

Not everything in the sky is aimed at a city. About a quarter of the arsenal is
coming for the complex you are standing on.

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
node tools/playtest.js            # 40 gameplay assertions in a real browser
node tools/audio-integration.js   # static coverage + live audio graph measurement
node tools/campaign.js [0|1|2]    # a bot plays the whole game and reports balance
node tools/smoke.js               # boots, drives the UI, screenshots, frame cost
node tools/beauty.js              # composes specific scenes and photographs them
node tools/verify-bundle.js       # boots dist/nukehaus.html and plays it
node tools/preview-textures.js / preview-sprites.js / preview-vm.js / preview-maps.js
```

`playtest.js` drives the actual game systems and checks the things that matter:
that contact alone does not kill, that a burst chains through a flight, that one
leak burns a city and two destroy it, that a hand-dialled fuse pays double and
auto-ranging does not, that keycards gate their doors, that a wave can be fought
and cleared, that every level is fully reachable with live collision in place,
and that two minutes of continuous combat leaks no memory and produces no NaN.

It also drives a **synthetic standard-layout gamepad** through look, movement,
the trigger, the boot and the fuse, so controller support is covered by the
suite rather than by hope; and it checks the boot's shove and cooldown, wall
slams, pipe bombs from throw to detonation, mutants breaching in off camera,
each mutant's own attack, the radio queue never talking over itself, kill
streaks, and blood reaching the floor.

`campaign.js` is the balance instrument. A bot with perfect lead calculation and
no patience for anything else plays the whole game and reports, per level, how
long it took, what it cost in health, and how many warheads it let through. It
is how the flak collision bug was found: shells were bursting on the map
boundary, so the intercept rate was under half what it should have been and the
game was quietly unwinnable.

## The voices

All three characters are the same formant synthesiser wearing different vocal
tracts. Each voice scales the formant targets rather than just the pitch, which
is what actually separates a register: Hardigan's tract is ~12% longer and his
F2 sits near 340/1664 Hz on an /eh/, MUTTER sits at 492/1875, and Vance — heard
over a radio, band-limited to 400 Hz–3.2 kHz with squelch at each end — sits at
715/2332. Measured spectral centroids in the live graph: 538, 945 and 1546 Hz.

## Records

Best score, best city count and furthest level are kept per difficulty in
`localStorage`, and shown on the title screen. If the browser refuses to store
anything, the cabinet simply forgets.

## With respect to

MISSILE COMMAND (1980) and WOLFENSTEIN 3D (1992), which between them worked out
most of what makes a game feel like this.
