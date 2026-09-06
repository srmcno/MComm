// LEVEL 5 - MUTTER (34x34). One octagonal silo mouth, permanently open to the sky,
// four roofed bastions, a circuit dais with the core, and the elevator behind it.
import { G, fill, col, row, put, place, outlineIfWall, rowIfWall, colIfWall, toRows } from './mapkit.js';

export default function mutter() {
  const g = G(34, 34, '#');

  // ---- the arena: an octagon of open sky ---------------------------------
  fill(g, 3, 4, 30, 28, '^');
  for (let y = 4; y <= 28; y++) {
    for (let x = 3; x <= 30; x++) {
      const w = x - 3, e = 30 - x, n = y - 4, s = 28 - y;
      if (w + n < 5 || e + n < 5 || w + s < 5 || e + s < 5) put(g, x, y, 'W');
    }
  }

  // ---- rooms hung off it --------------------------------------------------
  fill(g, 14, 1, 18, 2, ' ');        // elevator alcove (behind the core)
  put(g, 16, 3, ' ');                // ...its throat
  fill(g, 14, 30, 19, 32, ' ');      // entry alcove
  fill(g, 2, 2, 5, 5, ' ');   put(g, 6, 5, ' ');    // NW bastion
  fill(g, 28, 2, 31, 5, ' '); put(g, 27, 5, ' ');   // NE bastion
  fill(g, 2, 27, 5, 30, ' '); put(g, 6, 27, ' ');   // SW bastion
  fill(g, 28, 27, 31, 30, ' '); put(g, 27, 27, ' ');// SE bastion
  fill(g, 1, 7, 2, 8, ' ');          // secret A (off the NW bastion)
  fill(g, 31, 7, 32, 8, ' ');        // secret B (off the NE bastion)
  fill(g, 10, 30, 12, 32, ' ');      // secret C (off the entry)

  // ---- the dais -----------------------------------------------------------
  fill(g, 12, 12, 13, 13, 'C'); fill(g, 20, 12, 21, 13, 'C');
  fill(g, 12, 18, 13, 19, 'C'); fill(g, 20, 18, 21, 19, 'C');
  put(g, 14, 11, 'S'); put(g, 18, 11, 'S'); put(g, 14, 20, 'S'); put(g, 18, 20, 'S');
  put(g, 16, 11, 'F'); put(g, 16, 21, 'F');

  // ---- materials ----------------------------------------------------------
  outlineIfWall(g, 13, 0, 19, 3, '=');     // elevator alcove
  outlineIfWall(g, 13, 29, 20, 33, '=');   // entry alcove
  outlineIfWall(g, 1, 1, 6, 6, 'C');       // bastions: MUTTER's own hardware
  outlineIfWall(g, 27, 1, 32, 6, 'S');
  outlineIfWall(g, 1, 26, 6, 31, 'S');
  outlineIfWall(g, 27, 26, 32, 31, 'C');
  put(g, 1, 3, 'S'); put(g, 32, 3, 'C'); put(g, 1, 29, 'C'); put(g, 32, 29, 'S');
  rowIfWall(g, 8, 12, 3, 'W'); rowIfWall(g, 20, 25, 3, 'W');    // the silo mouth proper
  rowIfWall(g, 8, 12, 29, 'W'); rowIfWall(g, 21, 25, 29, 'W');
  colIfWall(g, 2, 9, 23, 'W'); colIfWall(g, 31, 9, 23, 'W');
  put(g, 15, 1, '='); put(g, 17, 1, '=');   // the elevator car, walled into its niche
  put(g, 16, 0, 'N'); put(g, 16, 33, 'N');
  put(g, 2, 16, 'N'); put(g, 31, 16, 'N'); put(g, 16, 3, ' ');
  put(g, 24, 19, 'X'); put(g, 25, 19, 'X'); put(g, 25, 20, 'X');  // a collapsed gantry

  // ---- doors / start / exit / triggers -----------------------------------
  put(g, 16, 29, '-');
  place(g, 16, 31, '@');
  place(g, 16, 1, 'E');
  put(g, 16, 28, 'Z');   // stepping onto the deck
  put(g, 16, 22, 'Z');   // and again at the foot of the dais

  // ---- secrets ------------------------------------------------------------
  put(g, 2, 6, '%');     // NW bastion floor
  put(g, 31, 6, '%');    // NE bastion floor
  put(g, 13, 31, '%');   // entry alcove west wall

  // ---- the core -----------------------------------------------------------
  place(g, 16, 15, 'K');
  place(g, 15, 13, 'T'); place(g, 17, 13, 'T'); place(g, 15, 17, 'T'); place(g, 17, 17, 'T');

  // ---- the broken ring of cover ------------------------------------------
  for (const [x, y] of [[15, 7], [16, 7], [17, 7], [15, 25], [16, 25], [17, 25],
    [7, 15], [7, 16], [7, 17], [26, 15], [26, 16], [26, 17],
    [10, 10], [11, 10], [10, 11], [22, 10], [23, 10], [23, 11],
    [10, 22], [11, 22], [10, 21], [22, 22], [23, 22], [23, 21]]) put(g, x, y, 'B');
  for (const [x, y] of [[9, 7], [24, 7], [9, 25], [24, 25], [13, 9], [20, 9], [13, 23], [20, 23],
    [5, 12], [28, 12], [5, 20], [28, 20]]) place(g, x, y, 'D');

  // ---- the garrison -------------------------------------------------------
  place(g, 8, 12, 'e'); place(g, 25, 12, 'e'); place(g, 8, 20, 'e'); place(g, 26, 21, 'e');
  place(g, 23, 20, 'o'); place(g, 24, 21, 'o');
  place(g, 12, 6, 'd'); place(g, 21, 6, 'd'); place(g, 12, 26, 'd'); place(g, 21, 26, 'd');
  place(g, 6, 16, 'c'); place(g, 27, 16, 'c');
  place(g, 16, 5, 'b'); place(g, 16, 27, 'b');

  // ---- caches -------------------------------------------------------------
  place(g, 3, 3, 'M'); place(g, 30, 3, 'M'); place(g, 3, 29, 'M'); place(g, 30, 29, 'M');
  place(g, 5, 2, 'H'); place(g, 28, 2, 'H'); place(g, 5, 30, 'H'); place(g, 28, 30, 'H');
  place(g, 2, 4, 'm'); place(g, 31, 4, 'm'); place(g, 2, 29, 'm'); place(g, 31, 29, 'm');
  place(g, 4, 5, 'L'); place(g, 29, 5, 'L'); place(g, 4, 27, 'L'); place(g, 29, 27, 'L');
  place(g, 14, 8, 'm'); place(g, 18, 24, 'm'); place(g, 9, 16, 'm'); place(g, 24, 16, 'm');
  place(g, 14, 24, 'h'); place(g, 18, 8, 'h');
  place(g, 14, 30, 'L'); place(g, 19, 30, 'T'); place(g, 14, 2, 'L'); place(g, 18, 2, '$');
  place(g, 16, 32, 'h'); place(g, 18, 32, 'm');

  // ---- secret contents ----------------------------------------------------
  place(g, 1, 7, '$'); place(g, 1, 8, 'H');
  place(g, 32, 7, '$'); place(g, 32, 8, 'H');
  place(g, 10, 30, 'M'); place(g, 12, 32, 'H'); place(g, 10, 32, '$');

  return toRows(g);
}
