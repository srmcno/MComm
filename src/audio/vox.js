// vox.js — MUTTER, the bunker announcer.
//
// A cascade-free *parallel formant synthesiser* built entirely out of Web Audio
// primitives: a Rosenberg-ish glottal PeriodicWave and a white-noise buffer feed
// a five-band bandpass resonator bank whose centre frequencies, bandwidths and
// gains are ramped continuously (never stepped) between phoneme targets. Text is
// turned into phonemes by an NRL-style ordered rule set with an exception
// dictionary and a `{...}` literal-phoneme escape. The whole thing then goes
// through a fixed "PA horn" character chain — tube grit, 200 Hz/5 kHz band
// limiting, slapback + concrete reverb, and a bit-crush/dropout glitch stage.
//
// No speechSynthesis. No samples. No network. No libraries.

/* ────────────────────────────────────────────────────────────────────────── */
/* small utilities                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Deterministic xorshift32 — same sequence every run, so line picks repeat. */
let _seed = 0x1a2b3c4d >>> 0;
function rnd() {
  let x = _seed >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  _seed = x;
  return x / 4294967296;
}
/** Re-seed the line/jitter PRNG (tests use this to make renders reproducible). */
export function seedVox(n) { _seed = (n >>> 0) || 1; }

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. PHONEME INVENTORY — 41 phones + silence                                 */
/*    f  = [F1..F5] Hz     bw = bandwidths Hz      a = per-formant amplitude   */
/* ────────────────────────────────────────────────────────────────────────── */

// Per-formant trim that pre-compensates the lip-radiation shelf in the
// character chain. Without it F3-F5 arrive as loud as F1, the upper harmonics
// smear under vibrato, and every vowel reads as broadband hiss.
const TRIM = [1.0, 0.82, 0.30, 0.060, 0.020];

const BW_V = [90, 110, 170, 250, 320];
const BW_NAS = [180, 300, 420, 380, 400];

// Monophthongs. Values are the classic Peterson–Barney adult-male means,
// nudged for the announcer's low institutional register.
const VOWEL = {
  AA: { f: [730, 1090, 2440, 3300, 4200], a: [1.00, 0.62, 0.30, 0.13, 0.06] },
  AE: { f: [660, 1720, 2410, 3300, 4200], a: [1.00, 0.72, 0.34, 0.14, 0.06] },
  AH: { f: [640, 1190, 2390, 3300, 4200], a: [1.00, 0.60, 0.28, 0.12, 0.06] },
  AO: { f: [570,  840, 2410, 3300, 4200], a: [1.00, 0.55, 0.22, 0.10, 0.05] },
  AX: { f: [500, 1480, 2500, 3300, 4200], a: [0.85, 0.55, 0.26, 0.11, 0.05] },
  EH: { f: [530, 1840, 2480, 3350, 4250], a: [0.95, 0.80, 0.36, 0.15, 0.07] },
  ER: { f: [490, 1350, 1690, 3200, 4100], a: [0.92, 0.72, 0.52, 0.10, 0.05] },
  IH: { f: [390, 1990, 2550, 3400, 4250], a: [0.82, 0.86, 0.40, 0.16, 0.07] },
  IY: { f: [280, 2290, 3010, 3500, 4300], a: [0.70, 0.96, 0.52, 0.18, 0.08] },
  UH: { f: [440, 1020, 2240, 3200, 4100], a: [0.92, 0.52, 0.22, 0.10, 0.05] },
  UW: { f: [310,  870, 2240, 3200, 4100], a: [0.80, 0.44, 0.18, 0.08, 0.04] },
};

// Diphthongs glide from one target to another across the phone.
const DIPH = {
  AY: ['AA', 'IH'],
  EY: ['EH', 'IY'],
  OY: ['AO', 'IH'],
  AW: ['AA', 'UH'],
  OW: [{ f: [570, 850, 2410, 3300, 4200], a: [1.00, 0.55, 0.22, 0.10, 0.05] },
       { f: [400, 760, 2350, 3200, 4100], a: [0.85, 0.45, 0.18, 0.08, 0.04] }],
};

// Consonant places of articulation — formant loci. A consonant's resonator
// target is a blend of its locus and the adjacent vowel; that blend, ramped
// smoothly, *is* the place cue a listener actually hears.
const LOCUS = {
  lab: [380, 1000, 2300, 3200, 4100],   // P B M F V W
  alv: [380, 1720, 2600, 3300, 4200],   // T D N S Z L TH DH
  pal: [330, 2050, 2800, 3400, 4250],   // SH ZH CH JH Y
  vel: [340, 1700, 2250, 3200, 4100],   // K G NG  (F2/F3 pinch)
  ret: [340, 1050, 1400, 3100, 4000],   // R
};

// class: v=vowel d=diphthong n=nasal s=stop f=fricative a=affricate
//        l=liquid/glide h=aspirate
// vc: voiced.  dur: base duration in seconds at rate 1.
const CONS = {
  P:  { cls: 's', vc: 0, loc: 'lab', dur: 0.090, burst: [1000, 1.1, 0.59], asp: 0.040 },
  B:  { cls: 's', vc: 1, loc: 'lab', dur: 0.075, burst: [900, 1.1, 0.29], asp: 0.008 },
  T:  { cls: 's', vc: 0, loc: 'alv', dur: 0.090, burst: [3900, 2.4, 0.89], asp: 0.040 },
  D:  { cls: 's', vc: 1, loc: 'alv', dur: 0.072, burst: [3300, 2.4, 0.36], asp: 0.008 },
  K:  { cls: 's', vc: 0, loc: 'vel', dur: 0.098, burst: [1900, 3.0, 0.89], asp: 0.052 },
  G:  { cls: 's', vc: 1, loc: 'vel', dur: 0.078, burst: [1750, 3.0, 0.36], asp: 0.010 },

  CH: { cls: 'a', vc: 0, loc: 'pal', dur: 0.125, burst: [2700, 2.4, 0.83], fric: [2500, 3500, 2.6, 0.73] },
  JH: { cls: 'a', vc: 1, loc: 'pal', dur: 0.105, burst: [2600, 2.4, 0.41], fric: [2450, 3400, 2.6, 0.37] },

  //                        f1   f2   Q   amp
  F:  { cls: 'f', vc: 0, loc: 'lab', dur: 0.098, fric: [1500, 4200, 0.8, 0.25] },
  V:  { cls: 'f', vc: 1, loc: 'lab', dur: 0.068, fric: [1400, 4000, 0.8, 0.13] },
  TH: { cls: 'f', vc: 0, loc: 'alv', dur: 0.092, fric: [4400, 6000, 1.0, 0.20] },
  DH: { cls: 'f', vc: 1, loc: 'alv', dur: 0.058, fric: [4200, 5800, 1.0, 0.10] },
  S:  { cls: 'f', vc: 0, loc: 'alv', dur: 0.115, fric: [5100, 6600, 4.6, 0.78] },
  Z:  { cls: 'f', vc: 1, loc: 'alv', dur: 0.088, fric: [5000, 6400, 4.6, 0.35] },
  SH: { cls: 'f', vc: 0, loc: 'pal', dur: 0.118, fric: [2400, 3400, 2.7, 1.00] },
  ZH: { cls: 'f', vc: 1, loc: 'pal', dur: 0.085, fric: [2350, 3300, 2.7, 0.43] },
  HH: { cls: 'h', vc: 0, loc: null,  dur: 0.062, asp: 0.062 },

  M:  { cls: 'n', vc: 1, loc: 'lab', dur: 0.072, nas: [280, 1100, 2200, 3000, 3900] },
  N:  { cls: 'n', vc: 1, loc: 'alv', dur: 0.070, nas: [280, 1600, 2600, 3100, 4000] },
  NG: { cls: 'n', vc: 1, loc: 'vel', dur: 0.078, nas: [280, 2000, 2700, 3100, 4000] },

  L:  { cls: 'l', vc: 1, loc: 'alv', dur: 0.066, gl: [380, 1100, 2800, 3300, 4200], ga: [0.90, 0.42, 0.24, 0.10, 0.05] },
  R:  { cls: 'l', vc: 1, loc: 'ret', dur: 0.070, gl: [340, 1050, 1400, 3100, 4000], ga: [0.90, 0.68, 0.50, 0.10, 0.05] },
  W:  { cls: 'l', vc: 1, loc: 'lab', dur: 0.058, gl: [300,  660, 2200, 3200, 4100], ga: [0.85, 0.40, 0.16, 0.08, 0.04] },
  Y:  { cls: 'l', vc: 1, loc: 'pal', dur: 0.055, gl: [280, 2200, 3050, 3500, 4300], ga: [0.70, 0.90, 0.44, 0.16, 0.07] },
};

// Burst / frication amplitudes above are *relative* (1.0 = the loudest
// fricative, /sh/). NOISE_GAIN puts them on the same scale as voicing, after
// undoing the lip-radiation shelf the character chain applies downstream --
// without that correction the noise branch arrives ~14 dB hot and /s/ drowns
// the vowels it is supposed to sit beside.
const NOISE_GAIN = 0.0363;

const VOWEL_DUR = { v: 0.132, d: 0.190 };
const IS_VOWEL = (p) => !!VOWEL[p] || !!DIPH[p];
/** Every phone this synth knows, for tooling/validation. */
export const PHONE_SET = Object.freeze(
  [...Object.keys(VOWEL), ...Object.keys(DIPH), ...Object.keys(CONS)].sort()
);

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. TEXT → PHONEMES                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];

function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], 'hundred'); n %= 100; if (n) out.push('and'); }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) out.push(ONES[n]); }
  else if (n > 0) out.push(ONES[n]);
  return out;
}

/** 1979 → "nineteen seventy nine"; 2400 → "two thousand four hundred"; etc. */
function numberToWords(str) {
  let n = parseInt(str, 10);
  if (!isNum(n)) return [];
  if (n === 0) return ['zero'];
  // Years read as two pairs.
  if (str.length === 4 && n >= 1100 && n <= 2099 && str[0] !== '0') {
    const hi = Math.floor(n / 100), lo = n % 100;
    if (lo === 0) return [...under1000(hi), 'hundred'];
    if (lo < 10) return [...under1000(hi), 'oh', ONES[lo]];
    return [...under1000(hi), ...under1000(lo)];
  }
  const out = [];
  if (n >= 1000000) { out.push(...under1000(Math.floor(n / 1000000)), 'million'); n %= 1000000; }
  if (n >= 1000) { out.push(...under1000(Math.floor(n / 1000)), 'thousand'); n %= 1000; }
  if (n > 0) out.push(...under1000(n));
  return out;
}

const ABBREV = {
  'MR': 'mister', 'MRS': 'missus', 'DR': 'doctor', 'ST': 'saint',
  'NO': 'number', 'VS': 'versus', 'ETC': 'etcetera', 'PCT': 'percent',
};

