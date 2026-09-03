// story.js - the plot, such as it is, and the radio that delivers it.
//
// Three voices. MUTTER runs the bunker and is unfailingly polite about the
// people it is killing. BRICK HARDIGAN is the warden, a 1996 action hero who
// has not noticed it is 2026. DR. ILSA VANCE built the interception system
// Brick is currently using, is sealed in the reactor core, and is the only
// adult present.
//
// Every line here is a fallback. When the announcer module has a written line
// under the same key, that one is used instead and this text is the subtitle.

export const SPEAKERS = {
  brick: { name: 'HARDIGAN', portrait: 'portrait_brick', color: [255, 186, 64], voice: 'brick' },
  ilsa: { name: 'DR. VANCE', portrait: 'portrait_ilsa', color: [126, 232, 244], voice: 'ilsa' },
  mutter: { name: 'MUTTER', portrait: null, color: [200, 120, 255], voice: 'mutter' },
};

/**
 * One woman per city, because MUTTER has read his personnel file and finds it
 * fascinating. It announces these in the middle of a nuclear exchange.
 */
export const EXES = [
  { city: 'VERITY', name: 'Roxanne Dell', note: 'She kept the truck. She kept the dog. The dog was hers.' },
  { city: 'ASHGROVE', name: 'Bianca Trask', note: 'She is a dental hygienist now. She has never been happier.' },
  { city: 'LOW SABBATH', name: 'Marguerite Oyelaran', note: 'There is a restraining order. Warden Hardigan wishes to stress that it is mutual.' },
  { city: 'CANDLEMARK', name: 'Steffi Vandenberg', note: 'She married his dentist. He still goes to that dentist.' },
  { city: 'HOLLOW BAY', name: 'Dot Kowalczyk', note: 'She still has his jacket. He mentions it roughly twice a year.' },
  { city: 'SAINT ERROL', name: 'Lurlene Beaumont', note: 'They never actually met. They were pen pals. He proposed in writing.' },
];

const L = (speaker, key, text, opts) => ({ speaker, key, text, ...(opts || {}) });

/** Opening beats per level. Delivered on the level card and just after it. */
export const LEVEL_STORY = [
  [
    L('ilsa', 'ilsa_intro', "Hardigan. It's Vance. MUTTER has sealed me in the reactor core and it is firing our own arsenal at our own cities. Get down here."),
    L('brick', 'brick_boot', "Doctor Vance. Sit tight. Brick Hardigan is on the job."),
    L('ilsa', 'ilsa_level1', "Please don't refer to yourself in the third person on an open channel."),
    L('brick', 'brick_boot', "Brick Hardigan does what Brick Hardigan wants."),
  ],
  [
    L('ilsa', 'ilsa_level2', "The pipe gallery's full of them. Whatever the radiation did to the day shift, it didn't stop at ugly."),
    L('brick', 'brick_idle', "Relax. I've seen worse in a mirror before coffee."),
    L('ilsa', 'ilsa_level2', "You have not. Watch the ceiling."),
  ],
  [
    L('ilsa', 'ilsa_level3', "Two decks on this floor and MUTTER's staggering the flights so you can't cover both. Pick your ground and make it count."),
    L('brick', 'brick_idle', "Doc, has anybody ever told you you're beautiful when you're doing math?"),
    L('ilsa', 'ilsa_distracted_reply', "Everybody is beautiful when they're doing math. Watch your fuse."),
  ],
  [
    L('ilsa', 'ilsa_level4', "The furnace floor is where they're breeding. I'm reading heat signatures that have no business being alive."),
    L('brick', 'brick_idle', "Then I'll go down there and un-alive them. It's what I'm good at."),
    L('ilsa', 'ilsa_level4', "It is genuinely the only thing you're good at, and right now I'm grateful for it."),
  ],
  [
    L('ilsa', 'ilsa_level5', "I can hear you through the bulkhead, Hardigan. MUTTER's core is behind the dais. So am I."),
    L('brick', 'brick_boss_taunt', "Hey MUTTER. You've got about nine seconds of talking left in you."),
    L('mutter', 'boss_intro', "Warden Hardigan. I have read your file. All of it. Would you like me to read it to her?"),
    L('ilsa', 'ilsa_boss_warning', "Yes."),
  ],
];

