// maps.js - NUKEHAUS level data.
//
// ZERO IMPORTS. Pure data plus pure functions, browser-safe ESM. Texture names
// are plain strings; the engine resolves them against its own atlas.
//
// Row 0 is north (-y). One character per cell. See LEGEND below for the full
// alphabet; `tools/preview-maps.js` renders every level as ANSI art and PNG.

// ---------------------------------------------------------------------------
// Textures the engine promises to build. Everything referenced here must be in
// this list - validateAll() enforces it.
// ---------------------------------------------------------------------------
const BASE_TEXTURES = [
  'CONCRETE', 'CONCRETE_CRACKED', 'STEEL_PLATE', 'STEEL_RIVET', 'HAZARD', 'PIPES',
  'VENT', 'TILE', 'TILE_BLOOD', 'RUST', 'SANDBAG', 'SCREENS', 'CIRCUIT', 'SILO_WALL',
  'WARNING', 'DOOR', 'DOOR_JAMB', 'DOOR_RED', 'DOOR_BLUE', 'DOOR_GOLD', 'ELEVATOR',
  'FLESH', 'FLOOR_CONCRETE', 'FLOOR_GRATE', 'FLOOR_TILE', 'FLOOR_DIRT', 'FLOOR_BLOOD',
  'CEIL_CONCRETE', 'CEIL_LAMP', 'CEIL_PIPES', 'CEIL_FLESH', 'FLOOR_DECK',
];
// Filled in below the variant table, which is where the rest are named.
export const VALID_TEXTURES = BASE_TEXTURES.slice();

// ---------------------------------------------------------------------------
// The alphabet. Every descriptor has a `type`:
//   'wall'   solid, blocks movement and sight, `tex` names its material
//   'door'   solid until opened, slides into the wall, `door` names its key
//   'secret' pushwall: solid, renders as its dominant neighbour, slides 2 cells
//   'floor'  walkable; may carry `floor` (texture), `sky`, `trigger`, `exit`,
//            `start` or `ent` (an entity standing on the level's default floor)
// A descriptor with no `floor` uses the level's floorTex; sky cells use its
// deckFloorTex.
// ---------------------------------------------------------------------------
export const LEGEND = {
  // --- walls ---------------------------------------------------------------
  '#': { type: 'wall', tex: 'CONCRETE', desc: 'concrete' },
  'X': { type: 'wall', tex: 'CONCRETE_CRACKED', desc: 'cracked concrete' },
  '=': { type: 'wall', tex: 'STEEL_PLATE', desc: 'steel plate' },
  '+': { type: 'wall', tex: 'STEEL_RIVET', desc: 'riveted steel' },
  '!': { type: 'wall', tex: 'HAZARD', desc: 'hazard stripe' },
  'p': { type: 'wall', tex: 'PIPES', desc: 'pipe bank' },
  'v': { type: 'wall', tex: 'VENT', desc: 'vent grate' },
  't': { type: 'wall', tex: 'TILE', desc: 'tile' },
  ':': { type: 'wall', tex: 'TILE_BLOOD', desc: 'tile, gone bad' },
  'R': { type: 'wall', tex: 'RUST', desc: 'rust' },
  'B': { type: 'wall', tex: 'SANDBAG', desc: 'sandbag stack' },
  'S': { type: 'wall', tex: 'SCREENS', desc: 'screen bank' },
  'C': { type: 'wall', tex: 'CIRCUIT', desc: 'circuitry' },
  'W': { type: 'wall', tex: 'SILO_WALL', desc: 'silo wall' },
  'N': { type: 'wall', tex: 'WARNING', desc: 'warning placard' },
  'F': { type: 'wall', tex: 'FLESH', desc: 'flesh' },
  '%': { type: 'secret', tex: null, desc: 'pushwall' },
  // --- doors ---------------------------------------------------------------
  '-': { type: 'door', door: 'free', tex: 'DOOR', desc: 'blast door' },
  '1': { type: 'door', door: 'red', tex: 'DOOR_RED', desc: 'red keydoor' },
  '2': { type: 'door', door: 'blue', tex: 'DOOR_BLUE', desc: 'blue keydoor' },
  '3': { type: 'door', door: 'gold', tex: 'DOOR_GOLD', desc: 'gold keydoor' },
  // --- floors --------------------------------------------------------------
  ' ': { type: 'floor', desc: 'floor' },
  '_': { type: 'floor', floor: 'FLOOR_GRATE', desc: 'grating' },
  ',': { type: 'floor', floor: 'FLOOR_DIRT', desc: 'salt drift' },
  ';': { type: 'floor', floor: 'FLOOR_BLOOD', desc: 'blood slick' },
  '^': { type: 'floor', sky: true, desc: 'open sky' },
  'Z': { type: 'floor', trigger: true, desc: 'siege trigger' },
  'E': { type: 'floor', exit: true, desc: 'exit elevator' },
  '@': { type: 'floor', start: true, desc: 'player start' },
  // --- entities ------------------------------------------------------------
  'a': { type: 'floor', ent: 'wrencher', enemy: true, desc: 'Wrencher' },
  'b': { type: 'floor', ent: 'sparker', enemy: true, desc: 'Sparker' },
  'c': { type: 'floor', ent: 'bellows', enemy: true, desc: 'Bellows unit' },
  'd': { type: 'floor', ent: 'wasp', enemy: true, desc: 'Silo Wasp' },
  'e': { type: 'floor', ent: 'priest', enemy: true, desc: 'Ordnance Priest' },
  'K': { type: 'floor', ent: 'boss', enemy: true, desc: 'MUTTER core' },
  'r': { type: 'floor', ent: 'key_red', key: 'red', desc: 'red key' },
  'u': { type: 'floor', ent: 'key_blue', key: 'blue', desc: 'blue key' },
  'g': { type: 'floor', ent: 'key_gold', key: 'gold', desc: 'gold key' },
  'h': { type: 'floor', ent: 'medkit_small', pickup: true, desc: 'small medkit' },
  'H': { type: 'floor', ent: 'medkit_big', pickup: true, desc: 'big medkit' },
  'm': { type: 'floor', ent: 'ammo', pickup: true, desc: 'flak ammo' },
  'M': { type: 'floor', ent: 'ammo_crate', pickup: true, desc: 'ammo crate' },
  'w': { type: 'floor', ent: 'weapon', pickup: true, desc: 'weapon pickup' },
  '$': { type: 'floor', ent: 'treasure', pickup: true, desc: 'treasure' },
  'o': { type: 'floor', ent: 'barrel', desc: 'explosive barrel' },
  'D': { type: 'floor', ent: 'pillar', desc: 'pillar' },
  'L': { type: 'floor', ent: 'lamp', light: true, desc: 'ceiling lamp' },
  'T': { type: 'floor', ent: 'flare', light: true, desc: 'wall flare' },
};

// ---------------------------------------------------------------------------
// Numeric wall ids. 0 is walkable; everything else indexes a solid cell.
// 1..19 static walls, 20 pushwall, 30..33 doors.
// ---------------------------------------------------------------------------
export const WALL_IDS = {
  '#': 1, 'X': 2, '=': 3, '+': 4, '!': 5, 'p': 6, 'v': 7, 't': 8, ':': 9, 'R': 10,
  'B': 11, 'S': 12, 'C': 13, 'W': 14, 'N': 15, 'F': 16,
  '%': 20,
  '-': 30, '1': 31, '2': 32, '3': 33,
};

/** Inverse of WALL_IDS: numeric id -> character. */
export const WALL_CHARS = Object.freeze(Object.fromEntries(
  Object.entries(WALL_IDS).map(([ch, id]) => [id, ch]),
));

export const SECRET_ID = 20;
export const DOOR_IDS = { free: 30, red: 31, blue: 32, gold: 33 };

export function isDoorId(id) { return id >= 30 && id <= 33; }
export function isSecretId(id) { return id === SECRET_ID; }

/** Facing, in radians: +x is east, +y is south. */
export const DIR = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 };

// ---------------------------------------------------------------------------
// ASCII. Authored with tools/design-maps.js; edit there and re-run it, or edit
// here by hand - the rows are the only source of truth the engine reads.
// ---------------------------------------------------------------------------
// <ascii:begin>
// INTAKE - 40x40
const ROWS_INTAKE = [
  '########################################',
  '####################WNWWWWWNW###########',
  '##RRRRRRRRRR########W^^^^^^^W#####==E===',
  '##R        R$H######W^^^h^^^W#####+T   =',
  '##R $   o  %  ######W^^D^^^^W#####+    =',
  '##R        R#WWWWWWWW^^^^^^^WWWWWW+    =',
  '##R   L    R#W^^^^^^^^^^^^^^^^^^^^=    =',
  '##R      m R#W^^^^^B^^^^^^^^B^^^^^= L  =',
  '##R        R#N^^M^^^^^^^^^^^^^^m^^-    =',
  '##RRR RRRRRR#W^^^^^B^^^^^^^^B^a^^^=    =',
  '###SS SSSSS##W^^^^^^^^^^^^^^^^^^^^=  H =',
  '###        ##WWWWWWWW^m^^^^^WWWWWW======',
  '### M    h #########W^^^^D^^WCCCCCCCCCC#',
  '###  b     #########W^^^^^^^WC M      C#',
  '###   L    ####vvvvvWWWWZWWWWC     a  C#',
  '###      b ####vM L ov#! !   %        C#',
  '### D      ####v  b  v#=-=$ MC      T C#',
  '######-#####pppv D D vp= =pppCCCC-CCCCC#',
  '#####p________T______________T_______p##',
  '#####p___________o____________b____m_p##',
  '#####p____m__________T_______________p##',
  '#####ppppppp pppppppppppppp pppppppppp##',
  '############-##############-############',
  '############ ############## ############',
  '######## $          B          tttttttt#',
  '########    L       B     L  m t      t#',
  '########         o       D     t Tw h t#',
  '####$  #    a                  t      t#',
  '####   %      BB        BB     -      t#',
  '####H  #                       t ;;;; t#',
  '########     D        o   a    t ;;a; t#',
  '######## h         L           t      t#',
  '########                       tt::::tt#',
  '################===-====################',
  '################=      =################',
  '################= L  T =################',
  '################=      =################',
  '################=  @   =################',
  '################=    h =################',
  '################========################',
];

