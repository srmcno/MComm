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

Every pixel, every sound effect and every note of music in this game is
generated from code at load time. There are no image files. The one exception
is recorded sound: the cast's lines were recorded by voice actors (ElevenLabs)
and ship inside the game as small clips, as does the chainsaw's engine. A line
nobody recorded is a subtitle; no synthetic voice ever reads one out.

## Play it

**<https://srmcno.github.io/MComm/>**: the single-file build, published from
`main` on every push. Click once to wake the audio, then take the mouse.

## If it will not start

Add `?safe` to the address (<https://srmcno.github.io/MComm/?safe>). Safe Mode
skips the GPU effects chain, audio and controller polling, so it runs anywhere
a canvas does. If the game ever fails to boot, the error screen offers Safe
Mode and a **Copy details** button with the browser, GPU and the stage loading
reached; `NUKEHAUS_DIAG()` in the console prints the same thing.

## Run it locally

Any modern browser. It needs to be served over HTTP (it uses ES modules), not
opened as a `file://` URL.

```
python3 -m http.server 8080
```

The built single file (`dist/nukehaus.html`, via `node tools/bundle.js`) has no
module loading and no external requests, so that one *does* open from `file://`.

Then open <http://localhost:8080>. Click once to wake the audio, and go.

### Or as one file

```
npm install && node tools/bundle.js
```

writes `dist/nukehaus.html`: the entire game (engine, art, levels, music,
voice) in a single ~14 MB HTML file (about 2 MB of game and 12 MB of recorded
voice) that makes no external requests. Open it directly, mail it to someone,
put it anywhere.

Mouse look uses pointer lock where the browser allows it. Where it doesn't (an
embedded frame, a browser setting, a user who said no) the cursor steers the
view instead, so the game plays either way.

Tested in Chromium. Runs comfortably at 60fps on Apple silicon; the renderer
adapts its internal resolution to whatever hardware it lands on.

## The mechanic

Point at it and pull the trigger. On the deck, **THE WIDOW** is a hitscan hand
cannon: bottomless, loud, and a round to the head does more than double. When
the roof grinds open the Widow goes back in its holster and **THE SPLITTER**,
the anti-missile gun, comes up on its own. When the sky is clear you get the
Widow back.

Flak shells carry a **proximity fuse**. They burst at their closest pass to the
first thing they meet: a warhead, a mutant, a wall. So the sky is not about
range, it is about **lead**. When a warhead is in your sights the ranger paints
a bracket on the **intercept point** (not on the warhead, on where it is going
to be). Put the cross on the bracket and it turns green; fire, and the shell
meets it. A shell that bursts right on its target is a `BULLSEYE`, worth double.

A warhead caught in a burst cooks off its own payload, and that second burst is
**bigger than the shell that lit it**. Warheads arrive in salvos, so a burst
placed in the middle of a flight cascades. Chains are where the score is.

## Controls

```
W A S D / arrows   move                SHIFT     run
mouse              look                LMB       fire
wheel, Z / X, [ ]  change weapon       1 - 7     pick a weapon
V, RMB or MMB      THE BOOT            B or G    pipe bomb (again to detonate)
SPACE / F          use: doors, vending machines, lockers, drawers, consoles,
                   the pinball machine, the toilet (Duke rule)
TAB / M            automap             ESC / P   pause
```

### Controllers

Plug in an Xbox or PlayStation pad and it is picked up on its own: the on-screen
prompts switch to that pad's own glyphs.

```
left stick  move          right stick  look         L2/LT  fine aim
R2/RT       fire          Y/△ or R3    the boot     X/□    pipe bomb
A/✕         use           B/○          next weapon
D-pad       weapons       LB/RB        weapons      START  pause
```

Sticks use a squared response curve with deadzones, the triggers are analog, and
rumble fires on shots, kicks, damage and explosions.

## The arsenal