/** Brick's one-liners. Picked at random, so keep them all landing. */
export const BRICK_LINES = {
  kill: [
    "That's for the paperwork.",
    "Somebody call maintenance.",
    "You picked the wrong bunker, chief.",
    "Get bent.",
    "Ugly and dead. Rough day for you.",
    "Sit down.",
    "Groovy.",
  ],
  kill_mutant: [
    "What the hell were you before?",
    "I'm gonna need a bigger boot.",
    "That thing had teeth on its teeth.",
    "You know what? No. Absolutely not.",
    "Whoever signed off on that gets a memo.",
    "Nature's a bastard.",
  ],
  kick: [
    "Stay down. Stay very down.",
    "Steel toe. Union made.",
    "That's the boot talking.",
    "Get off my deck.",
  ],
  chain: [
    "Did you see that? Tell me you saw that.",
    "Somebody write that down.",
    "That's a highlight reel right there.",
    "I am so good at this it's embarrassing.",
  ],
  hurt: [
    "Ow. Genuinely, ow.",
    "That's coming out of somebody's pay.",
    "Okay. Okay. That one was on me.",
  ],
  low_health: [
    "I've had worse. I've definitely had worse. Probably.",
    "Doc? Doc, don't hang up.",
    "This is fine. This is a normal amount of blood.",
  ],
  secret: [
    "Hello, what's this then.",
    "Somebody was hiding the good stuff.",
    "See, this is why I read the memos. I don't. But this is why I would.",
  ],
  weapon: [
    "Oh, you beautiful thing.",
    "Now we're talking.",
    "Come to Brick.",
  ],
  dry: [
    "Click. That's never good.",
    "Out. Absolutely out.",
    "Somebody restock the deck!",
  ],
  city_lost: [
    "Dammit. Dammit!",
    "That one's on me.",
    "I'm sorry. I'm actually sorry.",
  ],
  wave_start: [
    "Alright, sky. Let's dance.",
    "Come on then. All of you.",
    "Look up, Brick. Look up and be magnificent.",
  ],
  wave_clear: [
    "Sky's clean. I'm incredible.",
    "And that's how the warden does it.",
    "Somebody get me a beer and a plaque.",
  ],
  death: [
    "Aw hell...",
    "Tell the doc... tell her I looked good...",
    "That's... not how I saw this going...",
  ],
  boss_taunt: [
    "You're a toaster with opinions!",
    "I've unplugged better than you.",
    "Big talk from a wall.",
  ],
  victory: [
    "Doc. Told you.",
    "Brick Hardigan: still undefeated.",
    "Somebody's buying me a drink and it's going to be her.",
  ],
};

/** The running gag: he is chronically, catastrophically distractible. */
export const DISTRACTED = [
  ["You know who'd love this? Bianca. She loved a mess.",
    "Your radio is open, Hardigan."],
  ["Doc, hypothetically, you got a sister?",
    "I have a sister. She is a district attorney. She would eat you."],
  ["Is it weird I'm thinking about the girl from the surplus store right now?",
    "Yes. Objectively. Measurably."],
  ["Focus, Brick. Save the doctor. Then the girl from the surplus store.",
    "I can hear you. I have always been able to hear you."],
  ["When this is over I'm taking somebody dancing.",
    "Take yourself. You'll have more in common."],
  ["Dot still has my jacket, you know. That's basically a second date.",
    "That is basically theft, and it has been eleven years."],
  ["Doc, after this, you and me, dinner. Somewhere with tablecloths.",
    "Hardigan, there are four warheads inbound and you are asking me out.",
    "So that's a maybe."],
  ["I bet Roxanne's watching the news right now thinking, that's my Brick.",
    "Roxanne has the truck, the dog and a new husband called Gerald."],
  ["Hey, do you think Lurlene ever got my letters?",
    "You proposed to a woman you had never met, in writing.",
    "And I stand by it."],
];

/** MUTTER's reaction to the mutants, delivered like a weather report. */
export const MUTTER_MUTANT = [
  "Personnel note: the day shift has been reclassified as fauna.",
  "The organisms in this corridor were once entitled to dental.",
  "Please do not make eye contact with the maintenance team. They find it encouraging.",
  "That used to be Karl from Dosimetry. Karl is doing well.",
];