// THE ORGAN LOFT - 48x48
const ROWS_ORGAN_LOFT = [
  '################################################',
  '############WNWWWWWWWWWWWWWWWWWWWWNW############',
  '##RRRRRRRRRRW^^^^^^^^^^^^^^^^^^^^^TW############',
  '##R       $ W^^^b^^^^^^D^^^^m^^^^^^======E==####',
  '##R         W^^^B^^^^^^^^^^^^^^B^^^=      $=####',
  '##R  b  D   W^^^^^^^WNWWWWWW^^^^^^^=T      =####',
  '##R   ppp   W^^^^^^^WWWWWWWW^^^^^^^=       =####',
  '##R   L p   W^M^^D^^WWWWWWWW^^D^^m^-       =####',
  '##RT       hW^^^^^^^WWWWWWWW^^^^^^^=    L  =####',
  '##R,,,,,    W^^^^^^^WWWWWWNW^^^^^^^= H     =####',
  '##R,,,,, a  W^^^B^^^^^^^^^^^^^^B^^^=       =####',
  '##R,M,,,    W^^^^^^H^^^^D^^^^^^^$^^=========####',
  '##R,,,,,    NT^^^^^^^^^^^^^^^^^^^^^N############',
  '##R%RRRRRR RWWWWWWWWWW=Z=WWWWWWWWWWW############',
  '##$ ######-###########= =#######################',
  '##H ###### ###########=2=###############SSSSSSSS',
  '######## L           T    T           L S      S',
  '########      D     a            D      S    e S',
  '########    b    B            B      w  -  L   S',
  '########  o      B            B         S      S',
  '########      D            e     D b    S $  m S',
  '########H              L               mS      S',
  '########vvvv###########-###### #####vvvvSSS%SSSS',
  '##################p$   __  h R-RR#########   ###',
  '##################p    L_    R  RRRRRR####$ H###',
  '#CCCCCCCCCCCCC####p  D __ D  Ro     $R####   ###',
  '#C$    L    hC##$      __    R    o  R##########',
  '#C e         C## L  e  __    R       R##########',
  '#C    D D    vvvvvv    __o   R  RRRRRR##########',
  '#C     u     -    -  D __ D  RT SSSSSS##########',
  '#C    D D    vvvvvv    __    R       S##########',
  '#C           C####pT   _a   TR    b MS##########',
  '#C     L   h C## H     __    R       S#WWWWWWWW#',
  '#CM          C##e    D __ D  -  SSSSSS#W^^^^^HW#',
  '#CC-CCCCCCCCCC####p   o__    R TRRRRRR#W^e^^^^W#',
  '##v Tpppp######M  p    __  e R       R#W^^^B^^W#',
  '##v  oLhp######   %    __    R    a  R#W^^^B^^W#',
  '##v   b p######$  p  D __ D  R  h    R#W^^^^^^W#',
  '##v    Mp#########p    _L    R  RRRRRR#W^^D^^^W#',
  '##v  ppppRRRRRRRRRp m  __    RL WWWWWWWW^^^^^^W#',
  '##v  vR oo       Rppppp-pppppR  W^^^m^^^^^^^^^W#',
  '##v mvR        M R=          R  W^^B^^^^^^^^^^W#',
  '##vT  R  a       R= L      L R  -Z^B^^^^^^^^D^W#',
  '###   -    L      -          R  W^^^^D^^^^^^^^W#',
  '######R          R=    @     R mW^^^^^^BB^^^^^W#',
  '###m  %       m  R= h     a  RRRW^m^^^^^^^^^^MW#',
  '###$  Rh        $R=        m =##NWWWWWWNWWWWWWW#',
  '######RRRRRRRRRRRR============##################',
];

// SALT CATHEDRAL - 52x52
const ROWS_SALT_CATHEDRAL = [
  '####################################################',
  '#################WNWWWWWNW#######WNWWWWWWWWWWWNW####',
  '#################W^^^H^^^W#######W^^^^^^H^^^^^m==E==',
  '#################W^^^D^^^W#######W^^^^^^^^^^^^^=T  =',
  '#RRRRRRRRRR######W^^B^^^^W#######W^^D^^^^^^^D^^=   =',
  '#R   L  D WWWWWWWW^^^^^^^WWWWWWWWW^^^^^^^^^^^^^=   =',
  '#R H  e   W^^d^^^^^^^^^^^^^^^^^^WW^^^^^BBBB^^^^=   =',
  '#R        W^^^^B^^^^^^^^^^^B^^^^WW^M^^^BBBB^^m^- L =',
  '#RT  M    -^M^^^^^^D^^^D^^^^^^m^NW^^^^^BBBB^^^^=   =',
  '#R        W^^^^B^^^^^^^^^^^B^^^^WW^^^^^^^^^^^^^=   =',
  '#R b    $ W^^^^^^^^^^^^^^^^^^m^^WW^^D^^^^^^^D^^= H =',
  '#R      D WWWWWWWW^^^D^^^WWWWWWWWW^^^^^^m^^^^^^=   =',
  '#RRRRRRRRRR######W^^^^B^^W#######Nd^^^^^^^^^^^^N====',
  '####M $##########W^^^m^^^W#######WWWWWWWWWW!Z!WW####',
  '####H  ##########WWWWZWWWW#################! !######',
  '####   #####NNNNNN###-############NNNNNNSSS!3!SSSSS#',
  '#XXXX%XXXXXXM    X       L       X     hS$  L    TS#',
  '#XM       $X     Xd             hX   w  S d       S#',
  '#X b     o X    D      D      D         S         S#',
  '#X    X L  X                      L     S     D D S#',
  '#X T  X    -  e    BB      BB          o-      g  S#',
  '#X  d X    X     L                  D   S     D D S#',
  '#X,,,,   a Xo   D      D      D         S         S#',
  '#Xh,,,     X     X               Xe     S m       S#',
  '#XXXXXXXXXXX b   X       m       X    b Sh   e   MS#',
  '#########################1##############SSSSSSSSSSS#',
  '##########T,,,,,,,,,,,X,,,,,,X,,,,,,,,,,,T##########',
  '##########,,,,,,,,,,o,X,,,,,,X,o,,,,,,,,,,##########',
  '##########               d                ##########',
  '#:::::::::    D    D            Dh   D    ttttttttt#',
  '#:$;;;;;h:           a                    tM     $t#',
  '#:;;r;;;;:  BBBBB        L                t       t#',
  '#:;;;;;;;:  B MbB        X                t   d   t#',
  '#:L      :    D    D    X X     D    D    t       t#',
  '#:   X   : L           o $ o            L t  L    t#',
  '#: d     :              X X          b    t       t#',
  '#:    T  :               X         B M B  -   D   t#',
  '#:       :    D    D     L      D  BBBBB  t     e t#',
  '#:   X   -                                t   D   t#',
  '#:       :        m           a           t       t#',
  '#:     d :               o                t       t#',
  '#: T     :  a D    D  X      X  D    D    t m     t#',
  '#:   X   :T,,,,,,,o,,,X,,,,,,X,,,,,,,,,,HTt     T t#',
  '#:       :###############-################t;;;;;;;t#',
  '#:M      :#########Xo,,,D,,D,,,mX#########t;;;;;;;t#',
  '#:  e    :#########X,,,,,,,,,,,,X#########tttt%tttt#',
  '#:     T :######H  X,,,L,,,,L,,,X############$  ####',
  '#::::%::::######   %,,,,,,,,,,,,X############  H####',
  '####$  #########M $X,,,,,@,,,,,,X###################',
  '####M H############X,h,,,,,,,a,,X###################',
  '###################X,,,,,T,,,,,,X###################',
  '###################XXXXXXXXXXXXXX###################',
];

// THE FURNACE - 56x56
const ROWS_FURNACE = [
  '########################################################',
  '#######WNWWWWWWWWWWWWWWWWWWWWWNW####WNWWWWWWWWWWWWWWWNW#',
  '#######W^m^^^^^^^^^H^^^^^^^^^^^WH $#W^M^^^^^^^^^^^^^^mW#',
  '#######W^^^^^^^^^^^B^^^^D^^^^m^WM  #W^^^^^^^^^^D^^^^^^W#',
  '#######W^^^B^^^^^^^^^^^^^^^B^^^==%==W^^^BB^^^^^^^^^^^^W#',
  '#######W^^^B^^^^^^^^^^^^^^^B^^^- T -Z^^^^^^^^^^^^B^^^^W#',
  '#######W^^^^^^^^^^^^^^^^^^^^^^^=====W^^^^^^^B^^^^^^^^^W#',
  '#######W^^^^^^^NWWWWWWWW^^^^^^^W####W^D^^^d^B^^^^^^^^^W#',
  '#######W^^^^^^^WWWWWWWWW^^^^^^^W####W^^^^^^^^^^^e^^^^^W#',
  '#######W^^D^c^^WWWWWWWWW^^d^D^^W####WWW-WWWWWW^^^^^^^^W#',
  '#######W^^^^^^^WWWWWWWWW^^^^^^^W###==== ====#W^^^^^^D^W#',
  '#######W^^^^^^^WWWWWWWWW^^^^^^^W###=      $=#W^^^^^^^^W#',
  '#######W^^^^^^^WWWWWWWWN^^^^^^^W###= L     =#W^^^^B^^^W#',
  '#######W^^^^^^^^^^^^^^^^^^^^^^^W###=       =#W^^^^^^^^W#',
  '#######W^^^B^^^^^^^^^^^^^^^B^^^W###=       =#W^^^^^d^^W#',
  '#######W^M^^^^D^^^^B^^^^^^^^^^^W###=       =#W^^^^^^^^W#',
  '#######N^^^^^^^^^^^m^^^^^^^^^M^N###=     H =#W^^^B^^^^W#',
  '#######WWWWWWWWWW!Z!WWWWWWWWWWWW###=T      =#W^D^^^^^^W#',
  '#################! !###############===E=====#NM^^^^^^HN#',
  '############FFFFF!1!FFFFFFFFFFFFFFF##########WWWWWWWWWW#',
  '############M       m   T     a   o#####################',
  '###########p b  D              ___ p####################',
  '###########p         c         ___ p####################',
  '###########p    pppp           ___ p####################',
  '###########p    pppp           _c_ p####################',
  '############    pppp     c     ___ #####################',
  '############T   pppp L    L    ___ #####################',
  '############ ___      oo   pppp   T#####################',
  '############ ___    D     Dpppp    #####################',
  '########H $# ___           pppp    FFFFFFFFFFFFFFFFFFF##',
  '########   % _c_    ;;;;;;;pppp    FM       L    o  $F##',
  '########M  # ___ L  ;;;;;;;   L    -     b           F##',
  '############ ___    ;;;a;;;      b F  d           d  F##',
  '##vvvpppppv#o             m    D  HF                 F##',
  '##v#######M#######-###-############F    D  FFFFFF  D F##',
  '##vL####  T  b      c  v###########F       F;e;;F    F##',
  '##p ######### #### ### v###########F       FT;;;F    F##',
  '##p #####o     h   ### v###########F    c  F;r;;Fb   F##',
  '##p ######### #### ### vM  ########F       F;;;;F    F##',
  '##pb    L    L####     %   ########F       F;;c;F  D F##',
  '##p #### ############# v$ H########F       FF-FFF    F##',
  '##p  m   #############av###########F    D            F##',
  '##po#### ############# v#####$ M###F  d            e F##',
  '##v     a       T  ###Lv#####   ###F      o          F##',
  '##v ##m####h####$#####mv#####H  ###FH       L       mF##',
  '#=v-vvvvvvvvvvvvvvvvvvvv######%!!!!FFFFF-FFFFFFFFFFFFF##',
  '#=____a___=#############  M      o  m            $    ##',
  '#=_L____h_=#############   b          D     a  B      ##',
  '#=________ppppppppppppp#       B               B    w ##',
  '#=________p    b  o         L  B          L        L  ##',
  '#=___@____- T        a                  B             ##',
  '#=________ppppppppppppp#           c    B         e   ##',
  '#=______T_=#############     D             o D       H##',
  '#=m_______=###################!!!!!!!!!!!!!!!!!!########',
  '#==========#############################################',
  '########################################################',
];