| | | |
|---|---|---|
| **THE BOOT** | always in hand | No ammo, no reload, its own button. Shoves things. Hard enough into a wall and the wall finishes the job. |
| **THE WIDOW** | hand cannon | Hitscan and bottomless. Pops heads. Cannot reach the sky. |
| **THE SPLITTER** | triple flak | The anti-missile gun, and it comes up on its own when the roof opens. Three shells that burst on whatever they pass, missiles and mutants alike. |
| **THE NAILDRIVER** | rivet chaingun | A real machine gun: a heavy chained thump with a sub under it, a hard kick, and rounds that take limbs off. For the things walking on your deck. Hopeless against the sky. |
| **THE HALO** | ring launcher | Blooms into a ring of bursts at the first thing it meets. Sweeps a whole altitude. |
| **PIPE BOMBS** | thrown | They bounce, settle, and tick faster as they run down. Press again to detonate. One bursting in the sky counts as flak. |
| **DEADMAN'S SWITCH** | you don't want to know | Scrubs the sky. Scrubs your instruments for six seconds too. |
| **THE SEVERANCE** | diamond-chain saw | Slot 7, lying in the first corridor of floor one. No ammo. Hold fire and it bites. See below. |

Punting a live pipe bomb with the boot is available and inadvisable.

**THE SEVERANCE** is a concrete saw somebody left in the corridor, and the chain
is dull. Hold fire and it grinds through whatever is in front of it: furniture,
doors, mutants, with the noise to match. Sometimes a mutant catches on the
teeth and hangs there, screaming complaints at you in the staff voice while the
blade works up to it. Keep the trigger down and it bites through. Aim high and
the cut runs down the middle, aim low and it goes across the waist; either way
you get two halves, spurting, that land on the floor separately. **V** boots
the victim off the blade, letting go of the trigger or changing weapon slides
him off, and what you hung is still standing there afterwards, cross.
Its engine is recorded (ElevenLabs sound effects, in `src/audio/sawpack.js`): an
idle and a flat-out loop crossfaded on the throttle, and the chain in meat,
played on their own high-passed path so a saw held for ten seconds does not
squash every other sound in the game. It goes through a desk in about a third of
a second.

The guns are built as real perspective geometry and held in real hands: the
barrel runs away from you toward the crosshair, the slide kicks back, brass
flips out, and the boot you kick with is your own boot, seen from above.

## Taking them apart

Parts come off where they are hit, and they come off a lot. A Widow round at the
hat pops the head; a nail to the knee takes the leg; the Splitter at close range
takes two or three things at once; a pipe bomb takes most of the rest and
throws what is left. Hardigan has something to say about most of it, and now
and then Ilsa or MUTTER has something to say about him.
Losing a part does not have to be fatal, and it is rarely dignified:

- **No head:** the body sprints a panicked zigzag with a fountain where the
  head was, bumps into things, and falls over two or three seconds later.
- **One leg:** it hops. **No legs:** it crawls, and it is still coming.
- **No arms:** it has to improvise, and it does.

Everything that comes off is a physics object. Heads, arms and legs fly,
spin, bounce off walls, roll and settle in their own blood, and stay there.
The boot punts them (a long punt of a head is scored accordingly). Bodies
launched by blasts tumble, slam into walls, leave a smear, and bowl over the
ones behind them. Spent brass bounces on the deck.

## Breaking things

The furniture is not painted, it is built: every desk, chair, locker, vending
machine, toilet and server rack is a small model of boxes, cylinders, cones
and spheres with real materials (wood with its grain along the plank, office
steel worn back to bare metal at the edges, fabric, porcelain, lit green
phosphor). It is drawn as real 3D geometry, not a picture: each model is cut
into triangles whose textures are baked from those materials with the ceiling
light's shadows, ambient occlusion where parts meet and bevelled edges, and the
renderer draws them with a depth buffer. Walk round a desk and it stays put
while you see its side, then its back; a locker that goes over really falls
flat on its face, and a chair you kick tumbles end over end. It stands with its back to
the wall it was put against and its front to the room, the chair is turned to
its desk, the pews face the altar, and each room has what that kind of room
would have: an office has desks with a filing cabinet, a bin and a plant; a
washroom has sinks and a mop bucket; a store room has shelving, gas bottles
and a workbench; a machine room has racks of tape drives and piles of dead
monitors; the chapel has candelabras and a lectern; the meat locker has
butcher's blocks.

Everything with a body has hit points and a material, and comes apart the way
it would. Round, boot or blast:

