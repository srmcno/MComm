// weapons.js - the arsenal.
//
// Four of the five are flak: they lob a shell that does nothing on contact and
// everything when its fuse runs out. The Naildriver is the exception, a kinetic
// weapon for the things walking around on your deck.

export const AMMO_FLAK = 'flak';
export const AMMO_NAIL = 'nail';
export const AMMO_CHARGE = 'charge';

export const WEAPONS = {
  pistol: {
    id: 'pistol', slot: 1, name: 'THE WIDOW',
    blurb: 'Break-action flak pistol. Regenerates. Never leaves you naked.',
    kind: 'flak', vm: 'pistol',
    ammo: AMMO_FLAK, cost: 1, refire: 0.50,
    flakSpeed: 138, blastRadius: 5.4, spread: 0.0, pellets: 1,
    kick: 5.2, shakeAmount: 0.5, flash: 'flash_small', light: [1.0, 0.72, 0.34],
    sfx: 'flak_fire', groundDamage: 34,
  },
  splitter: {
    id: 'splitter', slot: 2, name: 'THE SPLITTER',
    blurb: 'Three shells, one fuse. Brackets a target instead of threading it.',
    kind: 'flak', vm: 'splitter',
    ammo: AMMO_FLAK, cost: 3, refire: 0.80,
    flakSpeed: 126, blastRadius: 4.3, spread: 0.055, pellets: 3,
    kick: 9.5, shakeAmount: 1.1, flash: 'flash_medium', light: [1.0, 0.66, 0.3],
    sfx: 'flak_fire', groundDamage: 26,
  },
  nailer: {
    id: 'nailer', slot: 3, name: 'THE NAILDRIVER',
    blurb: 'A rivet gun that forgot its job. Hopeless against the sky.',
    kind: 'kinetic', vm: 'nailer',
    ammo: AMMO_NAIL, cost: 1, refire: 0.082,
    projectileSpeed: 62, range: 26, damage: 17, spread: 0.028, pellets: 1,
    kick: 2.4, shakeAmount: 0.35, flash: 'flash_plume', light: [1.0, 0.84, 0.5],
    sfx: 'nailer_fire',
  },
  halo: {
    id: 'halo', slot: 4, name: 'THE HALO',
    blurb: 'Detonates as a ring at your fuse range. Sweeps a whole altitude.',
    kind: 'ring', vm: 'halo',
    ammo: AMMO_FLAK, cost: 8, refire: 1.25,
    flakSpeed: 116, blastRadius: 6.2, ringRadius: 15.5, ringCount: 7,
    spread: 0, pellets: 1,
    kick: 11, shakeAmount: 1.6, flash: 'flash_ring', light: [0.42, 0.95, 1.0],
    sfx: 'halo_fire', groundDamage: 30,
  },
  deadman: {
    id: 'deadman', slot: 5, name: "DEADMAN'S SWITCH",
    blurb: 'Scrubs the sky. Scrubs your instruments too. Use it once and regret it.',
    kind: 'nuke', vm: 'deadman',
    ammo: AMMO_CHARGE, cost: 1, refire: 2.4,
    blastRadius: 46, altitude: 34,
    kick: 26, shakeAmount: 6.5, flash: 'flash_large', light: [1.0, 1.0, 0.94],
    sfx: 'deadman_arm',
  },
};

export const WEAPON_ORDER = ['pistol', 'splitter', 'nailer', 'halo', 'deadman'];

export const AMMO_MAX = { [AMMO_FLAK]: 180, [AMMO_NAIL]: 320, [AMMO_CHARGE]: 3 };

export function weaponBySlot(slot) {
  return WEAPON_ORDER.find((k) => WEAPONS[k].slot === slot);
}