// MUTTER - 34x34
const ROWS_MUTTER = [
  '#############===N===##############',
  '#CCCCCC######= =E= =#######SSSSSS#',
  '#C   HC######=L   $=#######SH   S#',
  '#S M  C#WWWWW=== ===WWWWWW#S  M C#',
  '#Cm   CW^^^^^^^^^^^^^^^^^^WS   mS#',
  '#C  L  ^^^^^^^^^b^^^^^^^^^^  L  S#',
  '#C%CCC^^^^^^d^^^^^^^^d^^^^^^SSS%S#',
  '#$ WW^^^^D^^^^^BBB^^^^^^D^^^^WW $#',
  '#H W^^^^^^^^^^m^^^h^^^^^^^^^^^W H#',
  '##W^^^^^^^^^^D^^^^^^D^^^^^^^^^^W##',
  '##W^^^^^^^BB^^^^^^^^^^BB^^^^^^^W##',
  '##W^^^^^^^B^^^S^F^S^^^^B^^^^^^^W##',
  '##W^^D^^e^^^CC^^^^^^CC^^^e^^D^^W##',
  '##W^^^^^^^^^CC^T^T^^CC^^^^^^^^^W##',
  '##W^^^^^^^^^^^^^^^^^^^^^^^^^^^^W##',
  '##W^^^^B^^^^^^^^K^^^^^^^^^B^^^^W##',
  '##N^^^cB^m^^^^^^^^^^^^^^m^Bc^^^N##',
  '##W^^^^B^^^^^^^T^T^^^^^^^^B^^^^W##',
  '##W^^^^^^^^^CC^^^^^^CC^^^^^^^^^W##',
  '##W^^^^^^^^^CC^^^^^^CC^^XX^^^^^W##',
  '##W^^D^^e^^^^^S^^^S^^^^o^X^^D^^W##',
  '##W^^^^^^^B^^^^^F^^^^^^Bo^e^^^^W##',
  '##W^^^^^^^BB^^^^Z^^^^^BB^^^^^^^W##',
  '##W^^^^^^^^^^D^^^^^^D^^^^^^^^^^W##',
  '###W^^^^^^^^^^h^^^m^^^^^^^^^^^W###',
  '###WW^^^^D^^^^^BBB^^^^^^D^^^^WW###',
  '#SSSSS^^^^^^d^^^^^^^^d^^^^^^CCCCC#',
  '#S  L  ^^^^^^^^^b^^^^^^^^^^  L  C#',
  '#S    SW^^^^^^^^Z^^^^^^^^^WC    C#',
  '#CmM  S#WWWWW===-====WWWWW#C  MmS#',
  '#S   HS###M  =L    T=######CH   C#',
  '#SSSSSS###   %  @   =######CCCCCC#',
  '##########$ H=  h m =#############',
  '#############===N====#############',
];
// <ascii:end>

