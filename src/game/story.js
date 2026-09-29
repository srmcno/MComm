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
  // Whoever is on the end of the chainsaw. Not a character: a different one every time.
  victim: { name: 'STAFF MEMBER', portrait: null, color: [255, 118, 96], voice: 'victim' },
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
      L('ilsa', 'ilsa_level1', 'Wonderful. Now stop narrating, and learn to lead a missile on this floor while nothing important is on fire.'),
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
      L('ilsa', 'ilsa_story3_reply', 'Everybody is beautiful when they do math. You should try it some time. Lead your targets.'),
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
 * and the mute path). dismember, headshot, crawler, punt, headless, gibbed
 * and splat are the gore quips: a limb off, a head popped, a legless crawler,
 * a severed part booted across the room, a headless body still running, a
 * body that came apart all at once, and one thrown into a wall.
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
    'I came here to chew ass and kick gum. Fuck. Other way around. DOC. Which way is it?',
    "Bang. Motherfucker's gone. Somebody get the mop. Somebody get the mop AND a priest AND a guy who does taxes.",
    "That guy had a wife, two kids and a hovercraft lease. Now he's got a hole. Life's a real bitch, Doc.",
    "Human beings are ninety percent water. That guy was ninety percent gravy. I'm serious. Doc. Look at it.",
    'I put a hole through him so big I could see the guy behind him. The guy behind him waved. Very civil.',
    "Dead center. Okay, left of center. Okay, that was his elbow. He's dead, though. Elbow's a vital organ now.",
    "Bang, a sad little sigh, and one shoe flew off. It's always one shoe. Why is it always the one goddamn shoe?",
    'He said sorry on the way down. Sorry! Denise threw a lamp at my head and never once said sorry.',
    'Popping him was like popping bubble wrap. Bubble wrap with a dental plan. Goddamn, I love this job.',
    'He looked so disappointed going down. Same face my dates make when I order for them. I always order the fish.',
    'His badge said Ask Me About Safety. So I asked, with a gun. Guy did not know shit about safety.',
    "He didn't scream. He went huh, like a guy who found a quarter in the couch. Then he died. Huh.",
    "Best thing about a gun? It never asks for half the house. I'm looking at you, Marlene.",
    'He came at me with a stapler and clicked it. Twice. Real slow. It worked. I got scared. Bang.',
    "Goodnight, sweet prince. That's Shakespeare. I saw it. Fine, a guy described it to me at a bar.",
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
    'It looked at me like it wanted to hug me, mate with me, and file a complaint. In that order.',
    "I shot it in the face and it said 'thank you.' Doc, what the fuck kind of bunker is this?",
    'It had a second mouth in its stomach, and that mouth had a mustache. Put that in the report. Underline mustache.',
    "It smelled like a wet dog that sells insurance. Don't ask me how I know what that smells like.",
    "It curtsied right before I shot it. With every single leg. Doc, I think I'm the asshole here.",
    'Classic IT. Looked at me like I was the problem. So I turned it off. It did not turn back on.',
    "It was wearing a wedding ring. Somebody said yes to that. Good for it. Really. Fuck. I'm so happy for it.",
    'It dropped a keycard and half a sandwich with the crusts cut off. Somebody loved that thing. Or made it lunch. Same thing.',
    'That was not a man or a woman. That was two mailboxes and a sadness. I put it out of its misery.',
    "Something smaller just crawled out of the body. Nope. I don't do sequels. Nobody likes the sequel. Not even the studio.",
    "It looked normal from the neck up. That's worse. Give me tentacles. I know what to do with tentacles.",
    "It made a noise like a modem having a stroke. That's the same noise I make at parties. Nobody's ever helped.",
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
    'My podiatrist told me to stop kicking things. My podiatrist has not met this asshole.',
    "Sorry, reflex. I kick everything. Doors, vending machines, my brother-in-law. There's a form for it.",
    'That one was for Danny Kowalski. Ninth grade. The gym locker incident. You know what you did, Danny.',
    "One kick, he's down. Two kicks, he's out. Three kicks and I'm just being a dick. Four, and I might be the villain.",
    'Went straight for the nuts. No nuts. Just more elbow. Doc, I feel misled. A man should know where the nuts are.',
    "Where I'm from, a kick means hello. Also goodbye. Also 'get out of my truck.' You got all three.",
    "I wanted to shake your hand. You didn't really have one. So I improvised. With the boot. It was a firm shake.",
    'Coach Miller said I had no follow-through. Look at that. Right through the guy and into the wall.',
    'That sounded like a xylophone made of ribs. Doc, I think I just played Mozart. Encore?',
    'I tried teaching a guy to kick once. He lost a toe, a job and a wife. Blames me for all three. Fair.',
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
    'It went off like a chip bag at a funeral. Loud. Rude. Everybody looked. Nobody said anything.',
    'Oh, fuck, it got on the jacket. Dry clean only. And this is not dry. This is the opposite of dry.',
    'That head flew so far I heard it land in the next room. Then a scream. Sorry, whoever that was.',
    "First guy who ever looked up to me. And I stepped on his head. That's a pattern. Doc, tell me it's not a pattern.",
    "My boot's full of guy. I need a hose, a fresh sock and a long look in the mirror.",
    "My therapist says I should express my feelings. So I did. With my foot. She's going to be so proud.",
    'That was for the parking spot in nineteen ninety-four. Yes, you. I never forget a face. Or a Buick.',
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
    'Get me a notary. That needs to be stamped, framed and read at my funeral by a man in a really good hat.',
    'That was poetry. A sonnet written entirely in dead guys. Somebody frame it. Somebody frame the guys.',
    "I'm owed a parade. A small one. Two guys, a horse and a banner. Doc holds the horse.",
    "My old record was seven, and it's written on a bar tab in Duluth. I'm going back to update the tab.",
    "One kill for every finger I've got. Well, nine. The tenth is in a jar in Reno. Different story.",
    "Nobody clapped. All those dead and not one round of applause. Fine. I'll do it. Bravo, Brick.",
    "Boom, boom, boom. Nobody spoke, nobody made eye contact. It was like a men's room, but with fire.",
    "I've been saving a fuck yeah since nineteen ninety-four. Didn't wanna waste it on anything small. Fuck yeah.",
    'Killing in bulk, like a guy with a Costco card. Somebody hand me a free sample in a tiny paper cup.',
    "I love a big explosion more than I've loved most of my wives. That's in the divorce papers. Under grounds.",
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
    "Not one drop of sweat. Doc, smell the shirt. Actually, don't. Nobody smell the shirt.",
    "This isn't a fight anymore. It's a hobby. Like whittling, if whittling had a body count and better hair.",
    'Somebody owes me a raise. Hazard pay, dental, and a company car with a working cassette deck.',
    "I'm an artist. Like a piano player, if the piano was on fire and all the keys were guys.",
    "I'm gonna be known as the man who wouldn't die. Nobody's said it yet. I've been telling people to.",
    "They'll name something after me. A highway. A sandwich. A minor rash. I will honestly accept any of them.",
    'Kill after kill and not one tip. Unbelievable. I want to speak to their manager. Oh, wait. I killed him first.',
    "I've killed so many guys I forgot why I came in here. Was it milk? Doc, was it milk?",
    'Somebody make me a plaque. Brass, with my face on it. And under the face, one word. Yes.',
    "Brick Hardigan. Sounds like a guy who drives a Corvette. I drive a Ford. The name's doing a lot of work.",
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
    'OW! FUCK! Right in the tattoo! You killed the panther! You killed the goddamn panther!',
    'Fuck! You hit the pager! Somebody could be paging me right now! A woman! My mother! The dentist!',
    "Shit! You hit the wallet! The photo of the dog is in there! It's the only way I get to see him!",
    "Goddamn! That hurt worse than my third wife's mother, and she hit me with the casserole dish. With the casserole in it.",
    "AH! It went right through my arm! Wait. No. Just the jacket. Okay. Fuck. That jacket was leather. That's worse.",
    "Ow! That's not crying. That's my eyes leaking. It's a mechanical issue. Nobody write down that I cried.",
    "Ow! Oh, it's fine, don't apologize. Wait. You weren't going to. Shit. Fuck you, then.",
    "Ow, fuck! Right on the truck keys! I'm gonna have a bruise shaped like a Ford. Try explaining that at a pool.",
    "Goddamn it, that's the most anybody's touched me in months. I'm not saying I liked it. I'm saying I noticed.",
    "Nobody told me there'd be hitting! I read the brochure! It had a sunset and a guy with a margarita!",
    'Not in front of the lady. Be brave. Be a man. Be quiet. OW! FUCK! SHIT! Sorry, Doc. That was the other guy.',
    "Ow! That's the exact spot a guy hit me with a pool cue in Toledo! Doc, he's following me! He's here!",
    'Fuck! I paid a guy named Ray eighty dollars to make me bulletproof! He had a van! It said medical on the side, in marker!',
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
    'If I die, bury me with the truck. Standing up, like a horse. A horse with a bad transmission.',
    "There's a light. It's warm. It's bubbling. Doc, it's a hot tub. It's finally a hot tub. I'm going in.",
    "Doc, if I die, there's a storage unit in Boise. Burn it. Don't open it. Don't look. Burn it. Keep the jacket.",
    "Excuse me. Everybody. Quick favor. Could you please stop shooting at me for one minute? I'll owe you.",
    "Doc, lie to me. Tell me I look good and I'm gonna live. Use the voice you use on the reactor.",
    'Doc, tell Tammy I forgive her. Then tell her I want the Rolodex back. Then tell her fuck you.',
    "For my tombstone, put 'He tried.' No. 'He almost tried.' No. 'Sorry about the hair.' Yeah. That one.",
    "There's a tunnel. And at the end, a guy with a clipboard. I owe that guy money. Fuck, I owe everybody.",
    "I'm not dying. I'm regrouping. On the floor. With my eyes closed. It's a very tactical nap.",
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
    "I'm not saying I'm a detective. I'm saying I stared at a wall for a long time and it blinked first.",
    'Thirty years of leaning on things in bars, and finally it pays off. Put leaner on my resume.',
    'Doc, put strategic kicking in the report. Not panic kicking. Strategic. Underline it twice.',
    'Doc, sit down. I found a room. On my own. Take a minute. Cry if you need to.',
    "First I looked. Then I looked harder. Then I hit it with my boot. That's the scientific method.",
    'Everybody walked past this wall. Engineers. Scientists. Guys with clipboards. Guys with bigger clipboards. Then me. First try. Suck it, clipboards.',
    "Some say I got lucky. Luck is kicking one wall. Skill is kicking forty. The forty-first one opened. That's math.",
    "Fuck me, there's a whole room in here. Look at that. A room. I didn't even ask for a room. I just wanted to lean.",
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
    'Engraved on the stock. To Gerald, for thirty years of service. Gerald, you beautiful son of a bitch. You saved this for me.',
    "Good evening. My name is Brick. I'll be your shooter tonight. Can I start you off with some mutants?",
    "Doc, tell me I can keep it. Say yes fast. I've already told it about my mother.",
    "Cold to the touch, heavy in the hand, better in the dark. I'm describing the gun. I'm also describing Marlene.",
    'A safety switch. Cute. Never used one. Ask my ex-wives. Ask my dentist. Ask the emergency room in Reno.',
    'I want to hold you. I want to name you. I want to lose you in a divorce and buy you back at a pawnshop.',
    "Just so we're clear, gun, I'm not looking for anything serious. Just something loud. Oh, you're loud? Fuck. We're perfect.",
    'I was gonna grab the other one. But you looked lonely. Also the other one was on fire.',
    "Scratch on the barrel. I love a gun with a past. Denise had a past. She also had a warrant. That's chemistry.",
    "I'm going to be gentle. I'm going to take it slow. I'm going to take my time. Okay, I shot the ceiling. Sorry, ceiling.",
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
    "I had one job. Bring the bullets. Okay, two jobs. Bring the bullets and look good. I'm batting five hundred.",
    "Empty. Great. Now it's a very expensive stick. I'm a caveman with a warranty.",
    "Somebody's been in my ammo. Somebody ate the bullets and put the box back. That's a sick person.",
    "Out of ammo. It feels like showing up to a funeral in a swimsuit. I'm not saying it's happened. It's happened.",
    "The gun left me. No note. No nothing. I didn't even see it pack.",
    'I was saving one bullet for a special occasion. And I used it on a Tuesday. A fucking Tuesday.',
    'Somebody throw me anything. A pipe. A shoe. A small sad sandwich. Anything with edges.',
    "Empty. Don't panic. I've scheduled panic for four o'clock. What time is it? Fuck. It's four.",
    'Nothing in the chamber. Nothing in the clip. Nothing in my pockets. Nothing in the bank. Weird day. Consistent, though.',
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
    "There was a pretzel guy there. He knew me by name. Not my name. A name I'd used. Aw, fuck.",
    "I had a storage unit in that city. Trophies. Cassettes. A frozen wedding cake. Which wedding? I honestly can't remember.",
    "Something's wrong with my face. It's leaking. From the eyes. Doc, is that a thing? Is that sweat?",
    "Doc, are we the bad guys? Don't answer. Ask me after lunch. I'll have had a drink.",
    'Somewhere in that cloud is a woman named Lorraine who still has my leather jacket. Goodbye, Lorraine. Mostly goodbye, jacket.',
    'That was a shithole. But it was my shithole. There was a parrot at the pet store that said poor Brick every time I walked in.',
    "That city had a zoo with one monkey. He threw things at me every Sunday. I'm going to miss that monkey.",
    "Ma's cousin Dennis lived there. I never liked Dennis. He borrowed my ladder in nineteen ninety-one. Now I'll never get it back.",
    "I don't know what to feel. So I'm putting it in the drawer. With the divorces. It's a full drawer.",
    "I need a drink. I need a cheeseburger. I need a woman to tell me it's not my fault. I'll settle for the cheeseburger.",
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
    "Sky's full of nukes and one pigeon. Guess who I'm shooting first. Fuck that pigeon.",
    "Every one of those missiles knows exactly where it's going. God, I envy them. Now die, you beautiful bastards.",
    "I trained for this. Eleven dollars in quarters on a Missile Command machine in a Holiday Inn lobby. Nobody's more ready.",
    'Doc, cover your ears. Not for the missiles. For the language.',
    'Steady. Steady. Steady. Ah, fuck steady. Fire.',
    "Missile, missile, missile, and one little one. Who sends a little one? That's disrespect. That's personal.",
    'Somebody in a bunker just said launch. Somebody in this bunker just said fuck you. Very short conversation.',
    "Nobody's ever thrown me a surprise party. Now the whole sky's shown up with presents. I didn't even clean.",
    "Stay calm. I've survived worse. I once went to Marlene's baby shower. She wasn't pregnant. It was for the cat.",
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
    'Beautiful. Somewhere a guy in a lab coat is crying into a very expensive keyboard.',
    "I'd like to thank my mother, my barber and my hands. Not you, Roxanne. You know what you did.",
    'Every last one gone. Little pieces of them are drifting toward Nebraska right now. Sorry, Nebraska. Nice state. Great corn.',
    "That was better than sex. And that's not a brag. That's a medical concern.",
    'Give me a parade. Give me a plaque. Give me a reserved parking spot. Hardigan, with an I. Everybody forgets the I.',
    'Good work, me. Good work, hands. Left eye, great job. Right eye, we need to talk.',
    "If they made a movie of this, I'd play myself. The hair would need its own actor.",
    "Not a scratch on me. Look. Not one. Okay, that's a scratch. That one's old. That one's from Reno.",
    "Somebody buy this man a drink. Nobody? Okay. I'll buy me one. I've got great taste in men.",
    "The sky doesn't hold a grudge. Unlike my third wife. She keeps a list. She mails me updates.",
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
    "I once lost a fistfight to a vending machine. Rematch, I won. Mutter, you're just a vending machine with a god complex.",
    "I want to speak to your manager. Wait. It's you? Fuck. Fine. Then I want to speak to your mother. I've got notes.",
    "Mutter, you remind me of my third wife's lawyer. Lovely voice, no soul, took my good jacket.",
    "Mutter, would you mind holding, please? I need to fix my hair. Then I'll kill you. Thank you for your patience.",
    'Thank you for calling, Mutter. Your death is very important to us. Please stay on the line. Forever.',
    "That calm librarian voice doesn't scare me. Real librarians scare me. I've owed one four hundred dollars since nineteen ninety-one.",
    "It's okay, Mutter. You can say it. Nobody's listening. Just once. Say fuck. Say it for me.",
    "I've been yelled at by experts. My mother, four ex-wives and a manager at Chuck E. Cheese. You're not even on the list.",
    "Go on, do the menacing speech. I'll wait. I brought a chair. Take your time. Do the voice.",
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
    'Detachable! Nobody told me they came detachable!',
    'Pieces of shit. Plural. Look at all the pieces.',
    "Flat pack mutant. Some parts may be missing. That one. That one's missing.",
    'Say goodbye to your little friend!',
    "It's only a flesh wound! A big, floppy, flying flesh wound!",
    "Anybody lose a thing? I've got a thing here. It's still wet.",
    "Hold still, I'm redesigning you!",
    "Damn it, now there's two of you. One of you is just a lot smaller.",
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
    'Headshot! Somebody tell the scoreboard. And the janitor.',
    "Your head called. It's not coming back.",
    "Shit, that's a lot of skull. Where were you keeping all that?",
    'Pop! Like bubble wrap full of bad decisions.',
    "That's what you get for thinking. Nobody asked you to think.",
    "Well, that's a weight off your shoulders.",
    'Bless you! Wow. That was a big one.',
    "Somebody's gonna need dental records. And a mop. And a bigger mop.",
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
    'Look at you, doing the worm. Nobody asked for the worm.',
    'Guess somebody skipped leg day. Permanently.',
    "Shit, he's gaining on me. Slowly. Very, very slowly.",
    "Keep crawling, sport. You'll make it by Christmas.",
    'Aw, he wants a hug. Nope. No. Bad crawler.',
    'Half the man he used to be, and twice the attitude.',
    "It's like one of those robot vacuums. One that hates me.",
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
    'And the kick is up! And it is gross!',
    'Hardigan scores! The crowd goes wild! The crowd is also dead!',
    'Goal! Get the hell in there! Goal!',
    "Man, I miss football. This is almost as good. It's wetter.",
    'Somebody catch that! No? Okay. Nobody catch that.',
    'Instant replay! Look at that spiral!',
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
    'Somebody get this man a sneaker deal!',
    "Damn, he's faster without it. Should I try that? No. No, Brick.",
    "No head, no problem. That's the spirit, buddy.",
    "Left! Left! Your other left! Ah, he can't hear me.",
    "He's looking for his head. With what, buddy? With what?",
    "That's the most productive thing he's done all day.",
  ],
  gibbed: [
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
  splat: [
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

/** MUTTER on the mess, now and then, after Brick has had his say about it. */
export const MUTTER_GORE = [
  'Cleanup requested on this level. The cleanup crew is also on this level. In several places.',
  'That was a biohazard. It is now several smaller biohazards. Thank you, warden.',
  'Please return all limbs to their original owners, or to lost property.',
  'Your conduct has been logged under enthusiasm, excessive.',
  'The cleaning budget for this quarter was nineteen dollars. You have spent it.',
  'I have added the ceiling to the cleaning rota. I never expected to say that.',
  'Warden, please stop sorting the staff by size.',
  'Health and safety would like a word. Health and safety is on the wall behind you.',
];

/** Ilsa on the mess. She swears in German, which he does not notice. */
export const ILSA_GORE = [
  'Hardigan, that was a person. Mostly. Now it is several.',
  'Scheisse. I will be seeing that when I close my eyes.',
  'Please stop playing with them. They are not toys, they are evidence.',
  'I designed that gun to shoot down missiles, not to make soup.',
  'Mein Gott. Why is there something on the ceiling? Why is it waving?',
  'You are enjoying this far too much, Hardigan.',
  'I have a camera in that corridor. I am turning it off now.',
  'Hardigan, wipe your visor. You are dripping on my floor plans.',
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

  /**
   * Drop everything below priority `p`, the line on air included (and its
   * voice with it). The player dying keeps the death exchange this way, and
   * nothing that was waiting in front of it.
   */
  keepAbove(p) {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if ((this.queue[i].priority || 0) < p) this.queue.splice(i, 1);
    }
    if (this.current && (this.current.priority || 0) < p) {
      const talking = this.current.job ? this.ownsVoice(this.current) : true;
      this.current = null;
      this.cooldown = 0.28;
      if (talking) this.cancelVoice();
    }
  }

  /**
   * MUTTER took the floor with something that matters more (a warning): the
   * line on air has lost its voice, so it gives up the portrait as well, and
   * goes back in the queue to be said whole later if it had barely started.
   */
  yieldFloor() {
    const m = this.current;
    if (!m) return;
    this.current = null;
    this.cooldown = 0.28;
    if (m.t < m.life * 0.5) {
      this.queue.unshift({ speaker: m.speaker, key: m.key, text: m.text, priority: m.priority,
        args: null, delay: 0.3, exact: true });
      if (this.queue.length > 3) this.queue.length = 3;
    }
  }

  cancelVoice() {
    const v = this.game && this.game.vox;
    if (v && v.cancel) { try { v.cancel(); } catch { /* the mute path is fine */ } }
  }

  /**
   * The game paused mid-line. The browser's speech engine runs on its own
   * clock, not the game's, so it has to be stopped outright; the line goes
   * back on the front of the queue so it is heard whole on resume, unless it
   * was nearly finished anyway.
   */
  hold() {
    const m = this.current;
    this.current = null;
    if (m && m.t < m.life * 0.7) {
      this.queue.unshift({ speaker: m.speaker, key: m.key, text: m.text, priority: m.priority,
        args: null, delay: 0.3, exact: true });
      if (this.queue.length > 3) this.queue.length = 3;
    }
    this.cancelVoice();
  }

  /** Whether the voice engine is still audibly on the line. */
  voiceBusy() {
    const v = this.game && this.game.vox;
    try { return !!(v && v.busy); } catch { return false; }
  }

  /**
   * Whether the voice still talking is this line's own, and not a line that
   * started after it (MUTTER's game over card, a warning that cut in).
   */
  ownsVoice(c) {
    if (!this.voiceBusy()) return false;
    const g = this.game;
    return !c.job || !g || !g.voxJob || g.voxJob === c.job;
  }

  /**
   * @param {string} speaker  brick | ilsa | mutter
   * @param {string} key      announcer line key
   * @param {string} text     fallback text, also the subtitle
   * @param {object} opts     {once, priority, delay, args}
   */
  say(speaker, key, text, opts = {}) {
    const tag = opts.once ? key + '|' + (text || '').slice(0, 24) : null;
    if (tag && this.said.has(tag)) return false;
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
    if (this.queue.length > 2) {
      // Full: the least important waiter makes room, the oldest of them first,
      // so the plot never loses its place in line to banter.
      let w = 0;
      for (let i = 1; i < this.queue.length; i++) if ((this.queue[i].priority || 0) < (this.queue[w].priority || 0)) w = i;
      if ((this.queue[w].priority || 0) > pr) return false;
      this.queue.splice(w, 1);
    }
    if (tag) this.said.add(tag);
    this.queue.push({ speaker, key, text, priority: pr, args: opts.args, pick: opts.pick, delay: opts.delay || 0, exact: !!opts.exact });
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

  /**
   * The distraction gag: he says a thing, she answers, sometimes he doubles
   * down. With the recorded cast speaking, only exchanges it has takes of
   * are played, each once, so the joke never switches voices halfway.
   */
  distract() {
    const v = this.game.vox;
    let set = DISTRACTED[this.distractIdx % DISTRACTED.length];
    if (v && v.acted && typeof v.canVoice === 'function') {
      const said = (s) => s.every((line, j) => v.canVoice(j === 1 ? 'ilsa' : 'brick', line));
      while (this.distractIdx < DISTRACTED.length && !said(DISTRACTED[this.distractIdx])) this.distractIdx++;
      if (this.distractIdx >= DISTRACTED.length) return false;
      set = DISTRACTED[this.distractIdx];
    }
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
      const c = this.current;
      if (c.job && !c.job.fired) {
        // Handed to the voice, which is still finishing somebody else's line:
        // the clock, the portrait and the caption wait until this one starts.
        // A line the engine threw away (a warning cut in, or took its place in
        // the engine's queue) never starts, and nobody heard it, so it goes
        // back in line to be said whole. A line that went nowhere for another
        // reason gets one more try, then the next one goes.
        c.wait = (c.wait || 0) + dt;
        const busy = this.voiceBusy();
        if (c.job.fired) { this.onAir(c); return; }
        if (c.job.dropped || !busy || c.wait > 15) {
          const tries = (c.tries || 0) + 1;
          this.current = null;
          this.cooldown = 0.28;
          if (tries <= (c.job.dropped ? 3 : 1) && c.wait <= 15) {
            this.queue.unshift({ speaker: c.speaker, key: c.key, text: c.text, priority: c.priority,
              args: null, delay: 0.4, exact: true, tries });
            if (this.queue.length > 3) this.queue.length = 3;
          }
        }
        return;
      }
      c.t += dt;
      if (c.t >= c.life) {
        // The caption's clock is an estimate and the voice is the truth: a
        // natural voice can run long, and the next speaker must not start
        // over the end of it. Hold the floor while it talks, within reason.
        if (c.t < c.life + 4 && this.ownsVoice(c)) return;
        if (c.natural && !c.closed) this.game.sound.sfx('radio_close', { vol: 0.42 });
        this.current = null;
        this.cooldown = 0.28;
        return;
      }
      // A browser voice is studio-clean, and Ilsa is on a radio in a reactor
      // core. A little crackle now and then puts her back there.
      // She keys off when she stops talking, not when the caption's estimate
      // runs out. Only for a browser voice: the formant Ilsa carries her own
      // squelch tail, and with the voice OFF a click after a silent caption is
      // just a click.
      if (c.natural && !c.closed && c.t > 0.6 && !this.ownsVoice(c)) {
        c.closed = true;
        this.game.sound.sfx('radio_close', { vol: 0.42 });
      }
      if (c.crackleAt !== undefined && !c.closed && c.t >= c.crackleAt && c.t < c.life - 0.5) {
        this.game.sound.sfx('radio_static', { vol: 0.13 });
        c.crackleAt += 1.6 + this.game.rng() * 1.8;
      }
      return;
    }
    if (this.cooldown > 0 || !this.queue.length) return;
    // Somebody (MUTTER on the tannoy, usually) still has the floor. Wait for
    // it so the caption and the voice arrive together, but not forever, and
    // not at all for anything urgent: a stuck engine must not gag the plot.
    // Urgent means it would take the floor anyway. A line that could only
    // queue behind the voice (MUTTER's game over card) waits here instead,
    // where the portrait and the caption can wait with it.
    const g = this.game;
    let top = -Infinity;
    for (let i = 0; i < this.queue.length; i++) top = Math.max(top, this.queue[i].priority || 0);
    const busy = this.voiceBusy();
    const urgent = top >= 5 && top > ((g && g.voxFloor) || 0);
    if (busy && !urgent && (this.floorWait || 0) < 6) {
      this.floorWait = (this.floorWait || 0) + dt;
      return;
    }
    this.floorWait = 0;
    const m = this.queue.shift();
    if (m.delay > 0) { m.delay = 0; this.cooldown = 0.3; this.queue.unshift(m); return; }
    const sp = SPEAKERS[m.speaker] || SPEAKERS.mutter;
    const dur = g.speakAs(sp.voice, m.exact ? null : m.key, m.text, m.args, m.pick, m.priority);
    // Show the line the announcer actually chose, not the fallback we queued.
    const said = (g.lastSpoken && g.lastSpoken.text) || m.text;
    const natural = m.speaker === 'ilsa' && dur > 0 && !!g.vox && g.vox.engine === 'natural';
    this.current = {
      // A long transmission is allowed its length; the old 7.5 s cap cut the
      // caption (and the portrait's mouth) off while the voice went on.
      ...m, text: said, t: 0, life: Math.max(2.4, Math.min(14, dur || estimate(said))),
      speakerDef: sp,
      natural,
      crackleAt: natural ? 0.8 + g.rng() * 1.2 : undefined,
      // A line the engine refused outright still carries its job, marked
      // dropped, so update() can put it back in line rather than caption it.
      job: dur > 0 || (g.lastVoiceJob && g.lastVoiceJob.dropped) ? g.lastVoiceJob || null : null,
    };
    if (!this.current.job || this.current.job.fired) this.onAir(this.current);
  }

  /** The line is audible: key the radio (Ilsa is on one) and take its real length. */
  onAir(c) {
    if (c.speaker === 'ilsa') this.game.sound.sfx('radio_open', { vol: 0.5 });
    if (c.job && c.job.dur > 0) c.life = Math.max(2.4, Math.min(14, c.job.dur));
  }

  get portraitKey() {
    if (!this.current || !this.current.speakerDef.portrait) return null;
    if (this.current.job && !this.current.job.fired) return null;   // still waiting for the floor
    const base = this.current.speakerDef.portrait;
    const t = this.current.t;
    // Mouth-ish animation: cycle expressions while talking, settle at the end.
    const talking = t < this.current.life - 0.5;
    const frame = this.current.mood !== undefined ? this.current.mood
      : (talking ? (1 + (Math.floor(t * 3.2) % 2)) : 0);
    return `${base}_${frame}`;
  }
}

function estimate(text) { return Math.max(2.2, Math.min(9, (text || '').length * 0.055 + 1.1)); }

function shuffled(n, rng) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
