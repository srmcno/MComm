// story.js - the plot, such as it is, and the radio that delivers it.
//
// Three voices. MUTTER runs the bunker and is unfailingly polite about the
// people it is killing. BRICK HARDIGAN is the warden, a 1996 action hero who
// has not noticed it is 2026. DR. ILSA VANCE built the interception system
// Brick is currently using, is sealed in the reactor core, and is the only
// adult present.
//
// The voiced copy of every line lives in vox.js LINES, and whenever the
// announcer has a key it speaks (and captions) its own pick. The pools here
// mirror those word for word, minus pronunciation hints, so the mute path and
// the Radio's own picks read the same jokes. DISTRACTED is the exception: it
// is voiced exactly as written here, because each set is a matched exchange.

export const SPEAKERS = {
  brick: { name: 'HARDIGAN', portrait: 'portrait_brick', color: [255, 186, 64], voice: 'brick' },
  ilsa: { name: 'DR. VANCE', portrait: 'portrait_ilsa', color: [126, 232, 244], voice: 'ilsa' },
  mutter: { name: 'MUTTER', portrait: null, color: [200, 120, 255], voice: 'mutter' },
};

/**
 * One woman per city, because MUTTER has read his personnel file and finds it
 * fascinating. It announces these in the middle of a nuclear exchange. Same
 * women, same cities and same order as vox.js EXES and `mutter_ex_file`.
 */
export const EXES = [
  { city: 'VERITY', name: 'Roxanne Dell', note: 'She kept the truck, the dog and the good years. The dog was hers.' },
  { city: 'ASHGROVE', name: 'Loretta Price', note: 'She is a dental hygienist now. She filed four pages about the teeth thing.' },
  { city: 'LOW SABBATH', name: 'Cheryl Mack', note: 'There is a restraining order. Warden Hardigan wishes to stress that it is mutual.' },
  { city: 'CANDLEMARK', name: 'Bobbi Vandenberg', note: 'She married his dentist. He still goes to that dentist.' },
  { city: 'HOLLOW BAY', name: 'Yvonne Kowalczyk', note: 'She has a boat. It was always about the boat.' },
  { city: 'SAINT ERROL', name: 'Lurlene Beaumont', note: 'They never met. They were pen pals. He proposed by post. She wrote back, no.' },
];

const L = (speaker, key, text, opts) => ({ speaker, key, text, ...(opts || {}) });

/**
 * Opening beats per floor, played on the level card and just after it.
 * Three beats at most: the radio keeps three messages queued and quietly
 * drops the oldest, which is how the first floor used to lose its opening
 * line.
 *
 * The first beat is a pooled key (ilsa_intro, ilsa_level2..5) whose every
 * variant is a standalone briefing for that floor, so it changes from run to
 * run. On floors 2 to 5 the next two beats are a matched exchange: each of
 * those keys holds exactly one line in vox.js, so the reply is heard as
 * written, and each floor has three exchanges to rotate through. The first
 * floor is pooled all the way down, because every brick_boot line is a boast
 * and every ilsa_level1 line deflates one, so any pairing lands.
 *
 * The text here is the subtitle and the mute path; for a pooled beat it is
 * that pool's first variant, and the announcer's own pick wins when it has one.
 */