// ---------------------------------------------------------------------------
// The five levels, in play order.
// ---------------------------------------------------------------------------
export const MAPS = [
  {
    name: 'INTAKE',
    subtitle: 'Bunker Sieben, Level One',
    brief: 'WELCOME BACK WARDEN. Your badge still works, which MUTTER finds ' +
      'hilarious. Walk the intake corridors, take the splitter out of the ' +
      'decon showers, and be standing on the deck when the roof opens.',
    rows: ROWS_INTAKE,
    wallTex: { '#': 'OFFICE_WALL' },
    floorTex: 'FLOOR_LINO',
    ceilTex: 'CEIL_OFFICE',
    deckFloorTex: 'FLOOR_DECK',
    music: 'prowl',
    weapons: ['splitter'],
    par: 240,
    siege: {
      waves: [{
        trigger: 0,
        name: 'FIRST FLIGHT',
        duration: 55,
        spawn: [
          { type: 'stick', count: 10, from: 0, to: 40, speed: 1.0 },
          { type: 'mirv', count: 2, from: 22, to: 45, speed: 0.9 },
        ],
        maxAlive: 4,
        grunts: [{ kind: 'sparker', count: 2, from: 12, to: 34 }],
        intensity: 0.4,
      }],
    },
  },
  {
    name: 'THE ORGAN LOFT',
    subtitle: 'Bunker Sieben, Ventilation Tier',
    brief: 'Four hundred metres of dead pipe organ that used to be an air ' +
      'handler. The priests sing to it. Take the blue valve key off them, ' +
      'because the loft door does not care how politely you ask.',
    rows: ROWS_ORGAN_LOFT,
    wallTex: { '#': 'STEEL_RIVET', 'p': 'ORGAN_PIPES' },
    floorTex: 'FLOOR_BOARDS',
    ceilTex: 'CEIL_BEAMS',
    deckFloorTex: 'FLOOR_DECK',
    music: 'prowl',
    weapons: ['nailer'],
    par: 330,
    siege: {
      waves: [
        {
          trigger: 0,
          name: 'EVENSONG',
          duration: 60,
          spawn: [
            { type: 'stick', count: 12, from: 0, to: 42, speed: 1.05 },
            { type: 'mirv', count: 4, from: 14, to: 50, speed: 0.9 },
          ],
          maxAlive: 5,
          grunts: [{ kind: 'sparker', count: 3, from: 10, to: 40 }],
          intensity: 0.5,
        },
        {
          trigger: 1,
          name: 'THE LOFT ANSWERS',
          duration: 70,
          spawn: [
            { type: 'stick', count: 14, from: 0, to: 50, speed: 1.1 },
            { type: 'mirv', count: 5, from: 12, to: 58, speed: 0.95 },
            { type: 'smart', count: 3, from: 30, to: 62, speed: 1.0 },
          ],
          maxAlive: 6,
          grunts: [
            { kind: 'wasp', count: 2, from: 15, to: 45 },
            { kind: 'priest', count: 2, from: 35, to: 60 },
          ],
          intensity: 0.62,
        },
      ],
    },
  },
  {
    name: 'SALT CATHEDRAL',
    subtitle: 'Bunker Sieben, Reclamation Vaults',
    brief: 'Groundwater got in decades ago and left the hall crusted white. ' +
      'MUTTER keeps its relics here: a red key in the crypt, a gold one on a ' +
      'shrine of screens, and two silos it would rather you did not reach.',
    rows: ROWS_SALT_CATHEDRAL,
    wallTex: { '#': 'SALT_WALL' },
    floorMap: { ',': 'FLOOR_SALT' },
    floorTex: 'FLOOR_CONCRETE',
    ceilTex: 'CEIL_SALT',
    deckFloorTex: 'FLOOR_DECK',
    music: 'prowl',
    weapons: ['halo'],
    par: 420,
    siege: {
      waves: [
        {
          trigger: 0,
          name: 'SALT AND FIRE',
          duration: 65,
          spawn: [
            { type: 'stick', count: 14, from: 0, to: 45, speed: 1.1 },
            { type: 'mirv', count: 5, from: 12, to: 52, speed: 0.95 },
            { type: 'mine', count: 4, from: 20, to: 58, speed: 0.5 },
          ],
          maxAlive: 6,
          grunts: [{ kind: 'wasp', count: 3, from: 10, to: 45 }],
          intensity: 0.62,
        },
        {
          trigger: 1,
          name: 'THE CHOIR',
          duration: 65,
          spawn: [
            { type: 'stick', count: 12, from: 0, to: 40, speed: 1.15 },
            { type: 'smart', count: 5, from: 8, to: 52, speed: 1.05 },
            { type: 'screamer', count: 3, from: 25, to: 58, speed: 1.3 },
          ],
          maxAlive: 7,
          grunts: [{ kind: 'sparker', count: 3, from: 8, to: 40 }],
          intensity: 0.72,
        },
        {
          trigger: 1,
          name: 'ANTIPHON',
          duration: 55,
          spawn: [
            { type: 'mirv', count: 6, from: 0, to: 40, speed: 1.0 },
            { type: 'buster', count: 2, from: 18, to: 44, speed: 0.8 },
            { type: 'screamer', count: 4, from: 10, to: 48, speed: 1.35 },
          ],
          maxAlive: 7,
          grunts: [{ kind: 'priest', count: 2, from: 12, to: 40 }],
          intensity: 0.8,
        },
      ],
    },
  },
  {
    name: 'THE FURNACE',
    subtitle: 'Bunker Sieben, Thermal Plant',
    brief: 'The heat exchangers still run, feeding something MUTTER grew in ' +
      'the gullet. It has a red key in it. The plant deck is a ring around a ' +
      'live tube, so mind where you stand when the roof goes.',
    rows: ROWS_FURNACE,
    wallTex: { '#': 'RUST' },
    floorTex: 'FLOOR_SCORCH',
    ceilTex: 'CEIL_FLESH',
    deckFloorTex: 'FLOOR_DECK',
    music: 'prowl',
    weapons: ['deadman'],
    par: 480,
    siege: {
      waves: [
        {
          trigger: 0,
          name: 'STACK PRESSURE',
          duration: 70,
          spawn: [
            { type: 'stick', count: 14, from: 0, to: 46, speed: 1.15 },
            { type: 'mirv', count: 6, from: 10, to: 56, speed: 1.0 },
            { type: 'mine', count: 5, from: 16, to: 62, speed: 0.5 },
          ],
          maxAlive: 7,
          grunts: [{ kind: 'bellows', count: 2, from: 14, to: 48 }],
          intensity: 0.7,
        },
        {
          trigger: 0,
          name: 'BACKDRAUGHT',
          duration: 60,
          spawn: [
            { type: 'smart', count: 6, from: 0, to: 44, speed: 1.1 },
            { type: 'screamer', count: 4, from: 10, to: 50, speed: 1.35 },
            { type: 'buster', count: 3, from: 22, to: 54, speed: 0.85 },
          ],
          maxAlive: 8,
          grunts: [{ kind: 'wasp', count: 3, from: 8, to: 44 }],
          intensity: 0.8,
        },
        {
          trigger: 1,
          name: 'EVERYTHING IT HAS LEFT',
          duration: 80,
          spawn: [
            { type: 'stick', count: 16, from: 0, to: 55, speed: 1.2 },
            { type: 'mirv', count: 7, from: 6, to: 64, speed: 1.05 },
            { type: 'smart', count: 6, from: 14, to: 70, speed: 1.1 },
            { type: 'screamer', count: 5, from: 26, to: 72, speed: 1.4 },
            { type: 'buster', count: 3, from: 34, to: 70, speed: 0.85 },
          ],
          maxAlive: 9,
          grunts: [
            { kind: 'priest', count: 2, from: 10, to: 40 },
            { kind: 'bellows', count: 2, from: 30, to: 65 },
          ],
          intensity: 0.9,
        },
      ],
    },
  },
  {
    name: 'MUTTER',
    subtitle: 'Bunker Sieben, Launch Control',
    brief: 'No roof to open. It took the roof off itself years ago so it ' +
      'could watch. Six cities left, one machine, and whatever it can still ' +
      'get into the air. The elevator behind the dais goes up. Earn it.',
    // NOTE: the level is normally ended by killing the boss. The 'E' elevator
    // sits in the alcove directly behind the dais - i.e. behind where the boss
    // was - so the engine can also just walk the player out.
    rows: ROWS_MUTTER,
    wallTex: { '#': 'STEEL_PLATE', '=': 'SERVER' },
    floorTex: 'FLOOR_RAISED',
    ceilTex: 'CEIL_CABLES',
    deckFloorTex: 'FLOOR_DECK',
    music: 'boss',
    weapons: [],
    par: 300,
    siege: {
      waves: [
        {
          trigger: 0,
          name: 'IT SEES YOU',
          duration: 60,
          spawn: [
            { type: 'stick', count: 12, from: 0, to: 40, speed: 1.2 },
            { type: 'mirv', count: 5, from: 8, to: 48, speed: 1.05 },
            { type: 'mine', count: 4, from: 14, to: 52, speed: 0.5 },
          ],
          maxAlive: 7,
          grunts: [{ kind: 'wasp', count: 3, from: 10, to: 45 }],
          intensity: 0.75,
        },
        {
          trigger: 0,
          name: 'CANDLEMARK FIRST',
          duration: 65,
          spawn: [
            { type: 'smart', count: 7, from: 0, to: 48, speed: 1.15 },
            { type: 'screamer', count: 5, from: 8, to: 54, speed: 1.4 },
            { type: 'buster', count: 3, from: 20, to: 58, speed: 0.85 },
          ],
          maxAlive: 8,
          grunts: [{ kind: 'priest', count: 2, from: 12, to: 46 }],
          intensity: 0.85,
        },
        {
          trigger: 1,
          name: 'THE WHOLE ARSENAL',
          duration: 95,
          spawn: [
            { type: 'stick', count: 18, from: 0, to: 70, speed: 1.25 },
            { type: 'mirv', count: 8, from: 4, to: 78, speed: 1.1 },
            { type: 'smart', count: 8, from: 10, to: 84, speed: 1.15 },
            { type: 'screamer', count: 6, from: 18, to: 86, speed: 1.45 },
            { type: 'buster', count: 4, from: 28, to: 84, speed: 0.9 },
            { type: 'mine', count: 6, from: 12, to: 80, speed: 0.5 },
          ],
          maxAlive: 10,
          grunts: [
            { kind: 'bellows', count: 2, from: 15, to: 50 },
            { kind: 'wasp', count: 4, from: 25, to: 75 },
            { kind: 'priest', count: 2, from: 45, to: 85 },
          ],
          intensity: 1.0,
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Dressing. The ASCII says what a cell IS; this decides what it LOOKS like, so
// the same '#' down a forty-cell corridor stops being forty identical walls.
// Everything here is a pure function of (level, x, y): the bunker is dressed
// the same way on every load and in every tool.
// ---------------------------------------------------------------------------

/**
 * Per-family variants: [texture, weight, feature]. The family's own texture
 * is always a candidate at BASE_WEIGHT (or its override). Features are the
 * jokes and set pieces (a poster, a sign, a fish tank); they are spaced out so
 * a punchline is never told twice in the same corridor.
 */
export const TEXTURE_VARIANTS = {
  CONCRETE: [['CONCRETE_STAIN', 2], ['CONCRETE_HOLES', 2], ['CONCRETE_POSTER', 1, 1],
    ['CONCRETE_GRAFFITI', 1, 1], ['CONCRETE_SIGN', 1, 1], ['CONCRETE_FUSE', 1, 1]],
  CONCRETE_CRACKED: [['CRACKED_REBAR', 2], ['CRACKED_BLOOD', 1, 1], ['CRACKED_GRAFFITI', 1, 1]],
  OFFICE_WALL: [['OFFICE_SCUFF', 3], ['OFFICE_VENT', 2], ['OFFICE_BLOOD', 1], ['OFFICE_EMPLOYEE', 1, 1], ['OFFICE_BOARD', 1, 1],
    ['OFFICE_CLOCK', 1, 1], ['OFFICE_SAFETY', 1, 1], ['OFFICE_EXTING', 1, 1], ['OFFICE_CAT', 1, 1],
    ['OFFICE_PINUP', 1, 1], ['LOCKERS', 1, 1]],
  STEEL_PLATE: [['STEEL_DENTS', 2], ['STEEL_CABLES', 2], ['STEEL_SIGN', 1, 1], ['STEEL_PANEL', 1, 1],
    ['LOCKERS', 1, 1]],
  STEEL_RIVET: [['RIVET_RUST', 2], ['RIVET_DENTS', 2], ['RIVET_HATCH', 1, 1], ['RIVET_GAUGES', 1, 1], ['RIVET_STENCIL', 1, 1], ['LOCKERS', 1, 1]],
  HAZARD: [['HAZARD_WORN', 2], ['HAZARD_SIGN', 1, 1]],
  PIPES: [['PIPES_BARE', 5], ['PIPES_LEAK', 2], ['PIPES_VALVE', 1], ['PIPES_GAUGE', 1, 1]],
  VENT: [['VENT_FAN', 2], ['VENT_BLOOD', 1], ['VENT_EYES', 1, 1]],
  TILE: [['TILE_MISSING', 2], ['TILE_HAND', 1], ['TILE_MIRROR', 1, 1], ['TILE_GRAFFITI', 1, 1],
    ['TILE_SIGN', 1, 1]],
  TILE_BLOOD: [['TILE_SPLAT', 2], ['TILE_HELP', 1, 1]],
  RUST: [['RUST_HOLE', 2], ['RUST_PATCH', 2]],
  SANDBAG: [['SANDBAG_TORN', 2], ['SANDBAG_HELMET', 1, 1]],
  // A bank of monitors is SUPPOSED to show different things side by side, so
  // none of these count as features; the no-repeat rule keeps them mixed.
  SCREENS: [['SCREENS_RADAR', 2], ['SCREENS_DEAD', 2], ['SCREENS_BSOD', 2], ['SCREENS_FISH', 1],
    ['SCREENS_POPUP', 1], ['SCREENS_TOAST', 1]],
  CIRCUIT: [['CIRCUIT_B', 3], ['CIRCUIT_BURNT', 1], ['CIRCUIT_TAPE', 1, 1]],
  SILO_WALL: [['SILO_STAIN', 2], ['SILO_SCORCH', 2], ['SILO_LADDER', 1], ['SILO_13', 1, 1], ['SILO_03', 1, 1]],
  WARNING: [['WARN_SMOKE', 1, 1], ['WARN_INCIDENT', 1, 1], ['WARN_GLOW', 1, 1]],
  FLESH: [['FLESH_TUMOR', 2], ['FLESH_EYE', 1, 1], ['FLESH_MOUTH', 1, 1], ['FLESH_FACE', 1, 1]],
  SALT_WALL: [['SALT_CRYSTAL', 2], ['SALT_CRACKED', 2], ['SALT_BONES', 1, 1], ['SALT_SHRINE', 1, 1]],
  LOCKERS: [['LOCKERS_OPEN', 1, 1]],
  SERVER: [['SERVER_B', 3], ['SERVER_LABEL', 1, 1]],
  ORGAN_PIPES: [['ORGAN_RAMP', 3], ['ORGAN_SING', 1, 1]],
  // floors
  FLOOR_CONCRETE: [['FLOOR_CONCRETE_OIL', 2], ['FLOOR_CONCRETE_CRACK', 2], ['FLOOR_CONCRETE_DRAIN', 1],
    ['FLOOR_CONCRETE_PUDDLE', 1], ['FLOOR_CONCRETE_RUBBLE', 1], ['FLOOR_CONCRETE_OUTLINE', 1, 1],
    ['FLOOR_CONCRETE_BUTTS', 1, 1]],
  FLOOR_TILE: [['FLOOR_TILE_MISSING', 2], ['FLOOR_TILE_CRACK', 2], ['FLOOR_TILE_BLOOD', 1],
    ['FLOOR_TILE_DRAIN', 1]],
  FLOOR_GRATE: [['FLOOR_GRATE_GLOW', 1]],
  FLOOR_DIRT: [['FLOOR_DIRT_PUDDLE', 1], ['FLOOR_DIRT_BONES', 1, 1]],
  FLOOR_DECK: [['FLOOR_DECK_OIL', 1], ['FLOOR_DECK_HATCH', 1, 1]],
  FLOOR_BLOOD: [['FLOOR_BLOOD_SMEAR', 1]],
  FLOOR_LINO: [['FLOOR_LINO_MISSING', 2], ['FLOOR_LINO_BLOOD', 1], ['FLOOR_LINO_COFFEE', 1, 1],
    ['FLOOR_LINO_OUTLINE', 1, 1]],
  FLOOR_SALT: [['FLOOR_SALT_PUDDLE', 1]],
  FLOOR_RAISED: [['FLOOR_RAISED_OPEN', 1, 1]],
  FLOOR_SCORCH: [['FLOOR_SCORCH_GRILLE', 1, 1]],
  // ceilings
  CEIL_CONCRETE: [['CEIL_CONCRETE_STAIN', 2], ['CEIL_CONCRETE_VENT', 1], ['CEIL_CONCRETE_CABLES', 1]],
  CEIL_PIPES: [['CEIL_PIPES_VENT', 1], ['CEIL_PIPES_LEAK', 1]],
  CEIL_FLESH: [['CEIL_FLESH_TUMOR', 2], ['CEIL_FLESH_EYE', 1, 1]],
  CEIL_OFFICE: [['CEIL_OFFICE_STAIN', 2], ['CEIL_OFFICE_MISSING', 1]],
  CEIL_BEAMS: [['CEIL_BEAMS_STAIN', 2], ['CEIL_BEAMS_HOLE', 1, 1]],
  FLOOR_BOARDS: [['FLOOR_BOARDS_BLOOD', 1], ['FLOOR_BOARDS_HOLE', 1, 1]],
};
const BASE_WEIGHT = { SCREENS: 2, PIPES: 3, FLOOR_CONCRETE: 6, FLOOR_TILE: 5, FLOOR_GRATE: 10, FLOOR_DIRT: 5, FLOOR_DECK: 7,
  FLOOR_LINO: 6, FLOOR_RAISED: 5, CEIL_CONCRETE: 6, CEIL_OFFICE: 6, TILE_BLOOD: 3, WARNING: 2 };

/** Materials that exist only to dress levels (they are not in LEGEND). */
const EXTRA_MATERIALS = ['OFFICE_WALL', 'SALT_WALL', 'LOCKERS', 'SERVER', 'ORGAN_PIPES', 'FLOOR_LINO',
  'FLOOR_SALT', 'FLOOR_RAISED', 'FLOOR_SCORCH', 'CEIL_OFFICE', 'CEIL_TUBE', 'CEIL_SALT', 'CEIL_CABLES',
  'CEIL_LAMP_DEAD', 'RUST_FURNACE', 'FLOOR_KEEPCLEAR', 'CEIL_BEAMS', 'FLOOR_BOARDS', 'CEIL_ROOF', 'CEIL_ROOF_B'];

/**
 * Set dressing. h is world height (a wall is 1), z lifts it off the floor.
 *   solid   blocks bodies (propBlock), so it is only placed where it cannot
 *           cut a route in two
 *   wall    wants a wall at its back, and is nudged against it
 *   hang    hangs from the ceiling, so never under open sky
 *   fixture Brick can use it (toilets, urinals)
 */
export const DECOR = {
  desk: { h: 0.5, solid: true, wall: true },
  chair: { h: 0.46 },
  filing: { h: 0.62, solid: true, wall: true },
  locker: { h: 0.92, solid: true, wall: true },
  vending: { h: 0.9, solid: true, wall: true, max: 2, apart: 8 },
  cooler: { h: 0.62, solid: true, wall: true, max: 2, apart: 8 },
  toilet: { h: 0.44, solid: true, wall: true, fixture: 'toilet' },
  urinal: { h: 0.46, z: 0.14, solid: true, wall: true, fixture: 'urinal' },
  skeleton: { h: 0.4, wall: true },
  sandbags: { h: 0.4, solid: true },
  crate: { h: 0.48, solid: true },
  crates: { h: 0.82, solid: true, wall: true },
  console: { h: 0.62, solid: true, wall: true },
  plant: { h: 0.62, wall: true },
  mop: { h: 0.58, wall: true },
  chains: { h: 0.62, z: 0.38, hang: true },
  hook: { h: 0.7, z: 0.3, hang: true },
  corpse: { h: 0.26, max: 5 },
  corpse2: { h: 0.24, max: 5 },
  nosecone: { h: 0.92, solid: true, max: 3, apart: 8 },
  pinball: { h: 0.72, solid: true, wall: true, max: 1 },
  candles: { h: 0.28, emissive: true, max: 12 },
  pew: { h: 0.44, solid: true },
  trash: { h: 0.4, wall: true },
  cone: { h: 0.3 },
};

/**
 * Each floor's own look. tint grades every light on the level; walls, floor
 * and ceil name the materials; floorsBy lets a room take its floor from the
 * walls around it (tile walls, tile floor); decor is the scatter pool; props
 * and features are hand-placed [x, y, name] set pieces.
 */
const LOOKS = [
  { // INTAKE: a government office that forgot to evacuate
    tint: [0.96, 1.02, 0.98],
    tubes: 4,
    floorsBy: { TILE: 'FLOOR_TILE', TILE_BLOOD: 'FLOOR_TILE', RUST: 'FLOOR_CONCRETE', PIPES: 'FLOOR_CONCRETE',
      CIRCUIT: 'FLOOR_RAISED', SCREENS: 'FLOOR_RAISED', VENT: 'FLOOR_CONCRETE', STEEL_PLATE: 'FLOOR_CONCRETE' },
    ceilsBy: { PIPES: 'CEIL_PIPES', RUST: 'CEIL_CONCRETE', TILE: 'CEIL_CONCRETE', CIRCUIT: 'CEIL_CABLES',
      SCREENS: 'CEIL_CABLES', VENT: 'CEIL_PIPES' },
    density: 0.13,
    decor: [['desk', 4], ['chair', 4], ['filing', 3], ['locker', 2], ['cooler', 1], ['vending', 1],
      ['plant', 3], ['mop', 1], ['corpse', 2], ['trash', 2], ['cone', 1], ['console', 1], ['crate', 1]],
    deck: [['crate', 2], ['sandbags', 2], ['corpse2', 1]],
    decorBy: {
      PIPES: [['crate', 2], ['crates', 1], ['corpse', 1], ['sandbags', 1], ['cone', 1]],
      VENT: [['crate', 2], ['crates', 1], ['corpse', 1], ['cone', 1]],
      RUST: [['crate', 2], ['crates', 2], ['sandbags', 1], ['skeleton', 1]],
      STEEL_PLATE: [['locker', 2], ['cooler', 1], ['filing', 1], ['plant', 1], ['vending', 1], ['pinball', 1]],
    },
    // the decon showers double as the gents
    props: [[37, 25, 'urinal'], [37, 27, 'urinal'], [37, 29, 'toilet'], [37, 31, 'toilet'], [32, 31, 'mop'],
      // the warden's old office, where the run starts
      [17, 34, 'filing'], [22, 34, 'cooler'], [17, 38, 'plant']],
    features: [[38, 26, 'TILE_MIRROR'], [38, 30, 'TILE_GRAFFITI'], [34, 24, 'TILE_SIGN'],
      [16, 36, 'LOCKERS'], [23, 35, 'STEEL_SIGN'], [14, 23, 'OFFICE_EMPLOYEE']],
  },
  { // THE ORGAN LOFT: sodium light on brass, and the priests' candles
    tint: [1.1, 0.95, 0.78],
    pillar: 'pillar_wood',
    floorsBy: { RUST: 'FLOOR_CONCRETE', CIRCUIT: 'FLOOR_RAISED', SCREENS: 'FLOOR_RAISED', VENT: 'FLOOR_GRATE',
      STEEL_PLATE: 'FLOOR_TILE' },
    ceilsBy: { CIRCUIT: 'CEIL_CABLES', SCREENS: 'CEIL_CABLES', RUST: 'CEIL_CONCRETE', VENT: 'CEIL_PIPES',
      STEEL_PLATE: 'CEIL_PIPES' },
    density: 0.1,
    decor: [['candles', 3], ['chains', 3], ['skeleton', 2], ['crates', 2], ['crate', 2], ['pew', 2],
      ['corpse', 2], ['console', 1], ['locker', 1], ['mop', 1], ['trash', 1]],
    deck: [['crate', 2], ['sandbags', 2], ['nosecone', 1]],
    // the priests' chapel in the great hall, and a console for the organ
    props: [[21, 18, 'pew'], [24, 18, 'pew'], [21, 20, 'pew'], [24, 20, 'pew'], [28, 21, 'candles'],
      [7, 7, 'console']],
    features: [],
  },
  { // SALT CATHEDRAL: brine-cold, white, and full of pews nobody sits in
    tint: [0.86, 0.97, 1.14],
    pillar: 'pillar_salt',
    floorsBy: { TILE: 'FLOOR_TILE', TILE_BLOOD: 'FLOOR_TILE', SALT_WALL: 'FLOOR_SALT', SCREENS: 'FLOOR_RAISED' },
    ceilsBy: { SCREENS: 'CEIL_CABLES', TILE: 'CEIL_CONCRETE', TILE_BLOOD: 'CEIL_CONCRETE' },
    density: 0.08,
    decor: [['pew', 4], ['candles', 3], ['skeleton', 3], ['chains', 1], ['crate', 1], ['plant', 1],
      ['corpse', 1], ['nosecone', 1]],
    deck: [['crate', 2], ['sandbags', 2], ['nosecone', 1]],
    // even a cathedral has a gents
    props: [[49, 32, 'toilet'], [49, 34, 'urinal'], [49, 38, 'urinal']],
    features: [[50, 31, 'TILE_GRAFFITI']],
  },
  { // THE FURNACE: red heat, meat hooks and the smell
    tint: [1.16, 0.88, 0.74],
    pillar: 'pillar_rust',
    variants: { RUST: [['RUST_FURNACE', 1, 1]] },
    floorsBy: { PIPES: 'FLOOR_GRATE', VENT: 'FLOOR_GRATE', FLESH: 'FLOOR_CONCRETE' },
    ceilsBy: { PIPES: 'CEIL_PIPES', VENT: 'CEIL_PIPES', STEEL_PLATE: 'CEIL_CONCRETE' },
    density: 0.1,
    decor: [['hook', 4], ['chains', 3], ['skeleton', 2], ['corpse2', 2], ['crates', 2], ['crate', 1],
      ['sandbags', 1], ['nosecone', 1], ['trash', 1]],
    deck: [['crate', 2], ['sandbags', 2], ['nosecone', 1]],
    props: [],
    features: [],
  },
  { // MUTTER: the machine's own rooms, lit the colour of a bruise
    tint: [1.02, 0.88, 1.12],
    pillar: 'pillar_tech',
    tubes: 5,
    floorsBy: {},
    ceilsBy: {},
    density: 0.1,
    decor: [['console', 3], ['chair', 2], ['desk', 1], ['pinball', 1], ['cooler', 1], ['corpse', 2],
      ['skeleton', 1], ['crate', 1]],
    deck: [['crate', 2], ['sandbags', 2], ['nosecone', 1]],
    // the operators' rooms, and what they did on the night shift
    props: [[4, 2, 'console'], [2, 4, 'chair'], [29, 2, 'console'], [18, 30, 'pinball']],
    features: [],
  },
];

/** Integer hash to 0..1. Deterministic and cheap; this runs once per cell. */
function hash3(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Weighted pick from [[name, weight, ...], ...] with u in 0..1. */
function pickWeighted(list, u) {
  let total = 0;
  for (const e of list) total += e[1];
  let r = u * total;
  for (const e of list) { r -= e[1]; if (r < 0) return e; }
  return list[list.length - 1];
}

export function lookOf(index) { return LOOKS[index] || null; }

for (const t of EXTRA_MATERIALS) if (!VALID_TEXTURES.includes(t)) VALID_TEXTURES.push(t);
for (const list of Object.values(TEXTURE_VARIANTS)) {
  for (const [t] of list) if (!VALID_TEXTURES.includes(t)) VALID_TEXTURES.push(t);
}
for (const look of LOOKS) {
  for (const list of Object.values(look.variants || {})) {
    for (const [t] of list) if (!VALID_TEXTURES.includes(t)) VALID_TEXTURES.push(t);
  }
}

/**
 * Dress one parsed level in place. Returns the extras parseLevel hands on:
 * decor, fixture lights and the light grade.
 */
function dressLevel(def, idx, P) {
  const { w, h, wall, wallTexName, floorTexName, ceilTexName, sky, secret, trigger, exit, doors, ents } = P;
  const look = def.look || LOOKS[idx] || {};
  const n = w * h;
  const seed = 0x51ab + idx * 7919;
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
  const walkable = (x, y) => inb(x, y) && !wall[y * w + x];
  const solidWall = (x, y) => !inb(x, y) || (wall[y * w + x] && !isDoorId(wall[y * w + x]));
  const variantsFor = (fam) => {
    const extra = look.variants && look.variants[fam];
    const base = TEXTURE_VARIANTS[fam];
    if (!base && !extra) return null;
    return (base || []).concat(extra || []);
  };

  // Everything a player needs to walk to, or through, is protected from clutter.
  const guard = new Uint8Array(n);
  const mark = (x, y, r) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (inb(x + dx, y + dy)) guard[(y + dy) * w + x + dx] = 1;
  };
  for (const d of doors) mark(d.x, d.y, 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (secret[i]) mark(x, y, 2);
      if (trigger[i] || exit[i]) mark(x, y, 1);
    }
  }
  const entAt = new Uint8Array(n);
  for (const e of ents) {
    const ex = (e.x - 0.5) | 0, ey = (e.y - 0.5) | 0;
    entAt[ey * w + ex] = 1;
    if (e.kind.startsWith('key_') || e.kind === 'weapon' || e.kind === 'boss') mark(ex, ey, 1);
  }
  if (P.start) mark((P.start.x - 0.5) | 0, (P.start.y - 0.5) | 0, 1);

  // --- 1. rooms take their floor and ceiling from their walls ---------------
  // Nearest wall material within three cells decides, so a tiled washroom has a
  // tiled floor without anyone painting it into the ASCII.
  const nearestWallTex = (x, y) => {
    for (let r = 1; r <= 3; r++) {
      let best = null, bestD = 1e9;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = x + dx, yy = y + dy;
          if (!inb(xx, yy)) continue;
          const j = yy * w + xx;
          if (!wall[j] || isDoorId(wall[j]) || secret[j]) continue;
          const t = wallTexName[j];
          if (t === 'DOOR_JAMB' || t === 'ELEVATOR') continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = t; }
        }
      }
      if (best) return best;
    }
    return null;
  };
  // What a room is made of also decides what gets left lying in it.
  const roomFam = new Array(n).fill(null);
  {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (wall[i] || sky[i] || exit[i]) continue;
        const t = nearestWallTex(x, y);
        if (!t) continue;
        roomFam[i] = t;
        const f = look.floorsBy && look.floorsBy[t];
        if (f && floorTexName[i] === (def.floorTex || DEFAULT_FLOOR)) floorTexName[i] = f;
        const c = look.ceilsBy && look.ceilsBy[t];
        if (c && ceilTexName[i] === (def.ceilTex || DEFAULT_CEIL)) ceilTexName[i] = c;
      }
    }
  }
  const COMMON_ROOMS = {
    TILE: [['mop', 2], ['trash', 2], ['corpse', 1], ['cone', 2]],
    TILE_BLOOD: [['skeleton', 2], ['corpse', 1], ['candles', 1], ['mop', 1]],
    SCREENS: [['console', 3], ['chair', 2], ['desk', 1], ['trash', 1]],
    CIRCUIT: [['console', 2], ['chair', 1], ['crate', 1]],
    SERVER: [['console', 2], ['chair', 1], ['crate', 1]],
  };

  // --- 2. strip lights on a lattice, in rooms, never over a lamp ------------
  const fixtureLights = [];
  if (look.tubes) {
    const sp = look.tubes, ox = (idx * 3) % sp, oy = (idx * 5 + 1) % sp;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if ((x + ox) % sp || (y + oy) % sp) continue;
        if (wall[i] || sky[i] || !ceilTexName[i] || ceilTexName[i] === 'CEIL_LAMP') continue;
        let open = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (walkable(x + dx, y + dy)) open++;
        if (open < 6) continue;
        // One in five has died, and one of those still flickers in the dark.
        const u = hash3(x, y, seed + 3);
        if (u < 0.18) { ceilTexName[i] = 'CEIL_LAMP_DEAD'; continue; }
        ceilTexName[i] = 'CEIL_TUBE';
        fixtureLights.push({ x: x + 0.5, y: y + 0.5, r: 0.86, g: 0.96, b: 1.0, intensity: 0.32, radius: 5.2 });
      }
    }
  }

  // --- 3. wall variants --------------------------------------------------------
  const features = [];
  const featureOk = (x, y, name, gap) => {
    for (const f of features) {
      const d = Math.hypot(f[0] - x, f[1] - y);
      if (d < gap) return false;
      if (f[2] === name && d < 14) return false;
    }
    return true;
  };
  for (const [fx, fy, name] of look.features || []) {
    if (inb(fx, fy) && wall[fy * w + fx] && !isDoorId(wall[fy * w + fx])) {
      wallTexName[fy * w + fx] = name;
      features.push([fx, fy, name]);
    }
  }
  const handPlaced = new Set((look.features || []).map(([fx, fy]) => fy * w + fx));
  const nearInterest = (x, y) => {
    for (const d of doors) if (Math.abs(d.x - x) + Math.abs(d.y - y) <= 3) return true;
    return false;
  };
  const choose = (i, x, y, fam, vars, s, gap) => {
    const list = [[fam, BASE_WEIGHT[fam] || 4]].concat(vars);
    const boost = nearInterest(x, y) ? 3 : 1;
    const weighted = list.map((e) => (e[2] ? [e[0], e[1] * boost, 1] : e));
    let pick = pickWeighted(weighted, hash3(x, y, s));
    if (pick[2] && !featureOk(x, y, pick[0], gap)) {
      pick = pickWeighted(list.filter((e) => !e[2]), hash3(x, y, s + 1));
    }
    return pick;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!wall[i] || isDoorId(wall[i]) || handPlaced.has(i)) continue;
      const fam = wallTexName[i];
      const vars = variantsFor(fam);
      if (!vars) continue;
      // Only a face somebody can stand in front of is worth dressing.
      if (!walkable(x - 1, y) && !walkable(x + 1, y) && !walkable(x, y - 1) && !walkable(x, y + 1)) continue;
      let pick = choose(i, x, y, fam, vars, seed + 11, 5);
      // Never the same dressing twice within two cells along a run: A-B-A
      // reads as a pattern just as surely as A-A does.
      const left = x > 0 ? wallTexName[i - 1] : '', up = y > 0 ? wallTexName[i - w] : '';
      const left2 = x > 1 ? wallTexName[i - 2] : '', up2 = y > 1 ? wallTexName[i - 2 * w] : '';
      const near = (e) => e === left || e === up || e === left2 || e === up2;
      if (pick[0] !== fam && near(pick[0])) {
        pick = choose(i, x, y, fam, vars.filter((e) => !near(e[0])), seed + 23, 5);
      }
      // And never three plain ones: that is exactly the stretch that reads as
      // a tiled pattern. Break it with something quiet.
      // (A monitor bank gets no plain pair at all: two identical screens side
      // by side is the one thing a control room never shows.)
      const plainRun = fam === 'SCREENS' ? (left === fam || up === fam)
        : (left === fam && left2 === fam) || (up === fam && up2 === fam);
      if (pick[0] === fam && plainRun) {
        const quiet = vars.filter((e) => !e[2] && !near(e[0]));
        if (quiet.length) pick = pickWeighted(quiet, hash3(x, y, seed + 29));
        else {
          const loud = vars.filter((e) => !near(e[0]) && featureOk(x, y, e[0], 3));
          if (loud.length) pick = pickWeighted(loud, hash3(x, y, seed + 31));
        }
      }
      wallTexName[i] = pick[0];
      if (pick[2]) features.push([x, y, pick[0]]);
    }
  }

  // --- 4. floor and ceiling variants --------------------------------------------
  const plane = (names, s, gap) => {
    const feats = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (wall[i]) continue;
        const fam = names[i];
        if (!fam) continue;
        const vars = variantsFor(fam);
        if (!vars) continue;
        const list = [[fam, BASE_WEIGHT[fam] || 4]].concat(vars);
        let pick = pickWeighted(list, hash3(x, y, s));
        if (pick[2]) {
          const tooClose = feats.some((f) => Math.hypot(f[0] - x, f[1] - y) < gap) || entAt[i] || guard[i];
          if (tooClose) pick = [fam];
          else feats.push([x, y]);
        }
        const left = x > 0 ? names[i - 1] : '', up = y > 0 ? names[i - w] : '';
        if (pick[0] !== fam && (pick[0] === left || pick[0] === up)) pick = [fam];
        names[i] = pick[0];
      }
    }
  };
  plane(floorTexName, seed + 31, 7);
  plane(ceilTexName, seed + 37, 6);
  // Hazard boxes on the concrete in front of the heavy doors, where a forklift
  // driver once parked anyway.
  for (const d of doors) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = d.x + dx, y = d.y + dy;
      if (!walkable(x, y)) continue;
      const i = y * w + x;
      const fam = floorTexName[i];
      if (!fam.startsWith('FLOOR_CONCRETE') || sky[i] || entAt[i]) continue;
      if (hash3(x, y, seed + 39) < 0.45) floorTexName[i] = 'FLOOR_KEEPCLEAR';
    }
  }

  // --- 5. props ----------------------------------------------------------------
  const decor = [];
  const blockedByDecor = new Uint8Array(n);
  const passable = (x, y) => walkable(x, y) && !blockedByDecor[y * w + x];
  // Removing (x,y) from the walkable graph must not split its neighbours: walk
  // the 8-ring and count separate runs of passable cells that touch an
  // orthogonal neighbour. One run means everything around it still connects.
  const ringOffsets = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const safeToBlock = (x, y) => {
    const ring = ringOffsets.map(([dx, dy]) => passable(x + dx, y + dy));
    // A diagonal only links its two orthogonals if it is itself open.
    let runs = 0, start = -1;
    for (let k = 0; k < 8; k++) if (!ring[k]) { start = k; break; }
    if (start < 0) return true;                            // open floor all round
    let inRun = false, runHasOrtho = false;
    for (let s = 1; s <= 8; s++) {
      const k = (start + s) % 8;
      if (ring[k]) {
        if (!inRun) { inRun = true; runHasOrtho = false; }
        if (k % 2 === 0) runHasOrtho = true;
      } else if (inRun) {
        inRun = false;
        if (runHasOrtho) runs++;
      }
    }
    if (inRun && runHasOrtho) runs++;
    return runs <= 1;
  };
  const place = (x, y, kind, force) => {
    const spec = DECOR[kind];
    if (!spec) return false;
    const i = y * w + x;
    if (!walkable(x, y) || blockedByDecor[i] || entAt[i]) return false;
    if (!force && (guard[i] || trigger[i] || exit[i])) return false;
    if (spec.hang && (sky[i] || !ceilTexName[i])) return false;
    const sides = [];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) if (solidWall(x + dx, y + dy)) sides.push([dx, dy]);
    if (spec.wall && !sides.length) return false;
    if (spec.solid) {
      if (!safeToBlock(x, y)) return false;
      // Never in a one-wide corridor, however safe the topology says it is.
      if (!force && ((solidWall(x - 1, y) && solidWall(x + 1, y)) || (solidWall(x, y - 1) && solidWall(x, y + 1)))) return false;
    }
    let px = x + 0.5, py = y + 0.5;
    if (spec.wall) {
      const [dx, dy] = sides[(hash3(x, y, seed + 41) * sides.length) | 0];
      px += dx * 0.2; py += dy * 0.2;
    } else if (!spec.solid) {
      px += (hash3(x, y, seed + 43) - 0.5) * 0.4; py += (hash3(x, y, seed + 47) - 0.5) * 0.4;
    }
    if (spec.solid) blockedByDecor[i] = 1;
    decor.push({
      kind, key: `prop_${kind}`, x: px, y: py, z: spec.z || 0, h: spec.h,
      solid: !!spec.solid, emissive: !!spec.emissive, fixture: spec.fixture || null,
    });
    if ((kind === 'desk' || kind === 'console') && spec.wall) {
      // Somebody sat here. Pull the chair out on the room side, in the same cell.
      const ox = px - (x + 0.5), oy = py - (y + 0.5);
      decor.push({
        kind: 'chair', key: 'prop_chair', x: x + 0.5 - ox * 1.6, y: y + 0.5 - oy * 1.6, z: 0,
        h: DECOR.chair.h, solid: false, emissive: false, fixture: null,
      });
    }
    entAt[i] = 1;
    return true;
  };
  for (const [px, py, kind] of look.props || []) place(px, py, kind, true);
  const density = look.density || 0;
  const count = {};
  const fits = (x, y, kind) => {
    const spec = DECOR[kind];
    if (spec.max && (count[kind] || 0) >= spec.max) return false;
    if (spec.apart) {
      for (const d of decor) if (d.kind === kind && Math.hypot(d.x - x - 0.5, d.y - y - 0.5) < spec.apart) return false;
    }
    return true;
  };
  if (density > 0 && look.decor) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (wall[i]) continue;
        const onDeck = !!sky[i];
        const fam = roomFam[i];
        const roomPool = !onDeck && fam && ((look.decorBy && look.decorBy[fam]) || COMMON_ROOMS[fam]);
        const base = onDeck ? look.deck : (roomPool || look.decor);
        if (!base || !base.length) continue;
        if (hash3(x, y, seed + 51) > density * (onDeck ? 0.25 : 1)) continue;
        // Against a wall, anything goes and furniture is favoured; out in the
        // open only the things that stand on their own.
        const backed = solidWall(x - 1, y) || solidWall(x + 1, y) || solidWall(x, y - 1) || solidWall(x, y + 1);
        const pool = base.filter(([k]) => fits(x, y, k) && (backed || !DECOR[k].wall))
          .map(([k, wt]) => [k, backed && DECOR[k].wall ? wt * 2 : wt]);
        if (!pool.length) continue;
        let kind = pickWeighted(pool, hash3(x, y, seed + 53))[0];
        if (!place(x, y, kind, false)) {
          // Solid did not fit (a squeeze, a route): try one thing you can walk through.
          const soft = pool.filter(([k]) => !DECOR[k].solid);
          if (!soft.length) continue;
          kind = pickWeighted(soft, hash3(x, y, seed + 59))[0];
          if (!place(x, y, kind, false)) continue;
        }
        count[kind] = (count[kind] || 0) + 1;
      }
    }
  }

  // --- 6. the things on the walls that glow light the room ---------------------
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = wallTexName[y * w + x];
      if (t !== 'RUST_FURNACE' && t !== 'SALT_SHRINE') continue;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        if (!walkable(x + dx, y + dy)) continue;
        const hot = t === 'RUST_FURNACE';
        fixtureLights.push({
          x: x + 0.5 + dx * 0.9, y: y + 0.5 + dy * 0.9,
          r: 1.0, g: hot ? 0.5 : 0.7, b: hot ? 0.2 : 0.35, intensity: hot ? 0.7 : 0.45, radius: hot ? 4.5 : 3.6,
        });
        break;
      }
    }
  }
  for (const d of decor) {
    if (d.kind === 'candles') fixtureLights.push({ x: d.x, y: d.y, r: 1, g: 0.66, b: 0.3, intensity: 0.4, radius: 3.2 });
  }

  return { decor, fixtureLights, lightTint: look.tint || null, pillarKey: look.pillar || null };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const DEFAULT_FLOOR = 'FLOOR_CONCRETE';