- **Light things** (chairs, bins, cones, plants, a coat stand, the TV cart, a
  cable reel) are shoved by rounds, thrown by blasts and hoofed across the
  room by the boot. They tumble, bounce off the walls, smash if they hit one
  hard enough, and hurt whatever they land on. Walk into one and it goes
  where you are going. A kicked cable reel rolls, and bowls people over.
- **Tall things** (lockers, filing cabinets, the vending machine, bookshelves,
  shelving, server racks, candelabras) rock when you kick them and go over on
  the second boot, forward, onto whoever is standing in front, which may be
  you. A blast knocks them over too. Whatever is under one when it lands is
  flattened, furniture included. A kicked canteen table flips onto its side.
- **Broken things** throw their parts: planks, drawers, bent sheet steel,
  books, cans, monitors, circuit boards, shards of porcelain. They bounce,
  spin and stay on the floor, and the next blast throws them again. A desk
  sprays its paperwork, a filing cabinet its files, a vending machine its cans
  and foam, a photocopier a cloud of toner, a butcher's block its meat.
- **Things under pressure**: shoot a **gas bottle** and it either screams off
  across the room like a rocket and goes up where it lands, or stands there
  venting fire until the rest of them go with it. An **extinguisher** shot or
  kicked flies round the room on its own foam. A **server rack**, a **console**
  or a **generator** that breaks arcs into whoever is nearest, and a generator
  full of diesel explodes.

What is left is the model's own wreck: snapped, collapsed, scorched and
spilled. Solid furniture stops a bullet like a wall did, but stops being a
wall once it is gone or lying down. Every break goes on the invoice
(**PROPERTY DAMAGE** on the floor card), and MUTTER has opinions on it.

The building takes it too. Rounds leave holes in the walls, blasts leave soot
and cracks, and the thin walls come down: an office partition, a tiled wall, a
salt wall, a sheet of rusted iron, a block of concrete between two rooms can be
blown through, and the office board can be sawn through with THE SEVERANCE. A
wall only comes down where both sides were already reachable without a key,
so a hole makes a short cut, never a way round a locked door or into a secret.
Strip lights can be shot out, one tube at a time, and the room goes darker.
Shoot a pipe and it lets its steam out, which cooks whoever stands in it.

Some of it can be used, with **SPACE / F**, and a prompt says so when you are
facing one:

- **Vending machines** take a coin. Most of the time you get a soda that heals
  you when you walk over it; sometimes it eats the coin and jams (kick it),
  sometimes it pays out. A kick will also shake a can loose. Shoot it and it
  empties itself over the floor.
- **Water coolers** are a drink of water, five times, and a **sink** will wash
  your hands. **Lockers** open once and have ammo, a first aid kit, loose
  change or gym socks in them. **Filing cabinets and desks** have paperwork,
  and now and then something worth having in the drawer. The **photocopier**
  makes copies of your face, then of your backside.
- **Consoles** can be hacked: half the time they hand over the floor plan (the
  automap fills in), half the time MUTTER says no. The **pinball machine** pays
  points, or tilts.
- **Toilets** are a medkit with a flush. Shoot one and it turns into a
  fountain. **Ceiling lamps** can be shot out.
- **Crates, shelving, pallets and workbenches** may have supplies in them.
  Barrels, as ever, explode.

## Writing on the walls

Blood that hits a bare wall is sometimes a word. Once in a great while a splash
spells something (FUCK, SHIT, worse) in dripping capitals at the height it
landed, at most five times on a floor.

And somebody else writes there, too. **The Scribe** is a stick figure who is
too tall for the ceiling and has been in the bunker a great deal longer than
you have. He turns up in front of a wall every minute or two, writes a short
message on it in blood (a finger, a letter at a time, drips and all), giggles
in a high voice, and is gone. Sometimes he does it invisible and you only see
the words arrive. He never touches you and cannot be hit: a shot that passes
through him makes him laugh and go. If you get close he finishes in a hurry.
The writing is a real layer on the wall face that the raycaster blends in per
pixel (`src/game/scrawl.js`), so it sits in the light and fog like the wall does.

## What is down there

The bunker's staff are still on shift, after a fashion. Four of them are no
longer staff, and they are not in the map data. They come through the walls on a
per-floor schedule, always out of your line of sight, and the mix worsens as you
descend.

