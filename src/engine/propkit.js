// propkit.js - the shared palette and helpers the prop models are drawn with.
//
// Everything in the bunker is made of the same few things: laminate and pine,
// grey and green office steel, blue gym-locker paint, chrome, rubber, cheap
// fabric, paper, green phosphor. Keeping them here keeps the set consistent
// across the model files (propmodels*.js).

import { mat, inkAt } from './propstudio.js';

export { mat, inkAt };

// ------------------------------------------------------------------ palette

export const C = {
  laminate: mat('wood', [186, 150, 104], { grain: 0.7 }),
  oak: mat('wood', [150, 98, 58]),
  pine: mat('wood', [196, 150, 92]),
  darkwood: mat('wood', [104, 64, 38]),
  crate: mat('wood', [170, 128, 74], { grain: 1.2 }),
  steelGrey: mat('paint', [132, 138, 140], { wear: 0.5 }),
  officeGreen: mat('paint', [104, 122, 102], { wear: 0.6 }),
  lockerBlue: mat('paint', [70, 96, 118], { wear: 0.7, rust: 0.1 }),
  olive: mat('paint', [96, 104, 74], { wear: 0.6 }),
  beige: mat('paint', [196, 186, 160], { wear: 0.3 }),
  cream: mat('plastic', [214, 206, 184]),
  colaRed: mat('paint', [186, 30, 32], { wear: 0.4 }),
  chrome: mat('metal', [178, 182, 188]),
  darkMetal: mat('metal', [74, 76, 82]),
  black: mat('plastic', [34, 34, 38]),
  rubber: mat('rubber', [30, 30, 32]),
  fabricBlue: mat('fabric', [58, 76, 124]),
  fabricRed: mat('fabric', [120, 44, 40]),
  paper: mat('paper', [236, 232, 218]),
  manila: mat('paper', [214, 190, 128]),
  screenGreen: mat('screen', [60, 210, 110]),
  screenDark: mat('screen', [14, 30, 20], { glow: 0.5 }),
  glass: mat('glass', [60, 70, 78]),
  brass: mat('brass', [196, 158, 70]),
  porcelain: mat('porcelain', [232, 232, 226]),
  mug: mat('porcelain', [222, 214, 196]),
  coffee: mat('plastic', [60, 34, 18]),
  leaf: mat('plastic', [64, 118, 54], { gloss: 0.2 }),
  terracotta: mat('plastic', [170, 92, 58], { gloss: 0.1 }),
  soil: mat('fabric', [58, 42, 30]),
};

export const TAU = Math.PI * 2;

// Screens: a green terminal with a few lines of text and a scanline.
export function terminal(lines, col = [80, 230, 130]) {
  return (u, v) => {
    const row = Math.floor(v * 7);
    const inText = row >= 1 && row <= 5 && u > 0.1 && u < 0.1 + lines[(row - 1) % lines.length] * 0.8;
    const scan = Math.floor(v * 28) % 2 ? 0.8 : 1;
    const k = inText && (Math.floor(u * 40) % 3) ? 1 : 0.28;
    return [col[0] * k * scan, col[1] * k * scan, col[2] * k * scan];
  };
}

// A stencil painted on a face: text in a box (u0..u1, v0..v1), otherwise the material.
export function stencil(text, u0, v0, u1, v1, ink) {
  return (u, v) => (inkAt(text, (u - u0) / (u1 - u0), (v - v0) / (v1 - v0)) ? ink : null);
}