const DEFAULT_CEIL = 'CEIL_CONCRETE';
const DEFAULT_DECK = 'FLOOR_DECK';

function descOf(ch) { return LEGEND[ch] || null; }

function isWallChar(ch) {
  const d = descOf(ch);
  return !!d && (d.type === 'wall' || d.type === 'door' || d.type === 'secret');
}

function isSolidChar(ch) {
  const d = descOf(ch);
  return !!d && (d.type === 'wall' || d.type === 'secret');
}

function isWalkableChar(ch) {
  const d = descOf(ch);
  return !!d && d.type === 'floor';
}

function wallTexFor(def, ch) {
  const over = def.wallTex && def.wallTex[ch];
  if (over) return over;
  const d = descOf(ch);
  return (d && d.tex) || 'CONCRETE';
}

/**
 * Parse a level into flat typed arrays the renderer can chew on.
 * Accepts an index into MAPS, or a LevelDef directly.
 */
export function parseLevel(index) {
  const def = typeof index === 'number' ? MAPS[index] : index;
  if (!def) throw new Error(`parseLevel: no level ${index}`);
  const idx = typeof index === 'number' ? index : MAPS.indexOf(def);

  const rows = def.rows;
  const h = rows.length;
  const w = rows[0].length;
  const n = w * h;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? '#' : rows[y][x]);

  const wall = new Int16Array(n);
  const wallTexName = new Array(n).fill('');
  const floorTexName = new Array(n).fill('');
  const ceilTexName = new Array(n).fill('');
  const sky = new Uint8Array(n);
  const trigger = new Uint8Array(n);
  const exit = new Uint8Array(n);
  const secret = new Uint8Array(n);
  const doors = [];
  const ents = [];
  let start = null;

  const floorDefault = def.floorTex || DEFAULT_FLOOR;
  const ceilDefault = def.ceilTex || DEFAULT_CEIL;
  const deckFloor = def.deckFloorTex || DEFAULT_DECK;
  const weapons = (def.weapons || []).slice();
  let weaponCursor = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ch = at(x, y);
      const d = descOf(ch);
      floorTexName[i] = floorDefault;
      if (!d) { wall[i] = 1; wallTexName[i] = 'CONCRETE'; continue; }

      if (d.type === 'wall' || d.type === 'secret') {
        wall[i] = WALL_IDS[ch];
        wallTexName[i] = d.type === 'secret' ? '' : wallTexFor(def, ch);
        if (d.type === 'secret') secret[i] = 1;
        continue;
      }
      if (d.type === 'door') {
        wall[i] = WALL_IDS[ch];
        wallTexName[i] = wallTexFor(def, ch);
        doors.push({ x, y, kind: d.door });
        continue;
      }

      // walkable
      if (d.floor) floorTexName[i] = (def.floorMap && def.floorMap[ch]) || d.floor;
      if (d.sky) { sky[i] = 1; floorTexName[i] = deckFloor; }
      if (d.trigger) trigger[i] = 1;
      if (d.exit) exit[i] = 1;
      if (d.start) start = { x: x + 0.5, y: y + 0.5, dir: 0 };
      if (d.ent) {
        const e = { kind: d.ent, x: x + 0.5, y: y + 0.5 };
        if (d.ent === 'weapon') e.weapon = weapons[weaponCursor++] || null;
        ents.push(e);
      }
    }
  }

  // Sky bleeds onto walkable cells that are surrounded by it, so an ammo crate
  // or a pillar standing in the middle of a deck does not punch a roof-hole.
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    const add = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (sky[i] || wall[i]) continue;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (sky[(y + dy) * w + x + dx]) c++;
          }
        }
        if (c >= 5) { add.push(i); grew = true; }
      }
    }
    for (const i of add) { sky[i] = 1; floorTexName[i] = deckFloor; }
    if (!grew) break;
  }

  // Ceilings: open where the sky is, lit where a lamp hangs.
  for (let i = 0; i < n; i++) ceilTexName[i] = sky[i] ? '' : ceilDefault;
  for (const e of ents) {
    if (e.kind !== 'lamp') continue;
    const i = ((e.y - 0.5) | 0) * w + ((e.x - 0.5) | 0);
    if (!sky[i]) ceilTexName[i] = 'CEIL_LAMP';
  }

  // Pushwalls wear their dominant neighbour's material.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!secret[i]) continue;
      const tally = new Map();
      const bump = (nx, ny, weight) => {
        const j = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        if (!wall[j] || secret[j] || isDoorId(wall[j])) return;
        const t = wallTexName[j];
        tally.set(t, (tally.get(t) || 0) + weight);
      };
      bump(x - 1, y, 2); bump(x + 1, y, 2); bump(x, y - 1, 2); bump(x, y + 1, 2);
      bump(x - 1, y - 1, 1); bump(x + 1, y - 1, 1);
      bump(x - 1, y + 1, 1); bump(x + 1, y + 1, 1);
      let best = 'CONCRETE', bestN = -1;
      for (const [t, c] of tally) if (c > bestN) { best = t; bestN = c; }
      wallTexName[i] = best;
    }
  }

  // Door jambs, then elevator linings.
  for (const d of doors) {
    const horizontal = isSolidChar(at(d.x - 1, d.y)) && isSolidChar(at(d.x + 1, d.y));
    const a = horizontal ? [d.x - 1, d.y] : [d.x, d.y - 1];
    const b = horizontal ? [d.x + 1, d.y] : [d.x, d.y + 1];
    for (const [jx, jy] of [a, b]) {
      if (jx < 0 || jy < 0 || jx >= w || jy >= h) continue;
      const j = jy * w + jx;
      if (wall[j] && !isDoorId(wall[j]) && !secret[j]) wallTexName[j] = 'DOOR_JAMB';
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!exit[y * w + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (wall[j] && !isDoorId(wall[j]) && !secret[j] && wallTexName[j] !== 'DOOR_JAMB') {
          wallTexName[j] = 'ELEVATOR';
        }
      }
    }
  }

  if (start) start.dir = facing(rows, (start.x - 0.5) | 0, (start.y - 0.5) | 0);

  const dressed = dressLevel(def, idx, {
    w, h, wall, wallTexName, floorTexName, ceilTexName, sky, secret, trigger, exit, doors, ents, start,
  });

  return {
    index: idx,
    name: def.name,
    subtitle: def.subtitle,
    brief: def.brief,
    music: def.music,
    par: def.par,
    siege: def.siege,
    w, h,
    wall, wallTexName, floorTexName, ceilTexName,
    sky, trigger, exit, secret,
    doors, ents,
    start: start || { x: 1.5, y: 1.5, dir: 0 },
    decor: dressed.decor,
    fixtureLights: dressed.fixtureLights,
    lightTint: dressed.lightTint,
    pillarKey: dressed.pillarKey,
  };
}