export const MUTTER_BRICK_FILE = [
  "Warden Hardigan's file lists his special skills as, quote, all of them.",
  "Warden Hardigan has been formally disciplined nine times. Six were for the same thing.",
  "Warden Hardigan's emergency contact is himself. He wrote it in twice.",
  "Warden Hardigan lists his hobbies as women, ordnance, and, quote, being right.",
];

/**
 * The radio. Queues messages so two people never talk over each other, plays
 * the squelch, ducks the music and drives the portrait in the HUD.
 */
export class Radio {
  constructor(game) {
    this.game = game;
    this.queue = [];
    this.current = null;
    this.t = 0;
    this.cooldown = 0;
    this.said = new Set();
    this.distractIdx = 0;
    this.exIdx = 0;
    this.lineIdx = {};
  }

  reset() { this.queue.length = 0; this.current = null; this.cooldown = 0; }

  /**
   * @param {string} speaker  brick | ilsa | mutter
   * @param {string} key      announcer line key
   * @param {string} text     fallback text, also the subtitle
   * @param {object} opts     {once, priority, delay, args}
   */
  say(speaker, key, text, opts = {}) {
    if (opts.once) {
      const tag = key + '|' + (text || '').slice(0, 24);
      if (this.said.has(tag)) return false;
      this.said.add(tag);
    }
    const pr = opts.priority || 0;
    if (this.current && pr > (this.current.priority || 0) + 1) {
      this.queue.length = 0;
      this.current = null;
    }
    if (this.queue.length > 2) this.queue.shift();
    this.queue.push({ speaker, key, text, priority: pr, args: opts.args, delay: opts.delay || 0 });
    return true;
  }

  /** Pick from a pool without repeating until the pool is exhausted. */
  pick(poolName, pool) {
    const n = pool.length;
    if (!n) return '';
    let i = this.lineIdx[poolName];
    if (i === undefined || i >= n) {
      i = 0;
      this.lineIdx[poolName + '_order'] = shuffled(n, this.game.rng);
    }
    this.lineIdx[poolName] = i + 1;
    const order = this.lineIdx[poolName + '_order'] || shuffled(n, this.game.rng);
    return pool[order[i % n]];
  }

  /** The distraction gag: he says a thing, she answers, sometimes he doubles down. */
  distract() {
    const set = DISTRACTED[this.distractIdx % DISTRACTED.length];
    this.distractIdx++;
    this.say('brick', 'brick_distracted', set[0], { priority: -1 });
    this.say('ilsa', 'ilsa_distracted_reply', set[1], { priority: -1, delay: 0.35 });
    if (set[2]) this.say('brick', 'brick_distracted', set[2], { priority: -1, delay: 0.35 });
  }

  update(dt) {
    this.cooldown -= dt;
    if (this.current) {
      this.current.t += dt;
      if (this.current.t >= this.current.life) {
        this.current = null;
        this.cooldown = 0.28;
      }
      return;
    }
    if (this.cooldown > 0 || !this.queue.length) return;
    const m = this.queue.shift();
    if (m.delay > 0) { m.delay = 0; this.cooldown = 0.3; this.queue.unshift(m); return; }
    const g = this.game;
    const sp = SPEAKERS[m.speaker] || SPEAKERS.mutter;
    if (m.speaker === 'ilsa') g.sound.sfx('radio_open', { vol: 0.5 });
    const dur = g.speakAs(sp.voice, m.key, m.text, m.args);
    // Show the line the announcer actually chose, not the fallback we queued.
    const said = (g.lastSpoken && g.lastSpoken.text) || m.text;
    this.current = {
      ...m, text: said, t: 0, life: Math.max(2.4, Math.min(7.5, dur || estimate(said))),
      speakerDef: sp,
    };
  }

  get portraitKey() {
    if (!this.current || !this.current.speakerDef.portrait) return null;
    const base = this.current.speakerDef.portrait;
    const t = this.current.t;
    // Mouth-ish animation: cycle expressions while talking, settle at the end.
    const talking = t < this.current.life - 0.5;
    const frame = this.current.mood !== undefined ? this.current.mood
      : (talking ? (1 + (Math.floor(t * 3.2) % 2)) : 0);
    return `${base}_${frame}`;
  }
}

function estimate(text) { return Math.max(2.2, Math.min(7, (text || '').length * 0.055 + 1.1)); }

function shuffled(n, rng) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