/* --- exception dictionary ------------------------------------------------ */
/* Stress digits: 1 = primary, 2 = secondary, 0/absent = unstressed.          */
const DICT = {
  // proper nouns and coinages the rules cannot know
  MUTTER: 'M UH1 T ER', SIEBEN: 'Z IY1 B AH N', NUKEHAUS: 'N UW1 K HH AW S',
  VERITY: 'V EH1 R IH T IY', ASHGROVE: 'AE1 SH G R OW V',
  SABBATH: 'S AE1 B AH TH', CANDLEMARK: 'K AE1 N D AH L M AA R K',
  HOLLOW: 'HH AA1 L OW', ERROL: 'EH1 R AH L', DRESSEL: 'D R EH1 S AH L',
  MIRV: 'M ER1 V', WARDEN: 'W AO1 R D AH N', BUNKER: 'B AH1 NG K ER',
  // function words (deliberately unstressed and reduced)
  THE: 'DH AH', A: 'AH', AN: 'AE N', OF: 'AH V', TO: 'T UW', AND: 'AH N D',
  IS: 'IH Z', ARE: 'AA R', WAS: 'W AH Z', WERE: 'W ER', BE: 'B IY',
  BEEN: 'B IH N', AM: 'AE M', IT: 'IH T', ITS: 'IH T S', IN: 'IH N',
  ON: 'AA N', AT: 'AE T', AS: 'AE Z', BY: 'B AY', FOR: 'F AO R',
  FROM: 'F R AH M', WITH: 'W IH DH', THAT: 'DH AE T', THIS: 'DH IH S',
  THESE: 'DH IY Z', THOSE: 'DH OW Z', THERE: 'DH EH R', THEIR: 'DH EH R',
  THEY: 'DH EY', THEM: 'DH EH M', THEN: 'DH EH N', THAN: 'DH AE N',
  YOU: 'Y UW', YOUR: 'Y AO R', YOURS: 'Y AO R Z', MY: 'M AY', ME: 'M IY',
  I: 'AY1', WE: 'W IY', HE: 'HH IY', SHE: 'SH IY', HIS: 'HH IH Z',
  HER: 'HH ER', HAS: 'HH AE Z', HAVE: 'HH AE V', HAD: 'HH AE D',
  WILL: 'W IH L', WOULD: 'W UH D', SHALL: 'SH AE L', SHOULD: 'SH UH D',
  CAN: 'K AE N', COULD: 'K UH D', DO: 'D UW', DOES: 'D AH Z',
  DID: 'D IH D', DONE: 'D AH1 N', NOT: 'N AA T', NO: 'N OW1', SO: 'S OW1',
  OR: 'AO R', IF: 'IH F', BUT: 'B AH T', ALL: 'AO1 L', ANY: 'EH1 N IY',
  WHAT: 'W AH1 T', WHEN: 'W EH1 N', WHERE: 'W EH1 R', WHO: 'HH UW1',
  HOW: 'HH AW1', WHY: 'W AY1', WHICH: 'W IH1 CH',
  ONE: 'W AH1 N', TWO: 'T UW1', THREE: 'TH R IY1', FOUR: 'F AO1 R',
  FIVE: 'F AY1 V', SIX: 'S IH1 K S', SEVEN: 'S EH1 V AH N',
  EIGHT: 'EY1 T', NINE: 'N AY1 N', TEN: 'T EH1 N', ELEVEN: 'IH L EH1 V AH N',
  NINETEEN: 'N AY2 N T IY1 N', SEVENTY: 'S EH1 V AH N T IY',
  ONCE: 'W AH1 N S', ZERO: 'Z IH1 R OW',
  // words the letter rules mangle or under-stress
  ARE_: 'AA R',
  AGAIN: 'AH G EH1 N', ALREADY: 'AO L R EH1 D IY', ALWAYS: 'AO1 L W EY Z',
  ANOTHER: 'AH N AH1 DH ER', ANYTHING: 'EH1 N IY TH IH NG',
  ANYBODY: 'EH1 N IY B AA D IY', SOMEBODY: 'S AH1 M B AA D IY',
  NOBODY: 'N OW1 B AA D IY', EVERYBODY: 'EH1 V R IY B AA D IY',
  EVERY: 'EH1 V R IY', EVERYTHING: 'EH1 V R IY TH IH NG',
  NOTHING: 'N AH1 TH IH NG', SOMETHING: 'S AH1 M TH IH NG',
  BEAUTIFUL: 'B Y UW1 T IH F AH L', BEHIND: 'B IH HH AY1 N D',
  BECOME: 'B IH K AH1 M', BEFORE: 'B IH F AO1 R', BECAUSE: 'B IH K AO1 Z',
  BELONGED: 'B IH L AO1 NG D', BRIEFLY: 'B R IY1 F L IY',
  BUSTER: 'B AH1 S T ER', CEILING: 'S IY1 L IH NG',
  CITIES: 'S IH1 T IY Z', CITY: 'S IH1 T IY', CLEAN: 'K L IY1 N',
  CLEARED: 'K L IY1 R D', COLLECTED: 'K AH L EH1 K T IH D',
  CONSIDER: 'K AH N S IH1 D ER', CONTINUE: 'K AH N T IH1 N Y UW',
  CORRECTLY: 'K ER EH1 K T L IY', CORRESPONDENCE: 'K AO R AH S P AA1 N D AH N S',
  CORRIDOR: 'K AO1 R IH D AO R', CORRIDORS: 'K AO1 R IH D AO R Z',
  COUNTED: 'K AW1 N T IH D', CRITICAL: 'K R IH1 T IH K AH L',
  CROSS: 'K R AO1 S', DESIGNATED: 'D EH1 Z IH G N EY T IH D',
  DISAPPOINTED: 'D IH S AH P OY1 N T IH D', DISCOURAGED: 'D IH S K ER1 IH JH D',
  DIVIDE: 'D IH V AY1 D', DIVIDES: 'D IH V AY1 D Z',
  DOOR: 'D AO1 R', DOORS: 'D AO1 R Z', DESCENDING: 'D IH S EH1 N D IH NG',
  EDGES: 'EH1 JH IH Z', ELEVATED: 'EH1 L AH V EY T IH D',
  ENTHUSIASM: 'IH N TH UW1 Z IY AE Z AH M', EXCELLENT: 'EH1 K S AH L AH N T',
  FILE: 'F AY1 L', FINALLY: 'F AY1 N AH L IY', FLAK: 'F L AE1 K',
  FLOOR: 'F L AO1 R', FOND: 'F AA1 N D', FORGOTTEN: 'F ER G AA1 T AH N',
  GENTLE: 'JH EH1 N T AH L', GONE: 'G AO1 N', HEART: 'HH AA1 R T',
  IMPRESSED: 'IH M P R EH1 S T', INBOUND: 'IH1 N B AW N D',
  INTEGRITY: 'IH N T EH1 G R IH T IY', INTERESTING: 'IH1 N T R IH S T IH NG',
  LAUNCH: 'L AO1 N CH', LEAKING: 'L IY1 K IH NG', LEAVING: 'L IY1 V IH NG',
  LOCATE: 'L OW1 K EY T', LOGGED: 'L AO1 G D', LOVELY: 'L AH1 V L IY',
  MORALE: 'M ER AE1 L', MORNING: 'M AO1 R N IH NG',
  NOMINAL: 'N AA1 M IH N AH L', NOTIFY: 'N OW1 T IH F AY',
  OFFLINE: 'AO1 F L AY N', OPERATING: 'AA1 P ER EY T IH NG',
  ORDNANCE: 'AO1 R D N AH N S', PEACE: 'P IY1 S', PEOPLE: 'P IY1 P AH L',
  PERCENT: 'P ER S EH1 N T', PERFECT: 'P ER1 F IH K T',
  PERSONALLY: 'P ER1 S AH N AH L IY', PERSONNEL: 'P ER S AH N EH1 L',
  POPULATION: 'P AA P Y AH L EY1 SH AH N', PREDICTABLE: 'P R IH D IH1 K T AH B AH L',
  PREPARE: 'P R IH P EH1 R', PREVIOUS: 'P R IY1 V IY AH S',
  QUESTION: 'K W EH1 S CH AH N', QUIET: 'K W AY1 AH T',
  RAIL: 'R EY1 L', REACHED: 'R IY1 CH T', REACTION: 'R IY AE1 K SH AH N',
  READ: 'R IY1 D', REGARDING: 'R IH G AA1 R D IH NG', REGARDS: 'R IH G AA1 R D Z',
  REMAIN: 'R IH M EY1 N', REMAINS: 'R IH M EY1 N Z', REMINDER: 'R IH M AY1 N D ER',
  RETIRED: 'R IH T AY1 ER D', RETRACTING: 'R IY T R AE1 K T IH NG',
  ROOF: 'R UW1 F', ROOM: 'R UW1 M', SAFETY: 'S EY1 F T IY',
  SANDWICH: 'S AE1 N D W IH CH', SCHEDULED: 'S K EH1 JH UW L D',
  SCORED: 'S K AO1 R D', SCREAMING: 'S K R IY1 M IH NG',
  SECTOR: 'S EH1 K T ER', SECURED: 'S IH K Y UH1 R D',
  SENTIMENTAL: 'S EH N T IH M EH1 N T AH L', SERVICE: 'S ER1 V IH S',
  SEVERAL: 'S EH1 V R AH L', SILENCE: 'S AY1 L AH N S',
  SIRENS: 'S AY1 R AH N Z', SMART: 'S M AA1 R T', SORRY: 'S AA1 R IY',
  STOPPED: 'S T AA1 P T', STOPPING: 'S T AA1 P IH NG',
  SYSTEMS: 'S IH1 S T AH M Z', TEXTBOOK: 'T EH1 K S T B UH K',
  THANK: 'TH AE1 NG K', THINKING: 'TH IH1 NG K IH NG',
  UNUSUAL: 'AH N Y UW1 ZH UW AH L', VITALS: 'V AY1 T AH L Z',
  WALK: 'W AO1 K', WALLS: 'W AO1 L Z', WARHEAD: 'W AO1 R HH EH D',
  WEAPON: 'W EH1 P AH N', WINDOW: 'W IH1 N D OW', WHOLE: 'HH OW1 L',
  BEARING: 'B EH1 R IH NG', HOUSING: 'HH AW1 Z IH NG',
  ACQUIRED: 'AH K W AY1 ER D', ACCOUNTED: 'AH K AW1 N T IH D',
  ACCOUNT: 'AH K AW1 N T', ADEQUATE: 'AE1 D IH K W AH T',
  AIRBURST: 'EH1 R B ER S T', ARSENAL: 'AA1 R S AH N AH L',
  BALANCE: 'B AE1 L AH N S', BOARD: 'B AO1 R D',
  BRAVE: 'B R EY1 V', CARD: 'K AA1 R D', CHAIN: 'CH EY1 N',
  CONCLUDED: 'K AH N K L UW1 D IH D', CONFIRMED: 'K AH N F ER1 M D',
  ELEVENTH: 'IH L EH1 V AH N TH', ENJOY: 'EH N JH OY1',
  FUSE: 'F Y UW1 Z', HOLD: 'HH OW1 L D', LEVEL: 'L EH1 V AH L',
  LIFT: 'L IH1 F T', LOG: 'L AO1 G', LOOK: 'L UH1 K', LOST: 'L AO1 S T',
  LOW: 'L OW1', MIDDLE: 'M IH1 D AH L', MIND: 'M AY1 N D',
  NEXT: 'N EH1 K S T', OPEN: 'OW1 P AH N', OPERATION: 'AA P ER EY1 SH AH N',
  PLEASE: 'P L IY1 Z', PRESS: 'P R EH1 S', RATE: 'R EY1 T',
  SHOT: 'SH AA1 T', SKY: 'S K AY1', UPDATED: 'AH P D EY1 T IH D',
  WELCOME: 'W EH1 L K AH M', WORSE: 'W ER1 S', WROTE: 'R OW1 T',
  // hand-checked overrides for words the rules still mangle (see tools/vox-g2p.js)
  AH: 'AA1', OH: 'OW1', ADDRESSED: 'AH D R EH1 S T',
  AMMUNITION: 'AE M Y AH N IH1 SH AH N', ANSWER: 'AE1 N S ER',
  APPEAR: 'AH P IY1 R', ASSETS: 'AE1 S EH T S', CHAIR: 'CH EH1 R',
  COMPLAINT: 'K AH M P L EY1 N T', COMPLIANCE: 'K AH M P L AY1 AH N S',
  DOWN: 'D AW1 N', NOW: 'N AW1', GROWN: 'G R OW1 N', OWNER: 'OW1 N ER',
  ENDING: 'EH1 N D IH NG', EXIST: 'IH G Z IH1 S T', FINAL: 'F AY1 N AH L',
  HELLO: 'HH AH L OW1', IGNORE: 'IH G N AO1 R', INTO: 'IH1 N T UW',
  MEANT: 'M EH1 N T', MYSELF: 'M AY S EH1 L F',
  NECESSARY: 'N EH1 S AH S EH R IY', OPENS: 'OW1 P AH N Z',
  PROBLEM: 'P R AA1 B L AH M', PUT: 'P UH1 T', POORLY: 'P UH1 R L IY',
  RESOLVED: 'R IH Z AA1 L V D', SECONDS: 'S EH1 K AH N D Z',
  SOMEWHERE: 'S AH1 M W EH R', TOUCH: 'T AH1 CH', USUAL: 'Y UW1 ZH UW AH L',
  YOURSELF: 'Y AO R S EH1 L F', HAPPENED: 'HH AE1 P AH N D',
  HAPPENING: 'HH AE1 P AH N IH NG', WITHOUT: 'W IH TH AW1 T', KIND: 'K AY1 N D', FIND: 'F AY1 N D',
  // --- vocabulary added by the three-voice story (tools/vox-g2p.js --new) ---
  ABOUT: 'AH B AW1 T', ACROSS: 'AH K R AO1 S', AGO: 'AH G OW1',
  ALIVE: 'AH L AY1 V', ANNOYED: 'AH N OY1 D', ANNUAL: 'AE1 N Y UW AH L',
  ANYONE: 'EH1 N IY W AH N',
  ANYWHERE: 'EH1 N IY W EH R', ANYWAY: 'EH1 N IY W EY',
  APOLOGISING: 'AH P AA1 L AH JH AY Z IH NG', APPLIED: 'AH P L AY1 D',
  APPROACH: 'AH P R OW1 CH', ARCHITECTURE: 'AA1 R K IH T EH K CH ER',
  ARENA: 'AH R IY1 N AH', AROUND: 'AH R AW1 N D', AWAY: 'AH W EY1',
  BEING: 'B IY1 IH NG', BETTER: 'B EH1 T ER', BETWEEN: 'B IH T W IY1 N',
  BIOLOGICAL: 'B AY AH L AA1 JH IH K AH L', BREAK: 'B R EY1 K',
  BREATH: 'B R EH1 TH', BULLET: 'B UH1 L AH T', BULLETS: 'B UH1 L AH T S',
  CAREER: 'K ER IY1 R', CATHEDRAL: 'K AH TH IY1 D R AH L',
  CERTAIN: 'S ER1 T AH N', CHERYL: 'SH EH1 R AH L', CLOSE: 'K L OW1 S',
  COME: 'K AH1 M', COMING: 'K AH1 M IH NG', COMFORTABLE: 'K AH1 M F ER T AH B AH L',
  COMMENDATIONS: 'K AA M AH N D EY1 SH AH N Z', COMPUTER: 'K AH M P Y UW1 T ER',
  CONDUIT: 'K AA1 N D UW IH T', CONSIDERABLY: 'K AH N S IH1 D ER AH B L IY',
  CONTAIN: 'K AH N T EY1 N', CONTAINS: 'K AH N T EY1 N Z',
  COOLANT: 'K UW1 L AH N T', COUNTDOWN: 'K AW1 N T D AW N', COVER: 'K AH1 V ER',
  CREATIVE: 'K R IY EY1 T IH V', CURRENTLY: 'K ER1 AH N T L IY',
  DAMN: 'D AE1 M', DAYS: 'D EY1 Z', DEADLINE: 'D EH1 D L AY N',
  DECIDE: 'D IH S AY1 D', DECOMMISSIONED: 'D IY K AH M IH1 SH AH N D',
  DEGREES: 'D IH G R IY1 Z', DENTAL: 'D EH1 N T AH L',
  DETONATES: 'D EH1 T AH N EY T S', DIVORCE: 'D IH V AO1 R S',
  EFFICIENT: 'IH F IH1 SH AH N T', EMOTIONAL: 'IH M OW1 SH AH N AH L',
  EMPLOYEE: 'EH M P L OY IY1', EMPLOYMENT: 'EH M P L OY1 M AH N T',
  ENCOURAGEMENT: 'EH N K ER1 IH JH M AH N T', ENGINEER: 'EH N JH IH N IY1 R',
  ENGINEERING: 'EH N JH IH N IY1 R IH NG', ENOUGH: 'IH N AH1 F',
  EQUIPMENT: 'IH K W IH1 P M AH N T', EXTREMELY: 'EH K S T R IY1 M L IY',
  FELLA: 'F EH1 L AH', FITTED: 'F IH1 T IH D', FLATLINE: 'F L AE1 T L AY N',
  FLATTERING: 'F L AE1 T ER IH NG', FRIEND: 'F R EH1 N D', FULL: 'F UH1 L',
  FURNACE: 'F ER1 N AH S', GALLERIES: 'G AE1 L ER IY Z', GOES: 'G OW1 Z',
  GOTTEN: 'G AA1 T AH N', HALF: 'HH AE1 F', HAPPEN: 'HH AE1 P AH N',
  HARDIGAN: 'HH AA1 R D IH G AH N', HEY: 'HH EY1', HONEST: 'AA1 N AH S T',
  HOUSE: 'HH AW1 S', HOUSES: 'HH AW1 Z IH Z', HUMAN: 'HH Y UW1 M AH N',
  HUNDRED: 'HH AH1 N D R IH D', HYGIENIST: 'HH AY JH IY1 N IH S T',
  HYPOTHETICALLY: 'HH AY P AH TH EH1 T IH K AH L IY', IDEA: 'AY D IY1 AH',
  IDEALLY: 'AY D IY1 AH L IY', ILSA: 'IH1 L S AH',
  IMPORTANT: 'IH M P AO1 R T AH N T', IMPROVISE: 'IH1 M P R AH V AY Z',
  INCOMING: 'IH1 N K AH M IH NG', INTELLIGENCE: 'IH N T EH1 L IH JH AH N S',
  JACKET: 'JH AE1 K IH T', JUST: 'JH AH1 S T', LAWYER: 'L AO1 Y ER',
  LISTEN: 'L IH1 S AH N', LORETTA: 'L ER EH1 T AH', LOSES: 'L UW1 Z IH Z',
  LOVE: 'L AH1 V', MACHINE: 'M AH SH IY1 N',
  MAINTENANCE: 'M EY1 N T AH N AH N S', METRES: 'M IY1 T ER Z',
  MINUTES: 'M IH1 N IH T S', MISUSE: 'M IH S Y UW1 Z', MONTH: 'M AH1 N TH',
  MONTHS: 'M AH1 N TH S', NEIGHBOURS: 'N EY1 B ER Z', NINETY: 'N AY1 N T IY',
  NONE: 'N AH1 N', NUMBER: 'N AH1 M B ER', OBVIOUSLY: 'AA1 B V IY AH S L IY',
  OKAY: 'OW K EY1', ONTO: 'AA1 N T UW', ORGAN: 'AO1 R G AH N',
  POLITE: 'P AH L AY1 T', POWER: 'P AW1 ER', PROBLEMS: 'P R AA1 B L AH M Z',
  PROFESSIONALLY: 'P R AH F EH1 SH AH N AH L IY', PROFOUND: 'P R AH F AW1 N D',
  PROMOTED: 'P R AH M OW1 T IH D', PROPERTY: 'P R AA1 P ER T IY',
  PROTOTYPE: 'P R OW1 T AH T AY P', RADIO: 'R EY1 D IY OW',
  REACTOR: 'R IY AE1 K T ER', READING: 'R IY1 D IH NG', READS: 'R IY1 D Z',
  REALLY: 'R IY1 L IY', REALLOCATE: 'R IY AE1 L AH K EY T',
  RECORD: 'R EH1 K ER D', REDOUBT: 'R IH D AW1 T',
  REGISTERS: 'R EH1 JH IH S T ER Z', RESCUING: 'R EH1 S K Y UW IH NG',
  RESIDENCE: 'R EH1 Z IH D AH N S', RESTORED: 'R IH S T AO1 R D',
  RETICLE: 'R EH1 T IH K AH L', RIDICULOUS: 'R IH D IH1 K Y AH L AH S',
  ROUTES: 'R UW1 T S', RUNNING: 'R AH1 N IH NG', RUNS: 'R AH1 N Z',
  SAYS: 'S EH1 Z', SCHEMATICS: 'S K IH M AE1 T IH K S',
  SECOND: 'S EH1 K AH N D', SECRET: 'S IY1 K R AH T',
  SENTENCE: 'S EH1 N T AH N S', SOLUTION: 'S AH L UW1 SH AH N',
  SPHERE: 'S F IY1 R', STRATEGY: 'S T R AE1 T AH JH IY',
  SURVIVE: 'S ER V AY1 V', SYSTEM: 'S IH1 S T AH M',
  TECHNICIANS: 'T EH K N IH1 SH AH N Z', TELEMETRY: 'T AH L EH1 M AH T R IY',
  THOUSAND: 'TH AW1 Z AH N D', TIRED: 'T AY1 ER D', TOGETHER: 'T AH G EH1 DH ER',
  TRUCK: 'T R AH1 K', UNLOCKED: 'AH N L AA1 K T', VANCE: 'V AE1 N S',
  WALLET: 'W AA1 L AH T', WEARING: 'W EH1 R IH NG', WEATHER: 'W EH1 DH ER',
  WHATEVER: 'W AH T EH1 V ER', WOMAN: 'W UH1 M AH N', WON: 'W AH1 N',
  WRITTEN: 'R IH1 T AH N', DEB: 'D EH1 B', BOBBI: 'B AA1 B IY',
  YVONNE: 'IH V AA1 N', TRISH: 'T R IH1 SH', BRICK: 'B R IH1 K',
  AREA: 'EH1 R IY AH', ADJUSTS: 'AH JH AH1 S T S',
};

