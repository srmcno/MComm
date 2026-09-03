// LEVEL 3 - SALT CATHEDRAL (52x52). Narthex -> great hall hub -> crypt (red key)
// -> transept -> plus-shaped deck; reliquary (gold key) -> gold door -> deck B -> exit.
import { G, fill, col, row, put, place, outlineIfWall, rowIfWall, colIfWall, toRows } from './mapkit.js';

export default function saltCathedral() {
  const g = G(52, 52, '#');

  // ---- carve --------------------------------------------------------------
  fill(g, 20, 44, 31, 50, ',');     // narthex (start), salt-drifted
  fill(g, 10, 26, 41, 42, ' ');     // the great hall
  fill(g, 2, 30, 8, 46, ' ');       // crypt (red key)
  fill(g, 43, 30, 49, 44, ' ');     // south-east chapel
  fill(g, 12, 16, 39, 24, ' ');     // transept
  fill(g, 41, 16, 49, 24, ' ');     // reliquary (gold key)
  fill(g, 18, 2, 24, 13, '^');      // deck A: north arm
  fill(g, 11, 6, 31, 10, '^');      // deck A: transverse arm
  fill(g, 34, 2, 46, 12, '^');      // deck B
  put(g, 44, 14, ' ');              // gold airlock
  fill(g, 48, 3, 50, 11, ' ');      // exit vestibule
  put(g, 49, 2, ' ');              // the elevator car
  fill(g, 4, 48, 6, 49, ' ');       // secret A (under the crypt)
  fill(g, 45, 46, 47, 47, ' ');     // secret B (under the chapel)
  fill(g, 2, 17, 10, 23, ' ');      // salt works (west of the transept)
  fill(g, 2, 5, 9, 11, ' ');        // bell room (west flank of deck A)
  fill(g, 4, 13, 6, 15, ' ');       // secret C (between them)
  fill(g, 16, 46, 18, 48, ' ');     // secret D (west of the narthex)

  // ---- materials ----------------------------------------------------------
  outlineIfWall(g, 19, 43, 32, 51, 'X');   // narthex: cracked concrete
  outlineIfWall(g, 9, 25, 42, 43, '#');    // great hall
  outlineIfWall(g, 1, 29, 9, 47, ':');     // crypt: blood-slick tile
  outlineIfWall(g, 42, 29, 50, 45, 't');   // chapel: tile
  outlineIfWall(g, 11, 15, 40, 25, '#');   // transept
  rowIfWall(g, 12, 17, 15, 'N'); rowIfWall(g, 34, 39, 15, 'N');
  outlineIfWall(g, 40, 15, 50, 25, 'S');   // reliquary: screen shrine
  outlineIfWall(g, 1, 16, 11, 24, 'X');    // salt works
  outlineIfWall(g, 1, 4, 10, 12, 'R');     // bell room (deck shell wins below)
  outlineIfWall(g, 17, 1, 25, 14, 'W');    // deck A shell
  outlineIfWall(g, 10, 5, 32, 11, 'W');
  outlineIfWall(g, 33, 1, 47, 13, 'W');    // deck B shell
  outlineIfWall(g, 43, 13, 45, 15, '!');   // gold airlock throat
  outlineIfWall(g, 47, 2, 51, 12, '=');    // exit vestibule
  put(g, 18, 1, 'N'); put(g, 24, 1, 'N'); put(g, 10, 8, 'N'); put(g, 32, 8, 'N');
  put(g, 34, 1, 'N'); put(g, 46, 1, 'N'); put(g, 33, 12, 'N'); put(g, 47, 12, 'N');

  // ---- doors --------------------------------------------------------------
  put(g, 25, 43, '-');   // narthex -> great hall
  put(g, 9, 38, '-');    // great hall -> crypt
  put(g, 42, 36, '-');   // great hall -> chapel
  put(g, 25, 25, '1');   // RED: great hall -> transept
  put(g, 40, 20, '-');   // transept -> reliquary
  put(g, 21, 15, '-');   // transept -> deck A airlock
  put(g, 11, 20, '-');   // transept -> salt works
  put(g, 10, 8, '-');    // deck A -> bell room (duck out of the sky)
  put(g, 44, 15, '3');   // GOLD: reliquary -> deck B airlock
  put(g, 47, 7, '-');    // deck B -> exit vestibule

  // ---- secrets ------------------------------------------------------------
  put(g, 5, 47, '%');    // crypt floor  -> A
  put(g, 46, 45, '%');   // chapel floor -> B
  put(g, 5, 16, '%');    // salt works ceiling wall -> C
  put(g, 19, 47, '%');   // narthex west wall  -> D

  // ---- start / exit / triggers -------------------------------------------
  place(g, 25, 48, '@');
  place(g, 49, 2, 'E');
  put(g, 21, 14, 'Z');   // deck A
  put(g, 44, 13, 'Z');   // deck B

  // ---- narthex ------------------------------------------------------------
  place(g, 23, 46, 'L'); place(g, 28, 46, 'L'); place(g, 25, 50, 'T');
  place(g, 29, 49, 'a'); place(g, 21, 49, 'h'); place(g, 31, 44, 'm');
  place(g, 20, 44, 'o'); place(g, 27, 44, 'D'); place(g, 24, 44, 'D');

  // ---- great hall: colonnade, redoubts, plinth ---------------------------
  for (const x of [14, 19, 32, 37]) for (const y of [29, 33, 37, 41]) place(g, x, y, 'D');
  row(g, 12, 16, 31, 'B'); put(g, 12, 32, 'B'); put(g, 16, 32, 'B');      // west redoubt
  row(g, 35, 39, 37, 'B'); put(g, 35, 36, 'B'); put(g, 39, 36, 'B');      // east redoubt
  put(g, 24, 33, 'X'); put(g, 26, 33, 'X'); put(g, 24, 35, 'X'); put(g, 26, 35, 'X');
  put(g, 25, 32, 'X'); put(g, 25, 36, 'X');
  place(g, 25, 34, '$');                                                  // the plinth
  place(g, 23, 34, 'o'); place(g, 27, 34, 'o');
  fill(g, 10, 26, 41, 27, ','); fill(g, 10, 42, 41, 42, ',');
  place(g, 14, 32, 'M'); place(g, 37, 36, 'M');
  place(g, 15, 32, 'b'); place(g, 37, 35, 'b');
  place(g, 21, 30, 'a'); place(g, 30, 39, 'a'); place(g, 12, 41, 'a');
  place(g, 25, 28, 'd'); place(g, 25, 40, 'o');
  put(g, 22, 26, 'X'); put(g, 22, 27, 'X'); put(g, 29, 26, 'X'); put(g, 29, 27, 'X');
  put(g, 22, 41, 'X'); put(g, 22, 42, 'X'); put(g, 29, 41, 'X'); put(g, 29, 42, 'X');
  place(g, 20, 27, 'o'); place(g, 31, 27, 'o'); place(g, 18, 42, 'o');
  place(g, 25, 31, 'L'); place(g, 25, 37, 'L'); place(g, 11, 34, 'L'); place(g, 40, 34, 'L');
  place(g, 10, 26, 'T'); place(g, 41, 26, 'T'); place(g, 10, 42, 'T'); place(g, 41, 42, 'T');
  place(g, 33, 29, 'h'); place(g, 18, 39, 'm'); place(g, 40, 42, 'H');

  // ---- crypt: the red key ------------------------------------------------
  put(g, 5, 34, 'X'); put(g, 5, 38, 'X'); put(g, 5, 42, 'X');
  fill(g, 2, 30, 8, 32, ';');
  place(g, 4, 31, 'r');
  place(g, 3, 35, 'd'); place(g, 7, 40, 'd'); place(g, 4, 45, 'e');
  place(g, 2, 44, 'M'); place(g, 8, 30, 'h'); place(g, 2, 30, '$');
  place(g, 6, 36, 'T'); place(g, 3, 41, 'T'); place(g, 7, 46, 'T'); place(g, 2, 33, 'L');

  // ---- chapel -------------------------------------------------------------
  place(g, 46, 32, 'd'); place(g, 44, 41, 'm'); place(g, 48, 37, 'e');
  place(g, 43, 30, 'M'); place(g, 49, 30, '$'); place(g, 46, 44, 'H');
  place(g, 46, 36, 'D'); place(g, 46, 38, 'D'); place(g, 45, 34, 'L'); place(g, 48, 42, 'T');
  fill(g, 43, 43, 49, 44, ';');

  // ---- transept: salt columns, the halo ------------------------------
  place(g, 37, 17, 'w');
  for (const [x, y] of [[16, 18], [16, 22], [23, 18], [23, 22], [30, 18], [30, 22], [36, 21]]) place(g, x, y, 'D');
  put(g, 19, 20, 'B'); put(g, 20, 20, 'B'); put(g, 27, 20, 'B'); put(g, 28, 20, 'B');
  put(g, 17, 16, 'X'); put(g, 17, 17, 'X'); put(g, 17, 23, 'X'); put(g, 17, 24, 'X');
  put(g, 33, 16, 'X'); put(g, 33, 17, 'X'); put(g, 33, 23, 'X'); put(g, 33, 24, 'X');
  place(g, 14, 20, 'e'); place(g, 34, 23, 'e');
  place(g, 18, 17, 'd'); place(g, 32, 17, 'h');
  place(g, 13, 24, 'b'); place(g, 38, 24, 'b');
  place(g, 12, 16, 'M'); place(g, 39, 16, 'h'); place(g, 25, 24, 'm');
  place(g, 25, 16, 'L'); place(g, 17, 21, 'L'); place(g, 34, 19, 'L');
  place(g, 12, 22, 'o'); place(g, 39, 20, 'o');

  // ---- salt works ---------------------------------------------------------
  put(g, 6, 19, 'X'); put(g, 6, 20, 'X'); put(g, 6, 21, 'X');
  fill(g, 2, 22, 5, 23, ',');
  place(g, 3, 18, 'b'); place(g, 9, 22, 'a'); place(g, 4, 21, 'd');
  place(g, 2, 17, 'M'); place(g, 10, 17, '$'); place(g, 2, 23, 'h');
  place(g, 8, 19, 'L'); place(g, 3, 20, 'T'); place(g, 9, 18, 'o');

  // ---- bell room: cover from the sky --------------------------------------
  place(g, 5, 8, 'M'); place(g, 3, 6, 'H'); place(g, 8, 10, '$');
  place(g, 6, 6, 'e'); place(g, 3, 10, 'b');
  place(g, 5, 5, 'L'); place(g, 2, 8, 'T'); place(g, 8, 5, 'D'); place(g, 8, 11, 'D');

  // ---- reliquary: the gold key -------------------------------------------
  place(g, 47, 20, 'g');
  place(g, 46, 19, 'D'); place(g, 48, 19, 'D'); place(g, 46, 21, 'D'); place(g, 48, 21, 'D');
  place(g, 42, 17, 'd'); place(g, 42, 23, 'm'); place(g, 45, 24, 'e');
  place(g, 41, 16, '$'); place(g, 49, 24, 'M'); place(g, 41, 24, 'h');
  place(g, 44, 16, 'L'); place(g, 49, 16, 'T');

  // ---- deck A: the plus ---------------------------------------------------
  put(g, 15, 7, 'B'); put(g, 15, 9, 'B'); put(g, 27, 7, 'B'); put(g, 27, 9, 'B');
  put(g, 20, 4, 'B'); put(g, 22, 12, 'B');
  place(g, 19, 8, 'D'); place(g, 23, 8, 'D'); place(g, 21, 3, 'D'); place(g, 21, 11, 'D');
  place(g, 12, 8, 'M'); place(g, 30, 8, 'm'); place(g, 21, 2, 'H'); place(g, 21, 13, 'm');
  place(g, 13, 6, 'd'); place(g, 29, 10, 'm');

  // ---- deck B: the redoubt in the open ------------------------------------
  fill(g, 39, 6, 42, 8, 'B');
  place(g, 36, 4, 'D'); place(g, 44, 10, 'D'); place(g, 44, 4, 'D'); place(g, 36, 10, 'D');
  place(g, 35, 7, 'M'); place(g, 45, 7, 'm'); place(g, 40, 2, 'H'); place(g, 40, 11, 'm');
  place(g, 34, 12, 'd'); place(g, 46, 2, 'm');

  // ---- exit vestibule -----------------------------------------------------
  place(g, 49, 10, 'H'); place(g, 49, 7, 'L'); place(g, 48, 3, 'T');

  // ---- secret contents ----------------------------------------------------
  place(g, 4, 48, '$'); place(g, 6, 49, 'H'); place(g, 4, 49, 'M');
  place(g, 45, 46, '$'); place(g, 47, 47, 'H');
  place(g, 4, 13, 'M'); place(g, 6, 13, '$'); place(g, 4, 14, 'H');
  place(g, 16, 46, 'H'); place(g, 18, 48, '$'); place(g, 16, 48, 'M');

  return toRows(g);
}
