# NUKEHAUS — design & module contracts

A first-person raycast shooter (Wolfenstein 3D lineage) fused with Missile Command.

## Premise

Bunker Sieben. The launch-control intelligence MUTTER has decided the six cities
it was built to protect are the threat. It is firing your own arsenal at them.
You are the last warden. Fight down through the complex, and every time you reach
a **silo deck** the roof grinds open and you have to shoot the sky.

## The core mechanic

Flak does **no contact damage**. Only the airburst kills. So every shot needs three
axes, not two:

- **Azimuth + elevation** — mouse aim, like any shooter.
- **Range** — the fuse. Mouse wheel (or `[` / `]`). The reticle grows and a range
  ladder shows the armed distance. The shell detonates when it has flown that far.

A burst is a sphere. Warheads inside it die and their own payload cooks off,
producing a second, smaller sphere: **chains**. Missile Command's whole scoring
soul lives in that chain. Fuse within 12% of true range = `AIRBURST` bonus.

## Coordinate system

Real 3D throughout. `x`,`y` are the floor plane (1 unit = 1 map cell), `z` is height
(0 = floor, 1 = ceiling in corridors). The sky is the same space extended upward:
warheads spawn around z=70 at radius 80-110 from the map center, and the six cities
sit on the ground plane at radius ~62 in fixed compass directions. Everything the
raycaster draws is a real world position, so aiming, fuses, and chains are all
honest 3D distance checks.

## Pixel conventions

Everything is procedurally generated at load — no binary assets. All image buffers
are `Uint32Array` in canvas byte order (little-endian `0xAABBGGRR`). Build colors
with `rgba()` from `src/core/pixels.js`; never write raw hex. Alpha 0 means
"transparent" for sprites and "solid" is 255. Textures are 64x64 (`TEX`).

## Module contracts

### `src/engine/textures.js`
```js
export function buildTextures(): {
  atlas: Uint32Array,   // count * TEX * TEX pixels, texture i starts at i*TEX*TEX
  count: number,
  names: string[],      // index -> name, matches TEXTURE_ORDER below
  emissive: Float32Array // per texture, 0 = lit normally, 1 = ignores distance fog
}
```

### `src/engine/sprites.js`
```js
export function buildSprites(): {
  frames: Record<string, {w,h,data:Uint32Array}>  // keyed by frame id
}
```

### `src/audio/synth.js`
```js
export class Sound {
  async init()                     // must be called from a user gesture
  sfx(name, opts?)                 // opts: {vol, rate, pan, delay}
  music(track, opts?)              // 'title'|'prowl'|'siege'|'boss'|'victory'|'gameover'
  stopMusic(fadeSeconds?)
  setMaster(v) / setMusicVol(v) / setSfxVol(v)
  duck(amount, seconds)            // pull music down under voice
  get ctx() / get sfxBus()
}
```

### `src/audio/vox.js`
```js
export class Vox {
  constructor(ctx, destination)
  say(text, opts?)                 // formant-synth announcer, returns duration (s)
  get busy(): boolean
}
```

### `src/game/maps.js`
```js
export const MAPS: LevelDef[]      // see MAP FORMAT below
export function parseLevel(def): { w,h, walls:Uint8Array, meta:Uint8Array, ents:[], ... }
export function validateAll(): string[]   // [] when every level is sound
```

### `src/ui/title.js`
```js
export function drawTitle(ctx, w, h, t, state)
```

## MAP FORMAT

Levels are ASCII art. One char per cell. Row 0 is north (-y).

Walls / structure:
```
#  concrete        =  steel plate     !  hazard stripe    p  pipe bank
v  vent grate      t  tile            R  rust             B  sandbag
S  screen bank *   C  circuitry *     W  silo wall        N  warning sign
%  secret pushwall (looks like its neighbours)
-  blast door      1  red keydoor     2  blue keydoor     3  gold keydoor
E  exit elevator
```
`*` = emissive.

Floor / air:
```
(space)  normal floor      ^  open sky above this cell (silo deck)
_  grating floor           ,  dirt/rubble floor        :  blood-slick tile
```

Entities (stand on normal floor):
```
@  player start (exactly one, faces the first open neighbour)
a  Wrencher     b  Sparker      c  Bellows      d  Silo Wasp     e  Ordnance Priest
X  boss spawn
r  red key      u  blue key     g  gold key
h  small medkit H  big medkit   m  flak ammo    M  ammo crate
o  explosive barrel             D  pillar (blocks)     L  ceiling lamp
$  treasure                     T  wall flare (light source)
w  weapon pickup (see `weapons` array on the level, consumed in reading order)
Z  siege trigger — stepping here opens the roof and starts the wave
```

## LEVELS

1. **INTAKE** — teaching level. Corridors, wrenchers, one small siege.
2. **THE ORGAN LOFT** — pipe galleries, priests, two decks, blue key.
3. **SALT CATHEDRAL** — bigger, sandbag redoubts, wasps, gold key, heavy siege.
4. **THE FURNACE** — flesh/heat level, bellows units, a brutal deck.
5. **MUTTER** — boss arena, permanent open sky, the whole arsenal at once.

## CITIES

Six, on the horizon, each dies to one hit:
`VERITY`, `ASHGROVE`, `LOW SABBATH`, `CANDLEMARK`, `HOLLOW BAY`, `SAINT ERROL`.
They persist across levels. Zero cities = game over, no matter your health.

## TONE

Bleak, funny, profane. The bunker's PA system is a broken formant-synth voice
that keeps congratulating you. Enemies swear when they die. Never cruel about
real people or places; the target is an uncaring machine bureaucracy.