/* --- NRL-style letter-to-sound rules ------------------------------------- */
// Context language:  #=1+ vowels   :=0+ consonants   ^=1 consonant
//   .=voiced consonant   +=front vowel(E,I,Y)   %=suffix(E,ES,ED,ER,ELY,ING)
//   &=sibilant   @=consonant after which long-U is "oo"   ' '=word boundary

const VSET = 'AEIOUY';
const isV = (c) => VSET.indexOf(c) >= 0 && c !== undefined;
const isC = (c) => !!c && c !== ' ' && VSET.indexOf(c) < 0;
const VOICEDC = 'BDVGJLMNRWZ';
const SUFFIXES = ['ELY', 'ING', 'ERS', 'ED', 'ES', 'ER', 'E'];

// Both matchers return a plain boolean: a left-context walk can legitimately
// run off the front of the padded word (index -1), so a numeric "position"
// result is ambiguous and silently kills every word-initial rule.
function matchRight(pat, s, i) {
  let p = 0;
  while (p < pat.length) {
    const c = pat[p++];
    if (c === '#') { if (!isV(s[i])) return false; while (isV(s[i])) i++; }
    else if (c === ':') { while (isC(s[i])) i++; }
    else if (c === '^') { if (!isC(s[i])) return false; i++; }
    else if (c === '.') { if (!s[i] || VOICEDC.indexOf(s[i]) < 0) return false; i++; }
    else if (c === '+') { if (!s[i] || 'EIY'.indexOf(s[i]) < 0) return false; i++; }
    else if (c === '%') {
      let hit = false;
      for (const suf of SUFFIXES) if (s.startsWith(suf, i)) { i += suf.length; hit = true; break; }
      if (!hit) return false;
    } else if (c === '&') {
      if (s.startsWith('CH', i) || s.startsWith('SH', i)) i += 2;
      else if (s[i] && 'SCGZXJ'.indexOf(s[i]) >= 0) i++;
      else return false;
    } else if (c === '@') {
      if (s.startsWith('TH', i) || s.startsWith('CH', i) || s.startsWith('SH', i)) i += 2;
      else if (s[i] && 'TSRDLZNJ'.indexOf(s[i]) >= 0) i++;
      else return false;
    } else if (c === ' ') { if (s[i] !== ' ' && s[i] !== undefined) return false; i++; }
    else { if (s[i] !== c) return false; i++; }
  }
  return true;
}

function matchLeft(pat, s, i) {
  const at = (k) => (k < 0 ? ' ' : s[k]);   // off the front reads as a boundary
  let p = pat.length - 1;
  while (p >= 0) {
    const c = pat[p--];
    if (c === '#') { if (!isV(at(i))) return false; while (isV(at(i))) i--; }
    else if (c === ':') { while (isC(at(i))) i--; }
    else if (c === '^') { if (!isC(at(i))) return false; i--; }
    else if (c === '.') { if (VOICEDC.indexOf(at(i)) < 0) return false; i--; }
    else if (c === '+') { if ('EIY'.indexOf(at(i)) < 0) return false; i--; }
    else if (c === '&') {
      if (i >= 1 && (s.substr(i - 1, 2) === 'CH' || s.substr(i - 1, 2) === 'SH')) i -= 2;
      else if ('SCGZXJ'.indexOf(at(i)) >= 0) i--;
      else return false;
    } else if (c === '@') {
      if (i >= 1 && ['TH', 'CH', 'SH'].includes(s.substr(i - 1, 2))) i -= 2;
      else if ('TSRDLZNJ'.indexOf(at(i)) >= 0) i--;
      else return false;
    } else if (c === ' ') { if (at(i) !== ' ') return false; i--; }
    else { if (at(i) !== c) return false; i--; }
  }
  return true;
}