- **GHOUL**: the day shift, on all fours now, jaw unhinged. Rears up to strike.
- **STALKER**: a bear trap with a gallop. It lunges, and it is faster than you.
- **HOWLER**: mandibles that peel open around an acid gullet. Lobs on an arc.
- **GORGER**: a translucent sac of something boiling. It bursts when it dies and
  leaves a cloud that eats whatever is standing in it.
- **MAW**: a wall of fused screaming bodies. One per deep floor.

## The bunker

Five levels: **INTAKE**, **THE ORGAN LOFT**, **SALT CATHEDRAL**, **THE FURNACE**,
and **MUTTER**. Each is a Wolfenstein-shaped maze of keycards, blast doors and
pushwall secrets, opening onto **silo decks** where the roof grinds back and the
sky fills up.

The six cities on the horizon (VERITY, ASHGROVE, LOW SABBATH, CANDLEMARK,
HOLLOW BAY, SAINT ERROL) persist across the whole game. Each takes two hits:
the first leaves it burning and still worth defending, the second finishes it.
Lose all six and the run is over regardless of your health.

They do not heal on their own, but score rebuilds them. Every 15,000 points the
machine repairs the worst-hurt city and explains that this is not a
contradiction. That is Missile Command's bonus city, and it is the difference
between a hard game and a hopeless one.

Not everything in the sky is aimed at a city. About a quarter of the arsenal is
coming for the complex you are standing on.

No two stretches of wall are the same. Every wall, floor and ceiling cell picks
from a set of variants (stains, bullet holes, graffiti, posters, fuse boxes,
screens showing radar, error dialogs and a fish tank, a whiteboard of sales
figures that only goes one way, a wall phone off the hook, a sign asking you
not to punch the machine, and the dent that made it necessary), each floor has its own
palette, tint and columns, and the rooms are dressed with what a bunker staff
leaves behind (see **Breaking things**), and the staff themselves. The
toilets work, in the Duke tradition.

## How it is built

