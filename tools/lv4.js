// LEVEL 4 - THE FURNACE (56x56). Cold airlock -> heat-exchanger lattice ->
// bellows hall -> gullet (red key) -> red door -> ring deck -> catwalk -> L deck -> exit.
import { G, fill, col, row, put, place, outlineIfWall, rowIfWall, colIfWall, toRows } from './mapkit.js';

export default function furnace() {
  const g = G(56, 56, '#');

  // ---- carve --------------------------------------------------------------
  fill(g, 2, 46, 9, 53, '_');       // cold airlock (start)
  fill(g, 11, 49, 23, 50, ' ');     // cold return
  fill(g, 24, 46, 53, 52, ' ');     // boiler walk
  // heat exchanger lattice
  for (const x of [3, 8, 13, 18, 22]) fill(g, x, 35, x, 43, ' ');
  fill(g, 3, 44, 3, 45, ' ');
  for (const y of [35, 39, 43]) fill(g, 3, y, 22, y, ' ');
  fill(g, 4, 35, 7, 35, '#');       // ...with segments welded shut
  fill(g, 14, 39, 17, 39, '#');
  fill(g, 19, 43, 21, 43, '#');
  fill(g, 8, 36, 8, 38, '#');
  fill(g, 18, 40, 18, 42, '#');
  fill(g, 13, 40, 13, 42, '#');
  for (const x of [6, 11, 16, 22]) put(g, x, 44, ' ');   // dead-end nubs
  fill(g, 14, 37, 17, 37, ' ');     // cross-links that break the grid rhythm
  fill(g, 4, 41, 7, 41, ' ');
  fill(g, 9, 37, 12, 37, ' ');
  put(g, 10, 34, ' ');
  fill(g, 12, 20, 34, 33, ' ');     // bellows hall
  fill(g, 36, 30, 52, 44, ' ');     // the gullet
  fill(g, 43, 34, 48, 40, 'F');     // gullet core
  fill(g, 44, 35, 47, 39, ';');     // core interior
  put(g, 18, 18, ' ');              // red airlock
  fill(g, 8, 2, 30, 16, '^');       // deck A ring
  fill(g, 15, 7, 23, 12, 'W');      // deck A launch tube
  fill(g, 32, 5, 34, 5, ' ');       // catwalk between decks
  fill(g, 37, 2, 53, 8, '^');       // deck B bar
  fill(g, 46, 2, 53, 18, '^');      // deck B stem
  fill(g, 36, 11, 42, 17, ' ');     // exit vestibule
  put(g, 38, 18, ' ');              // ...and the elevator car
  fill(g, 8, 29, 10, 31, ' ');      // secret A
  fill(g, 24, 38, 26, 40, ' ');     // secret B
  fill(g, 29, 42, 31, 44, ' ');     // secret C
  fill(g, 32, 2, 34, 3, ' ');       // secret D

  // ---- materials ----------------------------------------------------------
  outlineIfWall(g, 1, 45, 10, 54, '=');    // cold airlock: steel
  outlineIfWall(g, 10, 48, 24, 51, 'p');   // cold return: pipe run
  outlineIfWall(g, 23, 45, 54, 53, '#');   // boiler walk
  rowIfWall(g, 30, 47, 45, '!'); rowIfWall(g, 30, 47, 53, '!');
  outlineIfWall(g, 2, 33, 23, 45, 'v');    // lattice shell: vent grates
  outlineIfWall(g, 11, 19, 35, 34, '#');   // bellows hall
  rowIfWall(g, 12, 34, 19, 'F');           // ...its north wall has gone soft
  outlineIfWall(g, 35, 29, 53, 45, 'F');   // the gullet
  outlineIfWall(g, 7, 1, 31, 17, 'W');     // deck A shell
  outlineIfWall(g, 17, 17, 19, 19, '!');   // red airlock throat
  outlineIfWall(g, 31, 4, 36, 6, '=');     // catwalk
  outlineIfWall(g, 36, 1, 54, 9, 'W');     // deck B shell
  outlineIfWall(g, 45, 1, 54, 19, 'W');
  outlineIfWall(g, 35, 10, 43, 18, '=');   // exit vestibule
  put(g, 8, 1, 'N'); put(g, 30, 1, 'N'); put(g, 7, 16, 'N'); put(g, 31, 16, 'N');
  put(g, 37, 1, 'N'); put(g, 53, 1, 'N'); put(g, 45, 18, 'N'); put(g, 54, 18, 'N');
  put(g, 15, 7, 'N'); put(g, 23, 12, 'N');
  colIfWall(g, 11, 21, 24, 'p'); colIfWall(g, 35, 21, 24, 'p');
  rowIfWall(g, 5, 9, 33, 'p'); rowIfWall(g, 15, 19, 33, 'p');
  colIfWall(g, 2, 36, 42, 'p');

  // ---- doors --------------------------------------------------------------
  put(g, 3, 45, '-');    // airlock -> lattice
  put(g, 10, 50, '-');   // airlock -> cold return
  put(g, 18, 34, '-');   // lattice -> bellows hall
  put(g, 22, 34, '-');   // lattice -> bellows hall
  put(g, 35, 31, '-');   // bellows hall -> gullet
  put(g, 40, 45, '-');   // gullet -> boiler walk
  put(g, 45, 40, '-');   // gullet -> core (red key)
  put(g, 18, 19, '1');   // RED: bellows hall -> deck A
  put(g, 31, 5, '-');    // deck A -> catwalk
  put(g, 35, 5, '-');    // catwalk -> deck B
  put(g, 39, 9, '-');    // deck B -> exit vestibule
  put(g, 39, 10, ' ');   // (vestibule mouth)

  // ---- secrets ------------------------------------------------------------
  put(g, 11, 30, '%');   // bellows hall west wall -> A
  put(g, 23, 39, '%');   // lattice east end       -> B
  put(g, 30, 45, '%');   // boiler walk north wall -> C
  put(g, 33, 4, '%');    // catwalk north wall     -> D

  // ---- start / exit / triggers -------------------------------------------
  place(g, 5, 50, '@');
  place(g, 38, 18, 'E');
  put(g, 18, 17, 'Z');   // deck A
  put(g, 36, 5, 'Z');    // deck B

  // ---- cold airlock -------------------------------------------------------
  place(g, 3, 47, 'L'); place(g, 8, 52, 'T');
  place(g, 8, 47, 'h'); place(g, 2, 53, 'm'); place(g, 6, 46, 'a');

  // ---- heat exchanger lattice --------------------------------------------
  place(g, 3, 39, 'b'); place(g, 13, 35, 'b'); place(g, 22, 41, 'a');
  place(g, 8, 43, 'a'); place(g, 20, 35, 'c');
  place(g, 6, 44, 'm'); place(g, 11, 44, 'h'); place(g, 16, 44, '$'); place(g, 22, 44, 'm');
  place(g, 10, 34, 'M'); place(g, 9, 37, 'o'); place(g, 15, 37, 'h'); place(g, 5, 41, 'm');
  place(g, 3, 35, 'L'); place(g, 13, 39, 'L'); place(g, 22, 43, 'L'); place(g, 8, 39, 'L');
  place(g, 10, 35, 'T'); place(g, 16, 43, 'T'); place(g, 3, 42, 'o');

  // ---- bellows hall -------------------------------------------------------
  fill(g, 16, 23, 19, 26, 'p');     // bellows unit one
  fill(g, 27, 27, 30, 30, 'p');     // bellows unit two
  fill(g, 13, 27, 15, 32, '_'); fill(g, 31, 21, 33, 26, '_');
  fill(g, 20, 30, 26, 32, ';');
  place(g, 21, 22, 'c'); place(g, 25, 25, 'c'); place(g, 14, 30, 'c'); place(g, 32, 24, 'c');
  place(g, 13, 21, 'b'); place(g, 33, 32, 'b'); place(g, 23, 32, 'a'); place(g, 30, 20, 'a');
  place(g, 22, 27, 'o'); place(g, 23, 27, 'o'); place(g, 12, 33, 'o'); place(g, 34, 20, 'o');
  place(g, 12, 20, 'M'); place(g, 34, 33, 'H'); place(g, 20, 20, 'm'); place(g, 26, 33, 'm');
  place(g, 21, 26, 'L'); place(g, 26, 26, 'L'); place(g, 17, 31, 'L'); place(g, 30, 31, 'L');
  place(g, 12, 26, 'T'); place(g, 34, 27, 'T'); place(g, 24, 20, 'T');
  place(g, 20, 28, 'D'); place(g, 26, 28, 'D'); place(g, 16, 21, 'D'); place(g, 31, 33, 'D');

  // ---- cold return + boiler walk ------------------------------------------
  place(g, 15, 49, 'b'); place(g, 21, 50, 'a');
  place(g, 18, 49, 'o'); place(g, 12, 50, 'T');
  place(g, 52, 48, 'w');                                   // deadman's switch
  place(g, 27, 47, 'b'); place(g, 35, 51, 'c'); place(g, 44, 47, 'a'); place(g, 50, 51, 'e');
  put(g, 31, 48, 'B'); put(g, 31, 49, 'B'); put(g, 40, 50, 'B'); put(g, 40, 51, 'B');
  put(g, 47, 47, 'B'); put(g, 47, 48, 'B');
  place(g, 29, 52, 'D'); place(g, 38, 47, 'D'); place(g, 45, 52, 'D');
  place(g, 26, 46, 'M'); place(g, 53, 52, 'H'); place(g, 36, 46, 'm'); place(g, 49, 46, '$');
  place(g, 28, 49, 'L'); place(g, 42, 49, 'L'); place(g, 51, 49, 'L');
  place(g, 33, 46, 'o'); place(g, 43, 52, 'o');

  // ---- the gullet: red key in the core ------------------------------------
  place(g, 45, 37, 'r');
  place(g, 45, 35, 'e'); place(g, 46, 39, 'c');
  place(g, 38, 32, 'd'); place(g, 50, 32, 'd'); place(g, 38, 42, 'd'); place(g, 51, 42, 'e');
  place(g, 41, 31, 'b'); place(g, 49, 37, 'b'); place(g, 40, 37, 'c');
  place(g, 36, 30, 'M'); place(g, 52, 30, '$'); place(g, 36, 44, 'H'); place(g, 52, 44, 'm');
  place(g, 40, 34, 'D'); place(g, 51, 34, 'D'); place(g, 40, 41, 'D'); place(g, 51, 39, 'D');
  place(g, 44, 30, 'L'); place(g, 44, 44, 'L'); place(g, 44, 36, 'T');
  place(g, 42, 43, 'o'); place(g, 49, 30, 'o');

  // ---- deck A: the ring around the tube -----------------------------------
  put(g, 11, 4, 'B'); put(g, 11, 5, 'B'); put(g, 27, 4, 'B'); put(g, 27, 5, 'B');
  put(g, 11, 14, 'B'); put(g, 27, 14, 'B'); put(g, 19, 3, 'B'); put(g, 19, 15, 'B');
  place(g, 10, 9, 'D'); place(g, 28, 9, 'D'); place(g, 14, 15, 'D'); place(g, 24, 3, 'D');
  place(g, 9, 15, 'M'); place(g, 29, 3, 'm'); place(g, 19, 2, 'H'); place(g, 19, 16, 'm');
  place(g, 9, 2, 'm'); place(g, 29, 16, 'M');
  place(g, 12, 9, 'c'); place(g, 26, 9, 'd');

  // ---- catwalk ------------------------------------------------------------
  place(g, 33, 5, 'T');

  // ---- deck B: the L over the stacks --------------------------------------
  put(g, 40, 4, 'B'); put(g, 41, 4, 'B'); put(g, 44, 6, 'B'); put(g, 44, 7, 'B');
  put(g, 49, 5, 'B'); put(g, 50, 12, 'B'); put(g, 49, 16, 'B');
  place(g, 38, 7, 'D'); place(g, 47, 3, 'D'); place(g, 52, 10, 'D'); place(g, 47, 17, 'D');
  place(g, 38, 2, 'M'); place(g, 53, 2, 'm'); place(g, 46, 18, 'M'); place(g, 53, 18, 'H');
  place(g, 42, 7, 'd'); place(g, 51, 14, 'd'); place(g, 48, 8, 'e');

  // ---- exit vestibule -----------------------------------------------------
  place(g, 41, 16, 'H'); place(g, 37, 12, 'L'); place(g, 42, 11, '$'); place(g, 36, 17, 'T');

  // ---- secret contents ----------------------------------------------------
  place(g, 8, 29, 'H'); place(g, 10, 29, '$'); place(g, 8, 31, 'M');
  place(g, 24, 38, 'M'); place(g, 26, 40, 'H'); place(g, 24, 40, '$');
  place(g, 29, 42, '$'); place(g, 31, 42, 'M'); place(g, 29, 44, 'H');
  place(g, 32, 2, 'H'); place(g, 34, 2, '$'); place(g, 32, 3, 'M');

  return toRows(g);
}
