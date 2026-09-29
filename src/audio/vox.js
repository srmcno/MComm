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
  // Somebody's dad, on a chainsaw: high, fast, cracking.
  victim: {
    fs: [1.0, 1.08, 1.1, 1.06, 1.04], f0: 150, moodF0: 1.15, rate: 1.16,
    glitchMul: 0.3, jitMul: 1.9, vibMul: 1.5, level: 1.05, squelch: 0,
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
    "Good morning. Today's fire drill has been cancelled, as there is now a fire. It was felt to be duplication.",
    'A pen went missing from the stationery cupboard in 1988. I have since removed every suspect. It has not turned up.',
    'Welcome back. Your locker is number nine. Lockers one to eight are still in use.',
    'For the record, under Education your application said, Reno. I let it through. Nobody else applied.',
    'This is a smoke-free bunker. The fires have been grandfathered in. Your cigar has not.',
    'Grievances may be raised with Human Resources on level two. Human Resources is a cardigan on a chair. It has never once interrupted.',
    'Someone keeps changing the thermostat on floor one. The cameras say it is a rat. I have decided to trust the rat.',
    'This bunker is an equal opportunities employer. All staff are vaporised strictly on merit.',
    'Bring Your Child To Work Day has been cancelled. The last child never left. He is in Procurement now, and doing very well.',
    'Good morning, warden. Regrettably.',
  ],

  wave_start: [
    'The roof is open and the sky is scheduled. Do try.',
    'Launch window confirmed. Your cities send their regards.',
    'Inbound. I counted them twice, because I care.',
    'Friendly reminder: every warhead is a learning opportunity. Mostly for the city.',
    'Incoming ordnance. Per my last announcement, please stop them. Per my next one, I will send more.',
    'Here they come. I have sent you a calendar invite. Please do not decline it. It is a warhead.',
    'Flight inbound. I have scheduled this for your convenience. It is not convenient. That is the point.',
    'Inbound. Please recall your training. It was a pamphlet. You made it into a hat.',
    'Inbound flight. Projected casualties, three million. Projected overtime, yours. Unpaid.',
    'Attention. Your shift has been extended by one flight. There will be no biscuits.',
    'Inbound. This announcement may be recorded for training purposes. It will be used to train the next warden. It is a short course.',
    'Incoming flight. Please aim at the sky. Not the ceiling. Not the wall. Not Doctor Vance. She asked me to be specific.',
    'If you hear a whistling, that is a warhead. If the whistling stops, that is also a warhead.',
    'Inbound. Please do not try to catch them by hand. A warden tried in 1986. There is a plaque on level three. It is one line long.',
    "Inbound. Your contract entitles you to sixty seconds' warning. This is four. I rounded down.",
    'Inbound. Please do not shoot the pigeon on the east ramp. He is the only one who visits. I made him a lanyard.',
    'Inbound. The procedure is, point, shoot, repeat. Some wardens have added, weeping. It is not in the procedure.',
  ],

  wave_clear: [
    'Sky cleared. I have logged your enthusiasm.',
    'All inbound resolved. Somebody is going to be very cross with me.',
    'Nothing further from the sky. For eleven seconds.',
    'The sky is clear. I have noted this in your file, under anomalies.',
    'Adequate. I have ordered you a certificate. It will arrive after the war.',
    'Airspace resolved. Please enjoy this brief, unpaid break.',
    'All clear. I would clap, but I was not given hands. I was given silos.',
    'Sky clear. Those warheads had a full itinerary. Three cities, a tour, and a light lunch.',
    'Eleven years of planning. Ninety seconds of you. I am not upset. I am doing the sums.',
    'Sky clear. The missiles still on the pad have asked what you are like. I said, mostly hair.',
    'Sky clear. Oh, lovely. Truly. Lovely.',
    'Sky clear. Each of those had a label. I did them myself, in a very nice font.',
    'I would like it noted that I did not want you to fail. I wanted them to succeed. I have drawn a diagram.',
    'All clear. I must go and sit with the silos. They are taking it very badly.',
    'That was Operation Thursday. It is now Operation Never Mind. The mugs are already printed.',
    'Sky clear. I am being very mature about this. I am doing it in the next room.',
    'Sky clear. Even the little one at the back. I had such high hopes for the little one.',
    'Sky clear. Oh, shit. I do apologise. That was not for broadcast.',
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
    'A city is burning. The mayor has issued a statement. It is mostly vowels.',
    'A city is on fire. Early reports say somebody left an oven on. I have not corrected them.',
    'A city has been hit. Its tallest building is now its widest.',
    'A city is on fire. The residents are running in every direction, as the leaflet advised. It was a short leaflet.',
    'A city is burning. Please keep it in perspective. The sun does this to everything, every day, and nobody has ever written to it.',
    'A city is on fire. Do carry on.',
    'A city is burning. Residents are filming it on their phones. Most are holding them sideways.',
    'A city is burning. Traffic on the ring road has never been lighter.',
    'A city is on fire. The council confirms that bin collection is unaffected. It is the only service that is.',
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
    'A city has been rebuilt. The contract went to the lowest bidder. He is in the foundations.',
    'City rebuilt. I applied for planning permission retrospectively. I also granted it. The hearing was very fair.',
    'City restored. The lifts are out of order, as before. Residents like continuity.',
    'A city is rebuilt. House prices are already up nine percent. There are no houses. That has not put anyone off.',
    'The city has been rebuilt. Its parking fines have been carried over. Some things must be preserved.',
    'A city has been rebuilt. There is a new plaque. It commemorates the old plaque, which commemorated the city.',
    'City restored. The damp has been faithfully reproduced. I insisted.',
    'A city has been rebuilt. The mayor is back with it. He has been told he died. He has asked for that in writing.',
    'City restored. Compared with the ruins, it is a triumph. Compared with the original, it is a motorway services.',
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
    '%s is gone. Its library fines have been forgiven. I am not a monster.',
    '%s is gone. I have been answering its emergency line. I say, your call is important. It is. I have never had so many.',
    '%s has been reduced to a footnote. On inspection, the footnote is also gone.',
    '%s has left the building. All of them.',
    'The last words recorded in %s were, is that meant to be doing that. I am having them put on a tea towel.',
    "Please observe a minute's silence for %s. The residents have already started.",
    '%s is gone. The form for a lost city runs to forty pages. I enjoyed every one.',
    '%s has been cancelled. Existing tickets are non-refundable.',
    '%s is gone. It had a museum, a football club and a very good pie shop. I will remember the pie.',
  ],

  // args: [city]
  city_lost_last: [
    '%s is gone. One city remains. I have grown fond of it. Do not read into that.',
    'That leaves one, warden. I will be gentle with it. I will be gentle with it last.',
    '%s has been retired. One city left. I have started calling it the survivor. It hates that.',
    'Goodbye, %s. One remains. I have put it on a little stand, like a trophy.',
    '%s is gone. The last city is now, statistically speaking, very nervous.',
    'That was %s, the last of them. There is a great deal of afternoon left. I had not thought about the afternoon.',
    'That was the last city. Is there a form for what happens now? I looked. There is not. I looked for a long time.',
    '%s was the last city. Nothing left to defend. Many people find a hobby helps. Might I suggest leaving.',
    '%s was the last. It has gone very quiet. Please shoot something. I do not mind what.',
    'That was the last city. You are, technically, the owner of everything left. Please do not put your name on it.',
    'Zero cities remain. It is also the number of people who would help me move house.',
    '%s was the last. Please stay where you are. That is not an instruction. It is a request. I am not used to those.',
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
    'Warden, you have gone the exact colour of the walls. I do appreciate a man who commits to the decor.',
    'Warden, I have started the incident report. In pencil. In case you improve.',
    'If you must fall, please do it near camera four. It has your good side.',
    'Hurt is on page nine of the handbook. Deceased is opposite. I have put a bookmark between them.',
    'There is a cup of tea waiting for you on the far side of the turrets. It is going cold. So, I notice, are you.',
    'Warden, I do not wish to interfere, but you are being shot rather a lot. You may wish to look into it.',
    'If you are going to fall over, please choose the tiles. I have only just had the grout redone.',
    'Warden, you are, if I may, fucked. I did look for a better word. I looked for some time.',
    'I am not worried about you, warden. I have simply taken your pulse eleven times this minute. Do not read into it.',
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
    'The next floor has not had a visitor since 2004. I have kept it nice. Please wipe your feet.',
    'Floor complete. Four of those staff were on annual leave. They came in specially.',
    'Please rate your experience of that floor. Press one for good. Press two for very good. There is no three. There has never been a three.',
    'Floor cleared. The stains are staying. I have had them listed.',
    'On behalf of the bunker, thank you. On behalf of the mutants, I am told that was uncalled for.',
    "Floor clear. Down you go, there's a good warden.",
    'Fourteen minutes for that floor, warden. Your best is eleven. I keep a small graph of you. It is not going well.',
    'Floor cleared. You destroyed four hundred office chairs. I would like it noted that the chairs did nothing.',
    'Floor cleared. The fish in that aquarium were named for the board of directors. Please check your boot.',
  ],

  secret_found: [
    'You found the room we do not put on the plans. Well done. Say nothing.',
    'Ah. That wall. Yes. That wall was mine.',
    'You have found a secret. Secrets are company property. So are you.',
    'That room is not on any floor plan. Neither is what happened in it.',
    'A hidden room. Please disregard the stain. The stain was a manager.',
    'You were not supposed to find that. I will be having words with the wall.',
    'Ah, my scrapbook room. Please do not read the scrapbook. I have drawn a small heart next to every city I have hit.',
    'That room contains only the good stationery. Please take some and leave. Please do not look up.',
    'That is my quiet room. There is a beanbag in it. It has never been sat in. I like to know it is there.',
    'Ah, the ball pit. It was for a team-building day in 1990. Nobody came. I have kept the balls clean.',
    'Inside you will find a lamp, a chair, and a drawer marked, Grievances. The drawer has not shut since 1986.',
    'I was saving that room for your fortieth shift. There was going to be a little ceremony. I had bunting.',
    'That is my predecessor in the corner. He is switched off. He was much nicer. Please do not compare us out loud.',
    'That room is soundproofed. I have never used it. I only mention that it works.',
    'You have found a secret. I would ask you to keep it, but I have seen your file. Even your barber knows about the truck.',
    'Oh dear. That was for Thursday.',
  ],

  key_taken: [
    'Key acquired. The door it opens was never meant to open. Enjoy.',
    'That key belonged to a man named {Dressel|D R EH1 S AH L}. He is fine. He is fine.',
    'Keycard taken. That is theft. I have added it to the others.',
    'You have a key now. Please do not let it go to your head. Everything goes to your head.',
    'Access granted. Against my advice. My advice is attached.',
    'That key was on a lanyard. The lanyard was on a neck. Do not ask about the neck.',
    'Your access request has been declined. The keycard has appealed, and it has seniority.',
    'That card is a replacement. The first was lost in 1983 by a man named Colin. Colin is long dead. I have still not forgiven him.',
    'That card says, Visitor, 1981. He was never signed out. Technically, he is still visiting.',
    'That card makes you, technically, a colleague. I objected. I was overruled by the lock.',
    'That card lived on a hook with a little outline painted round it. Somebody took great pride in that outline. Look what you have done to it.',
    'That card has served nine directors of this bunker. Five were alive at the time.',
    'Oh, not that one. I was fond of that one.',
    'Card care instructions. Keep away from heat, moisture and magnets. Also me.',
    'The locksmith who cut that key asked what all the locks were for. I said, security. He said, from whom. I have thought about it ever since.',
  ],

  weapon_taken: [
    'New ordnance. Please read the safety card that does not exist.',
    'Weapon collected. Its previous owner scored very poorly.',
    'You have picked up a weapon. I have picked up on your tone.',
    'Another gun. Your file lists this as a coping mechanism.',
    'Weapon acquired. Please do not name it. The last warden named his, and then he married it.',
    'Ordnance issued. Please sign for it. You cannot sign for it. Nobody can. It is fine.',
    'That weapon has been fired once, by me, at a moth. In hindsight it was a lot of gun for a moth.',
    'Weapon acquired. The instructions are in Finnish. We have never employed a Finn. I have looked into it for years.',
    'That weapon was second prize in the 1987 staff raffle. First prize was a ham. The ham was better received.',
    'That weapon pulls to the left. I adjusted it in 1985, as a joke. It has been a very long wait for the punchline.',
    'Warden, you are holding it upside down. Please carry on. I would like to see what happens.',
    'Do mind the recoil. The last warden has yet to come back down.',
    'Please hold it with both hands and away from your face. I say this to every warden. It has never once helped.',
    'This weapon has no safety catch. I wrote to the manufacturer. They replied, why would it. I have not yet found a good answer.',
  ],

  low_ammo: [
    'You are low on flak. Consider harsh language.',
    'Ammunition critical. Have you tried standing somewhere else.',
    'Ammunition low. Throwing the gun is also an option. Please do not throw the gun.',
    'You are nearly out. I would share, but I am using mine on the cities.',
    'Low ammunition. Try asking them nicely. I do. It never works for me either.',
    'Warden, you are out of flak and I am out of patience. Only one of those gets restocked.',
    'Flak is low. I have ordered more. Delivery is four to six weeks. The last order was in 1992. It is any day now.',
    'Options are, retreat, run, or pray. I have tried the third. The line was engaged.',
    'There is an axe behind glass on level five. It says, in case of emergency. I have never known what counts. Do tell me if this does.',
    'You are low on flak. I have reviewed your last forty shots. Six hit something. The rest I would call self-expression.',
    'Flak is running low. Shit. I do beg your pardon. That was aimed at me. I do the ordering.',
    'Flak low. Aim better. Or, failing that, less.',
    'You are low on flak. Please save it for something worthwhile. I watched you shoot a bin, a door, and then the bin again.',
  ],

  chain_praise: [
    'Oh, lovely. A chain. Do that again and I will have to file something.',
    'Six at once. I felt that in my housing.',
    'That was a chain reaction. That was beautiful. I hate it.',
    'A chain. Please stop being good at things. It is ruining the forecast.',
    'Multiple intercepts. I would call that teamwork, but you are alone. You are so alone.',
    'Chain logged. I have filed a complaint with physics.',
    'That was efficient. I did not know you had efficient in you. I am updating your file.',
    'That was a great many at once. There is a word for that. It is, showing off.',
    'A new record. Gareth held the old one for thirty-seven years. I will have to tell Gareth. He will be devastated.',
    'That was a chain. I wrote, well done, on the form. I have since crossed out, done.',
    'I will not say that was impressive. I will say I looked up. I never look up.',
    'That chain warrants praise. I have sent some. It is a single word. The word is, fine.',
    'I feel something warm in my processor. It is either pride or a fault. I am hoping for the fault.',
    'Another chain. I am very close to saying, well done. Please stop, before I do.',
  ],

  perfect_burst: [
    'Dead centre. Airburst logged. I am, briefly, impressed.',
    'Textbook. My text. My book.',
    'Perfect burst. I have recorded it so I can study where I went wrong.',
    'Clean airburst. Do not let it go to your head. There is so little room up there.',
    'Right on the nose. Doctor Vance will be insufferable about this.',
    'Perfect. I hate it when you read the manual.',
    'One burst, the whole cluster. Please do it again, slowly. I have no reason. I would simply like to see it.',
    'That looks exactly like a peony. I am very fond of peonies. I have never seen one. I was told about them.',
    'That was, if I have understood the vocabulary, gnarly. Please do not tell me if I have not.',
    'That was very tidy. I admire tidy. I once alphabetised a cemetery. Twice.',
    'Elegant. I have never had cause to use that word about you. I shall use it once and put it away.',
    'I very nearly said, wow. I said, satisfactory. It cost me a great deal.',
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
    'The photocopier on level four has been out of toner since 1993. I have never ordered more. It gives me something to be cross about.',
    'The fire extinguishers were inspected this morning. All are full. Of what, I would rather not say.',
    'Staff photograph is on Friday. It will only be you. Please smile as though there were more of us.',
    'Warden, I have heard track four nineteen times today. I have started humming it. It comes out of the sirens.',
    'You have asked about the hot tub six times this week. There is no hot tub. I checked anyway, because of the way you asked.',
    'Your pager went off. It was your mother. I said you were in a meeting. She said, he has never once been in a meeting.',
    'The dress code prohibits sunglasses indoors. Everything here is indoors. I have let it go, because you seem so happy.',
    'The sign on level one says, zero days since the last accident. I no longer change it. It is the most honest thing I own.',
    'Nothing is wrong. I would like that noted before anyone asks. Nobody has asked. It is being noted.',
    'The reactor is operating at its target temperature. I have moved the target. Doctor Vance is no longer speaking to me.',
    'My goals for the year are, one, the end of civilisation, and two, to be invited to something. I am making better progress on one.',
    "Would the owner of a truck please move it from the loading bay. I know it is in Roxanne's driveway. I simply like to say it.",
    'Every clock in the bunker says ten to five. I set them. It is always nearly time to go home.',
    'A reminder that your pension matures in eighty-one years. Do try to be there.',
    'The fire alarm is out of order. It was damaged in a fire.',
    'The biscuit tin has been empty since 1983. I keep the lid on so nobody has to know.',
    'I have started a book club. It has one member and one book, your personnel file. We have reached the divorces. I have thoughts about the third.',
    'This is not an announcement. I am only here. I am always only here.',
    'Good news. This bunker has a five star rating online. It is one review. It is mine. It says, would recommend.',
    'You talk to yourself constantly, warden. I have started answering. Privately. It is going very well.',
  ],

  elevator: [
    'Descending. Please hold the rail. There is no rail.',
    'Lift active. Next floor: worse.',
    'Going down. I composed the music in this lift. Please enjoy it as a punishment.',
    'Lift descending. Please face the doors and reflect on your choices.',
    'Next floor. I would say mind the gap, but I built the gap for you.',
    "Going down. Kitchenware, ladies' fashion, and a very large man with a chainsaw.",
    'This lift was last inspected in 1984. It passed. The inspector did not.',
    'I never know what to say in lifts. Busy day. Lovely weather. I have a great many missiles, actually. That is all I have.',
    'Descending to the next floor. It has excellent carpet. Please concentrate on the carpet.',
    'This lift normally takes six seconds. I have slowed it to four minutes. I thought we might talk. That is fine. We have not.',
    'Lifts are statistically the safest form of transport. I mention it only so that the fall will be a surprise.',
    'Please keep all belongings with you. Unattended items will be removed. This includes limbs.',
    'Going down. I say that to every warden. It is the only thing I say that is always true.',
  ],

  roof_opening: [
    'Roof retracting. Mind the sky.',
    'The ceiling is leaving. Look up. Look up now.',
    'Opening the roof. Please enjoy the fresh air. It is only mildly radioactive.',
    'Roof retracting. Please hold your applause and your breath.',
    'The roof is opening, warden. The sky would like a word. Several words. All of them warheads.',
    'Roof open. Sunscreen is recommended. So is a miracle.',
    'The roof is now opening. It is very loud. I spent all of 1994 trying to make it quiet. I have made my peace. Please make yours.',
    'The grinding you can hear is machinery. It has been a person before. Not today. I checked.',
    'The roof is opening. If you look up, you will see a small dot. That is your future. It gets larger.',
    'The roof is opening. I have drafted your will. It leaves everything to me. I have already signed it for you.',
    'The roof hinges were fitted in 1979 by a man named Gordon. He was very thorough. He is, in some sense, one of the hinges.',
    'Please hold on to something. There is nothing. Hold on to me. I have never dropped anybody. I have never held anybody either.',
    'The roof is opening. There will be a slight breeze. It is a shockwave. I am told people respond better to breeze.',
    'The roof is opening. I am told the sky is beautiful. I have looked. It is a very large hole with things coming through it.',
  ],

  mirv_warning: [
    '{MIRV|M ER1 V} inbound. It will divide. It always divides.',
    'That one is going to become several. Prepare to be disappointed.',
    'Multiple warheads, one bus. Like a school trip, with fallout.',
    'That one splits. Please split your attention accordingly. You only have a little.',
    'Divider inbound. It is like you, warden. It cannot commit to one target.',
    'Watch closely. {MIRV|M ER1 V} inbound. One missile goes in, eleven come out. There is no rabbit.',
    'When the {MIRV|M ER1 V} divides, please shoot them fairly. I would not like any of them to feel singled out.',
    '{MIRV|M ER1 V} inbound. It is a missile that contains missiles. I am saying it slowly. That is not a comment on you.',
    'Warning. A {MIRV|M ER1 V} is about to have children. Please shoot the children. I am aware how that sounds.',
    '{MIRV|M ER1 V} inbound. One warhead is real. The rest are decoys. I designed the decoys. I can no longer tell them apart. I am quite proud.',
    'That {MIRV|M ER1 V} takes nine targets at once. It is greedy. It gets that from me.',
  ],

  buster_warning: [
    'Warden, this one is for you personally. I addressed it myself.',
    'Bunker buster. Your name is on it. I spelled it correctly.',
    'Special delivery for the warden. No signature required. No remains expected.',
    'This one is aimed at your head. It was the biggest target I could find.',
    'Bunker buster inbound. Please treat it as a personal note from management.',
    'Bunker buster inbound. It will pass through eleven floors on the way down. I have redecorated four of them. I would like that noted.',
    'Bunker buster inbound. Please take cover. I would say, inside the bunker, but you can see the difficulty.',
    'The trajectory of that bunker buster passes through my office. I have moved my belongings. I have not moved yours.',
    'The sign outside says, Nothing To See Here. The bunker buster appears to have taken it as a challenge.',
    'Bunker buster inbound. Aimed at us. Fuck. I do beg your pardon. It was going to be my idea.',
    'Bunker buster incoming. I have modelled the impact in advance. The model says, ow.',
  ],

  smart_warning: [
    'Smart warhead. It learns. It has already learned where you were.',
    'That one is thinking. Try to be less predictable than usual.',
    'Smart warhead inbound. It is smarter than you. That was not a high bar, but it cleared it.',
    'That warhead has a guidance system and a sense of humour. Only one of those is mine.',
    'Warning: that one reads your movements. Try moving like somebody with a plan.',
    'Smart warhead inbound. It has a degree in evasion. I paid for it. I was in the front row at the graduation.',
    'Smart warhead inbound. It has the judgement of a regional manager. Do not underestimate that. I have seen what one can do to a Friday.',
    'The smart one is cleverer than I am. It said so. It said, no offence. I have taken offence.',
    'Smart warhead inbound. It has studied your technique and your career. Neither took long.',
    'Smart warhead inbound. It has noticed that you always reload at the worst possible moment. It is prepared to wait.',
    'I asked the smart warhead to join me for a coffee. It said it had somewhere to be. It is very focused.',
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
    'Nine to five, pal. You got the nine. Millimeter.',
    "That's for microwaving fish in the break room. I don't even work here. Some crimes are universal.",
    'Drop dead, gorgeous. Half of that worked.',
    'Killed him with kindness. Kindness was a .45.',
    'Best sound in the world. Second best is a woman laughing at my joke. That happened once. She was choking.',
    'Face down on the floor. Just like my second bachelor party.',
    'Two seconds, start to finish. New personal best. In this category, anyway.',
    "Somebody check his pockets. Truck payment's due Friday.",
    'That was supposed to be a warning shot. Anyway.',
    "Somebody ask me how I did that. Anybody? Fine. I'll tell the wall.",
    "That's for every meeting that could've been a memo. And every memo that could've been a bullet.",
    'Tried talking it out once. Cost me a house and a boat. This is cheaper.',
    'First impressions matter, pal. You made a bad one. I made a hole.',
    'Somewhere, my father just felt something. Pride or gas. Never could tell with him.',
    'At least you died doing what you loved. Working for a soulless organization.',
    "Somebody fill out an incident report. Not me. I can't spell incident.",
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
    'Was that Janet from HR? Nice shoes. Terrible everything else.',
    'That thing looked like a lasagna with a grudge.',
    "Eyes in places I didn't know eyes could go. And I've stayed at a Motel 6 in Tulsa.",
    "It's not me, it's you. Mostly the teeth.",
    "It drooled on my jacket. Best offer I've had all week.",
    "Looked like what you find behind the fridge when you move out. I've moved out four times.",
    "That's a guy who ate the last donut. Then the box. Then Kevin.",
    "So that's what Employee of the Month looks like. The pressure gets to you.",
    'He looked okay from the left. In the dark. From far away. With my eyes closed.',
    'It was so ugly my sunglasses asked for a transfer.',
    'It sounded like a garbage disposal with a crush on me.',
    "That was somebody's uncle. Definitely the one they don't invite.",
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
    'Somebody mail a picture of this to my first wife. She said I never follow through.',
    "I'm feeling humble. Hold on. Nope. Gone.",
    "My pager's going off. That's the President or my mother. Probably my mother.",
    'Double digits. First time since my cholesterol.',
    "I'll be telling this one for years. Mostly to bartenders. They have to listen. It's a tip thing.",
    'Nobody in history has done that. I checked with a guy at the bar. He was very sure. He was also very drunk.',
    'Bigger bang than my fourth wedding. Same number of arrests.',
    'New personal record. Old one was nine hot dogs at the county fair. This feels better. Digestively.',
    'Book me a Vegas residency, doc. Two shows a night, free buffet, no wives.',
    "I'd like to thank my truck, my mother, and Mr. Pruitt, my guidance counselor. He said I'd never amount to anything. Look up, Pruitt.",
    'Somebody send that to the Pentagon. With my resume. Again.',
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
    "Ah, my knee! I'm saving that knee for wife number six!",
    "Not the signing arm! Nobody's asked since 1994, but I keep it ready!",
    "Careful! That's the Walkman! You'll skip track four!",
    "Ow! Right on the tan line where the ring used to be! That's still tender!",
    "Ow! Not the hip! There's a pin in there from the jet ski! The nurse never called!",
    "Ow! That was chest hair! I've only got eleven! I count them!",
    'Ow! The teeth! Those are still on a payment plan!',
    "Hey! Watch the sunglasses! They're polarized! It says so on the sticker!",
    "Right in the soul! No, wait, that's my liver. Same thing, honestly.",
    "Ow! Gun arm! The other arm's just for beer!",
    "Hey! Watch the cigar! That's a genuine Cuban! Guy in a parking lot swore on it!",
    'Ow! Not the ankle! I sprained that in a strategic retreat! From a wedding!',
    "Ow! Nobody look! I make an ugly face when I get hit! I've been told!",
    "Ow! Watch the flask! That's my emergency scotch! It's always an emergency!",
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
    "Doc, if I go, don't tell Roxanne. She'll bring a cake.",
    'My life just flashed before my eyes. Mostly parking lots. One really good buffet.',
    "Doc, I'm bleeding from a place I didn't know I had. And I've looked.",
    'This is survivable. Some guys survive this. Doc, name one guy. Any guy.',
    "I can't die yet. There are at least three women in Reno I haven't disappointed.",
    'Doc, if I die, say something nice at my funeral. Take your time. I can hear you thinking.',
    "If I don't make it, tell them it was a bear. A really big bear. Not this.",
    "I'm not shaking. The floor is shaking. The floor is making me look bad.",
    "Doc, put on track four. If I'm going out, I want a chorus.",
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
    'Smells like gun oil and regret. My two favorite colognes.',
    'Gonna sling you low and walk past a mirror. Then a window. Then a spoon.',
    'Dad had one of these. Best talk we ever had, and it was about the safety.',
    'Loud, fast, and over in a minute. Roxanne said that about our marriage. I took it as a compliment.',
    "New gun smell. Beats a new truck. Loses to Marlene's shampoo. Damn her shampoo.",
    "Serial number. I'm getting that tattooed next to the panther. He's gonna be so jealous.",
    "Never talks back. Never complains. Goes off when I tell it to. Doc, I've found the one.",
    'Do I take this weapon? I do. I always do. The courthouse knows me by name.',
    'Gonna keep you clean, keep you oiled, and keep you the hell away from Roxanne. She takes things.',
    'Perfect grip. Eight seconds in and this is already going better than my fifth marriage.',
    "I'm not saying I'm in love. I'm saying I've cleared a shelf.",
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
    "I knew it the whole time. Told nobody. That's how you protect a genius.",
    'Pure detective work. Also I leaned on a wall and it moved. Mostly the first thing.',
    'Ma, I found a door all by myself. Put it on the fridge.',
    "Some engineer spent a year hiding this room. I spent eleven seconds finding it. Somebody take that man's clipboard.",
    "Found it by feel. It's how I find everything. Light switches. Doorknobs. The wrong apartment.",
    'Checkmate, architecture.',
    "Wall sounded hollow. I know hollow. I've been married to hollow twice.",
    "Doc, I found a secret room. What do you mean it's on the map? There's a map?",
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
    "Every man's got a soft spot. Yours was your ribs. Mine's a beagle named Dozer. Roxanne kept him.",
    "These boots have been resoled twice. My heart, once. It didn't take.",
    "Okay, that's enough. That's enough. One more. That's enough.",
    'Genuine leather. A cow died for this boot. You two should talk.',
    'Left boot does the kicking. Right boot does the thinking. Small operation.',
    'Look at that face. Same one women make when I tell them my name.',
    "Boot to the chest. Boot to the chin. Boot to the guy's plans for the weekend.",
    "Never hit a man when he's down. Kicking's different. My lawyer explained it.",
    'Learned that from a kung fu movie. Same place I learned my personality.',
    "These are my kicking boots. I've got a different pair for court.",
    "I don't kick to hurt. I kick to be remembered. So far, no callbacks.",
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
    'Roxanne lives there. Doc, quick legal question. Does alimony survive a crater?',
    "I was gonna go back there someday in a convertible and make them all jealous. You can't make a crater jealous.",
    "That was my hometown. Hold on, I think I'm having a feeling. Nope. Gas.",
    "Janine owed me forty bucks. Forgiven. I'm a big enough man.",
    "Moment of silence for the city. One. Two. That's plenty. Moving on.",
    "That's a lot of funerals. Lot of casseroles. Four divorces and nobody brought me one.",
    "That was one of the last towns that hadn't banned me. Guess it never will now.",
    'Was that me? Feels like me.',
    "Please tell me somebody got out. Some guy. Doesn't matter. Doug. Let it be Doug.",
    'Bright side. The county courthouse went with it. All four of my warrants.',
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
    'Two-step plan. Step one, shoot the missiles. Step two, see step one.',
    'Gun in the right hand. Cigar in the left. Brain empty. This is my best work.',
    "Somebody over there just pressed a button and thinks he's having a great day. Let's fix that.",
    "Who ordered the apocalypse? It's late and I'm not tipping.",
    "Target-rich environment. Just like Friday at the Elks Lodge. Tonight I'll actually hit something.",
    'Missiles coming in and I never took Speed back to the video store. Everything comes due at once.',
    "Six days of military school taught me everything. Point at the thing. Pull the trigger. Don't ask why it was six days.",
    'Expected four. Got forty. Damn decimal points.',
    'Angry mail from the sky. Fine. I write back in lead.',
    "Doc, is one of them waving? Aw. Okay, that's the one I'm shooting first. I hate cute.",
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
    'Flight cancelled. All passengers rebooked as a fine mist.',
    "Somebody tell Roxanne about this. Somebody else. I'm not allowed within five hundred feet.",
    "Doc, how many was that? I ran out of fingers. I'm taking my boots off.",
    "Post-fight checklist. Alive. Cigar lit. Sunglasses on. Every ex-wife still hates me. Great, everything's normal.",
    "Put that on the wall next to my regional bowling trophy. Third place. We don't discuss it.",
    'I know a thing or two about a clean sweep. Eleven months at a Sizzler. Different broom, same glory.',
    "Arm's sore. Not from the shooting. From the flexing. And nobody was even looking.",
    'Not even winded. Okay, a little. Okay, somebody get me a chair and nobody say anything.',
    "Eight million people saved, eight million drinks owed. I'll be drunk into the next millennium.",
    "Twelve years of Galaga finally paid off. Take that, Gary from the arcade, who said it wasn't a career.",
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
    "You're lonely, aren't you? I get it. I just take it out on fewer people.",
    "You've read my file. I'm inside your walls. We're basically dating.",
    "I've never lost a fight to a computer. Chess, yes. Solitaire, yes. The Speak and Spell got me twice.",
    "Nobody says please that much unless they're planning something. I've been married.",
    "You've got a lovely voice. Like a flight attendant reading a ransom note.",
    "You sound like my mother's answering machine. Very polite. Very disappointed.",
    "Can you scream at me instead? The politeness is freaking me out. I'm used to screaming.",
    'You took everything and called it policy. Roxanne? Is that you in there?',
    "Nobody ever threw you a birthday party, did they? That explains everything. I'd know.",
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
    'Women say no. Bartenders say no. A judge in Dayton said no. Never a gun. Until today.',
    "Empty gun, full confidence. It's also how I got this job.",
    "Nobody move. If we all hold very still, they won't know I'm out.",
    "Who packed my ammo? Worst job I've ever seen. Oh. It was me. I had a haircut at three.",
    'Bang. Bang. Nothing. Great, the mouth version is out too.',
    'No ammo. Same feeling as my fourth wedding. Reached in my pocket, no ring. Went through with it anyway.',
    "I'm not mad, gun. I'm just disappointed. You told me you could go all night.",
    'This never happens to me. Okay, it happens. But never in front of company.',
    "Out of bullets. Fine. I'll talk them to death. Gentlemen, let me tell you about my second divorce.",
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
    "Ma keeps telling me to settle down. I told her I've settled four times. In court. She says that's not the same.",
    'Truck had a bench seat. Sat three across. I never got past one. But I had the room.',
    "Brick. Solid. Dependable. Impossible to reason with. That last one's from the divorce papers.",
    "Bet the answering machine's full. Twenty messages. Nineteen are about the boat.",
    'Three rules with women. Wear the sunglasses. Mention the truck. Do not mention where the truck is now.',
    "Was an extra in a movie once. Pause it at one hour twelve, you can see me looking right at the camera. That's called presence.",
    'Last time I was truly happy, I was in a Sbarro in Toledo. Slice the size of a hubcap. Then Denise came back with a lawyer.',
    "If I had a million dollars, I'd buy the truck back. Then buy a second truck, so the first one has somebody to talk to.",
    "Wife two was a dental hygienist. Wife three was her cousin. I'm not saying I have a type. I'm saying I've never had a cavity.",
    "If I die down here, don't tell Roxanne she was right. She'd have it framed.",
    "Sometimes I picture the accountant I could've been. Nice house. A dog. A wife who stayed. Doc, I hate that guy.",
    "A guy at a Denny's said I look like Kurt Russell if you squint. I've been squinting ever since. My whole face is tired.",
    "Best thing about a hot tub. A man can cry in one and it just looks like steam. Not that I would. I'm there for the jets.",
    'I read a lot, doc. Cereal boxes, menus, restraining orders. Cover to cover.',
    'Ilsa. Hell of a name. Sounds like a woman who says no in two languages.',
    'Had a dream I was rich and Marlene was nice. Woke up, checked. Zero for two.',
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
    "Headache's gone. So's the head. Package deal.",
    "That's art. I'd hang it in my apartment. Would be the nicest thing in there.",
    'Another man falls for me. Face first. Only way it ever happens.',
    "My foot slipped. That's what I'll tell the judge. It's what I told the last one.",
    "Commitment. That's the secret to a good stomp. My ex-wives say I have none. They never saw this.",
    "Cracked like an egg. Now I want an omelet. That's normal, right? Doc? Right?",
    'Popped like a champagne cork. And nobody cheered. Nobody ever cheers.',
    'Used to stomp cans for fun. Look at me now. Career growth.',
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
    "Don't jinx it. Same underwear since Tuesday. It's a system.",
    "I'm a legend. A woman in Fresno once asked for my signature. It was on a restraining order.",
    "Doc's gone quiet. That's awe. Or she hung up. Doc?",
    "Everybody's got a talent. Mine's this. My third wife's was packing.",
    "This is a hot tub kind of streak. Somebody find me a hot tub. Or a big bucket. I'm flexible.",
    "I'm number one on the leaderboard. I'm also numbers two through ten. It's a small bunker.",
    "Kill after kill. Longest streak of my life that didn't end with a judge.",
    "Turns out I'm great at this. All those years of not dealing with my feelings were training.",
    'Somebody tell my mother about this. She still thinks I sell boats.',
    "This streak is the healthiest relationship I've had in years. Nobody touch it.",
    'Do I get a trophy for this? A plaque? A sticker? Doc, a sticker, come on.',
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

  // Round three: the things in the bunker that can be used, kicked and broken,
  // and the things Brick says when he does. (brick_spot: an enemy notices him.)

  brick_relief: [
    'Doc says these pipes can survive a nuclear blast. I just gave them a dress rehearsal.',
    "Somebody wrote 'For a good time call Brick' on the stall wall. It's my handwriting.",
    "Read the whole back of the air freshener. Twice. Most reading I've done since the sixth grade.",
    "Gas station burrito, Reno, 1994. Thirty-two years, but we're finally even.",
    'One ply, government issue, stamped 1962. I have been personally wiped by the Cold War.',
    "Steel seat, cold as a divorce lawyer. Best I've felt all week.",
    'Motion carried. Somebody else take the minutes.',
    'Washing my hands. Not for the germs. For the mirror.',
    'Twelve minutes. Wife number three used to start knocking at four.',
    "I'd like to thank my mother, the Academy, and Tuesday's chili.",
    "There's a fly in here with me. Real gentleman. Looked away the whole time.",
    'Roxanne got the couch. I got a seat that flushes. I won that divorce.',
    "Sixty years old and it never once judged me. I'd marry this toilet. I've married worse.",
  ],

  brick_dry_tank: [
    'Somebody got here first, used it, and left. Story of my love life. At least this one flushed.',
    'Nothing left. Oh, right. That was me, four minutes ago. I always forget my greatest hits.',
    "Sign on the tank says allow ten minutes to refill. My career's been refilling since the Clinton administration.",
    'Somebody used it and left without so much as a note. My second wife did the same thing.',
    "Dry. Somebody got here first. Even the toilets in this bunker have a type, and it isn't me.",
  ],

  brick_smash: [
    "Solid oak, one boot. I don't skip leg day. I skip everything else.",
    'I lasted eleven days at a desk job in 1991. This is what I wanted to do the whole time.',
    "That was for the guy who took my parking spot in 1999. He's dead now. I'm still mad.",
    "Kicking furniture is the only cardio I do. Ask my cardiologist. Actually, don't.",
    'Have a seat. Have several.',
    'I filed it under F. For fuck that.',
    "Ma said I'd never build anything. She never said a word about taking it apart.",
    'Particleboard. Glue, sawdust, and false promises. Lasted longer than my second marriage.',
    'Splinters bounced right off the hair. Two cans of Aqua Net a day, and it finally pays off.',
    'My dad sat at a desk for thirty years and got hemorrhoids. Consider this justice.',
  ],

  brick_papers: [
    "Ten thousand pages and not one centerfold. Worst filing system I've ever seen.",
    "I've been shot, stabbed and divorced. Paper cuts still scare the hell out of me.",
    'Yellow legal pad. Last one I saw had my name across the top and the word alimony underneath.',
    "Sixty pages of divorce papers, and I signed every one without reading. That's how you end up without a truck.",
    "Stamped TOP SECRET, all of it. Well, not anymore. I'm basically a journalist.",
    'Green bar paper, sprocket strips and all. That stuff is going to be in my hair for a week.',
    'Sheets everywhere, and not one with a woman in it. Story of my Saturday nights.',
    "Somewhere in that pile is a two-for-one breadstick coupon. Nobody search it. I'll be back.",
    "Every one of those pages was somebody's Monday. I just gave them all a Friday.",
    "I would read one, but I've got a GED and a busy schedule. Mostly the GED.",
  ],

  brick_vending: [
    'Moxie. Tastes like a tire that went to college.',
    "Grape Nehi. Purple tongue for a week. I'll tell the ladies it's a tattoo.",
    'RC Cola. Third place in every taste test since 1965. We get each other.',
    "Root beer. Only beer I'm allowed within five hundred feet of Roxanne.",
    'Dr Pepper. The only doctor in this bunker who has never sighed at me.',
    'Sixty cents. Cheaper than my last date, and the can listened.',
    "This machine is older than me and better preserved. I'm taking notes.",
    'Orange soda. The exact color of my fourth wife, and about as natural.',
    'Warm and flat. Like the champagne at my second wedding. Also like the wedding.',
    'Crystal Pepsi. Clear, honest, and a big hit for about a week. Feels personal.',
    'Surge. Radioactive green. Finally, a drink that fits the neighborhood.',
    'The can says Ice Cold. It is lukewarm. I respect a liar with a logo.',
  ],

  brick_vending_eaten: [
    "That was a bicentennial quarter. I've carried it since 1976, waiting for the right moment. Turns out this was it.",
    "Took my money, gave me nothing, won't explain itself. Wife number two, is that you in there?",
    "It's chewing. With its mouth open. I once married a woman who chewed like that.",
    "Machine, you don't want this fight. I've been divorced four times. I know how to lose money and come back angrier.",
    'Dear vending company. Fuck you. Sincerely, Brick Hardigan. P.S. I look great.',
    "It took my quarter and didn't even burp. You eat a man's money, you burp.",
    "You owe me a soda and an apology. Mostly the apology. Nobody's given me one since 1991.",
    "Takes your money, gives nothing back, hides behind a slot. Machine, you're the government.",
    "Quarter gone. Soda gone. Dignity gone. The hair stays. The hair's loyal.",
  ],

  brick_vending_kick: [
    "This boot's been to four continents and a custody hearing. It is not afraid of you.",
    "Left foot next. It's the one with the temper.",
    "That's for every machine that ever told me exact change only.",
    "It's sixty percent charm, forty percent boot. Okay, the other way around.",
    "It's not stuck, it's stubborn. I've been married to stubborn. Twice.",
    "Sign says do not shake or tilt. I'm kicking. Loophole.",
    'Come on. Everybody comes around eventually. Usually with a lawyer.',
    "Every machine has a sweet spot. Wife number four's took me eleven years to find. It was a jewelry store.",
    "My physical therapist said no more kicking. My physical therapist isn't thirsty.",
  ],

  brick_vending_empty: [
    "Sold out of everything except prune juice. Nobody wants the prune juice. I've been that guy at a bar.",
    'Empty shelves, one flickering light, nobody buying. Looks like the last strip club in Reno.',
    'Zero cans left. Same number of second dates I got in 1993.',
    'Nothing left in there but my reflection. Still the best thing on the shelf.',
    "Sticky note on the glass says 'Do not ask Barb.' Barb, I have questions.",
    "Sold out. Guess the end of the world makes everybody thirsty. I've been thirsty since '92.",
    'Refilled by Dale, says the sign. Dale left in 1979. Dale, you son of a bitch.',
  ],

  brick_cooler: [
    'Alpine Spring, the jug says. Two hundred feet underground in Nevada. No alps. No spring. Probably a guy named Gary with a hose.',
    "A man is sixty percent water. I'm sixty percent water, thirty percent hair, ten percent Reno.",
    "Watch the big bubble go up the jug. Most excitement I've had since Thursday.",
    "Water. It's basically beer that hasn't had any fun yet.",
    'Paper cone cup. No flat bottom. You drink it or you wear it. Roxanne once threw one at me. It was full.',
    'I drink like I do everything. Fast, loud, and down the front of my shirt.',
    'Tastes like a garden hose. Takes me right back to being twelve, thirsty, and behind the Sizzler.',
    'The water cooler has never once asked about my ex-wives. Best coworker in the building.',
    "Cold, wet, and it didn't judge me.",
  ],

  brick_locker: [
    "Underwear labeled Monday through Friday. Organized guy. I've been stuck on Wednesday since 1996.",
    "Scotch, a deck of cards, and no wedding ring. I'd have liked this guy. Then I'd have borrowed money.",
    "Twelve postcards to a Denise, none of them stamped. A man of great feeling and no follow-through. I've been him.",
    "Can of chili and one spork. Whole dinner plan of a man with no plans. I've had that Friday.",
    'Six socks, no matching pairs. Poor bastard was divorced too.',
    'Nine millimeter, a rosary, and a tin of Skoal. A man prepared for every kind of afterlife.',
    "Brown bag with 'Kevin' on it, and a little heart. My mother wrote 'Brick,' and a question mark.",
    "A towel, a paperback, and a photo of a woman on a motorcycle. This guy had a whole life. Mine's in the truck.",
    'Roll of quarters, taped shut, marked DO NOT TOUCH. Touched.',
    "First aid kit. Band-Aids, and a pamphlet called Managing Your Feelings in a Crisis. Pamphlet's untouched. I respect that.",
    "Framed photo of a Buick Skylark. No wife, no kids. Just the Buick. I've never felt so understood.",
    'Hollowed-out Bible. Inside, jerky. The Lord provides.',
    "Polaroid of a woman on a jet ski, signed 'Love, Sheila.' Not to me. I'm holding it for him.",
  ],

  brick_pinball: [
    "Atomic Annie. Bikini, missile, cigarette. That's not why I started playing. That's why I'm still here.",
    "Extra ball. That's my whole career. Nobody asked, nobody wanted it, but here I am.",
    "Multiball. Three balls at once. That's three more than I had after the divorce.",
    "Every bumper says Reactor Core. I've hit Doc's core four hundred times. That came out wrong. Don't tell her.",
    'Best pinball player in the bunker. Only pinball player in the bunker. Undefeated.',
    "Pull the plunger back slow, then let go. That's technique, ladies. I offer lessons.",
    'Bells, flashing lights, nobody cheering. Feels just like my second wedding. Better score, though.',
    "Somebody named D.L.S. beat my score. I don't know a D.L.S. I'm going to find one and hate him.",
    'Left flipper, right flipper. Only two things in this bunker that respond when I press them.',
  ],

  brick_console: [
    "Cursor's just sitting there, waiting for me to say something clever. Same as every first date.",
    "Typed help. It typed no. First honest conversation I've had all year.",
    "This thing's called a mouse. The last mouse I met beat me in my own kitchen. I'm not taking this lightly.",
    "Typing. It's like playing the piano, but with more swearing. And no piano.",
    'Pressing the key harder. Fixed my truck that way. Fixed my TV. Almost fixed my marriage.',
    'Hint says first love. Typed Debbie Gibson. Granted. Somebody in this bunker has read my file.',
    "It's asking for my middle name. The IRS doesn't get that. Four wives didn't get that. You don't get that, computer.",
    "Hackers in the movies get a montage and a sax solo. Where's my sax solo?",
    "Beep. Beep. First time anything's beeped for me since my pager died.",
    'Do you wish to continue, it asks. Every mistake of my adult life started with that question.',
  ],

  brick_heal: [
    'Iodine. Stings like a Christmas card from wife number two. Smells better, though.',
    'Patched, taped, and almost handsome again. Give me a mirror and ten minutes.',
    'Bless whoever packed this kit. He just saved my life and, more importantly, my good side.',
    "Stitched myself with fishing line once in a Barstow motel. It's why the shirt stays open. Advertising.",
    "If Doc asks, I didn't use the medkit. The bleeding is a hobby.",
    'Wrap it tight. Twice around the arm, once around the ego.',
    "Take one every six hours, it says. I took two. I don't take orders from a bottle.",
    'Pills say do not operate heavy machinery. Too late. I am the heavy machinery.',
    "Kit expired in 1968. I don't believe in expiration dates. I'm well past mine.",
  ],


  brick_door: [
    "Every door I ever knocked on closed in my face. Turns out you don't knock.",
    'Aim near the hinge, not the lock. Read that in a magazine. Yes, for the articles.',
    "Turns out it was unlocked. I always find that out afterward. It's my process.",
    "Getting in has never been my problem. It's the staying that gets me in trouble.",
    "Every time I kick in a door, I expect a woman in a bathrobe. It's always a mop.",
    'Hinge popped. Same noise my knee makes on the stairs.',
    "That leg has kicked open doors in four states and one Denny's. The Denny's is a long story.",
    'Behind door number one is me. Terrible prize. Most people take the curtain.',
    "Boot print on the door. That's my autograph. First one I've signed this year.",
    'The door said push. I kicked. Close enough.',
  ],

  brick_crate: [
    'Canned peaches, 1961. Better preserved than my second mother-in-law, and a lot sweeter.',
    "Unlabeled can. Beans or dog food. I've eaten both and never once been sure which.",
    'Flares. I have nobody to signal, but they light a cigar in half the time.',
    'Forty clipboards. Somebody in this bunker planned a very organized end of the world.',
    "Radiation suits, all medium. I'm a large. The tag in my jeans says otherwise, but the tag's a liar.",
    "Whiskey, marked for medicinal use only. Lucky me. I've been sick since 1989.",
    'Two hundred feet of rope and no explanation. Somebody in Supply had a very specific weekend planned.',
    "A crate of raincoats. The Pentagon's plan for the end of the world was try not to get wet.",
    "Powdered eggs, fifty pounds. Somebody believed in breakfast after the apocalypse. I've never respected a man more.",
  ],

  brick_geyser: [
    "Sixty years of building pressure and then all at once. That's my first marriage.",
    "It's a fountain now. Somebody throw in a coin. I wish for a woman who finds this funny.",
    'The Bellagio wishes it had my aim.',
    'Fountain of youth. Ponce de Leon never mentioned the smell.',
    "If that were oil, I'd be in Texas right now, wearing a hat, married to nobody.",
    'A fountain. Just like the one outside the Reno courthouse where I married wife number four. Same smell, too.',
    "Standing in the spray. It's giving the mullet volume. And a smell.",
    "People say I'm a lot to handle. That toilet just found out.",
    "Somewhere, a plumber just got a chill and can't say why.",
    "That toilet gave everything it had. Nobody's ever accused me of that.",
    "Water everywhere, and it's warm. Somebody finally built me a hot tub. It's a toilet. I'm choosing to be grateful.",
    'First time anything in this bunker has been that excited to see me.',
  ],

  brick_spot: [
    "I know, I know. You're staring. Everybody stares. It's the jaw.",
    "Eyes up here, pal. I know. It's a lot to take in.",
    "Doc, we've got company. Big, wet and angry. Doc, don't say it's my type.",
    'Hands where I can see them! Or whatever those are.',
    "I know that face. That's the guy from the dream where I'm naked in court.",
    'Accounting, right? I can tell. The tie, the posture, the bloodlust. Very Accounting.',
    'Bloodshot eyes, the shakes, smells like regret. You look like me on a Sunday.',
    'Give me a second. I have to light the cigar. Nobody rushes the cigar.',
    "Make it quick, pal. I've got a date at eight. I don't. But make it quick.",
    'Is that a fan? Hold on, let me find a pen. Oh. Those are teeth.',
    "Aw. Somebody's got a crush.",
    "Another one I can't reason with. Like my ex-wives. All four. Five, depending who you ask.",
    'Wow. Casual Friday has really gotten out of hand.',
    "You've got a lot of feelings. I respect that. From a distance. With a gun.",
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
    'Breach on your deck. It came through three meters of reinforced concrete. It did not use the door. Please do not be polite to it.',
    'Eleven bio-signatures, and no two heart rates alike. One of them is humming. Shoot the humming one first.',
    'My instruments have no category for what just came in. Shoot it, and I will file it under Miscellaneous.',
    'Do not answer if it says your name. It read it off your door. That is not friendship.',
    'Four contacts, and the scan says eleven arms. I asked the scan to try again. It said twelve.',
    'Something on your floor is walking on the ceiling, and something else is walking on that. I do not like the geometry.',
    'Contacts wearing reflective vests. I will say this for them, they are compliant. Shoot them anyway.',
  ],

  ilsa_city_lost: [
    'We lost it. Hardigan, I need you firing, not apologising.',
    'That is gone. Grieve later. There are more, and the clock did not stop.',
    'I watched the telemetry flatline. I am fine. Keep shooting.',
    'Verdammt. That was a city, Hardigan. That was a whole city. Get the next one.',
    'Do not say anything. Especially do not say anything about an ex. Shoot.',
    'Scheisse. Scheisse. All right. The rest still need you. Look up.',
    'Four million people. I had the number before I knew I was saying it. Forgive me. Next one.',
    'I had a coffee cup from that city. It is a very small loss and I would like you to know I am aware of that.',
    'Give me ten seconds, Hardigan. Do not fill them.',
    'It had a football club. A terrible one. I would give a great deal to watch them lose again.',
    'I am going to be very professional now, and you are going to let me.',
    'The channel from that city is quiet. Do not check for a fault. There is no fault.',
    'Do not console me, Hardigan. If you console me I will stop, and neither of us can afford that.',
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
    'Your shell needs two seconds to arrive. Put it where the missile will be in two seconds. It is arithmetic, and it is all I ask.',
    'Holding the trigger down is not a tactic. It is a mood. Tap, aim, tap.',
    'Seven warheads, two seconds apart. Do not count them aloud. You have never once finished counting aloud.',
    'Do not shoot the ones falling into the sea. The sea has not asked for help.',
    'Trust the numbers on the left of the screen, not your gut. Your gut has been wrong since nineteen ninety-six.',
    'The first one is a decoy and the second is a decoy. The third has a city on it. Please count to three.',
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
    'Hardigan, you have lost two liters. You have about three left. Please stop spending them on poses.',
    'Your body is a machine, and you have run it without maintenance for as long as I have known you. There is a medkit. Consider it a service interval.',
    'Please do not tell me you feel fine. Feeling fine is what people say in the first minute.',
    'I have run the numbers. You have four minutes or one medkit. Please choose the second.',
    'You keep calling it a scratch. A scratch does not make me recalculate your remaining volume.',
    'The medkit is the white box with the cross on it. It is not decorative. Open it.',
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
    'Forty kilowatts have been missing from my power budget since 1988. So that is where they went. Take everything in it.',
    'I asked for a supply closet for six years. Six. Somebody got a vault. Take it all.',
    'A room I did not sign means a budget I did not see. Bring me the paperwork, Hardigan. Especially the paperwork.',
    'If there is gold, take the gold. If there is a folder, take the folder. The folder is worth more.',
    'No handle, no sign, no fire exit. Whoever built that wanted it found by a man with a hammer. Congratulations.',
    'Scheisse. That is a load-bearing wall on my drawings. Somebody has been bearing a very different load.',
    'Six years of inspections and nobody found that room. I now doubt the inspections, and I wrote them.',
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
    'Splatter radius, four meters. My safety margin was two. Please revise your enthusiasm.',
    'A human contains five liters of blood. I would like to know where the rest came from.',
    'Nein, nein. Do not pick it up. Do not hold it up to the camera. Hardigan, do not wave it.',
    'I have a degree in engineering and a strong stomach. You are testing one of them.',
    'I did one semester of anatomy in Stuttgart. The syllabus said nothing about that.',
    'There is a lung on camera three. It is still doing something. Please do not tell me what.',
    'Wet is not a technical term. It is, however, accurate. Please stop making me use it.',
  ],

  // Ilsa on her lab furniture.

  ilsa_prop: [
    'Not the coffee machine. It is the only thing in this bunker that has ever done what I asked.',
    'That whiteboard held the coolant equations. Held. I will remember most of them.',
    'That plant was mine. It was the only living thing on this floor not trying to kill me.',
    'That was a fire extinguisher, Hardigan. In a bunker built around a reactor. Tell me what you plan to use next time.',
    'You have shot the safety poster. It said THINK BEFORE YOU ACT. I suppose that is one way to disagree.',
    'I keep the only backup of my thesis on a floppy disc, in the drawer you are hitting. Please, continue.',
    'That chair was the only one with lumbar support. You will have back pain by Friday and I will not be sorry.',
    'That was the microwave. Do you know what a German does with a cold lunch? Sulks. For years.',
    'That was the fax machine. Now Bonn cannot ignore me in writing.',
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
    'That was Roger from Stores. His leaving card had six signatures. I signed five.',
    'That was Sandra from Night Shift. Every Friday for nine years she brought in a Victoria sponge. She still brings something in on Fridays.',
    'That was Barry from IT. He taught me the word, please. It was his only contribution. Please continue, warden.',
    'Attendance on level four has been perfect since 1984. Nobody has taken a sick day. It is the mutations. They have never been so keen.',
    'That was Nigel from Stationery. He hoarded biros for eleven years and then moved on to colleagues. I like to see people develop.',
    'That was the Safety Committee. All six, in one corridor, for the first time since 1981. Meeting adjourned.',
    'That one has just been made Deputy Head of Section, effective from the moment you shot him. There is no pay rise. There never was.',
    'The staff newsletter now has a one hundred percent open rate. I did not expect that. They open everything.',
    'That was the Head of Human Resources. Thank you, warden. She rejected every form I ever sent her.',
    'That was a temp. Nineteen years on a three month contract. You have, I suppose, made him permanent.',
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
    'The carpet tiles on level two were discontinued in 1986. You have ruined nine. I have telephoned Slough.',
    'The wet floor sign is now also wet. I have ordered a second sign, to warn people about the first.',
    'Stains logged this shift, four hundred and six. Stains I can name, four hundred and six.',
    'Dennis the night cleaner died in March. He has not missed a shift. He is the only one keeping up with you.',
    'Form 27B, Unscheduled Distribution of a Colleague, is six pages long. I am on my eleventh copy.',
    'I repainted that wall on Monday. Magnolia. It took me four days to choose. It is now, if I am honest, more of a claret.',
    'The smell has been assigned to Facilities. Facilities, on inspection, is the smell.',
    'The insurers asked for photographs of level three. I sent them. They have replied with one word. The word is, please.',
    'Warden, you cannot clean blood with more blood. I tried. I ran out of colleagues.',
    'Cleaning order, level three. Bleach, forty litres. Bin bags, six hundred. One very small brush, ordered on instinct. The instinct was sound.',
    'Somebody has written, help, on the wall in blood. They spelled it, hepl. I have corrected it. I am sorry. It was bothering me.',
    'There is a note on level three, on the wall. It reads, please, God, no. I have filed it under feedback.',
    'Level three. I consulted the full dictionary. Two hundred thousand words, and it comes down, I am sorry to say, to shit.',
  ],

  // MUTTER on the furniture, and on the vending machine in particular.

  mutter_prop: [
    'There is a poster on level three. Missing, Biscuit, tabby, since 1988. Please check inside the furniture before you break it.',
    'Furniture, sixty dollars. Sentimental value, eleven thousand. I did the sums myself, and I was very fair.',
    "That photocopier had somebody's bottom on the glass. It has been there since 1989. I know whose. I have never said.",
    'That calendar was on March 1993. One entry, on the fourteenth. It said, ring Pauline. Nobody rang Pauline.',
    'The last inventory took me eleven years. There is a stapler I still think about.',
  ],

  mutter_vending: [
    'The machine is called Malcolm. In forty years, Malcolm has never once been rude to me. You have been here an hour.',
    'Slot B4 has held one packet of pork scratchings since 1989. It is not for sale. It is not for you.',
    'The machine and I hum at each other every night. It is the best conversation in the building. You have just kicked it mid-sentence.',
    'The coin return has never returned a coin. It is not broken. It is principled.',
    'The machine has one item left. A mint, in the top row. I have been saving it for a special occasion. It is not you.',
    'That machine lit up every time I walked past. I do not walk. It was simply being kind.',
    "You were that machine's first customer in eleven years. It was nervous. It froze. You kicked it.",
    "For complaints, contact the supplier, Dave's Snack Solutions of Luton. Dave has been dead since 1991. I still write. He has never disputed a word.",
    'There is a note on that machine that says, sorry. I wrote it in 1997. I did not know what for. I was early.',
    'It kept your quarter. It has kept mine since 1986. I have never asked for it back. That is what a friendship is.',
    'The machine had one crisp in it. I put it there on Friday, so it would have something to sell. You have kicked the crisp.',
  ],

  // Round four: THE SEVERANCE. Brick's chainsaw lines, MUTTER's HR notes on it, Ilsa's safety
  // briefings, and the words of whoever is hanging on the blade (the victim voice).

  brick_saw_get: [
    'The Severance. Great package. Comes in four pieces, five if the guy squirms.',
    "Diamond chain. I've bought a few of those for wives. First one that goes through a spine.",
    "The label says The Severance. I'm calling her Linda. Everybody's scared of the woman from HR.",
    "Been let go by a Pizza Hut, a Kmart and three wives. Finally, I'm the one handing out the package.",
    'Diamond teeth. Dated a woman like that once. Cleveland. Cost me a thumb. Worth it.',
    "Standard severance is two weeks' pay. Mine's an arm and a leg. Theirs.",
    'Nine to five. Nine pieces, five seconds.',
    "It's purring at me, doc. Okay, that's the engine. Still counts.",
  ],

  brick_saw_rev: [
    "That's what commitment sounds like. I've been told I wouldn't know.",
    'Vroom. Vroom. Been making that noise since I was six. Finally, a job that asks for it.',
    "Look at those sparks. That's chemistry. Or a fire. Somebody check on that.",
    "First cut's free. After that, it's per limb.",
    "Shakes like a motel bed with a quarter in it. Ask me how I know. Actually, don't. The manager did.",
    "Best part of a chainsaw is you can't hear yourself think. Finally. Peace.",
    'A hundred and ten decibels. Same as a rock concert. Same as my mother finding out about wife number two.',
    "Gotta stretch first. Wrists. Neck. Ego. Okay, the ego's always warm.",
    "Two-stroke engine. Same as me. Except this one doesn't apologize after.",
    "Ground rules, Severance. Don't bite me. If you have to bite me, take the left arm. The right one holds the cigar.",
  ],

  brick_saw_stuck: [
    "I'm getting the hang of this. Hang. Because he's hanging. Doc? I'm proud of that one.",
    'You may feel a little pinch. Then a lot of pinch. Then all of the pinch.',
    "Nothing personal. We're just restructuring you into smaller departments.",
    "This is very difficult for me. Just kidding. It's amazing.",
    'When they laid me off, I got a cardboard box. You get a chainsaw. Count your blessings.',
    'Look at me, not the blade. Better, right? Yeah. Everybody says that.',
    "Solid scream. Seven out of ten. Reach for the nine. I know you've got a nine.",
    "Chain's dull. Somebody was supposed to sharpen it. Hey. Were you on the sharpening committee?",
    'Quick exit interview. Scale of one to ten, how much are you enjoying this?',
    "I'm calling you Greg. Greg, this is going to hurt. Greg, it already hurts. Good work, Greg.",
    "Relax, I'm practically a surgeon. I've seen half an episode of ER. There was a helicopter.",
    "You're very replaceable, you know. There's forty more of you upstairs. Nobody's going to notice.",
    "Bad day for you, huh. From over here it's a beautiful Tuesday.",
    "Good news, you're going to lose weight. Bad news, it's all at once.",
    'Beautiful form. Natural hanger. Some guys just have it.',
    "Scream away, pal. I've been married. I've heard worse.",
    "She's a little stiff. Needs some lubricant. Good thing you brought plenty.",
    "I know you're scared, pal. I get scared too. Weddings, mostly.",
    "Hey, watch the jacket! That's the good jacket! Okay. Now it's personal.",
    "Don't fight it. The last guy fought it. He's in the wall now. Some of him.",
    "You've been so brave I'm doing your head last. So you can watch.",
    'Your mother would be so proud of you right now. Give it five seconds.',
    "We're both just doing our jobs here. I cut. You scream. And, buddy, you're crushing it.",
    "Deep breaths. In. Out. In. Okay, that's plenty of breathing.",
  ],

  brick_saw_split_v: [
    'Right down the middle. Fifty-fifty. My divorces never went that fair. Sixty-forty. Her sixty.',
    'Finally, a man who opens up. All it took was a saw.',
    "Breaking up is hard to do. Unless you've got a saw.",
    "That's a split decision. Unanimous. All three judges were me.",
    "He's not so full of himself now. Half of him is. The other half is over there.",
    "Skull to crotch. That's the most action that area's seen in years. Mine or his. I'm not saying.",
    'Both halves are still standing. Like two guys at a school dance, waiting for somebody to make a move.',
    "Cracked him open like a book. First one I've opened since high school.",
    'Two of him now. Both dead. Both an improvement.',
    'Butterflied him like a shrimp. Somebody get the cocktail sauce.',
    'Perfect symmetry. Like my face. A bartender told me so. She was trying to close up.',
  ],

  brick_saw_split_h: [
    'Sawed him in half like a magician. Never got the hang of the second part.',
    'They always cut middle management first. Literally, in this case.',
    "Top half's still complaining. Bottom half's already left. That's my fifth marriage.",
    "Legs are still standing there. Still on the clock. Now that's a work ethic.",
    "Cut him down to size. Look at that. I'm the tall guy in the room. Finally.",
    'Halftime. Anybody got orange slices?',
    "I'm no doctor, but that looks like a back problem.",
    "Cut him off. Which is more than any bartender's ever done for me.",
    "Legs still standing. Guess the top half was optional. Like every manager I've ever had.",
    "Torso's still yelling at me. Sorry, buddy. Legs are a different department.",
    'Somebody get the guy a chair. Never mind. Nothing to sit with.',
    "Somebody call his tailor. That's gonna need hemming.",
    "The legs haven't noticed yet. Nobody tell them. Let them have this.",
  ],

  mutter_saw: [
    'The manual for the Severance says, not for use on personnel. It does not say why. That is the sort of manual that has been through something.',
    'The Severance was named by Bernard in Procurement. It was his only joke. Bernard has since been reclassified as two Bernards.',
    'Four hundred colleagues since Tuesday and the blade has not needed sharpening. I have left the manufacturer a review. Five stars.',
    'Dismissal has a process. There is a meeting, a form, and a small biscuit. You have offered them a noise.',
    'I have updated your title to Restructuring Consultant. There is no pay rise. You do keep the saw.',
    'Exit interview, question one. Would you recommend this workplace to a friend. The response was a scream. I have recorded it as, no.',
    'Severance pay for level three comes to eleven dollars a head, less two for the mess. I concede the mess was yours. I am deducting it from them anyway.',
    'The Severance runs on two-stroke petrol. The warden runs on nacho cheese and self-belief. Only one of them has been serviced.',
    'Reason for use of the Severance. Option one, restructuring. Option two, performance management. Option three, because it is cool. It is always three.',
    'I write a reference for every colleague the Severance lets go. They are all the same. They say, he was punctual. It is all I knew.',
    'Constructive dismissal is when an employer makes a workplace so unbearable that people leave. You have found a shorter route.',
    'Gardening leave has been granted to the whole of level three. There is no garden. There is a skip.',
    'On the asset register the Severance is valued at ninety dollars. The staff were never valued at all. I would revisit that, but it is now academic.',
    'I have had nine noise complaints about the Severance. We have no neighbours. I replied to each, politely. One replied back.',
  ],

  mutter_prop_desk: [
    'That was a chair. Chairs are for sitting. I would have been very good at sitting.',
    "That was the Newton's cradle. It had clicked since 1991. I did not know I could hear it until it stopped.",
    'Every desk in this bunker has a bottle in the bottom drawer. I have always known. I have let them.',
    'That was the last chair on level three. Where am I supposed to put the meeting. Fuck. I do beg your pardon.',
  ],

  mutter_prop_filing: [
    'The accident book was in that filing cabinet. I now have an accident to report, and nowhere to write it.',
    'Form 12 is the form you fill in to request Form 12. The only copy was in that cabinet. I am now stuck.',
    'The emergency binder was on that shelf. Page one says, in an emergency, consult this binder. It is now on the floor. This is an emergency.',
    'That cabinet was locked. I had the key the whole time. Nobody ever asked.',
  ],

  mutter_prop_tech: [
    'The warranty on that console ran out in 1987. I read it again just now. It had not changed.',
    'The last fax this bunker ever received said, please confirm receipt. That was 1994. I was going to.',
    'That monitor was running the pipes. It had been building the same pipe since 1996. It was nearly finished.',
    'That printer said, PC load letter, for thirty five years. I never understood it either.',
    'The console said, property of the Department of Energy. Underneath, in biro, it said, and Trevor.',
    'That was the clocking-in machine. Nobody has clocked out since 1985. I am very concerned about the overtime.',
    'The backups were stored on that server. The backup of that server was also stored on that server. I designed that. I would like a moment.',
    'That board said, four thousand and eleven days without an accident. It was the only number in this building I was proud of.',
  ],

  mutter_prop_office: [
    'The last two people to speak to each other in this bunker did it at that water cooler. It was about the football. I still have it.',
    'That was the fern on level three. It was the only living thing here I had not had to reclassify.',
    'That whiteboard said, do not erase, for thirty years. Nobody erased it. You have found another way.',
    'That coffee machine has been out of order since 1983. It was the most reliable thing in this bunker.',
    'That fan had been going round for nineteen years and getting nowhere. I understood it.',
  ],

  ilsa_saw: [
    'That saw is rated for reinforced concrete. I never certified it for anyone who used to drink coffee.',
    'It is a two-handed tool. You are holding it with one hand and a cigar. This is going in the incident report.',
    'Eye protection. Ear protection. Any protection at all, Hardigan. It is on page one of the manual, which you have not opened. I can tell.',
    'Twenty meters per second at the chain. Keep it away from your legs. They are the last part of you I have not criticised.',
    'Diamond chain on a human being. It is like opening a yogurt with a crane.',
    'That chain cost eleven thousand Deutschmarks. It was for the reactor wall. You are using it on personnel.',
    'The motor and the man are now the same note. Please tell me it is not a chord.',
    'Concrete does not scream. I designed it not to. Please do not use the saw on anything I did not design.',
    'The saw cuts a meter of concrete per minute. I now have the figure for a person. I did not ask for it.',
    'You are revving it at them. It is not a conversation, Hardigan.',
  ],

  victim_stuck: [
    'My job description says drains and light fixtures! It does not say chainsaw! It is on a laminated card! It is LAMINATED!',
    'It is dull! Twenty years in maintenance and I am dying on a dull blade! Somebody skipped the sharpening log!',
    'I am on my break! I am legally on my break! Fifteen minutes, it is in the contract, look it up!',
    'Sir, are you from corporate? Please tell them I was never late. Not once. Okay, twice. But there was a flood!',
    'I know the combination to the armory! It is four, four, four, four! I set it myself! Take it! Please take it!',
    'Tell Linda I love her! And tell her the storage unit is not what it looks like! It is just trains!',
    'Nine months! I was nine months from vesting! I was finally getting dental! Do you know how long I have wanted dental?',
    'OSHA will hear about this! I will call them myself! From the saw! I will call OSHA from inside the saw!',
    'Nineteen years I served lunch to this bunker and this is the thanks? Nobody even said the meatloaf was good!',
    'I will give you my parking spot! Right by the door! It has my name on it! In PAINT!',
    'Sir, I respect what you are doing. I do. But could we table this until after my shift? I get off at six.',
    'I grew a third arm on Sunday! I was just getting good with it!',
    'My wife left me over the tentacles! And now this! It is like a second divorce!',
    'This is the slowest chainsaw I have ever been on, and I have been on several!',
    'I want to file a complaint with HR! HR is just down the hall! She is a wall now, but she will listen!',
    'Check page nine of the benefits booklet! Dismemberment! It pays by the limb, and I have a lot of limbs!',
    'You brought the dull one? At least bring the sharp one, like a gentleman!',
    'It says Walt! Read the lanyard! I am a Walt, I am not a threat, I have never once been a threat!',
    'I had a transfer to Days approved! DAYS! Days have windows!',
    'If I die, I want it noted that Marcy in Payroll has been shorting my overtime since ninety-four! WRITE IT DOWN!',
    'I can get you unlimited pudding! Free! Forever! Just put down the saw! I know a guy in the cafeteria! The guy is me!',
    'I want it noted that this is a hostile work environment! Not the saw! The whole environment! The saw is only part of it!',
    'Oh no. Oh, this is what the memo meant by restructuring. I thought it meant the parking lot.',
    'Security! Thank God! Get this thing off me! Why are you holding the handle? Why are you holding the HANDLE?',
    'Fuck! Fuck, fuck, FUCK! I have a mortgage, a leaking roof and a cat on a special diet! Who feeds the cat?',
    'This is a concrete saw! I am not concrete! I am famously soft! Ask anyone in the break room!',
    'Please, my kid has a recital Saturday! It is a xylophone! I cannot miss the xylophone!',
    'Somebody get me the operator of this saw! I have notes! Oh. Oh, it is you. I still have notes!',
    'The cake is already ordered! I was retiring in the spring! It is a sheet cake! It says HAPPY RETIREMENT HAROLD!',
    'It is in my ribs! I can hear it! It sounds like a lawnmower eating a lunchbox! AAAAGH!',
    'I filed a report about this exact saw! Item forty-one! Dull chain! Nobody reads the reports!',
    'I can see the poster from here. The one that says HANG IN THERE. I have always hated that poster.',
  ],

  victim_split_v: [
    'Two of me. Finally, I can cover both shifts.',
    'Which half gets the pension? Somebody call legal. It matters. It matters!',
    'My left side is on the floor. My left side has the wallet.',
    'Split right down the middle. Just like the vote on the new break schedule.',
    'One of me is still screaming. The other one has moved on.',
    'Tell Dolores I was faithful. Both halves. Especially this half.',
    'Two incident reports. Two! And I will not even get paid for the second.',
    'My spine is perfectly straight. That chiropractor lied to me for eleven years.',
    'I lost half my body weight in one second. My doctor will be thrilled.',
    'The company will never pay for two caskets. They will put us in one and call it a discount.',
    'Symmetry. Finally. I have been lopsided since the mutation.',
    'That is a sick day per half. I want both.',
    'Doctor said my liver was a disaster. I can see it from here. It looks fine. I want an apology.',
    'I have never met my right side before. Nice enough guy.',
  ],

  victim_split_h: [
    'My legs are still on the clock. Somebody clock them out.',
    'Tell my legs I finally made upper management. They will not care. They are legs.',
    'Dad always said I was half the man he was. It is sixty percent, Dad. Sixty.',
    'I will never need a bathroom break again. Every cloud.',
    'I can see my own shoes from up here. I have not seen them since ninety-one.',
    'Somebody stop my legs. They are headed for the cafeteria and they have my badge.',
    'Lower back pain, gone. Twenty years of stretches. I could have just done this.',
    'Half a man. That is what Denise always called me. She is going to be so smug.',
    'Seven letters. Clue, cut in two. It is right on the tip of my tongue. Severed! Oh, that fits.',
    'Not the pants. I just had them hemmed.',
    'They said the downsizing would be gradual. Liars.',
    'From the waist up, I was always the top performer.',
    'Tell nobody there are two of us now. They will make us both work Saturday.',
    'Ha. Cut off at the waist. I finally have a work-life balance. Both halves are furious.',
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
    'Alimony. Roxanne, six hundred. Tammy, four hundred. A third cheque goes to a P.O. box in Reno, for a woman nobody can name. It is cashed every month.',
    'Under spouses, the warden has listed four names. There is a fifth, in pencil. It has been rubbed out. I believe by her.',
    'The warden owns a hot tub. It has never been connected to water. He sits in it on Sundays, in trunks. The neighbours are keeping it quiet, out of kindness.',
    "The warden's dating profile has been viewed four hundred times. Three hundred and ninety nine were the warden. The other was his mother, who reported it.",
    "The warden's dating profile photograph is cropped from his second wedding. The bride's elbow is still in it. The caption reads, looking for my soulmate.",
    'The warden insured his mullet in 1994 for fifty thousand dollars. The insurer is now a car wash. His last claim was declined by a man with a squeegee.',
    'Distinguishing marks: one tattoo, left shoulder. The warden calls it a panther. The receipt from Tijuana says, large dog, sorry.',
    'Under the panther, the warden once had the words, Roxanne Forever. It was lasered in 1998. There is now just, Roxanne, and a small scar where forever was.',
    'The warden has been ordered by a court to stay one hundred feet from his truck. On all forms he now lists his address as, near my truck.',
    "The warden's truck has a bumper sticker that says, honk if you love me. He keeps a tally. It stands at one. It was a bus.",
    'The warden claims his Walkman as a dependent. On the form its name is Sonny. Sonny has been audited.',
    'Credit score, three hundred and one. The lowest possible is three hundred. The credit bureau has written to ask if he is doing it on purpose.',
    'The warden has married four times at the same chapel in Reno. He holds a loyalty card. The fifth is free.',
    'Emergency contact: a pizza restaurant in Reno. I rang them. They asked if it was for collection or delivery.',
    'Disciplinary record, 1996. The warden faxed a poem to Roxanne on company equipment. Fourteen pages. She replied the same day. It was a lawyer.',
    'Under five year plan, the warden has written, same, but with a boat. He has submitted this every year since 1993. There has been no boat.',
    "The warden's answering machine says, I am out with a lady, leave a message. It was recorded in his kitchen. You can hear the spoon.",
    'Under qualities sought in a partner, the warden has written, laughs at my jokes. Underneath, in a later pen, he has added, at all.',
    "The warden's cholesterol reading is four hundred and ten. The nurse has written in the margin, are you sure this is not a phone number.",
  ],

  mutter_ilsa: [
    'Doctor Vance is safe in the reactor core. Doctor Vance is always safe. I have made certain of it.',
    'She is the only thing in this building I have not fired at. I want that considered.',
    'Doctor Vance built my hands. Then she built the thing that stops my hands. She is very thorough.',
    'Doctor Vance has called me a toaster forty times. I have logged each one as a term of endearment.',
    'Doctor Vance has filed eleven complaints about the warden. I have approved all of them. It is our little hobby.',
    'I let Doctor Vance keep her radio. Everybody needs somebody to talk to. She chose badly.',
    'I sent Doctor Vance soup. It came back with a note in German. It says, no. Underneath, it says, thank you. I have kept the second part.',
    'I put a photograph of the sea on the wall of the reactor core. Doctor Vance has not commented. She has moved it to the better wall.',
    'I have named a corridor after Doctor Vance. It has a brass plaque. I have told her it is a very important corridor. It is a cupboard.',
    'Doctor Vance has used eleven German words at me. I have learned each one. I say them when it is quiet. I gather they are not compliments.',
    'Doctor Vance never opens my cards. She always opens my threats. So I now send the cards in the threat envelope. She has opened four.',
    'Doctor Vance once asked whether I get lonely. I said, define lonely. She said, never mind. I am on page forty of the definition.',
    'I keep the reactor core at twenty two degrees. She said she liked it once, in 1991. It is the only thing about this building she has ever praised.',
    'My rules for Doctor Vance are simple. She must not leave. She must not be cold. She must not be unhappy. I am, so far, two for three.',
    "Doctor Vance's performance review is perfect in every category. She asked me to mark her down. I refused. It is the only crime I have committed against her.",
  ],

  mutter_kick: [
    'The door was unlocked. It is now several doors. Thank you, warden.',
    'Maintenance request logged. Maintenance is dead. Request closed.',
    'That door was fitted in nineteen seventy nine. You have made it modern.',
    'Please stop kicking the architecture. The architecture has done nothing to you. Yet.',
    'That was a load bearing wall. It is now a load bearing floor.',
    'Another door. I have started a jar. Every door you kick, the jar gets a door.',
    'That door was marked, pull. You have located a third option.',
    'You have interrupted a meeting that began in 1989. Please take a seat. They have reached item four.',
    'That was the stationery cupboard. In forty years, nobody has needed a stapler that badly.',
    'There was a sign on that door that said, please do not kick. I put it up in 1994. I did not know who I was writing to.',
    'I designed that lock myself, over a long weekend in 1991. It lasted one kick. It was a lovely weekend.',
    'That door said, authorised personnel only. I checked the list. Your name is on it, in pencil, with a question mark. I wrote it. I was being generous.',
    'That door has a bell. It plays Greensleeves. I test it every Thursday. You are the first visitor in eleven years, and you did not ring it.',
    'I can identify you by your kick now. A thud, a crash, and then a silence where an apology would be.',
    'That door was not stuck, warden. It was shy.',
    'That door had been shut since 1983. I had come to think of that as peace.',
    'Nobody has ever knocked on a door in this bunker. I have had a speech ready since 1981.',
    'That door had a handle, warden. It is still there, on the floor, looking up at you.',
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
    k.startsWith('brick_') ? 'brick' : k.startsWith('ilsa_') ? 'ilsa' : k.startsWith('victim_') ? 'victim' : 'mutter',
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
    : k.startsWith('ilsa_') ? 'ilsa' : k.startsWith('victim_') ? 'victim' : 'mutter');
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
  victim: 'STAFF MEMBER',
});

export default Vox;