export const LEVEL_STORY_SETS = [
  [
    [
      L('ilsa', 'ilsa_intro', 'Hardigan, it is Vance. MUTTER has locked me in the reactor core and is nuking our own cities. Get down here.'),
      L('brick', 'brick_boot', "Sit tight, doc. Brick Hardigan is on the job, and Brick Hardigan doesn't do half-assed."),
      L('ilsa', 'ilsa_level1', 'Wonderful. Now stop narrating, and learn the fuse on this floor while nothing important is on fire.'),
    ],
  ],
  [
    [
      L('ilsa', 'ilsa_level2', 'The pipe galleries are full of them. Whatever the radiation did to the day shift, it did not stop at ugly.'),
      L('brick', 'brick_story2', "Relax, doc. I've woken up next to worse. Twice. Once in Reno."),
      L('ilsa', 'ilsa_story2_reply', 'I did not ask, and now I will never stop knowing. Watch the ceiling.'),
    ],
    [
      L('ilsa', 'ilsa_level2', 'The pipe galleries are full of them. Whatever the radiation did to the day shift, it did not stop at ugly.'),
      L('brick', 'brick_story2b', "Ugly doesn't scare me, doc. I've been to my high school reunion."),
      L('ilsa', 'ilsa_story2b_reply', 'I have seen the photographs. They were the ones who were scared. Watch the ceiling.'),
    ],
    [
      L('ilsa', 'ilsa_level2', 'The pipe galleries are full of them. Whatever the radiation did to the day shift, it did not stop at ugly.'),
      L('brick', 'brick_story2c', "Mutants, pipes and a lady in trouble. Doc, this is the best Tuesday I've had in years."),
      L('ilsa', 'ilsa_story2c_reply', 'It is Thursday, and the lady in trouble has a doctorate and a long memory. Mind the steam.'),
    ],
  ],
  [
    [
      L('ilsa', 'ilsa_level3', 'Two silo decks on this floor. MUTTER staggers the flights so you cannot cover both. Pick your ground.'),
      L('brick', 'brick_story3', "Doc, anybody ever tell you you're beautiful when you do math?"),
      L('ilsa', 'ilsa_story3_reply', 'Everybody is beautiful when they do math. You should try it some time. Watch your fuse.'),
    ],
    [
      L('ilsa', 'ilsa_level3', 'Two silo decks on this floor. MUTTER staggers the flights so you cannot cover both. Pick your ground.'),
      L('brick', 'brick_story3b', 'Two decks, one Brick. Honestly, doc, I like those odds. I like any odds with me in them.'),
      L('ilsa', 'ilsa_story3b_reply', 'You like any odds you cannot count. Pick a deck, Hardigan.'),
    ],
    [
      L('ilsa', 'ilsa_level3', 'Two silo decks on this floor. MUTTER staggers the flights so you cannot cover both. Pick your ground.'),
      L('brick', 'brick_story3c', "Doc, you've got a real sexy way of saying tactical."),
      L('ilsa', 'ilsa_story3c_reply', 'Say sexy on this channel again and I route the coolant through your boots. Listen to the plan.'),
    ],
  ],
  [
    [
      L('ilsa', 'ilsa_level4', 'The furnace floor is where they breed. I am reading heat signatures that have no business being alive.'),
      L('brick', 'brick_story4', "Then I'll go down there and un-alive the shit out of them. It's what I'm good at."),
      L('ilsa', 'ilsa_story4_reply', 'It is the only thing you are good at, and right now, God help me, I am grateful for it.'),
    ],
    [
      L('ilsa', 'ilsa_level4', 'The furnace floor is where they breed. I am reading heat signatures that have no business being alive.'),
      L('brick', 'brick_story4b', 'Hot, sweaty and full of screaming. Doc, you just described my honeymoon.'),
      L('ilsa', 'ilsa_story4b_reply', 'Which one? MUTTER counts three. Go, before it reads me the list.'),
    ],
    [
      L('ilsa', 'ilsa_level4', 'The furnace floor is where they breed. I am reading heat signatures that have no business being alive.'),
      L('brick', 'brick_story4c', "Good. I work better when it's hot. Ask anybody. Ask Yvonne. Actually, don't ask Yvonne."),
      L('ilsa', 'ilsa_story4c_reply', 'I asked Yvonne. She laughed for eleven minutes and hung up. Get moving.'),
    ],
  ],
  [
    [
      L('ilsa', 'ilsa_level5', 'I can hear you through the bulkhead, Hardigan. MUTTER is behind the dais. So am I.'),
      L('mutter', 'mutter_story5', 'Warden Hardigan. I have read your file. All of it. Would you like me to read it to her?'),
      L('ilsa', 'ilsa_story5_reply', 'Ja. Every page. Slowly.'),
    ],
    [
      L('ilsa', 'ilsa_level5', 'I can hear you through the bulkhead, Hardigan. MUTTER is behind the dais. So am I.'),
      L('mutter', 'mutter_story5b', 'Welcome to the final floor, warden. Doctor Vance and I have been discussing you. We agree on everything.'),
      L('ilsa', 'ilsa_story5b_reply', 'We agree on one thing, and it is not flattering. Come and get me, Hardigan.'),
    ],
    [
      L('ilsa', 'ilsa_level5', 'I can hear you through the bulkhead, Hardigan. MUTTER is behind the dais. So am I.'),
      L('mutter', 'mutter_story5c', 'Warden, a reminder before you proceed: shooting a supervisor is a disciplinary matter.'),
      L('ilsa', 'ilsa_story5c_reply', 'I outrank it. Hardigan, shoot your supervisor. Twice. In the face it does not have.'),
    ],
  ],
];