```
src/core/       pixel format, maths, input
src/engine/     raycaster, WebGL post chain, sky dome, procedural textures,
                sprites, weapon viewmodels, asset loader
src/game/       level runtime, player, weapons, enemies, the sky war, particles
src/audio/      Web Audio music + SFX synthesiser, voice casting, formant voice
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
- **Solid 3D furniture.** The models (`src/engine/propmodels*.js`) are baked
  into textured triangle meshes (`propmesh.js`) while the briefing card is up,
  and drawn by a small software rasterizer (`meshdraw.js`) with near-plane
  clipping, perspective-correct texturing, the room's light grid sampled per
  vertex and a per-pixel depth buffer that the billboards drawn after it test
  against, so staff are hidden behind a desk they are behind. Wrecks and
  opened lockers are baked in the gaps between frames when first needed. The
  old ray-traced pictures (`propstudio.js`) remain only as a fallback.

The software framebuffer goes to the GPU once per frame, where a WebGL2 chain
does two-level bloom, chromatic aberration, barrel warp, aperture-grille
scanlines, vignette, grain and the screen-wide flash and damage tints. If WebGL2
isn't available it falls back to a plain 2D blit and keeps playing.

Internal resolution adapts to the real frame interval, so it stays at 60fps on
modest hardware and sharpens up when it can.

## Tests

```
node tools/playtest.js            # 115 gameplay assertions in a real browser
node tools/audio-integration.js   # static coverage + live audio graph measurement
node tools/speech-check.js        # voice casting, captions, timing, fallback (mocked browsers)
node tools/scrawl-check.js        # the wall messages: font coverage, fit, curses, faces
node tools/props-check.js         # furniture models, facing, routes, breakable walls
node tools/props-tour.js          # photographs the furniture in the game (no asserts)
node tools/campaign.js [0|1|2]    # a bot plays the whole game and reports balance
node tools/smoke.js               # boots, drives the UI, screenshots, frame cost
node tools/beauty.js              # composes specific scenes and photographs them
node tools/gore-shots.js          # stages dismemberment and physics scenes and photographs them
node tools/verify-bundle.js       # boots dist/nukehaus.html and plays it
node tools/preview-textures.js / preview-sprites.js / preview-vm.js / preview-maps.js
```

`playtest.js` drives the actual game systems and checks the things that matter:
that a flak shell bursts on the warhead it passes and not on one it misses, that
one Widow round hurts and a headshot hurts double, that a burst chains through a
flight, that a shell put right on a warhead pays double, that the roof opening
hands over the Splitter and the sky closing hands back the Widow, that one leak
burns a city and two destroy it, that keycards gate their doors, that a wave can be fought
and cleared, that every level is fully reachable with live collision in place,
and that two minutes of continuous combat leaks no memory and produces no NaN.

It also drives a **synthetic standard-layout gamepad** through look, movement,
the trigger, the boot and the weapon buttons, so controller support is covered by the
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

## The soundtrack

Original 90s shooter metal, played by a synthesized band: double-tracked
rhythm guitars through a modelled amp and cabinet, a lead guitar with bends,
vibrato and pinch harmonics, a picked bass locked to the kick, and a full kit
with double-kick runs. Tempos run from 136 BPM on the title to 186 in the boss
fight, and the siege track thickens as the barrage does.

## The voices

**The recorded cast.** The lines heard most (the story on every floor, the gore
quips, the kills, the sky, the city losses, MUTTER reading your file, the doors,
the crates and the chain reactions) were recorded with ElevenLabs: Hardigan is
"John Texas", a deep gravelly American; Vance is "German Petra", English with a
hard German accent; MUTTER is "Daniel", a steady British broadcaster; and the
staff on the saw are "Dexter Glitch", a nervous man who has read the safety
manual twice. There are 408 takes, about 47 minutes of them (172 Hardigan, 177
MUTTER, 40 Vance, 19 on the saw), covering 108 of the game's 126 line pools. The
takes are trimmed, levelled to one loudness and stored as mono MP3 in
`src/audio/voicepack.js`: the first 163 at 32 kbps, the rest at 24 kbps (Vance,
who is on a band-limited radio, at 16 kbps and 16 kHz) to keep the file small.
`src/audio/acted.js` plays them through Web Audio, Vance through a radio
band-pass and MUTTER with a faint metallic comb. A line that has takes plays one
of them (never the same one twice running, and the right one for the city a line
names: every city has four takes of how it burns and four of how it is lost, so
a city that burns again says something new). A floor opening, or one of
Hardigan's distracted moments, is only played when the whole exchange was
recorded, so no scene switches voices halfway. Anything without a take is a
subtitle only: the game never reads a line out in a synthetic voice. **CALIBRATION
> VOICE** shows RECORDED CAST, or OFF.

`src/audio/speech.js` can still speak unrecorded lines (its `recordedOnly`
option, which the game turns on, is what stops it) through the browser's own
speech engine,
which on any desktop or phone is far easier to follow mid-firefight than
anything synthesised in a few kilobytes. Each character is cast from whatever
voices the machine offers, by language, apparent gender and quality: Hardigan
gets the deepest American man available (Edge's Davis or Guy, SAPI David, the
Mac's Alex), Vance gets a German voice reading the English script, which is the
cheapest real accent there is, and MUTTER gets a measured British man pitched
into the basement, with the old formant synthesiser murmuring underneath. No
two characters share a voice while there is an alternative. Durations are
estimated from syllables and rate, because `onend` is not to be trusted.

Whoever is hanging on the saw is a fourth voice, the staff member, recorded too
(19 takes).

The formant synthesiser in `src/audio/vox.js` is the original voice, kept in
the code but no longer offered: all three characters are the same formant
synthesiser wearing different vocal
tracts. Each voice scales the formant targets rather than just the pitch, which
is what actually separates a register: Hardigan's tract is ~12% longer and his
F2 sits near 340/1664 Hz on an /eh/, MUTTER sits at 492/1875, and Vance (heard
over a radio, band-limited to 400 Hz to 3.2 kHz with squelch at each end) sits at
715/2332. Measured spectral centroids in the live graph: 538, 945 and 1546 Hz.

## Records

Best score, best city count and furthest level are kept per difficulty in
`localStorage`, and shown on the title screen. If the browser refuses to store
anything, the cabinet simply forgets.

## With respect to

MISSILE COMMAND (1980) and WOLFENSTEIN 3D (1992), which between them worked out
most of what makes a game feel like this.