// [ left, target, right, phonemes ]
const RULES = {
  A: [
    [' ', 'A', ' ', 'AH'],
    [' ', 'A', '^#', 'AH'],
    [' ', 'ARE', ' ', 'AA R'],
    [' ', 'AR', 'O', 'AH R'],
    ['', 'AR', '#', 'EH R'],
    ['', 'AWAY', '', 'AH W EY'],
    ['', 'AW', '', 'AO'],
    [' :', 'ANY', '', 'EH N IY'],
    ['#:', 'ALLY', ' ', 'AH L IY'],
    [' ', 'AL', '#', 'AH L'],
    ['', 'AGAIN', '', 'AH G EH N'],
    ['#:', 'AG', 'E', 'IH JH'],
    ['', 'AI', '', 'EY'],
    ['', 'AY', '', 'EY'],
    ['', 'AU', '', 'AO'],
    ['', 'ALK', '', 'AO K'],
    ['#:', 'AL', ' ', 'AH L'],
    ['', 'ALL', '', 'AO L'],
    ['', 'AL', '^', 'AO L'],
    [' :', 'ABLE', '', 'EY B AH L'],
    ['', 'ABLE', '', 'AH B AH L'],
    ['', 'ANG', '+', 'EY N JH'],
    [' ', 'AR', ' ', 'AA R'],
    ['', 'ARR', '', 'AE R'],
    ['', 'AR', '^', 'AA R'],
    ['', 'AR', ' ', 'AA R'],
    ['', 'A', '^^E', 'AE'],
    ['', 'A', '^%', 'EY'],
    ['', 'A', '^+#', 'EY'],
    ['', 'A', '', 'AE'],
  ],
  B: [
    [' ', 'BE', '^#', 'B IH'],
    ['', 'BEING', '', 'B IY IH NG'],
    [' ', 'BOTH', ' ', 'B OW TH'],
    ['', 'BUIL', '', 'B IH L'],
    ['', 'BB', '', 'B'],
    ['', 'B', '', 'B'],
  ],
  C: [
    [' ', 'CH', '^', 'K'],
    ['^E', 'CH', '', 'K'],
    ['', 'CH', '', 'CH'],
    [' S', 'CI', '#', 'S AY'],
    ['', 'CI', 'A', 'SH'],
    ['', 'CI', 'O', 'SH'],
    ['', 'CI', 'EN', 'SH'],
    ['', 'CK', '', 'K'],
    ['', 'CC', '+', 'K S'],
    ['', 'CC', '', 'K'],
    ['', 'C', '+', 'S'],
    ['', 'C', '', 'K'],
  ],
  D: [
    ['#:', 'DED', ' ', 'D IH D'],
    ['.E', 'D', ' ', 'D'],
    ['#:^E', 'D', ' ', 'T'],
    [' ', 'DE', '^#', 'D IH'],
    [' ', 'DOING', '', 'D UW IH NG'],
    ['', 'DGE', '', 'JH'],
    ['', 'DG', '+', 'JH'],
    ['', 'DD', '', 'D'],
    ['', 'D', '', 'D'],
  ],
  E: [
    ['#:', 'E', ' ', ''],
    [' :', 'E', ' ', 'IY'],
    ['T', 'ED', ' ', 'IH D'],
    ['D', 'ED', ' ', 'IH D'],
    ['#', 'ED', ' ', 'D'],
    ['#:', 'E', 'D ', ''],
    ['', 'EV', 'ER', 'EH V'],
    ['', 'EE', '', 'IY'],
    ['', 'EARN', '', 'ER N'],
    [' ', 'EAR', '^', 'ER'],
    ['', 'EAD', '', 'EH D'],
    ['#:', 'EA', ' ', 'IY AH'],
    ['', 'EIGH', '', 'EY'],
    ['', 'EA', '', 'IY'],
    ['', 'EI', '', 'IY'],
    [' ', 'EYE', '', 'AY'],
    ['', 'EY', '', 'IY'],
    ['', 'EU', '', 'Y UW'],
    ['', 'ERI', '#', 'IY R IY'],
    ['', 'ERI', '', 'EH R IH'],
    ['#:', 'ER', '#', 'ER'],
    ['', 'ER', '#', 'EH R'],
    ['', 'ER', '', 'ER'],
    ['#:&', 'ES', ' ', 'IH Z'],
    ['#:', 'E', 'S ', ''],
    ['#:', 'ELY', ' ', 'L IY'],
    ['#:', 'EMENT', '', 'M AH N T'],
    ['', 'EFUL', '', 'F UH L'],
    ['', 'EW', '', 'UW'],
    ['', 'E', 'O', 'IY'],
    ['#:^', 'E', '^%', 'AH'],
    ['', 'E', '^%', 'IY'],
    ['', 'E', '^+:#', 'EH'],
    ['', 'E', '', 'EH'],
  ],
  F: [
    ['#:^', 'FUL', ' ', 'F UH L'],
    ['', 'FF', '', 'F'],
    ['', 'F', '', 'F'],
  ],
  G: [
    ['', 'GIV', '', 'G IH V'],
    [' ', 'G', 'I^', 'G'],
    ['', 'GE', 'T', 'G EH'],
    ['', 'GG', '', 'G'],
    ['#', 'GH', '', ''],
    [' ', 'GN', '', 'N'],
    ['', 'G', '+', 'JH'],
    ['', 'G', '', 'G'],
  ],
  H: [
    [' ', 'HAV', '', 'HH AE V'],
    [' ', 'HERE', '', 'HH IY R'],
    [' ', 'HOUR', '', 'AW ER'],
    ['', 'HONE', '', 'HH OW N'],
    ['', 'H', '#', 'HH'],
    ['', 'H', '', ''],
  ],
  I: [
    [' ', 'IN', '', 'IH N'],
    [' ', 'I', ' ', 'AY'],
    ['', 'IER', '', 'IY ER'],
    ['#:R', 'IED', ' ', 'IY D'],
    ['', 'IED', ' ', 'AY D'],
    ['', 'IEN', '', 'IY EH N'],
    ['', 'IE', 'T', 'AY EH'],
    ['', 'IGH', '', 'AY'],
    ['', 'ILD', '', 'AY L D'],
    ['', 'IND', ' ', 'AY N D'],
    ['', 'IND', '%', 'AY N D'],
    ['', 'IGN', ' ', 'AY N'],
    ['', 'IGN', '^', 'AY N'],
    ['', 'IGN', '%', 'AY N'],
    ['', 'IQUE', '', 'IY K'],
    ['', 'IE', ' ', 'AY'],
    ['', 'IE', '', 'IY'],
    ['', 'IR', '#', 'AY R'],
    ['', 'IR', '', 'ER'],
    ['', 'IZ', '%', 'AY Z'],
    ['', 'IS', '%', 'AY Z'],
    ['#:^', 'I', '^+', 'IH'],
    ['', 'I', '^%', 'AY'],
    ['', 'I', '^^', 'IH'],
    ['', 'I', '^+:#', 'IH'],
    ['', 'I', '^+', 'AY'],
    ['', 'I', '', 'IH'],
  ],
  J: [['', 'J', '', 'JH']],
  K: [[' ', 'K', 'N', ''], ['', 'K', '', 'K']],
  L: [
    ['', 'LO', 'C#', 'L OW'],
    ['', 'LL', '', 'L'],
    ['#:^', 'L', '%', 'AH L'],
    ['', 'LEAD', '', 'L IY D'],
    ['', 'L', '', 'L'],
  ],
  M: [['', 'MOV', '', 'M UW V'], ['', 'MM', '', 'M'], ['', 'M', '', 'M']],
  N: [
    ['E', 'NG', '+', 'N JH'],
    ['', 'NGL', '%', 'NG G AH L'],
    ['', 'NG', 'R', 'NG G'],
    ['', 'NG', '#', 'NG G'],
    ['', 'NG', '', 'NG'],
    ['', 'NK', '', 'NG K'],
    ['', 'NN', '', 'N'],
    ['', 'N', '', 'N'],
  ],
  O: [
    ['', 'OF', ' ', 'AH V'],
    ['', 'OROUGH', '', 'ER OW'],
    ['#:', 'OR', ' ', 'ER'],
    ['#:', 'ORS', ' ', 'ER Z'],
    ['', 'OR', '', 'AO R'],
    [' ', 'ONE', '', 'W AH N'],
    [' ', 'ONCE', '', 'W AH N S'],
    [' ', 'ONLY', '', 'OW N L IY'],
    [' ', 'OVER', '', 'OW V ER'],
    ['', 'OUGHT', '', 'AO T'],
    ['', 'OUGH', '', 'AH F'],
    ['', 'OULD', '', 'UH D'],
    ['', 'OUR', '', 'AO R'],
    ['', 'OUS', '', 'AH S'],
    ['', 'OUP', '', 'UW P'],
    ['', 'OU', '', 'AW'],
    ['', 'OW', '', 'OW'],
    ['', 'OY', '', 'OY'],
    ['', 'OING', '', 'OW IH NG'],
    ['', 'OI', '', 'OY'],
    ['', 'OOR', '', 'AO R'],
    ['', 'OOK', '', 'UH K'],
    ['', 'OOD', '', 'UH D'],
    ['', 'OO', '', 'UW'],
    ['', 'OA', '', 'OW'],
    ['', 'OL', 'D', 'OW L'],
    ['', 'OST', ' ', 'OW S T'],
    ['', 'O', 'NG', 'AO'],
    ['', 'O', 'SS ', 'AO'],
    ['', 'O', 'FF', 'AO'],
    ['', 'O', '^%', 'OW'],
    ['', 'O', '^EN', 'OW'],
    ['', 'O', '^I#', 'OW'],
    ['I', 'ON', ' ', 'AH N'],
    ['#:', 'ON', ' ', 'AH N'],
    ['', 'O', ' ', 'OW'],
    ['', 'O', 'E ', 'OW'],
    ['', 'O', '', 'AA'],
  ],
  P: [
    ['', 'PH', '', 'F'],
    ['', 'PEOP', '', 'P IY P'],
    [' ', 'P', 'S', ''],
    [' ', 'P', 'N', ''],
    ['', 'PP', '', 'P'],
    ['', 'P', '', 'P'],
  ],
  Q: [['', 'QUAR', '', 'K W AO R'], ['', 'QU', '', 'K W'], ['', 'Q', '', 'K']],
  R: [[' ', 'RE', '^#', 'R IY'], ['', 'RR', '', 'R'], ['', 'R', '', 'R']],
  S: [
    ['', 'SH', '', 'SH'],
    ['#', 'SION', '', 'ZH AH N'],
    ['', 'SION', '', 'SH AH N'],
    ['', 'SOME', '', 'S AH M'],
    ['#', 'SUR', '#', 'ZH ER'],
    ['', 'SUR', '#', 'SH ER'],
    ['#', 'SSU', '#', 'SH UW'],
    ['#', 'SED', ' ', 'Z D'],
    ['', 'SAID', '', 'S EH D'],
    [' ', 'SCH', '', 'S K'],
    ['', 'S', 'C+', ''],
    ['', 'SS', '', 'S'],
    ['#:.E', 'S', ' ', 'Z'],
    ['.', 'S', ' ', 'Z'],
    ['#', 'S', '#', 'Z'],
    ['#', 'SM', '', 'Z M'],
    ['', 'S', '', 'S'],
  ],
  T: [
    ['', 'TCH', '', 'CH'],
    [' ', 'THE', ' ', 'DH AH'],
    ['', 'THER', '', 'DH ER'],
    ['', 'THROUGH', '', 'TH R UW'],
    [' ', 'THUS', '', 'DH AH S'],
    ['', 'TH', '', 'TH'],
    ['#:', 'TED', ' ', 'T IH D'],
    ['S', 'TI', '#N', 'CH'],
    ['', 'TIO', 'N', 'SH AH'],
    ['', 'TI', 'A', 'SH'],
    ['', 'TIEN', '', 'SH AH N'],
    ['', 'TUR', '#', 'CH ER'],
    ['', 'TU', 'A', 'CH UW'],
    ['', 'TT', '', 'T'],
    ['', 'T', '', 'T'],
  ],
  U: [
    [' ', 'UN', 'I', 'Y UW N'],
    [' ', 'UN', '', 'AH N'],
    [' ', 'UPON', '', 'AH P AO N'],
    ['@', 'UR', '#', 'UH R'],
    ['', 'UR', '#', 'Y UH R'],
    ['', 'UR', '', 'ER'],
    ['', 'UY', '', 'AY'],
    ['G', 'U', '#', 'W'],
    ['#N', 'U', '', 'Y UW'],
    ['@', 'U', '', 'UW'],
    ['', 'U', '^^', 'AH'],
    ['', 'U', '^ ', 'AH'],
    ['', 'U', '', 'Y UW'],
  ],
  V: [['', 'VIEW', '', 'V Y UW'], ['', 'V', '', 'V']],
  W: [
    [' ', 'WERE', '', 'W ER'],
    ['', 'WA', 'SH', 'W AA'],
    ['', 'WA', 'ST', 'W EY'],
    ['', 'WA', 'S', 'W AA'],
    ['', 'WA', 'T', 'W AA'],
    ['', 'WHOL', '', 'HH OW L'],
    ['', 'WHO', '', 'HH UW'],
    ['', 'WH', '', 'W'],
    ['', 'WAR', '', 'W AO R'],
    ['', 'WOR', '^', 'W ER'],
    [' ', 'WR', '', 'R'],
    ['', 'W', '', 'W'],
  ],
  X: [[' ', 'X', '', 'Z'], ['', 'X', '', 'K S']],
  Y: [
    ['', 'YOUNG', '', 'Y AH NG'],
    [' ', 'YOU', '', 'Y UW'],
    [' ', 'YES', '', 'Y EH S'],
    [' ', 'Y', '', 'Y'],
    ['#:^', 'Y', ' ', 'IY'],
    ['#:^', 'Y', 'I', 'IY'],
    [' :', 'Y', ' ', 'AY'],
    [' :', 'Y', '#', 'AY'],
    [' :', 'Y', '^+:#', 'IH'],
    [' :', 'Y', '^#', 'AY'],
    ['', 'Y', '', 'IH'],
  ],
  Z: [['', 'ZZ', '', 'Z'], ['', 'Z', '', 'Z']],
  "'": [["", "'", '', '']],
};

