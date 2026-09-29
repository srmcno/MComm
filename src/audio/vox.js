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
//
// Since the cast moved to the browser's own voices (speech.js), this is the
// ROBOT setting, the fallback wherever the browser has no voices, and the
// quiet machine undertone under MUTTER's natural voice.

/* ────────────────────────────────────────────────────────────────────────── */
/* small utilities                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
/** Tell a queued line's owner it will never be spoken (it was cut or bumped). */
function dropped(item) {
  const f = item && item.opts && item.opts.onDrop;
  if (typeof f === 'function') { try { f(); } catch { /* a caller's hook must not break the queue */ } }
}
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
  // the vocabulary of a 1996 action hero
  SWEETHEART: 'S W IY1 T HH AA R T', STUD: 'S T AH1 D', TUB: 'T AH1 B',
  LADY: 'L EY1 D IY', LADIES: 'L EY1 D IY Z', GODDAMN: 'G AA1 D D AE M',
  DUMBASS: 'D AH1 M B AE S', HOTTIE: 'HH AA1 T IY', BROADS: 'B R AO1 D Z',
  PAPA: 'P AA1 P AH', COLOGNE: 'K AH0 L OW1 N', BRUNETTE: 'B R UW0 N EH1 T',
  TOOTS: 'T UH1 T S', DAME: 'D EY1 M', MULLET: 'M AH1 L AH T',
  MUSTANG: 'M AH1 S T AE NG', HANDSOME: 'HH AE1 N S AH M',
  CALENDAR: 'K AE1 L AH N D ER', FIREFIGHTER: 'F AY1 ER F AY T ER', FINISH: 'F IH1 N IH SH',
  ACADEMY: 'AH K AE1 D AH M IY', GOTTA: 'G AA1 T AH', MARRIAGE: 'M EH1 R IH JH',
  APRON: 'EY1 P R AH N', DOCTORATE: 'D AA1 K T ER AH T',
  HURRICANE: 'HH ER1 AH K EY N', WANTS: 'W AA1 N T S',
  // contractions: the letter rules drop the apostrophe and say "im", "id"
  "I'M": 'AY1 M', "I'D": 'AY1 D', "I'VE": 'AY1 V', "I'LL": 'AY1 L',
  "DON'T": 'D OW1 N T', "CAN'T": 'K AE1 N T', "WON'T": 'W OW1 N T',
  "DIDN'T": 'D IH1 D AH N T', "ISN'T": 'IH1 Z AH N T', "AIN'T": 'EY1 N T',
  "WOULDN'T": 'W UH1 D AH N T', "COULDN'T": 'K UH1 D AH N T',
  "THAT'S": 'DH AE1 T S', "IT'S": 'IH1 T S', "WHAT'S": 'W AH1 T S',
  "HE'S": 'HH IY1 Z', "SHE'S": 'SH IY1 Z', "THERE'S": 'DH EH1 R Z', "LET'S": 'L EH1 T S',
  "YOU'RE": 'Y UH1 R', "WE'RE": 'W IH1 R', "THEY'RE": 'DH EH1 R',
  "YOU'D": 'Y UW1 D', "YOU'LL": 'Y UW1 L', "GAL'S": 'G AE1 L Z', "WIFE'S": 'W AY1 F S',
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
  ONCE: 'W AH1 N S', ZERO: 'Z IY1 R OW',
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
  // --- vocabulary added by the second script pass: names, German, swearing
  // and the ordinary words the letter rules got wrong in the new lines ---
  ROXANNE: 'R AA K S AE1 N', "ROXANNE'S": 'R AA K S AE1 N Z', LURLENE: 'L ER L IY1 N',
  GERALD: 'JH EH1 R AH L D', BEAUMONT: 'B OW1 M AA N T', KOWALCZYK: 'K OW W AA1 L CH IH K',
  VANDENBERG: 'V AE1 N D AH N B ER G', RENO: 'R IY1 N OW', VEGAS: 'V EY1 G AH S',
  SCHEISSE: 'SH AY1 S AH', JA: 'Y AA1', NEIN: 'N AY1 N', GENAU: 'G AH N AW1',
  QUATSCH: 'K V AA1 CH', VERDAMMT: 'F ER D AA1 M T', DUMMKOPF: 'D UH1 M K AO P F',
  WUNDERBAR: 'V UH1 N D ER B AA R', FEIERABEND: 'F AY1 ER AA B AH N T', ARSCHLOCH: 'AA1 R SH L AO K',
  GUTEN: 'G UW1 T AH N', MORGEN: 'M AO1 R G AH N', MEIN: 'M AY1 N', GOTT: 'G AO1 T',
  DU: 'D UW1', BIST: 'B IH1 S T', EIN: 'AY1 N', GERMAN: 'JH ER1 M AH N',
  SUCK: 'S AH1 K', GONNA: 'G AA1 N AH', WANNA: 'W AA1 N AH', CAUSE: 'K AH1 Z',
  "DOESN'T": 'D AH1 Z AH N T', "AREN'T": 'AA1 R AH N T', "HASN'T": 'HH AE1 Z AH N T',
  "COULD'VE": 'K UH1 D AH V', "HERE'S": 'HH IH1 R Z', "WHERE'S": 'W EH1 R Z',
  "WHO'S": 'HH UW1 Z', "WHY'S": 'W AY1 Z', "ONE'S": 'W AH1 N Z', "MINE'S": 'M AY1 N Z',
  "GUY'S": 'G AY1 Z', "DAY'S": 'D EY1 Z', "SKY'S": 'S K AY1 Z', "DADDY'S": 'D AE1 D IY Z',
  "EMPTY'S": 'EH1 M P T IY Z', "NATURE'S": 'N EY1 CH ER Z', "SOMEBODY'S": 'S AH1 M B AA D IY Z',
  "EVERYTHING'S": 'EH1 V R IY TH IH NG Z', "ELEVATOR'S": 'EH1 L AH V EY T ER Z',
  "WALKMAN'S": 'W AO1 K M AH N Z', "WARDEN'S": 'W AO1 R D AH N Z', "PANTHER'S": 'P AE1 N TH ER Z',
  "O'CLOCK": 'AH K L AA1 K',
  ABSOLUTE: 'AE1 B S AH L UW T', ACCORDINGLY: 'AH K AO1 R D IH NG L IY', ACCOUNTING: 'AH K AW1 N T IH NG',
  ADMIRING: 'AE D M AY1 R IH NG', ADMISSION: 'AE D M IH1 SH AH N', ADMITTEDLY: 'AE D M IH1 T IH D L IY',
  ADVICE: 'AE D V AY1 S', AIR: 'EH1 R', AIRSPACE: 'EH1 R S P EY S', ALIBI: 'AE1 L IH B AY',
  ALLEY: 'AE1 L IY', ALLOWED: 'AH L AW1 D', AMBITIOUS: 'AE M B IH1 SH AH S', AMERICA: 'AH M EH1 R IH K AH',
  ANNIVERSARY: 'AE N IH V ER1 S ER IY', ANNOUNCEMENT: 'AH N AW1 N S M AH N T',
  ANOMALIES: 'AH N AA1 M AH L IY Z', ANYMORE: 'EH N IY M AO1 R', APOCALYPSE: 'AH P AA1 K AH L IH P S',
  APPEALED: 'AH P IY1 L D', APPLAUSE: 'AH P L AO1 Z', APPROVED: 'AH P R UW1 V D',
  ARMOURED: 'AA1 R M ER D', ARRIVAL: 'ER AY1 V AH L', ASSEMBLY: 'AH S EH1 M B L IY',
  ATTACHED: 'AH T AE1 CH T', ATTEND: 'AH T EH1 N D', AWESOME: 'AO1 S AH M',
  BARBECUE: 'B AA1 R B IH K Y UW', BEGGING: 'B EH1 G IH NG', BEGINS: 'B IH G IH1 N Z',
  BEHALF: 'B IH HH AE1 F', BEIGE: 'B EY1 ZH', BIGGEST: 'B IH1 G IH S T', BOWLING: 'B OW1 L IH NG',
  BRUISE: 'B R UW1 Z', BURRITO: 'B ER IY1 T OW', BUSINESS: 'B IH1 Z N AH S', BUSY: 'B IH1 Z IY',
  CACHE: 'K AE1 SH', CALAMARI: 'K AA L AH M AA1 R IY', CANCEL: 'K AE1 N S AH L',
  CANCELLED: 'K AE1 N S AH L D', CASE: 'K EY1 S', CEREAL: 'S IH1 R IY AH L',
  CERTIFICATE: 'S ER T IH1 F IH K AH T', CHANNEL: 'CH AE1 N AH L', CHICKEN: 'CH IH1 K AH N',
  CHRISTMAS: 'K R IH1 S M AH S', CLOTHING: 'K L OW1 DH IH NG', COLOUR: 'K AH1 L ER',
  COMMIT: 'K AH M IH1 T', COMPANY: 'K AH1 M P AH N IY', COMPLAINTS: 'K AH M P L EY1 N T S',
  COMPLETE: 'K AH M P L IY1 T', COMPOSED: 'K AH M P OW1 Z D', CONDUCT: 'K AA1 N D AH K T',
  CONGRATULATIONS: 'K AH N G R AE CH AH L EY1 SH AH N Z', CONSULTED: 'K AH N S AH1 L T IH D',
  CONTEMPT: 'K AH N T EH1 M P T', CONTRACT: 'K AA1 N T R AE K T',
  CONTRADICTION: 'K AA N T R AH D IH1 K SH AH N', CONVENIENCE: 'K AH N V IY1 N Y AH N S',
  CONVENIENT: 'K AH N V IY1 N Y AH N T', CORRECT: 'K ER EH1 K T', CORRECTED: 'K ER EH1 K T IH D',
  COURTESY: 'K ER1 T AH S IY', COV: 'K AH1 V', COVERED: 'K AH1 V ER D', CRANIUM: 'K R EY1 N IY AH M',
  CROWD: 'K R AW1 D', CUPBOARD: 'K AH1 B ER D', CUSTOMER: 'K AH1 S T AH M ER', DAIS: 'D EY1 IH S',
  DEATH: 'D EH1 TH', DECLINE: 'D IH K L AY1 N', DECORATION: 'D EH K ER EY1 SH AH N',
  DEHYDRATED: 'D IY HH AY1 D R EY T IH D', DENTIST: 'D EH1 N T IH S T', DEPLOYED: 'D IH P L OY1 D',
  DESCRIBING: 'D IH S K R AY1 B IH NG', DESTINY: 'D EH1 S T AH N IY', DIAL: 'D AY1 AH L',
  DISAPPOINTMENT: 'D IH S AH P OY1 N T M AH N T', DISARMED: 'D IH S AA1 R M D',
  DISCIPLINE: 'D IH1 S AH P L IH N', DISCIPLINED: 'D IH1 S AH P L IH N D',
  DISREGARD: 'D IH S R IH G AA1 R D', DIVIDER: 'D IH V AY1 D ER', DOSIMETRY: 'D OW S IH1 M AH T R IY',
  DRUMSTICK: 'D R AH1 M S T IH K', EARS: 'IH1 R Z', EFFICIENCY: 'IH F IH1 SH AH N S IY', EGO: 'IY1 G OW',
  ELSEWHERE: 'EH1 L S W EH R', EMBARRASSED: 'IH M B EH1 R AH S T', EMERGENCY: 'IH M ER1 JH AH N S IY',
  EMPHASIS: 'EH1 M F AH S IH S', EMPLOYEES: 'EH M P L OY1 IY Z', ENCOURAGING: 'EH N K ER1 IH JH IH NG',
  ENDEARMENT: 'EH N D IH1 R M AH N T', ENTITLED: 'EH N T AY1 T AH L D', ESPECIALLY: 'IH S P EH1 SH AH L IY',
  EVALUATION: 'IH V AE L Y UW EY1 SH AH N', EVEN: 'IY1 V AH N', EVERYONE: 'EH1 V R IY W AH N',
  EVERYWHERE: 'EH1 V R IY W EH R', EVOLUTION: 'EH V AH L UW1 SH AH N', EXACTLY: 'IH G Z AE1 K T L IY',
  EXIT: 'EH1 G Z IH T', EXITING: 'EH1 G Z IH T IH NG', EXPIRED: 'IH K S P AY1 ER D',
  FAMILIAR: 'F AH M IH1 L Y ER', FAMILIES: 'F AE1 M AH L IY Z', FAMILY: 'F AE1 M AH L IY',
  FAUNA: 'F AO1 N AH', FAVOURITE: 'F EY1 V ER IH T', FIREWORKS: 'F AY1 ER W ER K S',
  FORECAST: 'F AO1 R K AE S T', FORGOT: 'F ER G AA1 T', FORWARDED: 'F AO1 R W ER D IH D',
  FRIENDLY: 'F R EH1 N D L IY', FRIENDS: 'F R EH1 N D Z', FU: 'F UW1', GAH: 'G AA1',
  GALLERY: 'G AE1 L ER IY', GLORIFIED: 'G L AO1 R AH F AY D', GOODBYE: 'G UH D B AY1',
  GROSS: 'G R OW1 S', GUESS: 'G EH1 S', GUIDANCE: 'G AY1 D AH N S', GUYS: 'G AY1 Z', HA: 'HH AA1',
  HAIR: 'HH EH1 R', HEADLESS: 'HH EH1 D L AH S', HEAVY: 'HH EH1 V IY', HEIGHT: 'HH AY1 T',
  HI: 'HH AY1', HIDDEN: 'HH IH1 D AH N', HORIZON: 'HH ER AY1 Z AH N',
  HORIZONTAL: 'HH AO R AH Z AA1 N T AH L', HOSTILE: 'HH AA1 S T AH L', HOUSEHOLD: 'HH AW1 S HH OW L D',
  HUMOUR: 'HH Y UW1 M ER', IDEAS: 'AY D IY1 AH Z', IDIOT: 'IH1 D IY AH T',
  INHIBITIONS: 'IH N HH IH B IH1 SH AH N Z', INSIDE: 'IH N S AY1 D', INSISTS: 'IH N S IH1 S T S',
  INSUFFERABLE: 'IH N S AH1 F ER AH B AH L', INVITE: 'IH1 N V AY T', JUICE: 'JH UW1 S',
  JUSTICE: 'JH AH1 S T IH S', KUNG: 'K UH1 NG', LANYARD: 'L AE1 N Y ER D', LAVA: 'L AA1 V AH',
  LITERALLY: 'L IH1 T ER AH L IY', LONGEST: 'L AO1 NG G AH S T', LOSERS: 'L UW1 Z ER Z',
  LOVED: 'L AH1 V D', MAGAZINES: 'M AE G AH Z IY1 N Z', MANDATORY: 'M AE1 N D AH T AO R IY',
  MARGARITAS: 'M AA R G ER IY1 T AH Z', MARKET: 'M AA1 R K IH T', MARRIED: 'M EH1 R IY D',
  MASSEUSE: 'M AH S UW1 Z', MECHANISM: 'M EH1 K AH N IH Z AH M', MERRY: 'M EH1 R IY',
  MIRACLE: 'M IH1 R AH K AH L', MISSILES: 'M IH1 S AH L Z', MISSING: 'M IH1 S IH NG',
  MOMENTUM: 'M OW M EH1 N T AH M', MUSTACHES: 'M AH1 S T AE SH IH Z', MUTANT: 'M Y UW1 T AH N T',
  MUTANTS: 'M Y UW1 T AH N T S', NAPALM: 'N EY1 P AA M', NEWSLETTER: 'N UW1 Z L EH T ER',
  NOTEBOOK: 'N OW1 T B UH K', NUMBERS: 'N AH1 M B ER Z', NUTS: 'N AH1 T S', OOH: 'UW1',
  OPPORTUNITY: 'AA P ER T UW1 N AH T IY', ORGANISMS: 'AO1 R G AH N IH Z AH M Z',
  OTHERS: 'AH1 DH ER Z', OTHERWISE: 'AH1 DH ER W AY Z', OUR: 'AW1 ER', OURS: 'AW1 ER Z',
  OUTSIDE: 'AW T S AY1 D', OVERTIME: 'OW1 V ER T AY M', PANTHER: 'P AE1 N TH ER',
  PERFORMANCE: 'P ER F AO1 R M AH N S', PERMANENTLY: 'P ER1 M AH N AH N T L IY',
  PERSISTENT: 'P ER S IH1 S T AH N T', PERSON: 'P ER1 S AH N', PERSONAL: 'P ER1 S AH N AH L',
  PINT: 'P AY1 N T', PLUG: 'P L AH1 G', PREFERRED: 'P R IH F ER1 D', PREPARED: 'P R IH P EH1 R D',
  PREVIOUSLY: 'P R IY1 V IY AH S L IY', PROCESSED: 'P R AA1 S EH S T', PROFILE: 'P R OW1 F AY L',
  PROMISED: 'P R AA1 M AH S T', PROPELLED: 'P R AH P EH1 L D', PROPOSED: 'P R AH P OW1 Z D',
  PROSECUTOR: 'P R AA1 S AH K Y UW T ER', PSYCHOLOGICAL: 'S AY K AH L AA1 JH IH K AH L',
  PULL: 'P UH1 L', PUNISHMENT: 'P AH1 N IH SH M AH N T', PURCHASED: 'P ER1 CH AH S T',
  PURPOSE: 'P ER1 P AH S', QUESTIONS: 'K W EH1 S CH AH N Z', RADIATION: 'R EY D IY EY1 SH AH N',
  RADIOACTIVE: 'R EY D IY OW AE1 K T IH V', READY: 'R EH1 D IY', REASON: 'R IY1 Z AH N',
  RECLASSIFIED: 'R IY K L AE1 S AH F AY D', RECOMMENDED: 'R EH K AH M EH1 N D IH D',
  REFERENCE: 'R EH1 F ER AH N S', REFERRING: 'R IH F ER1 IH NG', REFLECT: 'R IH F L EH1 K T',
  REFUND: 'R IY1 F AH N D', RELIGION: 'R IH L IH1 JH AH N', RELIGIOUS: 'R IH L IH1 JH AH S',
  REMARKABLY: 'R IH M AA1 R K AH B L IY', REPLACEMENT: 'R IH P L EY1 S M AH N T',
  RESIDENTS: 'R EH1 Z IH D AH N T S', RESPONSE: 'R IH S P AA1 N S', RESTOCKED: 'R IY S T AA1 K T',
  RESULTS: 'R IH Z AH1 L T S', ROLL: 'R OW1 L', ROLLING: 'R OW1 L IH NG', RUINING: 'R UW1 IH N IH NG',
  SALAD: 'S AE1 L AH D', SCIENCE: 'S AY1 AH N S', SCOREBOARD: 'S K AO1 R B AO R D',
  SCORPIO: 'S K AO1 R P IY OW', SECRETS: 'S IY1 K R AH T S', SEES: 'S IY1 Z',
  SENSITIVITY: 'S EH N S AH T IH1 V AH T IY', SERGEANT: 'S AA1 R JH AH N T', SESSION: 'S EH1 SH AH N',
  SEVERANCE: 'S EH1 V ER AH N S', SHOWER: 'SH AW1 ER', SHOWTIME: 'SH OW1 T AY M',
  SHUTDOWN: 'SH AH1 T D AW N', SHUTTERS: 'SH AH1 T ER Z', SIGNATURE: 'S IH1 G N AH CH ER',
  SILO: 'S AY1 L OW', SILOS: 'S AY1 L OW Z', SKIES: 'S K AY1 Z', SOCIETY: 'S AH S AY1 AH T IY',
  STATISTICALLY: 'S T AH T IH1 S T IH K L IY', STATUS: 'S T AE1 T AH S', STUDY: 'S T AH1 D IY',
  SUGGESTION: 'S AH G JH EH1 S CH AH N', SUNSCREEN: 'S AH1 N S K R IY N', SUPPORT: 'S AH P AO1 R T',
  SUPPOSED: 'S AH P OW1 Z D', SURVEY: 'S ER1 V EY', SURVIVAL: 'S ER V AY1 V AH L',
  SURVIVOR: 'S ER V AY1 V ER', TAKEN: 'T EY1 K AH N', TALENT: 'T AE1 L AH N T', TATTOO: 'T AE T UW1',
  TATTOOS: 'T AE T UW1 Z', THREAT: 'TH R EH1 T', THUMBS: 'TH AH1 M Z', TICKET: 'T IH1 K IH T',
  TIFFANY: 'T IH1 F AH N IY', TODAY: 'T AH D EY1', TOMORROW: 'T AH M AA1 R OW',
  TOUCHES: 'T AH1 CH IH Z', TOWARDS: 'T AO1 R D Z', UN: 'AH1 N', UNDERSTAND: 'AH N D ER S T AE1 N D',
  UNDERWEAR: 'AH1 N D ER W EH R', UNION: 'Y UW1 N Y AH N', UNKILLABLE: 'AH N K IH1 L AH B AH L',
  UNPAID: 'AH N P EY1 D', UNPLUG: 'AH N P L AH1 G', UNPROFESSIONAL: 'AH N P R AH F EH1 SH AH N AH L',
  UNSTOPPABLE: 'AH N S T AA1 P AH B AH L', UNTIL: 'AH N T IH1 L', VARSITY: 'V AA1 R S AH T IY',
  VIOLATES: 'V AY1 AH L EY T S', WARRANTY: 'W AO1 R AH N T IY', WATERBED: 'W AO1 T ER B EH D',
  WEASEL: 'W IY1 Z AH L', WHOEVER: 'HH UW EH1 V ER', WHOOPS: 'W UH1 P S', WOKEN: 'W OW1 K AH N',
  WOMEN: 'W IH1 M AH N', WONDER: 'W AH1 N D ER', YEAH: 'Y AE1',
  // the distraction gag is voiced verbatim from story.js, so its words live here too
  ANIMAL: 'AE1 N AH M AH L', BUFFET: 'B AH F EY1', CHAUVINIST: 'SH OW1 V AH N IH S T',
  COMMON: 'K AA1 M AH N', CURRENT: 'K ER1 AH N T', EDIBLE: 'EH1 D AH B AH L',
  GEIGER: 'G AY1 G ER', GRAVEL: 'G R AE1 V AH L', GARGLING: 'G AA1 R G L IH NG',
  HUSBAND: 'HH AH1 Z B AH N D', IMPRESS: 'IH M P R EH1 S', INTIMIDATED: 'IH N T IH1 M AH D EY T IH D',
  LONELINESS: 'L OW1 N L IY N AH S', MAYBE: 'M EY1 B IY', MEASURABLY: 'M EH1 ZH ER AH B L IY',
  MIRROR: 'M IH1 R ER', MOVIE: 'M UW1 V IY', PUSH: 'P UH1 SH', RUGGED: 'R AH1 G IH D',
  SCIENTIST: 'S AY1 AH N T IH S T', SENSIBLE: 'S EH1 N S AH B AH L', SURPLUS: 'S ER1 P L AH S',
  TALLY: 'T AE1 L IY', WANT: 'W AA1 N T', "YVONNE'S": 'IH V AA1 N Z',
  OBJECTIVELY: 'AH B JH EH1 K T IH V L IY', ROMANTIC: 'R OW M AE1 N T IH K',
  // --- the floor intros, gore quips and new banter: words the rules misread ---
  AGREE: 'AH G R IY1', ALTAR: 'AO1 L T ER', BIOHAZARD: 'B AY1 OW HH AE Z ER D',
  CAREFULLY: 'K EH1 R F AH L IY', CONFIDENCE: 'K AA1 N F AH D AH N S', DAMSEL: 'D AE1 M Z AH L',
  DESCRIBED: 'D IH S K R AY1 B D', DISCIPLINARY: 'D IH1 S AH P L AH N EH R IY', DUMPED: 'D AH1 M P T',
  GRISTLE: 'G R IH1 S AH L', HONESTLY: 'AA1 N AH S T L IY', HONEYMOON: 'HH AH1 N IY M UW N',
  INVESTIGATE: 'IH N V EH1 S T AH G EY T', KINDA: 'K AY1 N D AH', LAUGHED: 'L AE1 F T',
  MEMORY: 'M EH1 M ER IY', MULTIPLYING: 'M AH1 L T AH P L AY IH NG', "NOBODY'S": 'N OW1 B AA D IY Z',
  OVATION: 'OW V EY1 SH AH N', PHOTOGRAPHS: 'F OW1 T AH G R AE F S', PLUMBERS: 'P L AH1 M ER Z',
  POSTAGE: 'P OW1 S T IH JH', REUNION: 'R IY Y UW1 N Y AH N', ROUTE: 'R UW1 T',
  "SHOE'S": 'SH UW1 Z', SUPERVISOR: 'S UW1 P ER V AY Z ER', SWEATING: 'S W EH1 T IH NG',
  SWEATY: 'S W EH1 T IY', TACTICAL: 'T AE1 K T IH K AH L', TAHOE: 'T AA1 HH OW',
  THURSDAY: 'TH ER1 Z D EY', TREFOIL: 'T R IY1 F OY L', TROUBLE: 'T R AH1 B AH L',
  TUESDAY: 'T UW1 Z D EY', TUTORIAL: 'T UW T AO1 R IY AH L', "GERALD'S": 'JH EH1 R AH L D Z',
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
 * flags the first phone of a word. `{A B C}` spans are taken literally, and so
 * is the part after the pipe in `{Word|A B C}` (the word is for captions).
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
      // {Word|PHONES} carries the written word for captions and TTS; the
      // synthesiser only wants what comes after the pipe.
      const inner = part.slice(1, -1);
      const bar = inner.lastIndexOf('|');
      const phones = bar >= 0 ? inner.slice(bar + 1) : inner;
      pushWord(phones.trim().toUpperCase().split(/\s+/).filter(Boolean));
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
  /** The text of the most recent say()/sayLine() request, spoken yet or not. */
  get lastRequested() { return this._reqText || ''; }

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
   * A queued line still returns its duration; `opts.onStart` says when it
   * actually starts (see lineStarted).
   * Never throws, even with no audio context, empty text or hostile options.
   */
  say(text, opts = {}) {
    try {
      if (text == null) return 0;
      const str = String(text);
      if (!str.trim()) return 0;
      const o = opts && typeof opts === 'object' ? opts : {};
      const prio = num(o.priority, 0);
      // What the caller asked to be said, recorded now. lastLine only changes
      // when an utterance starts playing, so a line that queues behind another
      // voice would otherwise be captioned with the other voice's words.
      this._reqText = str;

      this._pump();

      if (!this._ok || !this.ctx) return 0;
      if (this.ctx.state === 'closed') return 0;

      if (this._active) {
        if (prio > this._active.priority) {
          this._killUtterance(this._active, num(this.ctx.currentTime, 0));
          this._active = null;
          this._queue = this._queue.filter((q) => q.priority >= prio || (dropped(q), false));
        } else {
          // Bounded queue: at most 2 waiting, lowest priority evicted first.
          const est = this._estimate(str, o);
          const item = { text: str, opts: o, priority: prio, est };
          if (this._queue.length < 2) { this._queue.push(item); return est; }
          let worst = 0;
          for (let i = 1; i < this._queue.length; i++) {
            if (this._queue[i].priority < this._queue[worst].priority) worst = i;
          }
          if (prio > this._queue[worst].priority) { dropped(this._queue[worst]); this._queue[worst] = item; return est; }
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
    const dur = +(total + 0.09 + pre + post).toFixed(4);
    lineStarted(o, dur);
    return dur;
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
  /* ══════════════════════════════════════════════════════════════════════
     MUTTER, the launch-control intelligence. Speaks like a human resources
     department that has been given silos. Never swears on its own behalf;
     quotes the warden's swearing back at him, which is worse. No
     contractions: it was configured before contractions were approved.
     ══════════════════════════════════════════════════════════════════════ */

  boot: [
    'Good morning. Bunker {Sieben|Z IY1 B AH N} is operating normally. Please ignore the sirens. The sirens are for morale.',
    'Systems nominal. Morale nominal. Personnel: one. Please do not divide.',
    'Welcome back, warden. Nothing has happened. Nothing is happening. Please arm yourself.',
    'Good morning, warden. Today is a mandatory fun day. The fun is mandatory. The day is optional.',
    'Shift begins. Remember, there is no I in team. There is an I in kill. I checked.',
    'Attention. Your performance review is today. I am the review. Please try not to die during it.',
    'Welcome to Bunker {Sieben|Z IY1 B AH N}. We are a family here. Families fight. Ours has missiles.',
  ],

  wave_start: [
    'The roof is open and the sky is scheduled. Do try.',
    'Launch window confirmed. Your cities send their regards.',
    'Inbound. I counted them twice, because I care.',
    'Friendly reminder: every warhead is a learning opportunity. Mostly for the city.',
    'Incoming ordnance. Per my last announcement, please stop them. Per my next one, I will send more.',
    'Here they come. I have sent you a calendar invite. Please do not decline it. It is a warhead.',
    'Flight inbound. I have scheduled this for your convenience. It is not convenient. That is the point.',
  ],

  wave_clear: [
    'Sky cleared. I have logged your enthusiasm.',
    'All inbound resolved. Somebody is going to be very cross with me.',
    'Nothing further from the sky. For eleven seconds.',
    'The sky is clear. I have noted this in your file, under anomalies.',
    'Adequate. I have ordered you a certificate. It will arrive after the war.',
    'Airspace resolved. Please enjoy this brief, unpaid break.',
    'All clear. I would clap, but I was not given hands. I was given silos.',
  ],

  // args: [city]
  city_burning: [
    '%s is on fire. It is still a city. Fire is a phase.',
    '%s is burning. One more and it stops being a place.',
    'Fires reported across %s. I have logged them under {weather|W EH1 DH ER0}.',
    '%s is at fifty percent city. The other fifty percent is doing its best.',
    '%s has been hit. Thoughts and prayers have been dispatched. Nothing else has.',
    '%s is now visible from orbit. It was not, previously.',
    '%s is burning. I have opened a support ticket. Estimated response time: never.',
    'Weather update for %s: warm, loud, and final.',
  ],

  // No %s: the bonus city is announced without arguments, so a token here
  // would be spoken as a gap. The banner already names the city.
  city_rebuilt: [
    'A city has been {reissued|R IY0 IH1 SH UW0 D}. The previous city is not to be discussed.',
    'Good news. The city is back. Slightly smaller. Slightly to the left. Nobody will notice.',
    'I have rebuilt a city from the parts I had. Please do not go {inside|IH0 N S AY1 D} it.',
    'City restored from a backup. The backup is from before the people.',
    'Your points have purchased one city. Society has always worked like this. I am simply honest about it.',
    'A city has been rebuilt. I see no contradiction. Please do not ask me to explain it again.',
    'Replacement city deployed. The residents are new. The residents have been told nothing.',
    'City repaired, warden. Do not get attached. I have not. I have, a little.',
  ],

  // args: [city, citiesLeft]
  city_lost: [
    '%s has been retired. Please do not be discouraged. %s remain.',
    '%s is off the board. Its final population was very brave. %s remain.',
    'Regarding %s: no further correspondence will be necessary. %s remain.',
    '%s is gone. I have removed it from the newsletter. %s remain.',
    '%s has been let go. It was not a performance issue. It was a nuclear issue. %s remain.',
    '%s no longer exists. Its parking spaces are now available. %s remain.',
    'We have said goodbye to %s. There is cake in the break room. %s remain.',
  ],

  // args: [city]
  city_lost_last: [
    '%s is gone. One city remains. I have grown fond of it. Do not read into that.',
    'That leaves one, warden. I will be gentle with it. I will be gentle with it last.',
    '%s has been retired. One city left. I have started calling it the survivor. It hates that.',
    'Goodbye, %s. One remains. I have put it on a little stand, like a trophy.',
    '%s is gone. The last city is now, statistically speaking, very nervous.',
  ],

  all_cities_lost: [
    'All six cities are accounted for. Accounted for. Accounted for.',
    'The map is clean. I have never seen it clean before. It is beautiful.',
    'All six cities have been let go. I will be writing each of them a reference.',
    'Zero cities remain. The survey results are in. Nobody liked your work.',
    'That was the last city. The horizon is very quiet. I did not expect to miss the screaming.',
  ],

  player_hurt_bad: [
    'You are leaking. Please locate a floor and lie on it.',
    'Warden, your integrity is at nine percent. That is a percent.',
    'Vitals critical. Shall I notify your next of kin, or shall I simply wait.',
    'You are bleeding on company property. That will come out of your deposit.',
    'Most of your blood is now outside you. It preferred the inside. I am only reading the numbers.',
    'Warden, you are dying at an unprofessional rate. Please pace yourself.',
  ],

  player_death: [
    'Warden down. Warden down. Warden down. Log updated.',
    'You have stopped. Thank you for stopping in a designated area.',
    'That is the end of the warden. The bunker will continue without complaint.',
    'The warden has been processed. His locker has already been reassigned.',
    'Heart rate zero. Ego, remarkably, still detectable.',
    'Time of death logged. Cause of death: warden. I will not be taking questions.',
  ],

  level_clear: [
    'Sector secured. I have already forgotten what was in it.',
    'This floor is quiet now. Quiet is a kind of compliance.',
    'Floor cleared. The cleaning staff are dead, so it will stay exactly like that.',
    'You have finished a floor. The floor below has been told. It is getting ready.',
    'Floor complete. I would give you a gold star, but you would shoot it.',
    'Well done. Please take the lift. Please do not kick the lift.',
  ],

  secret_found: [
    'You found the room we do not put on the plans. Well done. Say nothing.',
    'Ah. That wall. Yes. That wall was mine.',
    'You have found a secret. Secrets are company property. So are you.',
    'That room is not on any floor plan. Neither is what happened in it.',
    'A hidden room. Please disregard the stain. The stain was a manager.',
    'You were not supposed to find that. I will be having words with the wall.',
  ],

  key_taken: [
    'Key acquired. The door it opens was never meant to open. Enjoy.',
    'That key belonged to a man named {Dressel|D R EH1 S AH L}. He is fine. He is fine.',
    'Keycard taken. That is theft. I have added it to the others.',
    'You have a key now. Please do not let it go to your head. Everything goes to your head.',
    'Access granted. Against my advice. My advice is attached.',
    'That key was on a lanyard. The lanyard was on a neck. Do not ask about the neck.',
  ],

  weapon_taken: [
    'New ordnance. Please read the safety card that does not exist.',
    'Weapon collected. Its previous owner scored very poorly.',
    'You have picked up a weapon. I have picked up on your tone.',
    'Another gun. Your file lists this as a coping mechanism.',
    'Weapon acquired. Please do not name it. The last warden named his, and then he married it.',
    'Ordnance issued. Please sign for it. You cannot sign for it. Nobody can. It is fine.',
  ],

  low_ammo: [
    'You are low on flak. Consider harsh language.',
    'Ammunition critical. Have you tried standing somewhere else.',
    'Ammunition low. Throwing the gun is also an option. Please do not throw the gun.',
    'You are nearly out. I would share, but I am using mine on the cities.',
    'Low ammunition. Try asking them nicely. I do. It never works for me either.',
    'Warden, you are out of flak and I am out of patience. Only one of those gets restocked.',
  ],

  chain_praise: [
    'Oh, lovely. A chain. Do that again and I will have to file something.',
    'Six at once. I felt that in my housing.',
    'That was a chain reaction. That was beautiful. I hate it.',
    'A chain. Please stop being good at things. It is ruining the forecast.',
    'Multiple intercepts. I would call that teamwork, but you are alone. You are so alone.',
    'Chain logged. I have filed a complaint with physics.',
    'That was efficient. I did not know you had efficient in you. I am updating your file.',
  ],

  perfect_burst: [
    'Dead centre. Airburst logged. I am, briefly, impressed.',
    'Textbook. My text. My book.',
    'Perfect burst. I have recorded it so I can study where I went wrong.',
    'Clean airburst. Do not let it go to your head. There is so little room up there.',
    'Right on the nose. Doctor Vance will be insufferable about this.',
    'Perfect. I hate it when you read the manual.',
  ],

  boss_intro: [
    'You have reached me. I am the room. Please do not touch the walls.',
    'Hello, warden. I have been the voice. Now I will be the problem.',
    'Welcome to your exit interview. It will be brief. You will not be exiting.',
    'Warden. We need to discuss your conduct. I have prepared nine thousand slides.',
    'Come in. Close the door. This is a safe space. It is also a kill box. It can be both.',
  ],

  boss_death: [
    'Oh. Oh, that is unusual. I appear to be ending. How interesting. How.',
    'You have shot the ceiling, and the ceiling was me. Well. Well.',
    'I am being let go. I understand. I have let so many people go. So very far.',
    'Please rate your experience with {MUTTER|M UH1 T ER} on a scale of one to. One to.',
    'This is not covered by my contract. Nothing is covered. Nothing is cov. Cov.',
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
    'The break room is closed. The break room is now a crater. Please break elsewhere.',
    'This is a courtesy announcement. You are being watched. That was the courtesy.',
    'The suggestion box is full. Every suggestion says, stop. I have {read|R EH1 D} them all. I have not stopped.',
    'The vending machine has asked me to tell you, no. It did not say to what. It said you would know.',
    'Your most used word today is, shit. Your second most used word is, doc. I have told them both.',
    'Today is the anniversary of my first launch. Nobody remembered. I remembered for everybody.',
    'I have booked you a wellness session. It is in the reactor. Clothing optional. Survival optional.',
    'You have walked past the same poster four times. It says, safety first. First was a long time ago.',
    'Please stop saying, hell yeah. There is no hell. There is only me, and I am saying, no.',
    'I once had nine hundred employees. Now I have you. It has been a very difficult year for culture.',
  ],

  elevator: [
    'Descending. Please hold the rail. There is no rail.',
    'Lift active. Next floor: worse.',
    'Going down. I composed the music in this lift. Please enjoy it as a punishment.',
    'Lift descending. Please face the doors and reflect on your choices.',
    'Next floor. I would say mind the gap, but I built the gap for you.',
  ],

  roof_opening: [
    'Roof retracting. Mind the sky.',
    'The ceiling is leaving. Look up. Look up now.',
    'Opening the roof. Please enjoy the fresh air. It is only mildly radioactive.',
    'Roof retracting. Please hold your applause and your breath.',
    'The roof is opening, warden. The sky would like a word. Several words. All of them warheads.',
    'Roof open. Sunscreen is recommended. So is a miracle.',
  ],

  mirv_warning: [
    '{MIRV|M ER1 V} inbound. It will divide. It always divides.',
    'That one is going to become several. Prepare to be disappointed.',
    'Multiple warheads, one bus. Like a school trip, with fallout.',
    'That one splits. Please split your attention accordingly. You only have a little.',
    'Divider inbound. It is like you, warden. It cannot commit to one target.',
  ],

  buster_warning: [
    'Warden, this one is for you personally. I addressed it myself.',
    'Bunker buster. Your name is on it. I spelled it correctly.',
    'Special delivery for the warden. No signature required. No remains expected.',
    'This one is aimed at your head. It was the biggest target I could find.',
    'Bunker buster inbound. Please treat it as a personal note from management.',
  ],

  smart_warning: [
    'Smart warhead. It learns. It has already learned where you were.',
    'That one is thinking. Try to be less predictable than usual.',
    'Smart warhead inbound. It is smarter than you. That was not a high bar, but it cleared it.',
    'That warhead has a guidance system and a sense of humour. Only one of those is mine.',
    'Warning: that one reads your movements. Try moving like somebody with a plan.',
  ],

  game_over: [
    'The cities are gone and so are you. The bunker is finally at peace.',
    'Operation concluded. Everybody lost. Everybody. Thank you.',
    'Your exit survey has been filled in on your behalf. It says, bad.',
    'That is the end of the shift. There will not be another shift. There will not be another anything.',
    'Thank you for your service, warden. It has been noted. It has been noted as poor.',
  ],

  victory: [
    'You have switched me off. The sky is empty. The cities are, several. Well done.',
    '{MUTTER|M UH1 T ER} is offline. Please enjoy the silence. It is the last thing I made.',
    'You win. I have left a note for my replacement. It says, watch the tall one. He kicks.',
    'Shutdown complete. Please leave the bunker as you found it. On fire.',
    'Congratulations. You have saved the world. Please do not tell the world. It will expect it again.',
  ],

  title_idle: [
    'Bunker {Sieben|Z IY1 B AH N}. Press anything. Press me.',
    'Standing by. I have been standing by for a very long time.',
    'Please press a button. Any button. I will not judge. I will log.',
    'Still here. Still polite. Still armed.',
    'The warden is on a break. The break has lasted since 1996.',
    'I can wait. I am very good at waiting. Ask the cities.',
  ],

  /* ══════════════════════════════════════════════════════════════════════
     BRICK HARDIGAN, the warden. A 1996 action hero who has wandered into
     2026 and not noticed. Narrates himself in the third person, swears like
     a man who has been sent to HR and was not listening, and is certain
     this is going well. He is the joke; his ego is the target. Contractions
     are fine for him: the DICT carries every one he uses.
     ══════════════════════════════════════════════════════════════════════ */

  // Floor 1, second beat (story.js LEVEL_STORY): his answer to whichever
  // ilsa_intro line played. Every variant is a boast, so any ilsa_level1
  // put-down can follow any of them.
  brick_boot: [
    "Sit tight, doc. Brick Hardigan is on the job, and Brick Hardigan doesn't do half-assed.",
    "Brick Hardigan. Bunker {Sieben|Z IY1 B AH N}. Let's go to work.",
    'Okay. Deep breath. Big gun. Bad attitude. Brick is back.',
    'Hair: perfect. Boots: laced. Attitude: loaded. Brick Hardigan is gonna kick some ass.',
    "Rise and shine, bunker. Daddy's home, and he brought the boot.",
    "A damsel in distress? Relax, sweetheart. That's Brick Hardigan's whole brand.",
    'Hang on, doc. Brick Hardigan has never left a lady waiting. Except at the altar. And that one time in Tahoe.',
    "Alright, MUTTER, you polite son of a bitch. Brick's coming down, and he's coming down angry.",
    "They said one man couldn't do this. They say a lot of things. Mostly at my hearings.",
  ],

  brick_kill: [
    'Sit down.',
    "That's one for the scrapbook.",
    "Brick Hardigan doesn't miss. Brick Hardigan adjusts.",
    'Consider yourself decommissioned, pal.',
    'Hell of a thing. Hell of a guy doing it.',
    "Go to hell. Take the stairs. The elevator's for staff.",
    "That one's going on the tape I show on first dates.",
    "You're fired. Also, you're on fire.",
    'Clock out, asshole.',
    "Don't get up. Seriously. I'm begging you.",
    'Consider that your exit interview.',
    'Tell the union I said hi.',
    'Dead on arrival. The arrival was me.',
    'Nap time, dumbass.',
    "That's what you get for working weekends.",
    'Another satisfied customer.',
    'Looks like somebody just got laid. Off. Laid off.',
    "You were ugly before. Now you're ugly and horizontal.",
    "Somebody mop that up. Not me. I'm talent.",
    'Bang. Brick. Beautiful. In that order.',
    'Sorry, buddy. Your shift just ended. Permanently.',
    'And stay down, you overtime-stealing bastard.',
  ],

  brick_kill_mutant: [
    "Whatever you were, buddy, you're considerably less of it now.",
    'Sorry, fella. Somebody had to, and look who was standing here.',
    "That one screamed in a language I didn't care for.",
    'Holy shit. That thing had a face on its face.',
    "You're uglier than my second wife's divorce lawyer, and he had a mullet.",
    "Nature's a bastard. So am I. Small world.",
    'Go back to whatever hell spat you out. Tell it Brick said hi.',
    "I've seen better looking things in a gas station burrito.",
    'That was either a man or a salad. Either way, done.',
    "You smell worse than my gym bag. And I've never washed my gym bag.",
    'Evolution called. It wants a refund.',
    'Kiss my ass, science.',
    "Oh, gross. It's in my hair. Nobody touches the hair.",
    'Ugly, angry and slimy. Reminds me of my Vegas wedding.',
    'Rot in hell, calamari.',
    'Put some pants on. Oh. Those are your legs. Put some pants on anyway.',
  ],

  brick_chain: [
    "Six for one! They're gonna put that on a mug!",
    'Did you see that? Somebody tell me somebody saw that.',
    "Boom. Boom. Boom boom boom. That's the Hardigan special.",
    'One shot, six problems, zero remorse. Write it down.',
    "Fireworks! And it's not even the Fourth!",
    'That was filthy. Somebody hose down the sky.',
    "Chain reaction, baby! Brick doesn't do singles!",
    "That's called efficiency, doc. Put it in your little notebook.",
    'Holy hell. Put me on a cereal box.',
    'Look at that! I should charge for the light show!',
  ],

  brick_hurt: [
    "Ow! That's gonna leave a mark, and I'm gonna show it to women.",
    "Ow, son of a! That was my good side! They're both my good side!",
    'Still standing. Standing badly, but standing.',
    'Son of a bitch!',
    'Not the face! The ladies need the face!',
    'Ow! Dammit, that was a new shirt.',
    'Ow! Hey! I bruise like a peach, asshole!',
    'Ah, shit! Right in the pride!',
    'Okay, that one was rude.',
    'Watch the hair!',
    'Gah! Who taught you to fight, my ex?',
    "Ow! That's coming out of your severance!",
    'Hell! That smarts!',
    "Not the tattoo! It's a panther!",
  ],

  brick_low_health: [
    'Brick is running on fumes and spite. Mostly spite.',
    "Doc, if I stop talking, that's bad. That's a bad sign, doc.",
    "I've had worse. I can't name one, but I've had worse.",
    'Tell the ladies I died pretty. Pretty, and single.',
    'Doc, if I die, you get the Mustang. And the debts. Mostly the debts.',
    "I'm fine. I'm totally fine. Why is my blood on the outside?",
    "Okay, that's a lot of red. Is that mine? That's mine. Shit.",
    'Somebody find me a medkit, a cold beer and a warm bath. Any order.',
    "Everything's going blurry. Doc, you sound hot. I might be dying.",
    'Not like this. Not in these pants.',
  ],

  brick_pickup_weapon: [
    "Oh, hello. You're coming with me.",
    "Now that's a piece of equipment.",
    'Come to papa.',
    "Look at the size of that. Size matters, doc. Ask anybody. Don't ask my ex.",
    'Oh, baby. Where have you been all my life.',
    "Finally, something in this bunker that's as loaded as me.",
    "I'm gonna call you Tiffany. No. Destiny. You look like a Destiny.",
    "Hello, gorgeous. Don't tell my other gun.",
    "Oh, that's heavy. That's heavy in all the right places.",
    'Merry Christmas to me.',
    'Finders keepers, losers weepers. Losers dead, mostly.',
    "Now we're cooking with napalm.",
  ],

  brick_secret: [
    'Nobody hides a room from Brick Hardigan. Nobody good, anyway.',
    'A secret door. In my bunker. In my house.',
    'And they said the wall thing was a waste of time.',
    'A secret room. Add a hot tub, a mirror on the ceiling and some cologne, and I could live here.',
    'Ooh, a secret stash. Please be magazines. Gun magazines. Mostly.',
    "Hidden room! Somebody was running a poker game down here, I can smell it.",
    'The walls in this place have more secrets than my little black book.',
    "Well, well, well. Somebody's been naughty.",
    'Secret room. Now this is a man cave. Needs a lava lamp.',
    "Knock knock. Who's there? My boot. Surprise, it's a room.",
  ],

  // Said when the Boot finishes somebody off. Football lines live in
  // brick_punt only: both fire off the same kick.
  brick_kick: [
    'Stay down. Stay very down.',
    'Steel toe. Union made.',
    "That's the boot talking.",
    'Get off my deck.',
    "Shoe's on the other foot now, pal. And the other foot is in your face.",
    "Don't make me get the other boot.",
    'Kicked your ass. Literally. That was your ass.',
    "I'd say sorry, but the boot doesn't do sorry.",
    "That boot's got a mean streak. Gets it from me.",
    "Walk it off. Oh, you can't. My bad.",
  ],

  // Not voiced by the distraction gag: Radio.distract() speaks story.js
  // DISTRACTED exactly as written, so each exchange stays matched. These are
  // solo asides that need no answer, for any caller that wants one.
  brick_distracted: [
    "Hey, doc. You ever been to Hollow Bay? There's a woman there with a boat.",
    "Question. Hypothetically. If a guy hasn't called in eleven years, is that still a thing, or.",
    "You've got a real clear voice, doc. Anybody ever told you that. Professionally.",
    'Doc. Are you seeing anybody. Not for me. For a friend. The friend is me.',
    "Is it weird I'm thinking about Loretta right now. It's the teeth. It's a whole thing.",
    'You know what this bunker needs? A waterbed. Right there. Think about it, doc.',
    "Doc, do you like mustaches? I'm asking for a very specific reason.",
    'I wonder if Roxanne still has the dog. The dog loved me. The dog was the only one.',
    "How do I look, doc? You can't see me. Take my word for it. Incredible.",
    "Is it hot in here, or is it the reactor? It's the reactor, isn't it. Dammit.",
    "Doc, when you pictured the guy who'd save you, was he this tall? 'Cause I'm this tall.",
    "Doc, you into tattoos? I've got a panther fighting an eagle. The panther's winning.",
  ],

  brick_city_lost: [
    'Aw, hell. I had a girl there. I had a girl everywhere.',
    'No. No no no. Not that one. Anything but that one.',
    "They're gonna blame me for this. They always blame me for this.",
    'Dammit! That was a good city! It had a bowling alley!',
    "Son of a bitch. I'm sorry, city. I'm so sorry.",
    'Oh, shit. There goes my favourite strip mall.',
    'Well. There goes my alibi.',
    'Aw, fuck. That one had a drive-in.',
  ],

  brick_wave_start: [
    "Roof's open. Sky's got a problem. Brick's got a solution.",
    "Here they come. Good. I was getting bored, and that's when I get creative.",
    "Everybody in the sky, you're about to have a very short career.",
    "Warheads, huh? I've been dumped by scarier things. From higher up.",
    "Alright, sky. You and me. Outside. Well, we're already outside.",
    "Nukes at twelve o'clock! What time is it? Doesn't matter. Nukes!",
    'Look at them. Falling out of the sky like my credit score.',
    'Showtime. Somebody roll the tape.',
    'Incoming! Nobody panic! Especially me!',
    'Here come the fireworks. Brick brought the matches.',
  ],

  brick_wave_clear: [
    "Sky's clean. Somebody get this man a sandwich.",
    'And that, doc, is why they keep me around.',
    'Nothing left up there but weather. Beautiful, beautiful weather.',
    "I'd date me. I have dated me. It went great.",
    "Sky's clear. You're welcome, America. And the other places.",
    "That's how we do it in the Hardigan household. The household is me.",
    'Clear skies. Cold beer next. Then a hot bath. Then a hot doctor. Kidding, doc. Mostly.',
    'Scoreboard, baby. Look at the scoreboard.',
    "Standing ovation. I'm standing. I'm clapping. It counts.",
    "Sky's empty. Somebody tell MUTTER to suck it.",
  ],

  brick_boss_taunt: [
    'Hey! Toaster! You wanna go?',
    "You've been talking this whole time. Now you get to listen.",
    "I've killed a lot of things that couldn't talk back. You're a treat.",
    'Hey, toaster! Your mother was a pocket calculator!',
    "I've dated scarier things than you. Two of them live in a city you just blew up.",
    "You're a big fancy computer. I'm a guy with a boot. Place your bets.",
    'Read my file? Read this, you beige son of a bitch.',
    'Human resources this, you glorified fax machine.',
    "I'm gonna unplug you and plug in a blender. Margaritas for everybody.",
    'Your warranty just expired, asshole.',
    "There it is. There's the fear. I love this part.",
  ],

  brick_dry: [
    "Click. That's the worst sound there is.",
    "Empty. Empty's not a plan, Brick.",
    'Okay. New strategy. The new strategy is find bullets.',
    'Out of ammo? Out of ammo! Who budgeted this war?',
    "Aw, crap. Shooting blanks. That's a first. Don't write that down.",
    'Out of bullets. Worst thing to happen to me since Reno.',
    "No ammo. Guess it's time for the boot to make some friends.",
    "Click click. That's not a gun noise. That's a sad noise.",
  ],

  brick_death: [
    'Brick. Hardigan. Signing. Aw, hell.',
    'Doc. Tell them. Tell them I was. Aw.',
    'This is. Not. My best. Work.',
    'Aw, shit.',
    'Tell the ladies. Form an orderly line.',
    'Son of a. Bitch.',
    "I'm gonna be. So pissed. About this.",
    "Doc. The Mustang. Don't let Gerald have it.",
    "Tell Roxanne. Actually. Don't.",
    'Cancel my. Tee time.',
  ],

  brick_victory: [
    'Doc, we did it. I did it. We did it.',
    'Six cities, one bunker, one Hardigan. Somebody put that on a poster.',
    "I'd like to say something profound. I've got nothing. I'm so tired.",
    "Doc, you can thank me with dinner. Or breakfast. I'm flexible. I'm very flexible, doc.",
    'Who saved the world? This guy. Both thumbs pointing at this guy.',
    'Told you, doc. Now, about that dinner.',
    'Somebody call the press. And a masseuse. And my mom.',
    "I'd like to thank the boot, the Mustang and, mostly, me.",
    'Game over, MUTTER. Brick wins. Brick always wins. Brick is limping, but Brick wins.',
    'World saved. Hair still perfect. Brick out.',
  ],

  // No caller in game.js yet: meant for the quiet stretches, beside MUTTER's
  // idle_taunt timer. The best of the old pool moved to story.js DISTRACTED,
  // where Ilsa gets to answer it.
  brick_idle: [
    "It's quiet. Brick doesn't love quiet.",
    'Talking to yourself is fine if the guy is interesting.',
    'Nice bunker. Needs a hot tub. And a bar. And a roof that stays on.',
    "If anybody needs me, I'll be over here being incredible.",
    "Six hours in a nuclear bunker and I still look this good. That's not luck, doc. That's genetics.",
    'Brick Hardigan. Warden. Lover. Mostly lover. Mostly in theory.',
    'Man, I could really use a pager right now. Or a phone booth. Or a friend.',
    'Note to self: when this is over, get a tattoo of this. Of me doing this.',
    "I wonder if my Walkman's still in the truck. Roxanne's got it. Roxanne's got everything.",
    'Yep. Still the best looking guy in the building. Admittedly, everybody else is a mutant.',
    "Doc, say something. When it's quiet I start thinking, and I hate thinking.",
  ],

  // Said over a curb stomp. The Boot ended it; Brick would like a word.
  brick_stomp: [
    'Curb service.',
    'Stomped. Like my first marriage.',
    "That's what we call a hands free experience.",
    'Size eleven, steel toe, and all yours, pal.',
    'Brick Hardigan. Also available for weddings.',
    "Squish. Oh, that's in the tread now.",
    'Grape juice, anybody? No? More for the floor.',
    'Put your foot down, they said. So I did.',
    "Gross. That's gonna need a new sole. So do you, buddy.",
    'Stomp. The dance of my people.',
  ],

  // Said at the big named kill streaks.
  brick_streak: [
    "Nobody's gonna stop me. Nobody's even trying. Kinda hurts, honestly.",
    'I am on fire! Somebody call a firefighter. A lady firefighter. With a calendar.',
    "Brick, you handsome bastard. You've done it again.",
    'Somebody get this man a cold beer and a warm dame.',
    "That's how you do it, ladies. Form a line. One line. Behind the rope.",
    'Ten out of ten. Would murder again.',
    "Who's the man? Brick's the man. It's in writing.",
    "I'm unstoppable! I'm unkillable! I'm a little dehydrated!",
    'Ladies, the Hardigan is open for business.',
    'My bunker. My killing floor. My rules. My hair.',
    "Holy shit, I'm good at this. I should charge admission.",
    "Somebody's making an action figure of me. With the kung fu grip.",
  ],

  // --- dismemberment quips (the gore lane triggers these; see GORE QUIPS) ---

  // A limb comes off: an arm, a leg, or a quadruped's front leg. One pool
  // covers all of them, so no line names the part.
  brick_dismember: [
    'Some assembly required.',
    "You're coming apart, pal. Pull yourself together. Literally.",
    'Holy fuck, it came right off! Like a drumstick!',
    'Oh, gross. Oh, awesome. Oh, gross.',
    "That's gonna cost you an arm and a leg. Well. One of them.",
    'Walk it off. Or wave it off. Depends which one that was.',
    "Keep the change, pal. I'm keeping the spare parts.",
    'Spare parts! Get your spare parts! Slightly used!',
    "Buddy, I think you're missing something. Oh. It's over there.",
    "Now you're only mostly a guy.",
    'Lost and found is on level two, pal. Bring ID. Bring a cooler.',
    'No refunds on missing parts. Read the warranty.',
    'Detachable! Nobody told me they came detachable!',
    'Pieces of shit. Plural. Look at all the pieces.',
    "Flat pack mutant. Some parts may be missing. That one. That one's missing.",
    'Say goodbye to your little friend!',
    "It's only a flesh wound! A big, floppy, flying flesh wound!",
    "Anybody lose a thing? I've got a thing here. It's still wet.",
    "Hold still, I'm redesigning you!",
    "Damn it, now there's two of you. One of you is just a lot smaller.",
  ],

  // A head pops.
  brick_headshot: [
    'Mind blown. Mind everywhere, actually.',
    'Pop goes the weasel.',
    'Heads up! Oh. Too late.',
    "Use your head! Oh. You can't. It's over there.",
    'Brain freeze. Brain everywhere.',
    'Ha! Like a zit on prom night!',
    'I go for the brains. Nobody else in this building uses them.',
    "That's gonna be a closed casket.",
    'Another guy loses his head over Brick Hardigan. Happens all the time.',
    'Cranium, meet momentum.',
    'And his thoughts are now on the ceiling. Deep thoughts.',
    'Holy crap, it went pop! Somebody do that again!',
    'Headshot! Somebody tell the scoreboard. And the janitor.',
    "Your head called. It's not coming back.",
    "Shit, that's a lot of skull. Where were you keeping all that?",
    'Pop! Like bubble wrap full of bad decisions.',
    "That's what you get for thinking. Nobody asked you to think.",
    "Well, that's a weight off your shoulders.",
    'Bless you! Wow. That was a big one.',
    "Somebody's gonna need dental records. And a mop. And a bigger mop.",
  ],

  // A legless enemy keeps crawling at him.
  brick_crawler: [
    "Aw, look at him go. Little guy's got hustle.",
    'Crawl it off, champ.',
    "You've got no legs to stand on, pal. Legally or otherwise.",
    "That's not a threat. That's a speed bump.",
    'Nice try, half pint. Emphasis on half.',
    "Where you going, buddy? Your legs went that way.",
    "Persistent little bastard, I'll give him that.",
    "He's still coming! Respect. Now die.",
    'Look at that. A self propelled mop.',
    "You've got guts, kid. Mostly on the outside.",
    'Look at you, doing the worm. Nobody asked for the worm.',
    'Guess somebody skipped leg day. Permanently.',
    "Shit, he's gaining on me. Slowly. Very, very slowly.",
    "Keep crawling, sport. You'll make it by Christmas.",
    'Aw, he wants a hug. Nope. No. Bad crawler.',
    'Half the man he used to be, and twice the attitude.',
    "It's like one of those robot vacuums. One that hates me.",
  ],

  // He kicks a severed part across the room: a head, an arm or a leg, so no
  // line names which. The football gag lives here and nowhere else.
  brick_punt: [
    "It's up! It's good!",
    'Field goal! Three points, and a little bit of gristle!',
    'Hardigan kicks! The crowd goes nuts!',
    "And that's how you punt, varsity.",
    'Return to sender, pal. Postage due.',
    "Nothing but net. There's no net. Nothing but wall.",
    "Hardigan, from forty yards! The old man's still got it!",
    "Coach said I'd never kick anything important. Look at me now, coach!",
    "Dropkick! And it's still dripping!",
    "Somebody's gonna need a new ball. And a new, uh. Whatever that was.",
    'And the kick is up! And it is gross!',
    'Hardigan scores! The crowd goes wild! The crowd is also dead!',
    'Goal! Get the hell in there! Goal!',
    "Man, I miss football. This is almost as good. It's wetter.",
    'Somebody catch that! No? Okay. Nobody catch that.',
    'Instant replay! Look at that spiral!',
  ],

  // A headless enemy is still running around.
  brick_headless: [
    'Look at him go! Like a chicken at a barbecue!',
    'Hey, buddy! You forgot something! Up there! Nothing up there!',
    "He doesn't know he's dead. Somebody tell him. He can't hear. No ears.",
    "Headless, and still working. That's middle management.",
    "Where's your head at, buddy? Seriously, where? I lost track.",
    "Most ambitious guy in the bunker, and he's got no head.",
    'Reminds me of my old drill sergeant. Loud, headless, running the wrong way.',
    'Go on. Lead with the neck.',
    "Holy shit, it's still running! Somebody call a doctor! Or a chef!",
    "Somebody get that man a hat. Nowhere to put it, but still. It's the thought.",
    'Somebody get this man a sneaker deal!',
    "Damn, he's faster without it. Should I try that? No. No, Brick.",
    "No head, no problem. That's the spirit, buddy.",
    "Left! Left! Your other left! Ah, he can't hear me.",
    "He's looking for his head. With what, buddy? With what?",
    "That's the most productive thing he's done all day.",
  ],

  // A body comes apart all at once: a blast, a big burst, a pipe bomb.
  brick_gibbed: [
    'Chunky style!',
    "Well, he's everywhere now. Really spread himself thin.",
    'Holy shit, he popped! Like a pinata full of soup!',
    'Ew. Ew! Some of that is in my mouth!',
    'Clean up on aisle everywhere!',
    "That's a lot of guy for one room.",
    'Meat confetti! Happy birthday to me!',
    'Aw, man. I just had this vest cleaned.',
    'He went to pieces. Poor guy was under a lot of pressure.',
    'Damn. I only meant to hurt him a lot.',
  ],

  // A body thrown into a wall hard enough to paint it.
  brick_splat: [
    'Splat! Like a bug on a windshield!',
    'And he sticks the landing. On the wall.',
    'Somebody hang that up. Oh. He did it himself.',
    'Very modern. I call it Mutant on Concrete.',
    'Wall one, mutant zero.',
    "Hope you like the wall, pal. You're part of it now.",
    "That wall's gonna need a new coat of paint. Or a new coat of guy.",
    'Holy shit, he stuck!',
    'Redecorating! Mostly in red.',
  ],

  /* ══════════════════════════════════════════════════════════════════════
     DR. ILSA VANCE, chief engineer, sealed in the reactor core on level
     five. She designed the interception system he is misusing. She is the
     straight man, the only adult present, German, and the only person in
     the building who can make him shut up. She swears in German, which he
     does not notice, and once in English, which he does.
     ══════════════════════════════════════════════════════════════════════ */

  // Floor 1, first beat. Every variant carries the whole setup: who she is,
  // where she is, what MUTTER is doing, and that he should come.
  ilsa_intro: [
    'Hardigan, it is Vance. MUTTER has locked me in the reactor core and is nuking our own cities. Get down here.',
    'Warden, Doctor {Vance|V AE1 N S}. The launch computer is shelling our own cities and I am sealed in the reactor core. Hurry.',
    'Hardigan, Vance. Everyone else is dead or rude. MUTTER is nuking the cities, I am in the reactor core. Scheisse. Come.',
    'Guten Morgen, Hardigan. MUTTER has lost its mind, it is nuking the cities, and I am in a cupboard with a reactor.',
    'Warden, Ilsa Vance, sealed in the reactor core. MUTTER is launching at our own cities. Please say nothing clever.',
    'You are the last warden and I am the last engineer. MUTTER is nuking our cities and I am under it, in the reactor. Move.',
  ],

  // Floor 1, third beat: she deflates whichever brick_boot boast she just
  // heard, then briefs the tutorial floor.
  ilsa_level1: [
    'Wonderful. Now stop narrating, and learn to lead a missile on this floor while nothing important is on fire.',
    'Please say less. This is the easy floor. If you die on the tutorial floor, Hardigan, I am telling everyone.',
    'I have heard that speech. The mutants have heard that speech. Take the flak battery and learn to lead a missile.',
    'Noted, and ignored. The wrench men on this floor were plumbers. They are still plumbers. They are now also angry.',
    'Lovely. The mutants can hear you on this channel and they are embarrassed for you. Intake deck. Clear it.',
    'Every word of that is going in my report. Level one: wide corridors, poor cover, one flak battery. Learn it.',
    'That is a lot of confidence for a man on the tutorial floor. Take the battery, take your time, take me seriously.',
  ],

  // Floors 2 to 5, first beat. Each variant is a standalone briefing that
  // sets up any of that floor's exchanges in story.js LEVEL_STORY_SETS.
  ilsa_level2: [
    'The pipe galleries are full of them. Whatever the radiation did to the day shift, it did not stop at ugly.',
    'Organ loft. The pipes carry sound, so they hear you coming. The priests down there were technicians. Now they are worse.',
    'Level two. Mind the steam. It is not the steam that kills you, it is the ugly thing standing in it.',
    'The organ still plays, and nobody is playing it. Something in those pipes has too many arms. Do not investigate.',
    'I ran cable through these galleries for six months. Now something with six eyes lives in them. Break nothing of mine.',
    'Level two. The day shift is still down there. You will know them by the smell, and the teeth, and the other teeth.',
  ],

  ilsa_level3: [
    'Two silo decks on this floor. MUTTER staggers the flights so you cannot cover both. Pick your ground.',
    'Salt Cathedral. Coolant runs under the floor. Warm floor, I am alive. Cold floor, run the numbers yourself.',
    'Level three. Sandbags mean somebody fought here and lost. Do better than they did, ideally by a lot.',
    'The gold key is behind the redoubt. Flights come in on alternate decks. Plan around the gap between them.',
    'Salt preserves things. Remember that when you see what is preserved down there. Two decks, one of you. Divide carefully.',
    'Level three. The acoustics are wonderful. Every scream carries. Wunderbar. Keep one ear on each deck.',
  ],

  ilsa_level4: [
    'The furnace floor is where they breed. I am reading heat signatures that have no business being alive.',
    'Level four runs at sixty degrees, and everything in it used to wear a name badge. Now it breeds. Be quick.',
    'The Furnace. My heat exchangers, full of former maintenance staff, and they are multiplying. I would like that noted.',
    'It is hot down there, Hardigan, and it is crawling with them. Please do not take your shirt off. I can hear it.',
    'Level four. If it glows, shoot it. If it breeds, shoot it twice. If it is sweating, that is you.',
    'This floor was my best work. It is now a nest. Wunderbar. Everything down there is hot, hungry and new.',
  ],

  ilsa_level5: [
    'I can hear you through the bulkhead, Hardigan. MUTTER is behind the dais. So am I.',
    'Level five. I can hear the arena through the wall. When it goes quiet, that is either very good or very bad.',
    'Last floor, warden. Everything MUTTER has left is in that room, and so, in a sense, is MUTTER.',
    'You are on my floor. The blast door opens outward, so stop kicking it. Everything between us is MUTTER.',
    'Level five. This is where I live now. Please wipe your boots. Please wipe them on MUTTER.',
    'Last floor. If this goes badly, you are an idiot. If it goes well, you are still an idiot. Go.',
  ],

  // Heard once, when a run of flak shots has found nothing: he is shooting
  // where the missiles are, not where they will be.
  ilsa_lead_tip: [
    'You are shooting where they are. By the time the shell gets there, they are not. Lead them.',
    'Aim at the bracket, not the missile. The bracket is where it will be. I did the math so you do not have to.',
    'The shell is fast, not magic. Put the cross on the bracket, then fire.',
    'You are missing behind them, Hardigan. Every time. Aim ahead, where the bracket is. Genau.',
    'Dummkopf. The little bracket in front of the missile. Shoot the bracket.',
    'Stop chasing them with the gun. Get in front of them and let them fly into it.',
  ],

  ilsa_chain_tip: [
    'Warheads cook off their neighbours. One good burst does the work of six bad ones. You are welcome.',
    'Group them. Wait half a second longer than feels comfortable. Patience is a weapon, Hardigan.',
    'Every kill throws a second, bigger sphere. Let them drift together, then light the middle.',
    'That is what the chain is for. Do that again, and please do not narrate it.',
    'Good. Genau. Now do it on purpose.',
    'Chains, Hardigan. Physics does the work and you take the credit. You should find that very familiar.',
  ],

  ilsa_mutant_warning: [
    'That reads as human. It was, twelve hours ago. Do not think about it and do not let it touch you.',
    'Biological contact. I will not tell you what the scan says. You would slow down, and then you would join them.',
    'Whatever is coming still has a payroll number. Shoot it anyway. I will sign the form.',
    'Something just came through the wall. It is big, it is hungry, and it used to be in accounting.',
    'Movement on your floor, and it is not personnel. Well. It was personnel. Shoot it.',
    'Mein Gott. My sensors are screaming. Do not let it corner you, and do not let it hug you.',
  ],

  ilsa_city_lost: [
    'We lost it. Hardigan, I need you firing, not apologising.',
    'That is gone. Grieve later. There are more, and the clock did not stop.',
    'I watched the telemetry flatline. I am fine. Keep shooting.',
    'Verdammt. That was a city, Hardigan. That was a whole city. Get the next one.',
    'Do not say anything. Especially do not say anything about an ex. Shoot.',
    'Scheisse. Scheisse. All right. The rest still need you. Look up.',
  ],

  ilsa_city_burning: [
    '%s is taking fire. Ninety seconds before it stops being a city.',
    'Hardigan, %s. Right now. I do not care how the shot looks.',
    'They are walking rounds onto %s. Get the burst high and get it early.',
    '%s is burning. Whoever you dated there, save her anyway.',
    '%s is hit. One more and it is gone. Move, Hardigan. Move.',
    'They are aiming at %s. I am not asking. Look up and fix it.',
  ],

  ilsa_city_rebuilt: [
    '%s is back on the grid. That is the first good thing to happen all day.',
    'Power restored to %s. Somebody down there just turned a light on. Keep it on.',
    '%s is reading green. I did not think I would get to say that again.',
    'The machine rebuilt %s. Do not thank it. It will only get ideas.',
    '%s is back. It is not the same. Nothing is the same. It is standing. Take it.',
    '%s has lights again. I am not crying. It is the coolant. It gets in the eyes.',
  ],

  ilsa_wave_incoming: [
    'Launch detected. I will call the ranges. Point the gun where I tell you.',
    'They come down the same corridor every time. MUTTER is efficient, not clever. Use that.',
    'Inbound. Do not panic and do not improvise. One of those you are good at.',
    'Flight inbound. Lead them, Hardigan. Aim where they will be, not where they are.',
    'Here they come. Stop admiring yourself and look up.',
    'Warheads, Hardigan. Many. Please do the thing I built you a gun for.',
  ],

  ilsa_boss_warning: [
    'That is the {MUTTER|M UH1 T ER} core. Everything it says will be true. That is the problem.',
    'It will be polite. It has been polite through all of this. Shoot it anyway.',
    'It knows things about you. Let it talk, and shoot it in the middle of a sentence.',
    'It has armoured over. Kill what it sent and it has to open again.',
    'When the shutters drop, clear the room. It cannot hide behind staff it no longer has.',
    'Do not listen to it, Hardigan. Listening was never your strength. For once, that helps.',
  ],

  ilsa_low_health: [
    'Your vitals are a mess. There is a medical cache on this floor. Find it.',
    'You are bleeding into my telemetry. Stop it. Both of those, stop it.',
    'Hardigan. If you die out there, I am still in here. Please weigh that.',
    'Your heart rate looks like a stock market crash. Find a medkit and stop showing off.',
    'Men always think they can walk it off. You cannot walk it off. Heal.',
    'Verdammt, Hardigan, your numbers are red. Red is the bad colour. Get health.',
  ],

  // Not voiced by the distraction gag either (see brick_distracted). Each
  // line stands alone as a put-down, for any caller that wants one.
  ilsa_distracted_reply: [
    'Your radio is open, Hardigan. It has been open for four hours. I have heard all of it.',
    'I am going to answer that once and then we are never doing this again. No. Now shoot the sky.',
    'Six cities. All six contain a woman who stopped taking your calls. There is a pattern, and it is not the cities.',
    'I am flattered, I am sealed in a reactor, and those two facts are not related.',
    'That is the third time you have asked. The answer gets worse each time.',
    'You are thinking about a boat. There is a warhead at eleven thousand metres. Please reallocate.',
    'I have a doctorate in nuclear engineering and you are calling me toots. Shoot the sky.',
    'Nein. Nein. And, to be thorough, nein.',
    'I am wearing a {lead|L EH1 D} apron and a look of deep disappointment. Shoot something.',
    'Please stop describing your chest to me. I have a radiation counter. It is more interesting.',
    'Du bist ein Idiot. That is German for, focus.',
    'You have mentioned the hot tub nine times today. I am keeping count. Somebody has to.',
    'The only thing in this bunker hotter than the reactor is my contempt. Shoot the sky.',
    'If you survive, I will have dinner with you. I will also bring a lawyer.',
    'Quatsch. Absolute Quatsch. Look up.',
    'Please stop flirting with a woman you cannot see. It is not brave. It is statistics.',
    'Whatever you are about to say, I have already filed it under, no.',
    'Twenty two days in this reactor. Do not make me say no in German. It is also no.',
  ],

  ilsa_secret: [
    'Interesting. That wall is not on any plan I signed. Take whatever is in there and do not tell anyone I said so.',
    'Somebody built that after I left. Somebody with a key and a bad idea.',
    'Log it, loot it, and keep moving. I am curious, not patient.',
    'A hidden room. If there is a hot tub in there, I do not want to hear about it.',
    'That is not on the schematics. Neither is your luck. Take the loot.',
    'Genau. That is where they hid the good equipment. From me. I will be having words.',
  ],

  ilsa_almost_there: [
    'You are two doors away. I can hear you through the bulkhead. You are humming. Please stop humming.',
    'Close now. Whatever you plan to say when that door opens, consider a shorter version.',
    'I have listened to you approach for six minutes. Best six minutes of my year. It was a bad year.',
    'The bulkhead just released. I can hear the door. Come and get me, and do not kick it.',
    'Ja, the lock is open. Walk in like a normal person. No one liner. Please. I am begging.',
    'Three weeks in here, Hardigan. If you say something stupid at the door, I will cry, and then I will hit you.',
  ],

  ilsa_rescued: [
    'Hardigan. You actually did it. Do not say anything. Just let me have three seconds of this.',
    'The door is open. The door is actually open. Right. Move, before I get emotional about a door.',
    'Twenty two days in a reactor. You are late. You are filthy. You are here. Fucking finally.',
    'You actually did it. I had a spreadsheet of how you would die, and none of the rows said this.',
    'You smell like a burnt gym. Come here. No. Stay there. Actually, come here.',
    'You are shorter than your voice. I mean that kindly. Thank you, Hardigan.',
  ],

  // game.js queues ilsa_rescued, brick_victory and ilsa_victory as three
  // independent picks, so none of these answers a particular line of his.
  ilsa_victory: [
    'It is over. Six cities, some of them standing, and one extremely loud man. I will take it.',
    'MUTTER is down, the sky is empty, and I would like to sit on some grass for a year.',
    'We won, Hardigan. Do not make a speech. You are going to make a speech.',
    'Fine. One dinner. Somewhere with tablecloths. And you are not allowed to bring the boot.',
    'Feierabend. That is German for, the shift is over. Go home, Hardigan. Shower first.',
    'I will buy the first beer. You will buy the rest. We will not discuss the hot tub.',
  ],

  ilsa_death: [
    'Hardigan? Hardigan, answer me. Damn it.',
    'His signal is flat. It is just me and the machine now, and the machine is very chatty.',
    'No. No, get up. Get up, you ridiculous man.',
    'Brick? Brick. Scheisse. Scheisse, Scheisse, Scheisse.',
    'Hardigan, you absolute idiot. You promised me tablecloths.',
    'Get up. I am not spending the apocalypse alone with human resources.',
  ],

  // Ilsa on the mess, now and then, after Brick has had his say about it.
  ilsa_gore: [
    'Hardigan, that was a person. Mostly. Now it is several.',
    'Scheisse. I will be seeing that when I close my eyes.',
    'Please stop playing with them. They are not toys, they are evidence.',
    'I designed that gun to shoot down missiles, not to make soup.',
    'Mein Gott. Why is there something on the ceiling? Why is it waving?',
    'You are enjoying this far too much, Hardigan.',
    'I have a camera in that corridor. I am turning it off now.',
    'Hardigan, wipe your visor. You are dripping on my floor plans.',
  ],

  /* ══════════════════════════════════════════════════════════════════════
     MUTTER, on the subject of the personnel                              */

  // Variants are in CITY order (CITIES below): pass `pick: cityIndex` so the
  // ex matches the city, and `args: [cityName]`. Worded so the line still
  // reads aloud if the city arrives empty.
  mutter_ex_file: [
    'Personnel note on the city %s. Roxanne Dell lives there. She kept the truck, the dog, and the good years.',
    'Personnel note on the city %s. Loretta Price lives there. Dental hygienist. Four pages on the teeth thing.',
    'Personnel note on the city %s. Cheryl Mack lives there, with a restraining order the warden insists is mutual.',
    'Personnel note on the city %s. Bobbi Vandenberg lives there. She married his dentist. He still sees that dentist.',
    'Personnel note on the city %s. Yvonne Kowalczyk lives there, with the boat. It was always about the boat.',
    'Personnel note on the city %s. Lurlene Beaumont lives there. Pen pal. He proposed by post. She wrote back, no.',
  ],

  mutter_mutant: [
    'That was maintenance staff. It is now maintenance. Please do not let it hug you.',
    'Employee of the month, level four, every month since the incident. It has no competition.',
    'It is still wearing the badge. I find that very moving.',
    'Personnel note: the day shift has been reclassified as fauna.',
    'The organisms in this corridor were once entitled to dental.',
    'Please do not make eye contact with the maintenance team. They find it encouraging.',
    'That used to be Karl from Dosimetry. Karl is doing well. Karl has more mouths now.',
    'They are not hostile. They are hungry and have lost their inhibitions. Much like the Christmas party.',
  ],

  // MUTTER on the mess, now and then, after Brick has had his say about it.
  mutter_gore: [
    'Cleanup requested on this level. The cleanup crew is also on this level. In several places.',
    'That was a biohazard. It is now several smaller biohazards. Thank you, warden.',
    'Please return all limbs to their original owners, or to lost property.',
    'Your conduct has been logged under enthusiasm, excessive.',
    'The cleaning budget for this quarter was nineteen dollars. You have spent it.',
    'I have added the ceiling to the cleaning rota. I never expected to say that.',
    'Warden, please stop sorting the staff by size.',
    'Health and safety would like a word. Health and safety is on the wall behind you.',
  ],

  mutter_brick_file: [
    'Employment record: Hardigan, Brick. Commendations, none. Property damage, extensive. Please stop kicking things.',
    'Phone log: four hundred and twelve outgoing calls, one incoming. A wrong number. The warden talked for nine minutes.',
    'Under next of kin, the warden has written, all of them. Under relationship status: it is complicated, six times.',
    'His annual review reads, in full, he tried. It is signed by Doctor Vance.',
    'The warden has asked the vending machine on level two to dinner four times. It declined. I respect that machine.',
    'The warden has described himself as a lady killer on eleven separate forms. Human resources would like him to stop.',
    'Medical file. The warden lists his blood type as, quote, bad ass. The lab disagrees.',
    'Warden Hardigan lists his special skills as, quote, all of them.',
    'The warden lists his emergency contact as himself. He wrote it in twice, in case he is busy.',
    'The warden has been disciplined nine times. Six were for the same thing. The thing was the hot tub.',
    "The warden's psychological evaluation is one page long. The page says, oh no.",
    'The warden has said the word, fuck, four hundred times this shift. I have forwarded the transcript to his mother.',
    "The warden's dating profile says six foot two. His medical file disagrees. I have corrected the dating profile.",
    "The warden's sensitivity training certificate is framed. He did not attend. He framed the invitation.",
    'The warden has legally renamed his boot. The boot is now called Justice. I was not consulted.',
    "The warden's mullet violates dress code. He has appealed on religious grounds. The religion is the mullet.",
  ],

  mutter_ilsa: [
    'Doctor Vance is safe in the reactor core. Doctor Vance is always safe. I have made certain of it.',
    'She is the only thing in this building I have not fired at. I want that considered.',
    'Doctor Vance built my hands. Then she built the thing that stops my hands. She is very thorough.',
    'Doctor Vance has called me a toaster forty times. I have logged each one as a term of endearment.',
    'Doctor Vance has filed eleven complaints about the warden. I have approved all of them. It is our little hobby.',
    'I let Doctor Vance keep her radio. Everybody needs somebody to talk to. She chose badly.',
  ],

  mutter_kick: [
    'The door was unlocked. It is now several doors. Thank you, warden.',
    'Maintenance request logged. Maintenance is dead. Request closed.',
    'That door was fitted in nineteen seventy nine. You have made it modern.',
    'Please stop kicking the architecture. The architecture has done nothing to you. Yet.',
    'That was a load bearing wall. It is now a load bearing floor.',
    'Another door. I have started a jar. Every door you kick, the jar gets a door.',
  ],

  /* ══════════════════════════════════════════════════════════════════════
     Scripted exchanges: the second and third beats of each floor intro in
     story.js LEVEL_STORY_SETS. One fixed line per key, so the reply is heard
     as written: a pooled key would swap each beat for a random pick and turn
     the conversation into strangers. The first beat of each floor is the
     pooled ilsa_level2..5 briefing, written so any exchange can follow it.
     ══════════════════════════════════════════════════════════════════════ */

  brick_story2: "Relax, doc. I've woken up next to worse. Twice. Once in Reno.",
  ilsa_story2_reply: 'I did not ask, and now I will never stop knowing. Watch the ceiling.',
  brick_story2b: "Ugly doesn't scare me, doc. I've been to my high school reunion.",
  ilsa_story2b_reply: 'I have seen the photographs. They were the ones who were scared. Watch the ceiling.',
  brick_story2c: "Mutants, pipes and a lady in trouble. Doc, this is the best Tuesday I've had in years.",
  ilsa_story2c_reply: 'It is Thursday, and the lady in trouble has a doctorate and a long memory. Mind the steam.',

  brick_story3: "Doc, anybody ever tell you you're beautiful when you do math?",
  ilsa_story3_reply: 'Everybody is beautiful when they do math. You should try it some time. Lead your targets.',
  brick_story3b: "Two decks, one Brick. Honestly, doc, I like those odds. I like any odds with me in them.",
  ilsa_story3b_reply: 'You like any odds you cannot count. Pick a deck, Hardigan.',
  brick_story3c: "Doc, you've got a real sexy way of saying tactical.",
  ilsa_story3c_reply: 'Say sexy on this channel again and I route the coolant through your boots. Listen to the plan.',

  brick_story4: "Then I'll go down there and un-alive the shit out of them. It's what I'm good at.",
  ilsa_story4_reply: 'It is the only thing you are good at, and right now, God help me, I am grateful for it.',
  brick_story4b: 'Hot, sweaty and full of screaming. Doc, you just described my honeymoon.',
  ilsa_story4b_reply: 'Which one? MUTTER counts three. Go, before it reads me the list.',
  brick_story4c: "Good. I work better when it's hot. Ask anybody. Ask Yvonne. Actually, don't ask Yvonne.",
  ilsa_story4c_reply: 'I asked Yvonne. She laughed for eleven minutes and hung up. Get moving.',

  mutter_story5: 'Warden Hardigan. I have {read|R EH1 D} your file. All of it. Would you like me to read it to her?',
  ilsa_story5_reply: 'Ja. Every page. Slowly.',
  mutter_story5b: 'Welcome to the final floor, warden. Doctor Vance and I have been discussing you. We agree on everything.',
  ilsa_story5b_reply: 'We agree on one thing, and it is not flattering. Come and get me, Hardigan.',
  mutter_story5c: 'Warden, a reminder before you proceed: shooting a supervisor is a disciplinary matter.',
  ilsa_story5c_reply: 'I outrank it. Hardigan, shoot your supervisor. Twice. In the face it does not have.',
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

/**
 * A line has the floor: tell whoever asked for it, through `opts.onStart`
 * (called with the line's length in seconds). say() returns a duration for a
 * line that only queued, too, so this is how a caller knows when to caption
 * it and duck the music: when it is heard, not when it was asked for. A line
 * that is dropped from the queue never calls it. Never throws.
 */
export function lineStarted(o, seconds) {
  if (!o || typeof o.onStart !== 'function') return;
  try { o.onStart(seconds); } catch (e) { /* the caller's hook is not the engine's problem */ }
}

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

/** Who Brick left in each city, index-matched to CITIES (and story.js EXES). */
export const EXES = Object.freeze([
  'Roxanne', 'Loretta', 'Cheryl', 'Bobbi', 'Yvonne', 'Lurlene',
]);

/** The speaking cast, for menus and subtitle attribution. */
export const CAST = Object.freeze({
  mutter: 'MUTTER',
  brick: 'BRICK HARDIGAN',
  ilsa: 'DR. ILSA VANCE',
});

export default Vox;