/** Face the most open direction; doors count as open because they will be. */
function facing(rows, sx, sy) {
  const h = rows.length, w = rows[0].length;
  const open = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const d = descOf(rows[y][x]);
    return !!d && (d.type === 'floor' || d.type === 'door');
  };
  const dirs = [
    ['north', 0, -1, DIR.north], ['east', 1, 0, DIR.east],
    ['south', 0, 1, DIR.south], ['west', -1, 0, DIR.west],
  ];
  let best = DIR.north, bestRun = -1;
  for (const [, dx, dy, rad] of dirs) {
    let run = 0, x = sx + dx, y = sy + dy;
    while (open(x, y) && run < 64) { run++; x += dx; y += dy; }
    if (run > bestRun) { bestRun = run; best = rad; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const KEY_FOR_DOOR = { '1': 'red', '2': 'blue', '3': 'gold' };

/**
 * Flood from the start, treating free doors as open and keydoors as open only
 * once their key has been reached. Re-floods from scratch after every new key
 * until nothing more opens up, so progression is simulated honestly.
 */
function progressionFlood(rows, sx, sy, secretsPassable) {
  const h = rows.length, w = rows[0].length;
  const at = (x, y) => rows[y][x];
  const have = { red: false, blue: false, gold: false };
  let seen = new Uint8Array(w * h);
  for (let round = 0; round < 8; round++) {
    const cur = new Uint8Array(w * h);
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (cur[i]) continue;
      const d = descOf(at(x, y));
      if (!d) continue;
      if (d.type === 'wall') continue;
      if (d.type === 'secret' && !secretsPassable) continue;
      if (d.type === 'door' && d.door !== 'free' && !have[d.door]) continue;
      cur[i] = 1;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    let grew = false;
    for (let i = 0; i < cur.length; i++) if (cur[i] !== seen[i]) { grew = true; break; }
    seen = cur;
    let gotKey = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!seen[y * w + x]) continue;
        const d = descOf(at(x, y));
        if (d && d.key && !have[d.key]) { have[d.key] = true; gotKey = true; }
      }
    }
    if (!grew && !gotKey) break;
  }
  return { seen, have };
}

