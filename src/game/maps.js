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
export const VALID_TEXTURES = [
  'CONCRETE', 'CONCRETE_CRACKED', 'STEEL_PLATE', 'STEEL_RIVET', 'HAZARD', 'PIPES',
  'VENT', 'TILE', 'TILE_BLOOD', 'RUST', 'SANDBAG', 'SCREENS', 'CIRCUIT', 'SILO_WALL',
  'WARNING', 'DOOR', 'DOOR_JAMB', 'DOOR_RED', 'DOOR_BLUE', 'DOOR_GOLD', 'ELEVATOR',
  'FLESH', 'FLOOR_CONCRETE', 'FLOOR_GRATE', 'FLOOR_TILE', 'FLOOR_DIRT', 'FLOOR_BLOOD',
  'CEIL_CONCRETE', 'CEIL_LAMP', 'CEIL_PIPES', 'CEIL_FLESH', 'FLOOR_DECK',
];

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
    wallTex: {},
    floorTex: 'FLOOR_CONCRETE',
    ceilTex: 'CEIL_CONCRETE',
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
    wallTex: { '#': 'STEEL_RIVET' },
    floorTex: 'FLOOR_TILE',
    ceilTex: 'CEIL_PIPES',
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
    wallTex: {},
    floorTex: 'FLOOR_CONCRETE',
    ceilTex: 'CEIL_CONCRETE',
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
    floorTex: 'FLOOR_CONCRETE',
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
    wallTex: { '#': 'STEEL_PLATE' },
    floorTex: 'FLOOR_TILE',
    ceilTex: 'CEIL_CONCRETE',
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
      if (d.floor) floorTexName[i] = d.floor;
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
  });
  return problems;
}
