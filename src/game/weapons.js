// weapons.js - the arsenal.
//
// Point and it hurts. The Widow and the Naildriver are hitscan, for the things
// walking around on your deck. The flak launchers, the Splitter and the Halo,
// are for the sky: their shells carry a proximity fuse and burst on the first
// thing they meet or pass close to (a warhead, a body, a wall), so a shot at a
// missile is about leading it, not dialling a range.

export const AMMO_FLAK = 'flak';
export const AMMO_NAIL = 'nail';
export const AMMO_CHARGE = 'charge';
export const AMMO_BOMB = 'bomb';

export const WEAPONS = {
  pistol: {
    id: 'pistol', slot: 1, name: 'THE WIDOW',
    blurb: 'A hand cannon with a grudge. Bottomless, loud, and it pops heads.',
    // Hitscan and bottomless (cost 0): the gun you always have has to kill
    // what is in front of it. A shot to the head does headMul times the damage.
    kind: 'kinetic', vm: 'pistol',
    ammo: AMMO_FLAK, cost: 0, refire: 0.30,
    range: 42, damage: 34, headMul: 2.2, spread: 0.006, pellets: 1,
    kick: 5.2, shakeAmount: 0.6, flash: 'flash_small', light: [1.0, 0.72, 0.34],
    sfx: 'widow_fire',
    // What a hit does to a body: chance the part it hit comes off, the extra
    // chance for the head, how many parts one hit may take, the shove, and the
    // force at which the whole thing goes.
    gore: { sever: 0.8, head: 1.0, parts: 1, knock: 9, gib: 0, lift: 2.5 },
  },
  splitter: {
    id: 'splitter', slot: 2, name: 'THE SPLITTER',
    blurb: 'Triple flak. Every shell bursts on whatever it passes: missiles, mutants, management.',
    // The sky gun, so it has the sky's economy: one flak a pull, three shells.
    kind: 'flak', vm: 'splitter',
    ammo: AMMO_FLAK, cost: 1, refire: 0.50,
    flakSpeed: 126, blastRadius: 5.0, spread: 0.055, pellets: 3,
    kick: 9.5, shakeAmount: 1.1, flash: 'flash_medium', light: [1.0, 0.66, 0.3],
    sfx: 'splitter_fire', groundDamage: 26,
    // Three shells, so up close three chances at a part each.
    gore: { sever: 0.85, head: 0.7, parts: 3, knock: 11, gib: 0, lift: 3.4 },
  },
  nailer: {
    id: 'nailer', slot: 3, name: 'THE NAILDRIVER',
    blurb: 'A rivet gun that forgot its job, and found a better one. Hopeless against the sky.',
    kind: 'kinetic', vm: 'nailer',
    ammo: AMMO_NAIL, cost: 1, refire: 0.078,
    projectileSpeed: 62, range: 28, damage: 22, spread: 0.026, pellets: 1,
    kick: 3.4, shakeAmount: 0.6, flash: 'flash_plume', light: [1.0, 0.84, 0.5],
    sfx: 'nailer_fire',
    // Chips: damage piles up per part and a burst to one limb takes it off.
    gore: { sever: 0.3, head: 0.5, parts: 1, knock: 1.5, gib: 0, lift: 0 },
  },
  halo: {
    id: 'halo', slot: 4, name: 'THE HALO',
    blurb: 'Blooms into a ring of bursts at the first thing it meets. Sweeps a whole altitude.',
    kind: 'ring', vm: 'halo',
    ammo: AMMO_FLAK, cost: 8, refire: 1.25,
    flakSpeed: 116, blastRadius: 6.2, ringRadius: 15.5, ringCount: 7,
    spread: 0, pellets: 1,
    kick: 11, shakeAmount: 1.6, flash: 'flash_ring', light: [0.42, 0.95, 1.0],
    sfx: 'halo_fire', groundDamage: 30,
    gore: { sever: 0.75, head: 0.6, parts: 3, knock: 11, gib: 0, lift: 3.4 },
  },
  pipebomb: {
    id: 'pipebomb', slot: 5, name: 'PIPE BOMBS',
    blurb: 'Throw it, walk away, press the button. Timing is a personal choice.',
    kind: 'throw', vm: 'pipebomb',
    ammo: AMMO_BOMB, cost: 1, refire: 0.55,
    throwSpeed: 17, blastRadius: 6.2, damage: 130, fuse: 6.5, maxLive: 4,
    kick: 4.5, shakeAmount: 0.4, flash: 'flash_small', light: [1.0, 0.8, 0.5],
    sfx: 'pipebomb_throw', groundDamage: 130,
    gore: { sever: 1.0, head: 0.7, parts: 5, knock: 20, gib: 60, lift: 5.5 },
  },
  deadman: {
    id: 'deadman', slot: 6, name: "DEADMAN'S SWITCH",
    blurb: 'Scrubs the sky. Scrubs your instruments too. Use it once and regret it.',
    kind: 'nuke', vm: 'deadman',
    ammo: AMMO_CHARGE, cost: 1, refire: 2.4,
    // Warheads live 88-118 cells out at 44-76 altitude. A 46-radius burst at 34
    // could not touch a single one of them, which made "scrubs the sky" a lie.
    blastRadius: 132, altitude: 52,
    kick: 26, shakeAmount: 6.5, flash: 'flash_large', light: [1.0, 1.0, 0.94],
    sfx: 'deadman_arm',
  },
};

export const WEAPON_ORDER = ['pistol', 'splitter', 'nailer', 'halo', 'pipebomb', 'deadman'];

/**
 * The Boot is not in the weapon order because it is never selected — it is
 * always available, on its own button, and it costs nothing but time.
 */
export const BOOT = {
  id: 'boot', name: 'THE BOOT', vm: 'boot',
  refire: 0.52, range: 2.35, arc: 0.62, damage: 52,
  knockback: 13, liftKick: 3.2, shakeAmount: 1.3,
  gore: { sever: 0.35, head: 1, parts: 1, knock: 14, gib: 0, lift: 3.4 },
};

export const AMMO_MAX = { [AMMO_FLAK]: 180, [AMMO_NAIL]: 320, [AMMO_CHARGE]: 3, [AMMO_BOMB]: 12 };

export function weaponBySlot(slot) {
  return WEAPON_ORDER.find((k) => WEAPONS[k].slot === slot);
}