/**
 * Check every level. Returns a list of human-readable problems; [] means the
 * whole campaign is sound.
 */
export function validateAll() {
  const problems = [];
  MAPS.forEach((def, li) => {
    const tag = `L${li + 1} ${def.name}`;
    const say = (s) => problems.push(`${tag}: ${s}`);
    const rows = def.rows;

    // 1. rectangularity ------------------------------------------------------
    if (!rows || !rows.length) { say('has no rows'); return; }
    const w = rows[0].length, h = rows.length;
    let ragged = false;
    rows.forEach((r, y) => {
      if (r.length !== w) { say(`row ${y} is ${r.length} chars, expected ${w}`); ragged = true; }
    });
    if (ragged) return;
    if (w > 64 || h > 64) say(`is ${w}x${h}, larger than 64x64`);
    const at = (x, y) => rows[y][x];

    // unknown characters
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!descOf(at(x, y))) say(`unknown char '${at(x, y)}' at ${x},${y}`);
      }
    }

    // 2. border --------------------------------------------------------------
    for (let x = 0; x < w; x++) {
      if (!isSolidChar(at(x, 0))) say(`border leak at ${x},0`);
      if (!isSolidChar(at(x, h - 1))) say(`border leak at ${x},${h - 1}`);
    }
    for (let y = 0; y < h; y++) {
      if (!isSolidChar(at(0, y))) say(`border leak at 0,${y}`);
      if (!isSolidChar(at(w - 1, y))) say(`border leak at ${w - 1},${y}`);
    }

    // 3. exactly one start, at least one exit --------------------------------
    const starts = [], exits = [], triggers = [], keys = [], skies = [];
    const enemies = [], pickups = [], secrets = [], bosses = [], weaponCells = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = at(x, y), d = descOf(ch);
        if (!d) continue;
        if (d.start) starts.push([x, y]);
        if (d.exit) exits.push([x, y]);
        if (d.trigger) triggers.push([x, y]);
        if (d.sky) skies.push([x, y]);
        if (d.key) keys.push([x, y, d.key]);
        if (d.enemy && d.ent !== 'boss') enemies.push([x, y, d.ent]);
        if (d.ent === 'boss') bosses.push([x, y]);
        if (d.pickup) pickups.push([x, y, d.ent]);
        if (ch === 'w') weaponCells.push([x, y]);
        if (d.type === 'secret') secrets.push([x, y]);
      }
    }
    if (starts.length !== 1) say(`has ${starts.length} player starts, expected exactly 1`);
    if (!exits.length) say('has no exit elevator');
    if (!starts.length) return;

    // 4. reachability --------------------------------------------------------
    const [sx, sy] = starts[0];
    const base = progressionFlood(rows, sx, sy, false);
    const ext = progressionFlood(rows, sx, sy, true);
    const reach = (x, y) => !!base.seen[y * w + x];
    const reachSecret = (x, y) => !!ext.seen[y * w + x];
    for (const [x, y, k] of keys) if (!reach(x, y)) say(`${k} key at ${x},${y} is unreachable`);
    for (const [x, y] of triggers) if (!reach(x, y)) say(`siege trigger at ${x},${y} is unreachable`);
    for (const [x, y] of exits) if (!reach(x, y)) say(`exit at ${x},${y} is unreachable`);
    for (const [x, y] of bosses) if (!reach(x, y)) say(`boss at ${x},${y} is unreachable`);
    let unreachableSky = 0;
    for (const [x, y] of skies) if (!reach(x, y)) unreachableSky++;
    if (unreachableSky) say(`${unreachableSky} open-sky deck cells are unreachable`);
    for (const [x, y, kind] of enemies) {
      if (!reach(x, y) && !reachSecret(x, y)) say(`${kind} at ${x},${y} is unreachable`);
    }
    for (const [x, y, kind] of pickups) {
      if (!reach(x, y) && !reachSecret(x, y)) say(`${kind} at ${x},${y} is unreachable`);
    }
    // keydoors must never gate their own key
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const want = KEY_FOR_DOOR[at(x, y)];
        if (!want) continue;
        if (!keys.some((k) => k[2] === want)) say(`${want} keydoor at ${x},${y} but no ${want} key on the level`);
      }
    }

    // 5. pushwalls need somewhere to go --------------------------------------
    for (const [x, y] of secrets) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const ok = dirs.some(([dx, dy]) => {
        const px = x - dx, py = y - dy;
        if (px < 0 || py < 0 || px >= w || py >= h) return false;
        if (!isWalkableChar(at(px, py))) return false;      // player must be able to push
        for (const step of [1, 2]) {
          const nx = x + dx * step, ny = y + dy * step;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
          if (!isWalkableChar(at(nx, ny))) return false;    // and it must have room to slide
        }
        return true;
      });
      if (!ok) say(`pushwall at ${x},${y} has no valid push direction`);
    }

    // 6. weapon pickups match the level's weapon list -------------------------
    const declared = (def.weapons || []).length;
    if (weaponCells.length !== declared) {
      say(`${weaponCells.length} 'w' cells but ${declared} entries in weapons[]`);
    }

    // 7. textures ------------------------------------------------------------
    const texOk = (t, where) => {
      if (!VALID_TEXTURES.includes(t)) say(`unknown texture '${t}' (${where})`);
    };
    texOk(def.floorTex, 'floorTex');
    texOk(def.ceilTex, 'ceilTex');
    texOk(def.deckFloorTex, 'deckFloorTex');
    for (const [ch, t] of Object.entries(def.wallTex || {})) {
      if (!LEGEND[ch]) say(`wallTex override for unknown char '${ch}'`);
      texOk(t, `wallTex['${ch}']`);
    }
    const seenChars = new Set();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) seenChars.add(at(x, y));
    for (const ch of seenChars) {
      const d = descOf(ch);
      if (d && d.tex) texOk(wallTexFor(def, ch), `char '${ch}'`);
    }

    // 8. triggers and waves line up ------------------------------------------
    const waves = (def.siege && def.siege.waves) || [];
    triggers.forEach((t, ti) => {
      if (!waves.some((wv) => wv.trigger === ti)) say(`siege trigger #${ti} at ${t[0]},${t[1]} has no wave`);
    });
    waves.forEach((wv, wi) => {
      if (!(wv.trigger >= 0 && wv.trigger < triggers.length)) {
        say(`wave ${wi} ('${wv.name}') points at trigger ${wv.trigger}, which does not exist`);
      }
    });

    // 9. doors sit in real doorways ------------------------------------------
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = descOf(at(x, y));
        if (!d || d.type !== 'door') continue;
        const wN = isSolidChar(at(x, y - 1)), wS = isSolidChar(at(x, y + 1));
        const wE = isSolidChar(at(x + 1, y)), wW = isSolidChar(at(x - 1, y));
        const oN = isWalkableChar(at(x, y - 1)), oS = isWalkableChar(at(x, y + 1));
        const oE = isWalkableChar(at(x + 1, y)), oW = isWalkableChar(at(x - 1, y));
        const horizontal = wW && wE && oN && oS;
        const vertical = wN && wS && oE && oW;
        if (!horizontal && !vertical) say(`door at ${x},${y} is not in a clean doorway`);
      }
    }

    // 10. parse-level invariants ---------------------------------------------
    const lv = parseLevel(li);
    for (const e of lv.ents) {
      const ex = (e.x - 0.5) | 0, ey = (e.y - 0.5) | 0;
      const i = ey * lv.w + ex;
      if (lv.wall[i]) say(`${e.kind} at ${ex},${ey} sits inside a wall`);
      if (!lv.floorTexName[i]) say(`${e.kind} at ${ex},${ey} sits on a cell with no floor`);
      if (e.kind === 'weapon' && !e.weapon) say(`weapon pickup at ${ex},${ey} got no name from weapons[]`);
    }
    if (li === 4 && !bosses.length) say('is the boss level but has no K');

    // 11. set dressing never cuts a route ------------------------------------
    // Re-flood with every solid prop as a wall: everything the bare map could
    // reach must still be reachable, prop cells themselves aside.
    const propAt = new Uint8Array(w * h);
    for (const d of lv.decor || []) {
      const dx = d.x | 0, dy = d.y | 0;
      const i = dy * w + dx;
      if (lv.wall[i]) say(`${d.kind} prop at ${dx},${dy} sits inside a wall`);
      if (d.solid) propAt[i] = 1;
    }
    const blockedRows = rows.map((r, y) => [...r].map((ch, x) => (propAt[y * w + x] ? '#' : ch)).join(''));
    const dressedFlood = progressionFlood(blockedRows, sx, sy, false);
    let cut = 0;
    for (let i = 0; i < w * h; i++) if (base.seen[i] && !propAt[i] && !dressedFlood.seen[i]) cut++;
    if (cut) say(`solid props cut off ${cut} reachable cells`);
  });
  return problems;
}