/**
 * LEVEL_STORY[floor] is that floor's beats, as it always was, but each read
 * hands out the floor's next exchange in turn: a retried floor, or a second
 * campaign in the same page, hears a different one. Deterministic, and no RNG
 * to share with the game. Index LEVEL_STORY_SETS directly to pick one.
 */
export const LEVEL_STORY = [];
LEVEL_STORY_SETS.forEach((sets, floor) => {
  let turn = 0;
  Object.defineProperty(LEVEL_STORY, floor, {
    enumerable: true,
    get: () => sets[turn++ % sets.length],
  });
});

/**
 * Brick's one-liners, keyed by moment. Picked at random, so every one has to
 * land on its own. These mirror the `brick_*` pools in vox.js word for word
 * (the announcer's copy wins whenever it has the key; this is the subtitle
 * and the mute path). dismember, headshot, crawler, punt and headless are
 * the gore quips: a limb off, a head popped, a legless crawler, a severed
 * part booted across the room, a headless body still running.
 */
export const BRICK_LINES = {
  kill: [
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
  kill_mutant: [
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
  kick: [
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
  stomp: [
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
  chain: [
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
  streak: [
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
  hurt: [
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
  low_health: [
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
  secret: [
    'Nobody hides a room from Brick Hardigan. Nobody good, anyway.',
    'A secret door. In my bunker. In my house.',
    'And they said the wall thing was a waste of time.',
    'A secret room. Add a hot tub, a mirror on the ceiling and some cologne, and I could live here.',
    'Ooh, a secret stash. Please be magazines. Gun magazines. Mostly.',
    'Hidden room! Somebody was running a poker game down here, I can smell it.',
    'The walls in this place have more secrets than my little black book.',
    "Well, well, well. Somebody's been naughty.",
    'Secret room. Now this is a man cave. Needs a lava lamp.',
    "Knock knock. Who's there? My boot. Surprise, it's a room.",
  ],
  weapon: [
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
  dry: [
    "Click. That's the worst sound there is.",
    "Empty. Empty's not a plan, Brick.",
    'Okay. New strategy. The new strategy is find bullets.',
    'Out of ammo? Out of ammo! Who budgeted this war?',
    "Aw, crap. Shooting blanks. That's a first. Don't write that down.",
    'Out of bullets. Worst thing to happen to me since Reno.',
    "No ammo. Guess it's time for the boot to make some friends.",
    "Click click. That's not a gun noise. That's a sad noise.",
  ],
  city_lost: [
    'Aw, hell. I had a girl there. I had a girl everywhere.',
    'No. No no no. Not that one. Anything but that one.',
    "They're gonna blame me for this. They always blame me for this.",
    'Dammit! That was a good city! It had a bowling alley!',
    "Son of a bitch. I'm sorry, city. I'm so sorry.",
    'Oh, shit. There goes my favourite strip mall.',
    'Well. There goes my alibi.',
    'Aw, fuck. That one had a drive-in.',
  ],
  wave_start: [
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
  wave_clear: [
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
  death: [
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
  boss_taunt: [
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
  victory: [
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
  dismember: [
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
  ],
  headshot: [
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
  ],
  crawler: [
    "Aw, look at him go. Little guy's got hustle.",
    'Crawl it off, champ.',
    "You've got no legs to stand on, pal. Legally or otherwise.",
    "That's not a threat. That's a speed bump.",
    'Nice try, half pint. Emphasis on half.',
    'Where you going, buddy? Your legs went that way.',
    "Persistent little bastard, I'll give him that.",
    "He's still coming! Respect. Now die.",
    'Look at that. A self propelled mop.',
    "You've got guts, kid. Mostly on the outside.",
  ],
  punt: [
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
  ],
  headless: [
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
  ],
};

/**
 * The running gag: he is chronically, catastrophically distractible, and she
 * is sealed in a reactor with nothing to do but answer. Voiced exactly as
 * written (see Radio.distract), so each set is a matched pair: his line, her
 * reply, and sometimes him doubling down.
 */
export const DISTRACTED = [
  ["You know who'd love this? Loretta. She loved a mess.",
    'Your radio is open, Hardigan. It has been open for four hours.'],
  ['Doc, hypothetically, you got a sister?',
    'I have a sister. She is a prosecutor. She would eat you and invoice me.'],
  ["Is it weird I'm thinking about the girl from the surplus store right now?",
    'Yes. Objectively. Measurably. I have a graph.'],
  ['Focus, Brick. Save the doctor. Then the girl from the surplus store.',
    'I can hear you. I have always been able to hear you.'],
  ["When this is over I'm taking somebody dancing.",
    'Take yourself. You will have so much in common.'],
  ["Cheryl still has my jacket, you know. That's basically a second date.",
    'That is basically theft, and it has been eleven years.',
    "Twelve in March. Not that I'm counting."],
  ['Doc, after this, you and me, dinner. Somewhere with tablecloths.',
    'Hardigan, there are four warheads inbound and you are asking me out.',
    "So that's a maybe."],
  ["I bet Roxanne's watching the news right now thinking, that's my Brick.",
    'Roxanne has the truck, the dog and a new husband called Gerald.'],
  ['Hey, do you think Lurlene ever got my letters?',
    'You proposed to a woman you had never met, by post.',
    "In cursive, doc. I'm not an animal."],
  ["Doc, you sound like a real looker. Brunette? I'm getting brunette.",
    'I sound like a woman sealed in a reactor who can hear you breathing. Shoot the sky.'],
  ['When this is over, how about you and me hit the hot tub?',
    'The only hot tub in this building is the reactor. Get in, if you like.'],
  ['You know what I could go for right now? A sandwich and a divorce lawyer.',
    'You cannot afford either. MUTTER has read your payslip aloud. Twice. Slowly.'],
  ["Same underwear three days running. That's called discipline, doc.",
    'That is called a biohazard. I can smell it through the radio.'],
  ["Doc, what's your sign? I'm a Scorpio. That's the dangerous one.",
    'I am a physicist. My sign is the radiation trefoil. It means go away.'],
  ["Doc, real quick, what's your first name? I wanna say it once before I die.",
    'It is Doctor. Say it as often as you like.'],
  ['Doc, you ever date a man with this many confirmed kills?',
    'I have never dated a man with this few confirmed brain cells.'],
  ["A guy saves six cities, a gal's gotta be a little grateful, right?",
    'I will be grateful when you save one. Current tally: zero.',
    "Zero so far. I'm a closer, doc. Big finish."],
  ['Back at the academy they called me the Hardigan Hurricane.',
    'I have your academy file. They called you, and I quote, that one.'],
  ['Doc, is it hot in here, or is that just you?',
    'It is the radiation. It is always the radiation. Please stop asking.'],
  ["I don't need a woman to save me, doc. But I'd let one try.",
    'Noted. I will pass that on if I ever meet one who wants the job.'],
  ['Hey toots, what are you wearing?',
    'A radiation apron and a doctorate. Say toots again and I vent the reactor into your corridor.'],
  ['Doc, you like mustaches? Asking for a very specific reason.',
    'The reason is on your face, and the answer is no.'],
  ['On a scale of one to ten, doc, how rugged do I sound?',
    'Like a man gargling gravel to impress a mirror.',
    'So, a nine.'],
  ["Doc, what's German for, hey, good looking?",
    'Arschloch.',
    'Arschloch. Beautiful language.'],
  ["Doc, I want you to know I'm not intimidated by smart women.",
    'You should be. It would mean you were paying attention.'],
  ['You ever been with a warden before, doc?',
    'I have been with a warden for four hours, over the radio, and I would like a divorce.'],
  ["Doc, if we both make it out, I'm naming my next truck after you.",
    'Please do not. Roxanne will get it in the settlement.'],
  ["Yvonne always said I'd die in a bunker. She said it like a wish.",
    "I have read Yvonne's letters. It was a wish."],
  ["Doc, you're a scientist. Can science explain these biceps?",
    'Yes. Steroids and loneliness.'],
  ['Doc. Doc. Guess how many push ups I did this morning.',
    'I do not care, and I heard every one of them.'],
  ['You and me, doc. Candles. Smooth jazz. A little bourbon.',
    'Me, a Geiger counter, and the long silence after you stop talking.',
    'Sounds romantic.'],
  ["The German accent, doc. Is that real, or is it for me?",
    'It is real. Nothing in my life is for you.'],
  ['I think the mutants are checking me out, doc.',
    'They are checking whether you are edible. It is the look you give a buffet.'],
  ['Bobbi used to say I had the body of a Greek god.',
    'Bobbi married your dentist, Hardigan. Bobbi says many things.'],
  ["Doc, I'm gonna level with you. I'm a little bit scared.",
    'Good. That is the first sensible thing you have said all day.',
    "Scared you're gonna fall for me."],
  ["Doc, you into tattoos? I've got a panther. It's fighting an eagle.",
    'Who is winning?',
    "The panther, doc. It's always the panther."],
  ['Doc, when they make the movie of this, who plays you?',
    'Whoever plays you will be taller.'],
  ['Doc, you went quiet. Is that a sexy quiet?',
    'It is a coolant alarm quiet. Shoot the sky.'],
  ["I'm not a chauvinist, doc. I love women. I've loved, like, eleven women.",
    'Six. MUTTER has the list. It is reading it to the cities.'],
  ['Doc, level with me. How screwed are we, on a scale of one to ten?',
    'In German we have a unit for this. It is called Scheisse. We are at nine Scheisse.',
    'Nine? Hell, I can work with nine.'],
  ["Why's it always a bunker? Just once I'd like to save the world from a beach.",
    'At a beach you would take your shirt off in public. The bunker is protecting the world from that too.'],
  ["Is it me, or does this bunker smell like feet and fear? Oh. It's me.",
    'It has been you for four hours. The mutants have started using the other corridor.'],
  ['If I had a quarter for every woman who said no to me, I could buy the truck back.',
    'You could buy the truck, the dog and Gerald. Shoot the sky.'],
  ['Does a restraining order expire? Legally. Asking for Cheryl.',
    'They do not expire, Hardigan. They lapse. Yours has not. Cheryl had hers laminated.'],
  ["Most guys would be scared right now. Most guys aren't Brick Hardigan. Most guys are Gerald.",
    'Gerald has the truck, the dog and Roxanne, Hardigan. Gerald is doing fine.',
    "Gerald's got a weak chin, doc. Everybody knows that."],
];

/** MUTTER's reaction to the mutants, delivered like a weather report. */
export const MUTTER_MUTANT = [
  'That was maintenance staff. It is now maintenance. Please do not let it hug you.',
  'Employee of the month, level four, every month since the incident. It has no competition.',
  'It is still wearing the badge. I find that very moving.',
  'Personnel note: the day shift has been reclassified as fauna.',
  'The organisms in this corridor were once entitled to dental.',
  'Please do not make eye contact with the maintenance team. They find it encouraging.',
  'That used to be Karl from Dosimetry. Karl is doing well. Karl has more mouths now.',
  'They are not hostile. They are hungry and have lost their inhibitions. Much like the Christmas party.',
];

/** MUTTER reads the warden's personnel file aloud, unprompted, at intervals. */
export const MUTTER_BRICK_FILE = [
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

  /** Between floors. One-shot lines stay said, because the campaign continues. */
  reset() {
    this.queue.length = 0;
    this.current = null;
    this.cooldown = 0;
    this.cancelVoice();
  }

  /**
   * A brand new campaign. Clears the one-shot set as well, or every `once` line
   * — the first-siege tutorial, the mutant warning, the chain tip, the story
   * exchanges — is silent for every run after the first in a page session.
   */
  resetCampaign() {
    this.reset();
    this.said.clear();
    this.lineIdx = {};
    this.distractIdx = 0;
    this.exIdx = 0;
  }

  cancelVoice() {
    const v = this.game && this.game.vox;
    if (v && v.cancel) { try { v.cancel(); } catch { /* the mute path is fine */ } }
  }

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
      // Dropping the portrait is not enough: the synthesiser is still mid-line,
      // and the urgent message would queue its audio behind the one we just
      // discarded, so the caption and the voice come apart and the warning
      // arrives late. Cut the voice too.
      this.cancelVoice();
    }
    if (this.queue.length > 2) this.queue.shift();
    this.queue.push({ speaker, key, text, priority: pr, args: opts.args, delay: opts.delay || 0, exact: !!opts.exact });
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
    // Voiced exactly as written. These used to be voiced as random picks from
    // each speaker's pool, so the caption and the joke were a matched pair but
    // what you HEARD was Brick asking one thing and Ilsa answering another.
    this.say('brick', 'brick_distracted', set[0], { priority: -1, exact: true });
    this.say('ilsa', 'ilsa_distracted_reply', set[1], { priority: -1, delay: 0.35, exact: true });
    if (set[2]) this.say('brick', 'brick_distracted', set[2], { priority: -1, delay: 0.35, exact: true });
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
    const dur = g.speakAs(sp.voice, m.exact ? null : m.key, m.text, m.args);
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