/** Run the ordered letter-to-sound rules over one bare word (letters only). */
function rulesToPhonemes(word) {
  const s = ' ' + word.toUpperCase().replace(/[^A-Z']/g, '') + ' ';
  const out = [];
  let i = 1;
  let guard = 0;
  while (i < s.length - 1 && guard++ < 400) {
    const set = RULES[s[i]];
    if (!set) { i++; continue; }
    let matched = false;
    for (let r = 0; r < set.length; r++) {
      const [L, T, R, P] = set[r];
      if (!s.startsWith(T, i)) continue;
      if (L && !matchLeft(L, s, i - 1)) continue;
      if (R && !matchRight(R, s, i + T.length)) continue;
      if (P) out.push(...P.split(' '));
      i += T.length;
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  return out;
}

const UNSTRESSED_PREFIX = /^(RE|DE|PRE|PRO|CON|COM|EX|BE|PER|SUR|SUP|SUB|DIS|MIS|OB)[A-Z]{3,}/;
const FUNCTION_WORDS = new Set(Object.keys(DICT).filter((w) => DICT[w].indexOf('1') < 0));

/** Heuristic lexical stress for words we have no dictionary entry for. */
function assignStress(word, phones) {
  const vi = [];
  for (let i = 0; i < phones.length; i++) if (IS_VOWEL(phones[i])) vi.push(i);
  if (!vi.length) return phones;
  const W = word.toUpperCase();
  if (FUNCTION_WORDS.has(W)) return phones;
  let pick = 0;
  // an initial reduced A- ("about", "around") never takes the stress
  if (vi.length >= 2 && vi[0] === 0 && phones[0] === 'AH' && W[0] === 'A') pick = 1;
  else if (vi.length >= 2) {
    if (/(TION|SION|CIAN|ITY|ICAL|IC|ICS|ITION)$/.test(W)) pick = Math.max(0, vi.length - 2);
    else if (/(ATION|ITION)$/.test(W)) pick = Math.max(0, vi.length - 2);
    else if (UNSTRESSED_PREFIX.test(W) && vi.length >= 2) pick = 1;
  }
  const out = phones.slice();
  out[vi[pick]] = out[vi[pick]] + '1';
  return out;
}

/** Split a stress digit off a phone code: "AH1" → ["AH", 1]. */
function splitStress(code) {
  const m = /^([A-Z]+)([0-9])?$/.exec(code);
  if (!m) return null;
  return [m[1], m[2] ? +m[2] : 0];
}

/** Grapheme-to-phoneme for a single word. Returns codes possibly with stress. */
export function g2pWord(word) {
  const raw = String(word || '').replace(/[^A-Za-z']/g, '');
  if (!raw) return [];
  const W = raw.toUpperCase();
  if (DICT[W]) return DICT[W].split(/\s+/).filter(Boolean);
  if (ABBREV[W]) return g2pWord(ABBREV[W]);
  const bare = rulesToPhonemes(W);
  const valid = bare.filter((p) => VOWEL[p] || DIPH[p] || CONS[p]);
  return assignStress(W, valid);
}

/**
 * Full text → phone list.
 * Returns [{p, st, wb, pause}] where `pause` marks silence (seconds) and `wb`
 * flags the first phone of a word. `{A B C}` spans are taken literally.
 */
export function textToPhonemes(text) {
  const src = String(text == null ? '' : text).replace(/[\u2018\u2019\u02bc]/g, "'");
  const out = [];
  const pushWord = (codes) => {
    let first = true;
    for (const c of codes) {
      const sp = splitStress(c);
      if (!sp) continue;
      if (!(VOWEL[sp[0]] || DIPH[sp[0]] || CONS[sp[0]])) continue;
      out.push({ p: sp[0], st: sp[1], wb: first });
      first = false;
    }
  };
  const pushPause = (d) => {
    const last = out[out.length - 1];
    if (last && last.pause) { last.pause = Math.max(last.pause, d); return; }
    if (out.length) out.push({ p: null, st: 0, wb: false, pause: d });
  };

  // Alternate plain-text runs and {PHONEME ESCAPE} spans.
  const parts = src.split(/(\{[^}]*\})/g);
  for (const part of parts) {
    if (!part) continue;
    if (part[0] === '{' && part[part.length - 1] === '}') {
      pushWord(part.slice(1, -1).trim().toUpperCase().split(/\s+/).filter(Boolean));
      continue;
    }
    const toks = part.match(/[A-Za-z][A-Za-z']*|\d+|[.,;:!?—–-]+|\s+/g);
    if (!toks) continue;
    for (const t of toks) {
      if (/^\s+$/.test(t)) continue;
      if (/^\d+$/.test(t)) { for (const w of numberToWords(t)) pushWord(g2pWord(w)); continue; }
      if (/^[A-Za-z']/.test(t)) { pushWord(g2pWord(t)); continue; }
      if (/[.!]/.test(t)) pushPause(0.30);
      else if (t.indexOf('?') >= 0) { pushPause(0.30); markTerminal(out, 'q'); }
      else if (/[—–]|--/.test(t)) pushPause(0.24);
      else pushPause(0.16);
      if (/[.!]/.test(t)) markTerminal(out, 'f');
    }
  }
  return out;
}

function markTerminal(list, kind) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].p) { list[i].term = kind; return; }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 3. PHONES → ACOUSTIC SEGMENTS                                              */
/* ────────────────────────────────────────────────────────────────────────── */

const DEF_A = [1.0, 0.6, 0.3, 0.12, 0.06];

function vowelFrames(p) {
  if (VOWEL[p]) return [VOWEL[p], VOWEL[p]];
  const d = DIPH[p];
  if (!d) return [{ f: VOWEL.AX.f, a: VOWEL.AX.a }, { f: VOWEL.AX.f, a: VOWEL.AX.a }];
  const g = (x) => (typeof x === 'string' ? VOWEL[x] : x);
  return [g(d[0]), g(d[1])];
}

/** Nearest vowel-ish target on either side, for locus blending. */
function neighbourVowel(phones, i, dir) {
  for (let k = i + dir; k >= 0 && k < phones.length; k += dir) {
    const p = phones[k].p;
    if (!p) break;
    if (IS_VOWEL(p)) { const fr = vowelFrames(p); return dir > 0 ? fr[0] : fr[1]; }
  }
  return VOWEL.AX;
}

const blend = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Expand a phone list into timed acoustic segments.
 * Each segment: { d, F, Fe, A, bw, v, ve, asp, fr, f1, f2, fg2, tr }
 */
function buildSegments(phones, opt) {
  const rate = clamp(num(opt.rate, 1), 0.4, 2.6);
  const segs = [];
  const push = (s) => { if (s.d > 0.0015) segs.push(s); };

  for (let i = 0; i < phones.length; i++) {
    const ph = phones[i];
    if (!ph.p) {
      push({ d: clamp(ph.pause / rate, 0.02, 1.2), F: VOWEL.AX.f, A: [0, 0, 0, 0, 0],
        bw: BW_V, v: 0, asp: 0, fr: 0, f1: 1500, f2: 3000, fg2: 0, tr: 0.03, sil: 1 });
      continue;
    }
    const p = ph.p;

    /* ---- vowels & diphthongs ---- */
    if (IS_VOWEL(p)) {
      const [s0, s1] = vowelFrames(p);
      let d = (DIPH[p] ? VOWEL_DUR.d : VOWEL_DUR.v);
      d *= ph.st ? 1.5 : 0.78;
      if (ph.term) d *= 1.35;
      if (p === 'AX') d *= 0.72;
      push({
        d: d / rate, F: s0.f, Fe: s1.f, A: s0.a, Ae: s1.a, bw: BW_V,
        v: 1, asp: 0.012, fr: 0, f1: 1500, f2: 3000, fg2: 0,
        tr: 0.048, vowel: 1, st: ph.st,
      });
      continue;
    }

    const c = CONS[p];
    if (!c) continue;
    const prevV = neighbourVowel(phones, i, -1);
    const nextV = neighbourVowel(phones, i, +1);
    const loc = c.loc ? LOCUS[c.loc] : nextV.f;
    const wordFinal = !phones[i + 1] || !phones[i + 1].p;
    const dur = c.dur / rate;

    /* ---- nasals ---- */
    if (c.cls === 'n') {
      push({
        d: dur, F: blend(c.nas, nextV.f, 0.12), A: [0.85, 0.20, 0.12, 0.05, 0.02],
        bw: BW_NAS, v: 0.72, asp: 0, fr: 0, f1: 1500, f2: 3000, fg2: 0, tr: 0.030,
      });
      continue;
    }

    /* ---- liquids and glides ---- */
    if (c.cls === 'l') {
      const t = p === 'W' || p === 'Y' ? 0.10 : 0.20;
      push({
        d: dur, F: blend(c.gl, nextV.f, t), Fe: blend(c.gl, nextV.f, t + 0.22),
        A: c.ga, bw: BW_V, v: 0.92, asp: 0.02, fr: 0, f1: 1500, f2: 3000, fg2: 0,
        tr: 0.042,
      });
      continue;
    }

    /* ---- aspirate ---- */
    if (c.cls === 'h') {
      push({
        d: dur, F: nextV.f, A: nextV.a, bw: BW_V, v: 0, asp: 0.26, fr: 0,
        f1: 1500, f2: 3000, fg2: 0, tr: 0.020,
      });
      continue;
    }

    /* ---- fricatives ---- */
    if (c.cls === 'f') {
      const [f1, f2, q, amp] = c.fric;
      push({
        d: dur, F: blend(loc, nextV.f, 0.42), A: DEF_A, bw: BW_V,
        v: c.vc ? 0.30 : 0, asp: 0, fr: amp * NOISE_GAIN * (wordFinal ? 0.85 : 1),
        f1, f2, fg2: p === 'S' || p === 'Z' ? 0.8 : 0.35, fq: q, tr: 0.022,
      });
      continue;
    }

    /* ---- stops and affricates: closure → burst → release ---- */
    const isAff = c.cls === 'a';
    const clos = (isAff ? 0.045 : 0.052) / rate;
    const bt = (isAff ? 0.016 : 0.012) / rate;
    const asp = (c.asp || 0) / rate * (wordFinal ? 0.5 : 1);
    // velars pinch toward the following vowel much more than labials do
    const mix = c.loc === 'vel' ? 0.52 : 0.66;
    const Fc = blend(loc, nextV.f, 1 - mix);
    const Fprev = blend(loc, prevV.f, 1 - mix);

    push({ // closure — silence (or a voice bar for B/D/G)
      d: clos, F: Fprev, Fe: Fc,
      A: c.vc ? [0.55, 0.03, 0.01, 0, 0] : [0, 0, 0, 0, 0], bw: BW_V,
      v: c.vc ? 0.16 : 0, asp: 0, fr: 0, f1: 1500, f2: 3000, fg2: 0, tr: 0.012,
      closure: 1,
    });
    const [bf, bq, ba] = c.burst;
    push({ // burst
      d: bt, F: Fc, A: DEF_A, bw: BW_V, v: 0, asp: 0,
      fr: ba * NOISE_GAIN * (wordFinal ? 0.6 : 1), f1: bf, f2: bf * 1.5, fg2: 0.4, fq: bq,
      tr: 0.0025, burst: 1,
    });
    if (isAff) {
      const [ff1, ff2, fq, fa] = c.fric;
      push({
        d: 0.062 / rate, F: Fc, A: DEF_A, bw: BW_V, v: c.vc ? 0.25 : 0, asp: 0,
        fr: fa * NOISE_GAIN, f1: ff1, f2: ff2, fg2: 0.55, fq, tr: 0.006,
      });
    } else if (asp > 0.004) {
      push({ // aspirated release: noise shaped by the *upcoming* vowel
        d: asp, F: blend(Fc, nextV.f, 0.55), Fe: nextV.f, A: nextV.a, bw: BW_V,
        v: 0, asp: c.vc ? 0.07 : 0.20, fr: 0, f1: 1500, f2: 3000, fg2: 0, tr: 0.008,
      });
    }
  }
  return segs;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 4. MOODS                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * VOICES — vocal-tract character, layered on top of `mood`.
 *
 * `fs` is the per-formant frequency scale, and it is the part that actually
 * makes these read as different people. A pitch shift alone just sounds like
 * the same man on a tape machine; moving F1-F5 moves the *tract*. Brick is a
 * longer tube (everything down ~12%); Ilsa is a shorter one (everything up,
 * but F1 much less than F2/F3 — that uneven scaling is what separates the
 * registers, since F1 is set mostly by jaw opening and barely by tract length).
 *
 * `f0` is the base pitch at mood `calm`; `moodF0` damps how far a mood is
 * allowed to drag it. Bandwidths are deliberately NOT scaled, so Q rides along
 * with the formant and each voice keeps the same relative damping.
 */
const VOICES = {
  mutter: {
    fs: [1, 1, 1, 1, 1], f0: 104, moodF0: 1, rate: 1,
    glitchMul: 1, jitMul: 1, vibMul: 1, level: 1, squelch: 0,
  },
  brick: {
    fs: [0.90, 0.87, 0.87, 0.88, 0.88], f0: 90, moodF0: 0.85, rate: 1.06,
    glitchMul: 0.45, jitMul: 1.35, vibMul: 0.8, level: 0.95, squelch: 0,
  },
  ilsa: {
    fs: [1.07, 1.20, 1.22, 1.18, 1.16], f0: 198, moodF0: 0.7, rate: 0.99,
    glitchMul: 0.12, jitMul: 0.55, vibMul: 0.7, level: 1.05, squelch: 1,
  },
};
const VOICE_NAMES = Object.keys(VOICES);

const MOODS = {
  calm:   { f0: 104, rate: 0.94, vib: 14, vibHz: 4.6, jit: 5,  decl: 0.80, glitch: 0.04, tilt: 1.00 },
  urgent: { f0: 130, rate: 1.20, vib: 9,  vibHz: 6.4, jit: 11, decl: 0.90, glitch: 0.20, tilt: 1.14 },
  sweet:  { f0: 122, rate: 0.84, vib: 34, vibHz: 5.2, jit: 4,  decl: 0.78, glitch: 0.02, tilt: 0.92 },
  dying:  { f0: 86,  rate: 0.80, vib: 52, vibHz: 3.1, jit: 26, decl: 0.55, glitch: 0.50, tilt: 0.82 },
};

/* ────────────────────────────────────────────────────────────────────────── */
/* 5. THE VOX                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const NYQ_MARGIN = 0.47;

export class Vox {
  constructor(ctx, destination) {
    this.ctx = ctx || null;
    this.dest = destination || (ctx && ctx.destination) || null;
    this._ok = false;
    this._active = null;
    this._live = new Set();
    this._queue = [];
    this._vol = 1;
    this._maxHz = 16000;
    this._lastText = '';
    this._lastVoice = 'mutter';
    try { this._build(); this._ok = true; } catch (e) { this._ok = false; }
  }

  /* ---------------- persistent character chain (built once) -------------- */

  _build() {
    const ctx = this.ctx;
    if (!ctx) throw new Error('no ctx');
    const sr = num(ctx.sampleRate, 44100);
    this._maxHz = sr * NYQ_MARGIN;

    // Glottal source: Rosenberg-ish pulse, ~-12 dB/oct.
    const H = 44;
    const re = new Float32Array(H), im = new Float32Array(H);
    for (let n = 1; n < H; n++) {
      im[n] = Math.pow(n, -1.85) * Math.exp(-n * 0.030);
      re[n] = Math.pow(n, -2.6) * 0.28 * (n & 1 ? 1 : -1);
    }
    this._wave = ctx.createPeriodicWave(re, im, { disableNormalization: false });

    // Noise: 2 s of white noise, generated once and looped forever.
    const nlen = Math.max(2048, Math.floor(sr * 2));
    const nb = ctx.createBuffer(1, nlen, sr);
    const nd = nb.getChannelData(0);
    let a = 0;
    for (let i = 0; i < nlen; i++) {
      const w = Math.random() * 2 - 1;
      a = a * 0.22 + w * 0.78;       // very gently tilted, still broadband
      nd[i] = a * 0.9;
    }
    this._noise = nb;

    // Waveshaper curves (all pre-computed; never allocated per utterance).
    this._tube = this._curve((x) => {
      const y = Math.tanh(x * 2.15) / Math.tanh(2.15);
      return y * 0.88 + x * 0.12;
    });
    // Brick gets driven harder, with a little asymmetry so it grows even
    // harmonics — that is the "chest" the clean curve does not have.
    this._tubeHard = this._curve((x) => {
      const y = Math.tanh(x * 3.6 + 0.12) / Math.tanh(3.72);
      return y * 0.82 + x * 0.18;
    });
    this._crush = [];
    for (const bits of [16, 7, 5.2, 4.2, 3.3]) {
      const steps = Math.pow(2, bits - 1);
      this._crush.push(this._curve((x) => Math.round(x * steps) / steps));
    }

    // Concrete corridor impulse: short, dark, decaying noise.
    const rlen = Math.floor(sr * 0.42);
    const ir = ctx.createBuffer(1, rlen, sr);
    const id = ir.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < rlen; i++) {
      const t = i / rlen;
      const e = Math.pow(1 - t, 3.4) * (i < sr * 0.006 ? i / (sr * 0.006) : 1);
      lp = lp * 0.62 + (Math.random() * 2 - 1) * 0.38;
      id[i] = lp * e * 0.8;
    }
    // Two hard early reflections — the slap of a concrete stairwell.
    const e1 = Math.floor(sr * 0.021), e2 = Math.floor(sr * 0.037);
    if (e1 < rlen) id[e1] += 0.5;
    if (e2 < rlen) id[e2] -= 0.34;

    /* --- graph --- */
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q, gain) => {
      const n = ctx.createBiquadFilter();
      n.type = type; n.frequency.value = f; n.Q.value = q;
      if (gain !== undefined) n.gain.value = gain;
      return n;
    };

    this.master = g(1.1);
    this.out = g(1);
    this._chain = [this.master, this.out];
    const keep = (...n) => { this._chain.push(...n); return n[n.length - 1]; };

    /* --- shared concrete corridor (slapback + short dark verb) ---------- */
    const dl = ctx.createDelay(0.5); dl.delayTime.value = 0.098;
    const fb = g(0.17);
    const dlDamp = bq('lowpass', 2200, 0.7);
    const dlOut = g(0.17);
    const conv = ctx.createConvolver(); conv.buffer = ir; conv.normalize = true;
    const revIn = bq('bandpass', 1100, 0.9);
    const revOut = g(0.10);
    dl.connect(dlDamp); dlDamp.connect(fb); fb.connect(dl); dl.connect(dlOut);
    revIn.connect(conv); conv.connect(revOut);
    dlOut.connect(this.master); revOut.connect(this.master);
    keep(dl, fb, dlDamp, dlOut, conv, revIn, revOut);
    this.master.connect(this.out);
    if (this.dest) this.out.connect(this.dest);

    /**
     * One colouration chain per speaking character. Utterances connect to
     * `chain.in`; `chain.crush` is the bit-crush stage whose curve the current
     * utterance selects. The corridor sends differ because MUTTER and Brick are
     * standing in the bunker and Ilsa is on a radio somewhere else entirely.
     */
    const build = (name, cfg) => {
      const cin = g(1);
      const pre = g(cfg.pre);
      // Lip radiation: real speech gets ~+6 dB/oct on the way out of the mouth.
      // Without it the glottal source's -12 dB/oct rolloff buries F3 upward and
      // the whole voice sounds like a man talking into a mattress.
      const rad1 = bq('highshelf', 900, 0.7, 11);
      const rad2 = bq('highshelf', 2400, 0.7, 5);
      cin.connect(pre); pre.connect(rad1); rad1.connect(rad2);
      let node = rad2;
      keep(cin, pre, rad1, rad2);

      if (cfg.tube) {                                  // valve grit
        const tube = ctx.createWaveShaper();
        tube.curve = cfg.tube === 2 ? this._tubeHard : this._tube;
        tube.oversample = '2x';
        node.connect(tube); node = keep(tube);
      }
      for (const [type, f, q, gn] of cfg.eq) {
        const b = bq(type, f, q, gn);
        node.connect(b); node = keep(b);
      }
      const crush = ctx.createWaveShaper();
      crush.curve = this._crush[0]; crush.oversample = 'none';
      node.connect(crush); node = keep(crush);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = cfg.comp[0]; comp.knee.value = cfg.comp[1];
      comp.ratio.value = cfg.comp[2]; comp.attack.value = cfg.comp[3];
      comp.release.value = cfg.comp[4];
      node.connect(comp); node = keep(comp);

      const dry = g(cfg.dry);
      node.connect(dry); dry.connect(this.master); keep(dry);
      if (cfg.send > 0) {
        const send = g(cfg.send);
        node.connect(send); send.connect(dl); send.connect(revIn); keep(send);
      }
      return { in: cin, crush };
    };

    this.voices = {
      // MUTTER: unchanged institutional tannoy — 300 Hz to ~5 kHz, honked.
      mutter: build('mutter', {
        pre: 1.4, tube: 1, dry: 0.86, send: 1,
        eq: [['highpass', 300, 0.7], ['highpass', 300, 0.7],
          ['peaking', 1850, 1.1, 6], ['lowpass', 4900, 0.9], ['lowpass', 5400, 0.6]],
        comp: [-22, 14, 5, 0.004, 0.16],
      }),
      // BRICK: a man in the room, not a loudspeaker. Keeps his chest, keeps
      // his top end, and is driven harder into the valve stage.
      brick: build('brick', {
        pre: 1.9, tube: 2, dry: 0.80, send: 0.62,
        eq: [['highpass', 105, 0.7], ['peaking', 220, 0.9, 4],
          ['peaking', 2100, 1.4, 2.5], ['lowpass', 7200, 0.7]],
        comp: [-19, 10, 3.2, 0.006, 0.20],
      }),
      // ILSA: a radio link. Hard 400 Hz-3.2 kHz band, tight compression, no
      // grit at all. She is meant to be the one you can always understand.
      ilsa: build('ilsa', {
        pre: 1.5, tube: 0, dry: 0.94, send: 0.14,
        eq: [['highpass', 400, 0.8], ['highpass', 420, 0.8],
          ['peaking', 2000, 1.2, 3.5], ['lowpass', 3200, 0.9], ['lowpass', 3400, 0.6]],
        comp: [-26, 8, 8, 0.003, 0.10],
      }),
    };
    // `this.in` stays pointed at MUTTER so anything holding the old reference
    // keeps working.
    this.in = this.voices.mutter.in;
  }

  _curve(fn) {
    const n = 2049;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const y = fn(x);
      c[i] = Number.isFinite(y) ? clamp(y, -1, 1) : 0;
    }
    return c;
  }

  /* ---------------- public API ------------------------------------------ */

  get busy() {
    this._pump();
    return !!this._active;
  }

  /**
   * The text of the most recent utterance, after variant selection and token
   * substitution. Subtitle this rather than re-picking a variant yourself, or
   * the caption and the voice will disagree.
   */
  get lastLine() { return this._lastText || ''; }

  /** The voice the most recent utterance used. */
  get lastVoice() { return this._lastVoice || 'mutter'; }

  setVolume(v) {
    this._vol = clamp(num(v, 1), 0, 4);
    if (!this._ok) return;
    try {
      const t = num(this.ctx.currentTime, 0);
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(1.1 * this._vol, t, 0.02);
    } catch (e) { /* never throw */ }
  }

  cancel() {
    this._queue.length = 0;
    if (!this._ok) { this._active = null; return; }
    const t = num(this.ctx && this.ctx.currentTime, 0);
    for (const u of Array.from(this._live)) this._killUtterance(u, t);
    this._active = null;
  }

  /**
   * Speak a canned line by key. The speaking character comes from VOICE_OF
   * unless `opts.voice` overrides it, so the engine never has to know who
   * says what. `opts.args` fills `%s` tokens left to right; `opts.pick`
   * selects a specific variant (used for the per-city ex-partner files, whose
   * variants are in CITY order rather than random).
   */
  sayLine(key, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    let text = isNum(o.pick) ? pickLineAt(key, o.pick) : pickLine(key);
    if (!text) return 0;
    const args = o.args;
    if (args && args.length) {
      let k = 0;
      text = text.replace(/%s/g, () => (k < args.length ? String(args[k++]) : ''));
    }
    text = text.replace(/%s/g, '').replace(/\s{2,}/g, ' ').trim();
    return this.say(text, o.voice ? o : { ...o, voice: voiceOf(key) });
  }

  /**
   * Speak. Returns the utterance duration in seconds, or 0 if it was dropped.
   *
   * Floor rules, tuned for a firefight where the game calls say() constantly:
   *   - nothing speaking          -> speak now
   *   - higher priority arrives   -> cut the current utterance off, speak now
   *   - equal or lower priority   -> wait, but only if fewer than 2 are already
   *                                  waiting; otherwise the lowest-priority
   *                                  waiter is displaced, or this one is
   *                                  dropped outright. A backlog of stale
   *                                  announcements is worse than silence.
   * Never throws, even with no audio context, empty text or hostile options.
   */
  say(text, opts = {}) {
    try {
      if (text == null) return 0;
      const str = String(text);
      if (!str.trim()) return 0;
      const o = opts && typeof opts === 'object' ? opts : {};
      const prio = num(o.priority, 0);

      this._pump();

      if (!this._ok || !this.ctx) return 0;
      if (this.ctx.state === 'closed') return 0;

      if (this._active) {
        if (prio > this._active.priority) {
          this._killUtterance(this._active, num(this.ctx.currentTime, 0));
          this._active = null;
          this._queue = this._queue.filter((q) => q.priority >= prio);
        } else {
          // Bounded queue: at most 2 waiting, lowest priority evicted first.
          const est = this._estimate(str, o);
          const item = { text: str, opts: o, priority: prio, est };
          if (this._queue.length < 2) { this._queue.push(item); return est; }
          let worst = 0;
          for (let i = 1; i < this._queue.length; i++) {
            if (this._queue[i].priority < this._queue[worst].priority) worst = i;
          }
          if (prio > this._queue[worst].priority) { this._queue[worst] = item; return est; }
          return 0;   // dropped — a stale announcement is worse than silence
        }
      }
      return this._speak(str, o, prio);
    } catch (e) {
      return 0;
    }
  }

  /* ---------------- internals ------------------------------------------- */

  _estimate(text, o) {
    try {
      const m = MOODS[o.mood] || MOODS.calm;
      const V = VOICES[o.voice] || VOICES.mutter;
      const rate = clamp(num(o.rate, 1) * m.rate * V.rate, 0.4, 2.6);
      const segs = buildSegments(textToPhonemes(text), { rate });
      let d = 0;
      for (const s of segs) d += s.d;
      return +(d + 0.09 + (V.squelch ? 0.20 : 0)).toFixed(4);
    } catch (e) { return 0; }
  }

  /** Retire the active utterance when its time is up and start the next. */
  _pump() {
    if (!this.ctx) { this._active = null; return; }
    const t = num(this.ctx.currentTime, 0);
    if (this._active && t >= this._active.endTime) this._active = null;
    if (!this._active && this._queue.length) {
      let best = 0;
      for (let i = 1; i < this._queue.length; i++) {
        if (this._queue[i].priority > this._queue[best].priority) best = i;
      }
      const item = this._queue.splice(best, 1)[0];
      try { this._speak(item.text, item.opts, item.priority); } catch (e) { /* ignore */ }
    }
  }

  _speak(text, o, prio) {
    const ctx = this.ctx;
    const mood = MOODS[o.mood] || MOODS.calm;
    const V = VOICES[o.voice] || VOICES.mutter;
    const FS = V.fs;
    const rate = clamp(num(o.rate, 1) * mood.rate * V.rate, 0.4, 2.6);
    const pitch = clamp(num(o.pitch, 1), 0.4, 2.5);
    const vol = clamp(num(o.vol, 1), 0, 2) * V.level;
    const glitch = clamp((num(o.glitch, 0) + mood.glitch) * V.glitchMul, 0, 1);

    const phones = textToPhonemes(text);
    if (!phones.length) return 0;
    const segs = buildSegments(phones, { rate });
    if (!segs.length) return 0;
    this._lastText = text;
    this._lastVoice = VOICES[o.voice] ? o.voice : 'mutter';

    let total = 0;
    for (const s of segs) total += s.d;
    if (!isNum(total) || total <= 0) return 0;
    total = clamp(total, 0.02, 40);

    const now = Math.max(0, num(ctx.currentTime, 0));
    // Radio voices open with a squelch burst, so speech starts a little later
    // and the utterance runs a little longer at the far end.
    const pre = V.squelch ? 0.070 : 0;
    const post = V.squelch ? 0.130 : 0;
    const t0 = now + 0.012 + pre;
    const tail = 0.10 + post;
    const u = this._makeVoice(V);
    u.priority = prio;
    u.endTime = t0 + total + tail;

    /* ---- F0 contour ---- */
    // moods carry an absolute F0 for MUTTER; treat it as a ratio for the rest
    // so each character keeps their own register while still reacting to mood.
    const moodRatio = 1 + (mood.f0 / MOODS.calm.f0 - 1) * V.moodF0;
    const f0Base = clamp(V.f0 * moodRatio * pitch, 50, 400);
    const decl = mood.decl;
    const P = u.osc.frequency;
    P.setValueAtTime(f0Base * 1.06, t0);

    /* ---- schedule every segment ---- */
    const F = u.fFreq, Q = u.fQ, A = u.fGain;
    // prime the resonators at the first segment's targets so nothing snaps
    for (let k = 0; k < 5; k++) {
      this._setP(F[k], clamp(segs[0].F[k] * FS[k], 60, this._maxHz), t0);
      this._setP(Q[k], clamp(segs[0].F[k] / segs[0].bw[k], 0.4, 26), t0);
      this._setP(A[k], 0, t0);
    }
    this._setP(u.voice.gain, 0, t0);
    this._setP(u.asp.gain, 0, t0);
    this._setP(u.fric.gain, 0, t0);
    this._setP(u.fricF1.frequency, clamp(segs[0].f1, 120, this._maxHz), t0);
    this._setP(u.fricF2.frequency, clamp(segs[0].f2, 120, this._maxHz), t0);

    let t = t0;
    let voiced = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const tr = clamp(num(s.tr, 0.03), 0.002, Math.max(0.003, s.d * 0.55));
      const tA = t + tr;                 // arrival of the "start" target
      const tE = t + s.d;                // segment end
      const tB = Math.max(tA + 0.001, tE - 0.004);

      for (let k = 0; k < 5; k++) {
        const raw = num(s.F[k], 500);
        const f1 = clamp(raw * FS[k], 60, this._maxHz);
        const f2 = clamp(num((s.Fe || s.F)[k], raw) * FS[k], 60, this._maxHz);
        this._ramp(F[k], f1, tA);
        if (f2 !== f1) this._ramp(F[k], f2, tB);
        const q1 = clamp(raw / num(s.bw[k], 120), 0.4, 26);
        this._ramp(Q[k], q1, tA);
        const on = s.v > 0 || s.asp > 0 ? TRIM[k] : TRIM[k] * 0.001;
        const a0 = clamp(num(s.A[k], 0), 0, 2) * on;
        const a1 = clamp(num((s.Ae || s.A)[k], num(s.A[k], 0)), 0, 2) * on;
        this._ramp(A[k], a0, tA);
        if (a1 !== a0) this._ramp(A[k], a1, tB);
      }

      // voicing / aspiration / frication amplitudes
      const vAmp = clamp(num(s.v, 0), 0, 1.4);
      const vTr = s.closure || s.burst ? 0.006 : Math.min(tr, 0.030);
      this._ramp(u.voice.gain, vAmp, t + vTr);
      if (isNum(s.ve)) this._ramp(u.voice.gain, clamp(s.ve, 0, 1.4), tB);
      this._ramp(u.asp.gain, clamp(num(s.asp, 0), 0, 1) * 0.9, t + Math.min(tr, 0.018));

      const fr = clamp(num(s.fr, 0), 0, 1.4);
      if (fr > 0) {
        this._setP(u.fricF1.frequency, clamp(num(s.f1, 1500), 120, this._maxHz), t);
        this._setP(u.fricF2.frequency, clamp(num(s.f2, 3000), 120, this._maxHz), t);
        this._setP(u.fricF1.Q, clamp(num(s.fq, 1.5), 0.3, 14), t);
        this._setP(u.fricF2.Q, clamp(num(s.fq, 1.5) * 1.35, 0.3, 18), t);
        this._setP(u.fricG2.gain, clamp(num(s.fg2, 0.4), 0, 1.4), t);
        this._ramp(u.fric.gain, fr, t + (s.burst ? 0.0022 : 0.012));
        if (s.burst) this._ramp(u.fric.gain, fr * 0.12, tE);
      } else {
        this._ramp(u.fric.gain, 0, t + 0.010);
      }

      // F0: declination + accents + jitter, one anchor per voiced segment
      if (s.vowel || (vAmp > 0.4 && !s.closure)) {
        const prog = clamp((t - t0) / total, 0, 1);
        let f = f0Base * (1 + (decl - 1) * prog);
        if (s.st) f *= 1.13;              // pitch accent on the stressed vowel
        if (s.vowel && s.st) f *= 1 + 0.02 * Math.sin(prog * 6.1);
        f *= 1 + (rnd() - 0.5) * (mood.jit * V.jitMul / 900);
        f = clamp(f, 40, 460);
        this._ramp(P, f, t + Math.min(0.05, s.d * 0.6));
        if (s.vowel) {
          const fEnd = clamp(f * (s.st ? 0.965 : 0.99), 40, 460);
          this._ramp(P, fEnd, tE);
        }
        voiced++;
      }
      t = tE;
    }

    // Terminal fall / question rise on the last voiced stretch.
    const lastTerm = phones.reduce((acc, p) => (p.term ? p.term : acc), 'f');
    const tEnd = t0 + total;
    this._ramp(P, clamp(f0Base * decl * (lastTerm === 'q' ? 1.30 : 0.74), 40, 460), tEnd);

    // Silence everything at the end, then fade the utterance bus out.
    for (let k = 0; k < 5; k++) this._ramp(A[k], 0, tEnd + 0.03);
    this._ramp(u.voice.gain, 0, tEnd + 0.03);
    this._ramp(u.asp.gain, 0, tEnd + 0.02);
    this._ramp(u.fric.gain, 0, tEnd + 0.02);

    const envStart = Math.max(0, pre ? t0 - pre - 0.006 : t0 - 0.004);
    const envRise = pre ? envStart + 0.008 : t0 + 0.010;
    const envEnd = tEnd + post;
    this._setP(u.gain.gain, 0, envStart);
    this._ramp(u.gain.gain, 0.34 * vol, envRise);
    this._ramp(u.gain.gain, 0.34 * vol, envEnd + 0.02);
    this._ramp(u.gain.gain, 0, envEnd + 0.055);

    /* ---- radio squelch: a clipped burst of the shared noise buffer at each
       end of the transmission, so Ilsa audibly keys the mic ---- */
    if (u.squelch) {
      this._setP(u.squelchBP.frequency, 2200, envStart);
      this._setP(u.squelchBP.Q, 1.15, envStart);
      const burst = (at, len, amp) => {
        if (!(at > 0)) return;
        this._setP(u.squelch.gain, 0, at);
        this._ramp(u.squelch.gain, amp, at + 0.004);
        this._ramp(u.squelch.gain, amp * 0.55, at + len);
        this._ramp(u.squelch.gain, 0, at + len + 0.014);
      };
      burst(t0 - pre + 0.004, 0.026, 0.40);
      burst(tEnd + 0.030, 0.034, 0.32);
    }

    /* ---- glitch: dropouts + pitch stumbles ---- */
    if (glitch > 0.02) {
      const drops = Math.min(48, Math.floor(total * glitch * 13));
      for (let i = 0; i < drops; i++) {
        const at = t0 + rnd() * Math.max(0.001, total - 0.03);
        const len = 0.008 + rnd() * 0.055 * glitch;
        const depth = 1 - (0.45 + rnd() * 0.55) * glitch;
        this._setP(u.drop.gain, 1, at);
        this._setP(u.drop.gain, clamp(depth, 0, 1), at + 0.002);
        this._setP(u.drop.gain, clamp(depth, 0, 1), at + len);
        this._setP(u.drop.gain, 1, at + len + 0.006);
      }
      const stumbles = Math.min(14, Math.floor(total * glitch * 3.2));
      for (let i = 0; i < stumbles; i++) {
        const at = t0 + rnd() * Math.max(0.001, total - 0.05);
        const cents = (rnd() * 2 - 1) * 900 * glitch;
        this._setP(u.osc.detune, 0, at);
        this._setP(u.osc.detune, clamp(cents, -1600, 1600), at + 0.004);
        this._setP(u.osc.detune, 0, at + 0.03 + rnd() * 0.05);
      }
    }
    // Bit-crush level follows the glitch amount (curve is pre-computed).
    try {
      const idx = clamp(Math.round(glitch * (this._crush.length - 1)), 0, this._crush.length - 1);
      u.chain.crush.curve = this._crush[idx];
    } catch (e) { /* ignore */ }

    /* ---- vibrato ---- */
    this._setP(u.vibOsc.frequency, clamp(mood.vibHz, 0.1, 20), t0);
    this._setP(u.vib.gain, clamp(mood.vib * V.vibMul, 0, 200), t0);
    if (o.mood === 'dying') {
      // the phrase sags apart
      this._ramp(u.vibOsc.frequency, clamp(mood.vibHz * 0.55, 0.1, 20), tEnd);
      this._ramp(P, clamp(f0Base * 0.42, 40, 460), tEnd + 0.05);
    }

    /* ---- start & schedule teardown ---- */
    const stopAt = u.endTime;
    const srcStart = Math.max(0, pre ? t0 - pre - 0.008 : t0 - 0.006);
    try { u.osc.start(srcStart); } catch (e) { /* ignore */ }
    try { u.vibOsc.start(srcStart); } catch (e) { /* ignore */ }
    try { u.noise.start(srcStart); } catch (e) { /* ignore */ }
    this._stopAll(u, stopAt);

    u.osc.onended = () => this._reap(u);
    this._live.add(u);
    this._active = u;
    return +(total + 0.09 + pre + post).toFixed(4);
  }

  /** Build the fixed ~26-node source chain for one utterance. */
  _makeVoice(V) {
    const ctx = this.ctx;
    const nodes = [];
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; nodes.push(n); return n; };

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this._wave);
    osc.frequency.value = 110;
    nodes.push(osc);

    const vibOsc = ctx.createOscillator();
    vibOsc.type = 'sine'; vibOsc.frequency.value = 5;
    nodes.push(vibOsc);
    const vib = g(0);                         // cents into osc.detune
    vibOsc.connect(vib); vib.connect(osc.detune);

    const noise = ctx.createBufferSource();
    noise.buffer = this._noise; noise.loop = true;
    nodes.push(noise);

    const voice = g(0);                       // voicing amplitude
    const asp = g(0);                         // aspiration into the tract
    const src = g(1);                         // tract input mix
    osc.connect(voice); voice.connect(src);
    noise.connect(asp); asp.connect(src);

    const fFreq = [], fQ = [], fGain = [];
    const sum = g(1);
    for (let k = 0; k < 5; k++) {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass'; b.frequency.value = 500 + k * 700; b.Q.value = 8;
      nodes.push(b);
      const a = g(0);
      src.connect(b); b.connect(a); a.connect(sum);
      fFreq.push(b.frequency); fQ.push(b.Q); fGain.push(a.gain);
    }

    // Fricative / burst branch: two parallel resonances off the same noise.
    const fric = g(0);
    const fricF1 = ctx.createBiquadFilter();
    fricF1.type = 'bandpass'; fricF1.frequency.value = 5000; fricF1.Q.value = 3;
    const fricF2 = ctx.createBiquadFilter();
    fricF2.type = 'bandpass'; fricF2.frequency.value = 6500; fricF2.Q.value = 4;
    nodes.push(fricF1, fricF2);
    const fricG2 = g(0.5);
    noise.connect(fric);
    fric.connect(fricF1); fricF1.connect(sum);
    fric.connect(fricF2); fricF2.connect(fricG2); fricG2.connect(sum);

    const drop = g(1);                        // glitch dropouts
    const gain = g(0);                        // utterance envelope
    const chain = this.voices[V === VOICES.brick ? 'brick'
      : V === VOICES.ilsa ? 'ilsa' : 'mutter'];
    sum.connect(drop); drop.connect(gain); gain.connect(chain.in);

    // Radio squelch taps the same noise source, so it costs two nodes and no
    // extra buffer, and it is silenced by the same cancel() fade as the voice.
    let squelch = null, squelchBP = null;
    if (V.squelch) {
      squelch = g(0);
      squelchBP = ctx.createBiquadFilter();
      squelchBP.type = 'bandpass'; squelchBP.frequency.value = 2200;
      squelchBP.Q.value = 1.15;
      nodes.push(squelchBP);
      noise.connect(squelch); squelch.connect(squelchBP); squelchBP.connect(gain);
    }

    return {
      nodes, osc, vibOsc, vib, noise, voice, asp, src, sum, fric, fricF1,
      fricF2, fricG2, drop, gain, fFreq, fQ, fGain, chain, squelch, squelchBP,
      dead: false, endTime: 0, priority: 0,
    };
  }

  _stopAll(u, at) {
    const t = Math.max(num(at, 0), 0);
    for (const s of [u.osc, u.vibOsc, u.noise]) {
      try { s.stop(t); } catch (e) { /* already stopped */ }
    }
  }

  _killUtterance(u, now) {
    if (!u || u.dead) return;
    const t = Math.max(0, num(now, 0));
    try {
      const cur = clamp(num(u.gain.gain.value, 0.2), 0, 2);
      u.gain.gain.cancelScheduledValues(t);
      u.gain.gain.setValueAtTime(cur, t);
      u.gain.gain.linearRampToValueAtTime(0, t + 0.015);
    } catch (e) { /* ignore */ }
    u.endTime = t + 0.02;
    this._stopAll(u, t + 0.02);
    // If onended never arrives (suspended/closed context) we still detach.
    u.cancelled = true;
  }

  _reap(u) {
    if (!u || u.dead) return;
    u.dead = true;
    this._live.delete(u);
    if (this._active === u) this._active = null;
    for (const n of u.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    u.nodes.length = 0;
    try { this._pump(); } catch (e) { /* ignore */ }
  }

  /* --- AudioParam writes: the only place values reach the audio graph --- */

  _setP(param, v, t) {
    if (!param || typeof param.setValueAtTime !== 'function') return;
    if (!isNum(v) || !isNum(t) || t < 0) return;
    try { param.setValueAtTime(v, t); } catch (e) { /* ignore */ }
  }

  _ramp(param, v, t) {
    if (!param || typeof param.linearRampToValueAtTime !== 'function') return;
    if (!isNum(v) || !isNum(t) || t < 0) return;
    try { param.linearRampToValueAtTime(v, t); } catch (e) { /* ignore */ }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 6. LINES — the script                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export const LINES = {
  boot: [
    'Good morning. Bunker {S IY1 B AH N} is operating normally. Please ignore the sirens.',
    'Systems nominal. Morale nominal. Personnel: one. Please do not divide.',
    'Welcome back, warden. Nothing has happened. Nothing is happening. Please arm yourself.',
  ],

  wave_start: [
    'The roof is open and the sky is scheduled. Do try.',
    'Launch window confirmed. Your cities send their regards.',
    'Inbound. I counted them twice, because I care.',
  ],

  wave_clear: [
    'Sky cleared. I have logged your enthusiasm.',
    'All inbound resolved. Somebody is going to be very cross with me.',
    'Nothing further from the sky. For eleven seconds.',
  ],

  city_burning: [
    '%s is on fire. It is still a city. Fire is a phase.',
    '%s is burning. One more and it stops being a place.',
    'Fires reported across %s. I have logged them under {W EH1 DH ER0}.',
    '%s is at fifty percent city. The other fifty percent is doing its best.',
  ],

  city_rebuilt: [
    '%s has been {R IY0 IH1 SH UW0 D}. The previous %s is not to be discussed.',
    'Good news. %s is back. Slightly smaller. Slightly to the left. Nobody will notice.',
    'I have rebuilt %s from the parts I had. Please do not go {IH0 N S AY1 D} it.',
    '%s has been restored from a backup. The backup is from before the people.',
  ],

  city_lost: [
    '%s has been retired. Please do not be discouraged. %s remain.',
    '%s is off the board. Its final population was very brave. %s remain.',
    'Regarding %s: no further correspondence will be necessary. %s remain.',
  ],

  city_lost_last: [
    '%s is gone. One city remains. I have grown fond of it. Do not read into that.',
    'That leaves one, warden. I will be gentle with it. I will be gentle with it last.',
  ],

  all_cities_lost: [
    'All six cities are accounted for. Accounted for. Accounted for.',
    'The map is clean. I have never seen it clean before. It is beautiful.',
  ],

  player_hurt_bad: [
    'You are leaking. Please locate a floor and lie on it.',
    'Warden, your integrity is at nine percent. That is a percent.',
    'Vitals critical. Shall I notify your next of kin, or shall I simply wait.',
  ],

  player_death: [
    'Warden down. Warden down. Warden down. Log updated.',
    'You have stopped. Thank you for stopping in a designated area.',
    'That is the end of the warden. The bunker will continue without complaint.',
  ],

  level_clear: [
    'Sector secured. I have already forgotten what was in it.',
    'This floor is quiet now. Quiet is a kind of compliance.',
  ],

  secret_found: [
    'You found the room we do not put on the plans. Well done. Say nothing.',
    'Ah. That wall. Yes. That wall was mine.',
  ],

  key_taken: [
    'Key acquired. The door it opens was never meant to open. Enjoy.',
    'That key belonged to a man named {D R EH1 S AH L}. He is fine. He is fine.',
  ],

  weapon_taken: [
    'New ordnance. Please read the safety card that does not exist.',
    'Weapon collected. Its previous owner scored very poorly.',
  ],

  low_ammo: [
    'You are low on flak. Consider harsh language.',
    'Ammunition critical. Have you tried standing somewhere else.',
  ],

  chain_praise: [
    'Oh, lovely. A chain. Do that again and I will have to file something.',
    'Six at once. I felt that in my housing.',
    'That was a chain reaction. That was beautiful. I hate it.',
  ],

  perfect_burst: [
    'Fuse perfect. Airburst logged. I am, briefly, impressed.',
    'Textbook. My text. My book.',
  ],

  boss_intro: [
    'You have reached me. I am the room. Please do not touch the walls.',
    'Hello, warden. I have been the voice. Now I will be the problem.',
  ],

  boss_death: [
    'Oh. Oh, that is unusual. I appear to be ending. How interesting. How.',
    'You have shot the ceiling, and the ceiling was me. Well. Well.',
  ],

  idle_taunt: [
    'The corridors are clean. I clean them. Nobody thanks the corridors.',
    'Reminder: the cities are not people. The cities are assets. The assets are screaming.',
    'I have counted every door in this bunker, and there is one I cannot account for.',
    'If you find a room with a chair in it, do not sit in the chair.',
    'Your heart rate is elevated. I have logged it as enthusiasm.',
    'Question. When this is over, what will I do. Answer. This.',
    'Somebody left a sandwich on level three in 1979. I have kept it.',
    'Please walk in the middle of the corridor. The edges are load bearing and sentimental.',
  ],

  elevator: [
    'Descending. Please hold the rail. There is no rail.',
    'Lift active. Next floor: worse.',
  ],

  roof_opening: [
    'Roof retracting. Mind the sky.',
    'The ceiling is leaving. Look up. Look up now.',
  ],

  mirv_warning: [
    '{M ER1 V} inbound. It will divide. It always divides.',
    'That one is going to become several. Prepare to be disappointed.',
  ],

  buster_warning: [
    'Warden, this one is for you personally. I addressed it myself.',
    'Bunker buster. Your name is on it. I spelled it correctly.',
  ],

  smart_warning: [
    'Smart warhead. It learns. It has already learned where you were.',
    'That one is thinking. Try to be less predictable than usual.',
  ],

  game_over: [
    'The cities are gone and so are you. The bunker is finally at peace.',
    'Operation concluded. Everybody lost. Everybody. Thank you.',
  ],

  victory: [
    'You have switched me off. The sky is empty. The cities are, several. Well done.',
    '{M UH1 T ER} is offline. Please enjoy the silence. It is the last thing I made.',
  ],

  title_idle: [
    'Bunker {S IY1 B AH N}. Press anything. Press me.',
    'Standing by. I have been standing by for a very long time.',
  ],

  /* ══════════════════════════════════════════════════════════════════════
     BRICK HARDIGAN — the warden. A 1996 action hero who has wandered into
     2026 and not noticed. Narrates himself in the third person. Certain this
     is going well. He is the joke; his ego is the target.
     ══════════════════════════════════════════════════════════════════════ */

  brick_boot: [
    'Brick Hardigan. Bunker {S IY1 B AH N}. Let us go to work.',
    'They said one man could not do this. They say a lot of things. Mostly at the hearing.',
    'Okay. Okay. Deep breath. Big gun. Bad attitude. Brick is back.',
    'Somewhere in this building is a woman who needs rescuing and a computer that needs shooting. Beautiful.',
  ],

  brick_kill: [
    'Sit down.',
    'That is one for the scrapbook.',
    'Brick Hardigan does not miss. Brick Hardigan adjusts.',
    'Consider yourself decommissioned, pal.',
    'Hell of a thing. Hell of a guy doing it.',
  ],

  brick_kill_mutant: [
    'Whatever you were, buddy, you are considerably less of it now.',
    'Sorry, fella. Somebody had to, and look who was standing here.',
    'That one screamed in a language I did not care for.',
  ],

  brick_chain: [
    'Six for one! They are going to put that on a mug!',
    'Did you see that? Somebody tell me somebody saw that.',
    'Boom. Boom. Boom boom boom. That is the Hardigan special.',
    'One shot, six problems, zero remorse. Write it down.',
  ],

  brick_hurt: [
    'That is going to leave a thing.',
    'Ow. Okay. Brick felt that one in the wallet.',
    'Still standing. Standing badly, but standing.',
  ],

  brick_low_health: [
    'Brick is running on fumes and spite. Mostly spite.',
    'Doc, if I stop talking, that is bad. That is a bad sign, doc.',
    'I have had worse. I cannot name one, but I have had worse.',
  ],

  brick_pickup_weapon: [
    'Oh, hello. You are coming with me.',
    'Now that is a piece of equipment. Look at the size of that.',
    'Somebody left this lying around. Their loss. Really, everybody loses.',
  ],

  brick_secret: [
    'Nobody hides a room from Brick Hardigan. Nobody good, anyway.',
    'A secret door. In my bunker. In my house.',
    'And they said the wall thing was a waste of time.',
  ],

  brick_kick: [
    'Doors are just walls with an attitude problem.',
    'Boot. Meet door. Door, you are fired.',
    'That is going in the incident report and I want it spelled right.',
  ],

  brick_distracted: [
    'Hey. Hey, doc. You ever been to Hollow Bay? There is a woman there with a boat.',
    'Question. Hypothetically. If a guy has not called in eleven years, is that still a thing, or.',
    'You have got a real clear voice, doc. Has anybody ever told you that. Professionally.',
    'Doc. Doc. Are you seeing anybody. Not for me. For a friend. The friend is me.',
    'Is it weird I am thinking about Loretta right now. It is the teeth. It is a whole thing.',
    'So after this, dinner. Not with you. Well. Could be with you.',
    'Does a restraining order expire. Legally. Asking for the record.',
    'Doc, real quick, what is your first name. I want to say it once before I die.',
  ],

  brick_city_lost: [
    'Aw, hell. Deb lived there. Deb lived right there.',
    'No. No no no. Not that one. Anything but that one.',
    'They are going to blame me for this. They always blame me for this.',
  ],

  brick_wave_start: [
    'Roof is open. Sky has got a problem. Brick has got a solution.',
    'Here they come. Good. I was getting bored and that is when I get creative.',
    'Everybody in the sky, you are about to have a very short career.',
  ],

  brick_wave_clear: [
    'Sky is clean. Somebody get this man a sandwich.',
    'And that, doc, is why they keep me around.',
    'Nothing left up there but weather. Beautiful, beautiful weather.',
  ],

  brick_boss_taunt: [
    'Hey! Toaster! You want to go?',
    'You have been talking this whole time. Now you get to listen.',
    'I have killed a lot of things that could not talk back. You are a treat.',
  ],

  brick_dry: [
    'Click. That is the worst sound there is.',
    'Empty. Empty is not a plan, Brick.',
    'Okay. New strategy. The new strategy is find bullets.',
  ],

  brick_death: [
    'Brick. Hardigan. Signing. Aw, hell.',
    'Doc. Doc, tell them. Tell them I was. Aw.',
    'This is. Not. My best. Work.',
  ],

  brick_victory: [
    'Doc. Doc, we did it. I did it. We did it.',
    'Six cities, one bunker, one Hardigan. Somebody put that on a poster.',
    'I would like to say something profound. I have got nothing. I am so tired.',
  ],

  brick_idle: [
    'It is quiet. Brick does not love quiet.',
    'Talking to yourself is fine if the guy is interesting.',
    'Man walks into a bunker. That is it. That is the whole joke. I am the joke.',
    'You know what I could go for right now. A sandwich and a divorce lawyer.',
  ],

  /* ══════════════════════════════════════════════════════════════════════
     DR. ILSA VANCE — chief engineer, sealed in the reactor core on level
     five. She designed the interception system he is misusing. She is the
     straight man, and the clearest voice in the game.
     ══════════════════════════════════════════════════════════════════════ */

  ilsa_intro: [
    'Hardigan, this is Doctor Vance. I am sealed in the reactor core on level five. I designed the system you are about to misuse. Please listen to me.',
    'Warden. Doctor {V AE1 N S}, engineering. I have thirty percent of a radio and one hundred percent of the schematics. Between us that is nearly a plan.',
    'You are the last warden and I am the last engineer and I would like the record to show neither of us applied for this.',
  ],

  ilsa_level1: [
    'Level one is intake. Wide corridors, poor cover, and the flak battery you need. Learn the fuse now, while nothing important is on fire.',
    'Start here. Nothing on this floor can really hurt you, which makes it the only honest floor in the building.',
    'Intake deck. Take the battery, take your time, and take me seriously, in that order.',
  ],

  ilsa_level2: [
    'Organ loft. The pipe galleries carry sound, so it hears you coming. It hears me too. Say something flattering about the architecture.',
    'Level two. I ran cable through these galleries for six months. If you break my conduit I will find a way to be annoyed about it from in here.',
    'Watch the priests on this floor. They were technicians. MUTTER promoted them.',
  ],

  ilsa_level3: [
    'Salt Cathedral. MUTTER routes coolant through here. If the floor is warm, I am still alive. Take that as encouragement or as a deadline.',
    'Level three. Sandbags mean somebody fought here and lost. Do better than they did, ideally by a lot.',
    'The gold key is behind the redoubt. I know because I signed for it in twenty nineteen and nobody ever asked for it back.',
  ],

  ilsa_level4: [
    'The Furnace. My prototype heat exchangers. I am told they are now full of things that used to be maintenance staff. I would like that noted.',
    'Level four runs at sixty degrees and everything in it used to have a name badge. Be quick and do not be sentimental.',
    'This floor was my best work. It is currently the worst place either of us has ever been.',
  ],

  ilsa_level5: [
    'You are on my floor. Reactor core, blast door, and a launch intelligence between us. Hardigan, the door opens outward. Please stop kicking it.',
    'Level five. I can hear the arena through the wall. When it goes quiet, that is either very good or very bad and I would rather know which.',
    'Last floor, warden. Everything MUTTER has left is in that room, and so, in a sense, is MUTTER.',
  ],

  ilsa_fuse_tip: [
    'The shell detonates where you set it, not where it hits. Contact does nothing. Range first, then aim. In that order, ideally.',
    'You are shooting a fuse, not a bullet. Decide how far away you want the explosion and the gun will do the rest.',
    'Wheel sets range. The reticle grows. When it matches the ladder, fire. I built this to be simple and I stand by that.',
  ],

  ilsa_chain_tip: [
    'Warheads cook off their neighbours. One good burst does the work of six bad ones. I did the maths so you would not have to. You are welcome.',
    'Group them. Wait half a second longer than feels comfortable and let them drift together. Patience is a weapon, Hardigan.',
    'Every kill throws a second, smaller sphere. Stand near enough to see it and too near to survive it.',
  ],

  ilsa_mutant_warning: [
    'That reads as human. It was, twelve hours ago. Do not think about it too hard and do not let it touch you.',
    'Biological contact. I am not going to tell you what the scan says. You would slow down, and slowing down is how you join them.',
    'Whatever is coming, it still has a payroll number. Shoot it anyway. I will sign the form.',
  ],

  ilsa_city_lost: [
    'We lost it. Hardigan, I need you firing, not apologising.',
    'That is gone. Grieve later. There are five more and the clock did not stop.',
    'I watched the telemetry flatline. I am fine. Keep shooting.',
  ],

  ilsa_city_burning: [
    '%s is taking fire. Ninety seconds before it stops being a city.',
    'Hardigan, %s. Right now. I do not care how the shot looks.',
    'They are walking rounds onto %s. Get the burst high and get it early.',
  ],

  ilsa_city_rebuilt: [
    '%s is back on the grid. That is the first good thing to happen all day.',
    'Power restored to %s. Somebody down there just turned a light on. Hold that thought and keep it alive.',
    '%s is reading green. I did not think I would get to say that again.',
  ],

  ilsa_wave_incoming: [
    'Launch detected. Six inbound. I will call the ranges. Point the gun where I tell you.',
    'They are coming down the same corridor every time. MUTTER is efficient, not clever. Use that.',
    'Inbound. Do not panic and do not improvise. One of those you are good at.',
  ],

  ilsa_boss_warning: [
    'That is the {M UH1 T ER} core. It is going to talk to you. Everything it says will be true. That is the problem.',
    'It will be polite. It has always been polite. It has been polite through all of this.',
    'Hardigan, listen. It knows things about you. Let it talk and shoot it in the middle of a sentence.',
  ],

  ilsa_low_health: [
    'Your vitals are a mess. Sit down for eleven seconds. I will wait. I am not going anywhere, obviously.',
    'You are bleeding into my telemetry. Stop it. Both of those, stop it.',
    'Hardigan. If you die out there I am still in here. Please weigh that.',
  ],

  ilsa_distracted_reply: [
    'Your radio is open, Hardigan. It has been open for four hours. I have heard all of it.',
    'I am going to answer that once and then we are never doing this again. No. Now shoot the sky.',
    'There are six cities. All six contain a woman who stopped taking your calls. There is a pattern here and it is not the cities.',
    'I am flattered, I am sealed in a reactor, and those two facts are not related.',
    'That is the third time you have asked. The answer has gotten worse each time.',
    'You are thinking about a boat. There is a warhead at eleven thousand metres. Please reallocate.',
    'I have your file. Loretta filed a formal complaint about the teeth thing. It runs to four pages.',
    'Restraining orders do not expire, they lapse. Yours has not. Focus.',
    'Ask me again when there is no longer a countdown. I am not saying yes. I am saying there is a countdown.',
  ],

  ilsa_secret: [
    'Interesting. That wall is not on any plan I signed. Take whatever is in there and do not tell anyone I said so.',
    'Somebody built that after I left. Somebody with a key and a bad idea.',
    'Log it, loot it, and keep moving. I am curious, not patient.',
  ],

  ilsa_almost_there: [
    'You are two doors away. I can hear you through the bulkhead. You are humming. Please stop humming.',
    'Close now. Whatever you are about to say when that door opens, consider a shorter version.',
    'I have been listening to you approach for six minutes. It has been the best six minutes of the year.',
  ],

  ilsa_rescued: [
    'Hardigan. You actually did it. Do not say anything. Just let me have three seconds of this.',
    'The door is open. The door is actually open. Right. Move, before I start being emotional about a door.',
    'Twenty two days in a reactor core. You were late. You came. I will take late.',
  ],

  ilsa_victory: [
    'It is over. Six cities, some of them standing, and one extremely loud man. I will take it.',
    'MUTTER is down and the sky is empty and I would like to sit on some grass for a year.',
    'We won, Hardigan. Do not make a speech. You are going to make a speech.',
  ],

  ilsa_death: [
    'Hardigan? Hardigan, answer me. Damn it.',
    'His signal is flat. It is just me and the machine now, and the machine is very chatty.',
    'No. No, get up. Get up, you ridiculous man.',
  ],

  /* ══════════════════════════════════════════════════════════════════════
     MUTTER, on the subject of the personnel                              */

  // Variants are in CITY order — pass `pick: cityIndex` so the ex matches
  // the city, and `args: [cityName]`.
  mutter_ex_file: [
    'Personnel note. %s is the residence of {D EH1 B}, who kept the truck. Warden, she kept the truck.',
    'Personnel note. %s houses Loretta, now a dental hygienist. She is doing very well. She did not ask about you.',
    'Personnel note. %s contains Cheryl, and a restraining order which the warden wishes on record is mutual.',
    'Personnel note. %s is home to {B AA1 B IY}, who still has your jacket and intends to keep it.',
    'Personnel note. %s is where {IH V AA1 N} lives, with the boat. It is a very good boat. It was always about the boat.',
    'Personnel note. %s registers one {T R IH1 SH}, who has returned zero of your four hundred and twelve calls. Four hundred and twelve.',
  ],

  mutter_mutant: [
    'That was maintenance staff. It is now maintenance. Please do not let it hug you.',
    'Employee of the month, level four, every month since the incident. It has no competition.',
    'It is still wearing the badge. I find that very moving.',
  ],

  mutter_brick_file: [
    'Employment record. Hardigan, Brick. Commendations, none. Property damage, extensive. Note from personnel, please stop kicking things.',
    'The Hardigan file lists four hundred and twelve outgoing calls and one incoming. It was a wrong number. He spoke for nine minutes.',
    'Under next of kin, the warden has written, all of them. Under relationship, he has written, it is complicated, six times.',
    'His annual review reads, in full, he tried. It is signed by Doctor Vance.',
  ],

  mutter_ilsa: [
    'Doctor Vance is safe in the reactor core. Doctor Vance is always safe. I have made certain of it.',
    'She is the only thing in this building I have not fired at. I want that considered.',
    'Doctor Vance built my hands. Then she built the thing that stops my hands. She is very thorough.',
  ],

  mutter_kick: [
    'The door was unlocked. It is now several doors. Thank you, warden.',
    'Maintenance request logged. Maintenance is dead. Request closed.',
    'That door was fitted in nineteen seventy nine. You have made it modern.',
  ],
};

const _lastPick = Object.create(null);

/**
 * Resolve a LINES key to a single string. Arrays are sampled with the module
 * PRNG (deterministic run-to-run) and never repeat the previous pick.
 */
export function pickLine(key) {
  const v = LINES[key];
  if (typeof v === 'string') return v;
  if (!Array.isArray(v) || !v.length) return '';
  if (v.length === 1) return v[0];
  let i = Math.floor(rnd() * v.length) % v.length;
  if (i === _lastPick[key]) i = (i + 1) % v.length;
  _lastPick[key] = i;
  return v[i];
}

/** Resolve a specific variant — used where the variant must match game state. */
export function pickLineAt(key, index) {
  const v = LINES[key];
  if (typeof v === 'string') return v;
  if (!Array.isArray(v) || !v.length) return '';
  const i = ((Math.floor(num(index, 0)) % v.length) + v.length) % v.length;
  return v[i];
}

/**
 * VOICE_OF — who speaks a given line key. The engine should not have to guess,
 * and `sayLine` consults this automatically whenever `opts.voice` is absent.
 * Prefix rule: `brick_*` -> brick, `ilsa_*` -> ilsa, everything else -> mutter.
 */
export const VOICE_OF = Object.freeze(
  Object.fromEntries(Object.keys(LINES).map((k) => [
    k,
    k.startsWith('brick_') ? 'brick' : k.startsWith('ilsa_') ? 'ilsa' : 'mutter',
  ]))
);

/** Voice for a line key, including keys not in LINES (same prefix rule). */
export function voiceOf(key) {
  const k = String(key || '');
  return VOICE_OF[k] || (k.startsWith('brick_') ? 'brick'
    : k.startsWith('ilsa_') ? 'ilsa' : 'mutter');
}

/** The six cities, in the order `mutter_ex_file` variants expect. */
export const CITIES = Object.freeze([
  'VERITY', 'ASHGROVE', 'LOW SABBATH', 'CANDLEMARK', 'HOLLOW BAY', 'SAINT ERROL',
]);

/** Who Brick left in each city, index-matched to CITIES. */
export const EXES = Object.freeze([
  'Deb', 'Loretta', 'Cheryl', 'Bobbi', 'Yvonne', 'Trish',
]);

/** The speaking cast, for menus and subtitle attribution. */
export const CAST = Object.freeze({
  mutter: 'MUTTER',
  brick: 'BRICK HARDIGAN',
  ilsa: 'DR. ILSA VANCE',
});

export default Vox;
