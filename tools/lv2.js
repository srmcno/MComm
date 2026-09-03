// LEVEL 2 - THE ORGAN LOFT (48x48). Nave spine, west bellows walk (blue key),
// east choir stalls -> L deck, north crossing -> blue door -> ring deck -> exit.
import { G, fill, col, row, put, place, outlineIfWall, rowIfWall, colIfWall, toRows } from './mapkit.js';

export default function organLoft() {
  const g = G(48, 48, '#');

  // ---- carve --------------------------------------------------------------
  fill(g, 19, 41, 28, 46, ' ');     // entry chamber (start)
  fill(g, 19, 23, 28, 39, ' ');     // the nave
  fill(g, 23, 23, 24, 39, '_');     // its grated spine
  fill(g, 8, 16, 39, 21, ' ');      // the crossing
  put(g, 17, 43, ' ');              // entry -> pump neck
  fill(g, 7, 40, 16, 46, ' ');      // pump room
  fill(g, 3, 42, 5, 43, ' ');       // vent crawl (wide foot)
  fill(g, 3, 35, 4, 41, ' ');       // vent crawl (shaft)
  fill(g, 5, 36, 7, 38, ' ');       // bellows nook off the crawl
  fill(g, 2, 26, 12, 33, ' ');      // valve chamber (blue key)
  fill(g, 14, 29, 17, 29, ' ');     // valve -> nave passage
  fill(g, 16, 26, 18, 27, ' ');     // nave niches, west side
  fill(g, 16, 32, 18, 33, ' ');
  fill(g, 30, 24, 31, 44, ' ');     // choir corridor
  fill(g, 32, 25, 36, 27, ' ');     // stall 1
  fill(g, 32, 30, 36, 32, ' ');     // stall 2
  fill(g, 32, 35, 36, 37, ' ');     // stall 3
  fill(g, 40, 33, 45, 45, '^');     // deck A: north-south bar
  fill(g, 33, 40, 45, 45, '^');     // deck A: east-west bar
  fill(g, 41, 16, 46, 21, ' ');     // screen room
  fill(g, 13, 2, 34, 12, '^');      // deck B: ring
  fill(g, 20, 5, 27, 9, 'W');       // deck B: launch tube
  fill(g, 23, 14, 23, 14, ' ');     // blue airlock
  fill(g, 36, 4, 42, 10, ' ');      // exit vestibule
  put(g, 41, 3, ' ');              // the elevator car
  fill(g, 3, 3, 11, 12, ' ');       // west gallery
  // secret closets
  fill(g, 2, 14, 3, 15, ' ');       // A: below the west gallery
  fill(g, 15, 35, 17, 37, ' ');     // B: behind the nave
  fill(g, 42, 23, 44, 25, ' ');     // C: under the screen room
  fill(g, 3, 45, 5, 46, ' ');       // D: behind the pump room

  // ---- materials ----------------------------------------------------------
  outlineIfWall(g, 18, 40, 29, 47, '=');   // entry chamber: steel
  outlineIfWall(g, 18, 22, 29, 40, 'p');   // nave: pipe banks
  outlineIfWall(g, 7, 15, 40, 22, '#');    // crossing: riveted structure
  outlineIfWall(g, 6, 39, 17, 47, 'R');    // pump room: rust
  outlineIfWall(g, 2, 34, 5, 42, 'v');     // vent crawl
  outlineIfWall(g, 4, 35, 8, 39, 'p');     // bellows nook
  outlineIfWall(g, 1, 25, 13, 34, 'C');    // valve chamber: circuitry
  outlineIfWall(g, 13, 28, 18, 30, 'v');   // valve passage
  outlineIfWall(g, 29, 23, 32, 45, 'R');   // choir corridor
  outlineIfWall(g, 31, 24, 37, 28, 'R');   // stalls
  outlineIfWall(g, 31, 29, 37, 33, 'S');   // (the middle stall watches you)
  outlineIfWall(g, 31, 34, 37, 38, 'R');
  outlineIfWall(g, 2, 2, 12, 13, 'R');     // west gallery
  outlineIfWall(g, 39, 32, 46, 46, 'W');   // deck A
  outlineIfWall(g, 32, 39, 46, 46, 'W');
  outlineIfWall(g, 40, 15, 47, 22, 'S');   // screen room
  outlineIfWall(g, 12, 1, 35, 13, 'W');    // deck B shell
  outlineIfWall(g, 22, 13, 24, 15, '=');   // blue airlock throat
  outlineIfWall(g, 35, 3, 43, 11, '=');    // exit vestibule
  put(g, 13, 1, 'N'); put(g, 34, 1, 'N'); put(g, 12, 12, 'N'); put(g, 35, 12, 'N');
  put(g, 21, 5, 'N'); put(g, 26, 9, 'N');  // placards on the launch tube
  put(g, 39, 46, 'N'); put(g, 32, 46, 'N');
  rowIfWall(g, 8, 11, 22, 'v'); rowIfWall(g, 36, 39, 22, 'v');

  // ---- necks that must survive the outlines -------------------------------
  put(g, 10, 13, ' '); put(g, 10, 15, ' ');  // gallery -> crossing
  put(g, 30, 22, ' ');                       // choir -> crossing

  // ---- doors --------------------------------------------------------------
  put(g, 23, 40, '-');   // entry -> nave
  put(g, 18, 43, '-');   // entry -> pump room
  put(g, 6, 43, '-');    // pump room -> vent crawl
  put(g, 3, 34, '-');    // vent crawl -> valve chamber
  put(g, 13, 29, '-');   // valve chamber -> passage
  put(g, 18, 29, '-');   // passage -> nave
  put(g, 23, 22, '-');   // nave -> crossing
  put(g, 29, 33, '-');   // nave -> choir corridor
  put(g, 30, 23, '-');   // choir corridor -> crossing
  put(g, 10, 14, '-');   // west gallery -> crossing
  put(g, 40, 18, '-');   // crossing -> screen room
  put(g, 32, 42, '-');   // choir corridor -> deck A
  put(g, 23, 15, '2');   // BLUE: crossing -> deck B
  put(g, 35, 7, '-');    // deck B -> exit vestibule

  // ---- secrets ------------------------------------------------------------
  put(g, 3, 13, '%');    // gallery floor -> closet A
  put(g, 18, 36, '%');   // nave west wall -> closet B
  put(g, 43, 22, '%');   // screen room floor -> closet C
  put(g, 6, 45, '%');    // pump room west wall -> closet D

  // ---- start / exit / triggers -------------------------------------------
  place(g, 23, 44, '@');
  place(g, 41, 3, 'E');
  put(g, 33, 42, 'Z');   // deck A
  put(g, 23, 13, 'Z');   // deck B

  // ---- entry chamber ------------------------------------------------------
  place(g, 20, 42, 'L'); place(g, 27, 42, 'L');
  place(g, 26, 45, 'a'); place(g, 20, 45, 'h'); place(g, 27, 46, 'm');

  // ---- the nave: colonnade of dead organ pipes -----------------------------
  place(g, 21, 25, 'D'); place(g, 26, 25, 'D');
  place(g, 21, 29, 'D'); place(g, 26, 29, 'D');
  place(g, 21, 33, 'D'); place(g, 26, 33, 'D');
  place(g, 21, 37, 'D'); place(g, 26, 37, 'D');
  place(g, 20, 27, 'e'); place(g, 27, 35, 'e');
  place(g, 24, 31, 'a');
  place(g, 23, 24, 'L'); place(g, 24, 38, 'L');
  place(g, 19, 31, 'T'); place(g, 28, 31, 'T');
  place(g, 20, 39, 'm'); place(g, 27, 23, 'h'); place(g, 19, 23, '$');
  place(g, 22, 34, 'o'); place(g, 25, 28, 'o');
  place(g, 16, 26, '$'); place(g, 17, 27, 'L'); place(g, 16, 33, 'e'); place(g, 17, 32, 'H');

  // ---- pump room ----------------------------------------------------------
  place(g, 9, 42, 'a'); place(g, 14, 45, 'm');
  place(g, 8, 40, 'o'); place(g, 9, 40, 'o');
  place(g, 15, 41, 'M'); place(g, 7, 46, 'h'); place(g, 11, 43, 'L');
  place(g, 16, 46, '$');

  // ---- vent crawl ---------------------------------------------------------
  place(g, 4, 41, 'm'); place(g, 3, 42, 'T'); place(g, 4, 35, 'T');
  place(g, 6, 37, 'b'); place(g, 5, 36, 'o'); place(g, 7, 38, 'M'); place(g, 6, 36, 'L');
  place(g, 7, 36, 'h');

  // ---- valve chamber: the blue key ---------------------------------------
  place(g, 7, 29, 'u');
  place(g, 6, 28, 'D'); place(g, 8, 28, 'D'); place(g, 6, 30, 'D'); place(g, 8, 30, 'D');
  place(g, 3, 27, 'e'); place(g, 11, 32, 'h');
  place(g, 2, 33, 'M'); place(g, 12, 26, 'h'); place(g, 7, 26, 'L'); place(g, 7, 32, 'L');
  place(g, 2, 26, '$');

  // ---- the crossing: transept, and the naildriver --------------------------
  place(g, 37, 18, 'w');
  place(g, 12, 18, 'b'); place(g, 35, 20, 'b'); place(g, 20, 17, 'a'); place(g, 27, 20, 'e');
  place(g, 14, 17, 'D'); place(g, 14, 20, 'D'); place(g, 33, 17, 'D'); place(g, 33, 20, 'D');
  put(g, 17, 18, 'B'); put(g, 17, 19, 'B'); put(g, 30, 18, 'B'); put(g, 30, 19, 'B');
  place(g, 9, 16, 'L'); place(g, 38, 16, 'L'); place(g, 23, 21, 'L');
  place(g, 8, 21, 'H'); place(g, 39, 21, 'm'); place(g, 10, 19, 'o');
  place(g, 21, 16, 'T'); place(g, 26, 16, 'T');

  // ---- choir corridor + stalls -------------------------------------------
  place(g, 34, 26, 'o'); place(g, 34, 31, 'b'); place(g, 34, 36, 'a');
  place(g, 36, 25, '$'); place(g, 36, 31, 'M'); place(g, 32, 37, 'h');
  place(g, 30, 29, 'T'); place(g, 31, 34, 'T'); place(g, 30, 39, 'L');
  place(g, 31, 44, 'm'); place(g, 30, 25, 'o');

  // ---- west gallery -------------------------------------------------------
  put(g, 6, 6, 'p'); put(g, 7, 6, 'p'); put(g, 8, 6, 'p'); put(g, 8, 7, 'p');
  fill(g, 3, 9, 7, 12, ',');
  place(g, 5, 5, 'b'); place(g, 9, 10, 'a');
  place(g, 4, 11, 'M'); place(g, 10, 3, '$'); place(g, 6, 7, 'L'); place(g, 8, 5, 'D');
  place(g, 3, 8, 'T'); place(g, 11, 8, 'h');

  // ---- screen room --------------------------------------------------------
  place(g, 45, 17, 'e'); place(g, 42, 20, '$'); place(g, 45, 20, 'm'); place(g, 43, 18, 'L');

  // ---- deck A: the L over the choir --------------------------------------
  put(g, 35, 41, 'B'); put(g, 35, 42, 'B'); put(g, 39, 44, 'B'); put(g, 40, 44, 'B');
  put(g, 43, 35, 'B'); put(g, 43, 36, 'B');
  place(g, 37, 43, 'D'); place(g, 42, 38, 'D'); place(g, 44, 42, 'D');
  place(g, 45, 45, 'M'); place(g, 34, 45, 'm'); place(g, 45, 33, 'H');
  place(g, 41, 34, 'e'); place(g, 36, 40, 'm');

  // ---- deck B: the ring ---------------------------------------------------
  put(g, 16, 4, 'B'); put(g, 16, 10, 'B'); put(g, 31, 4, 'B'); put(g, 31, 10, 'B');
  place(g, 17, 7, 'D'); place(g, 30, 7, 'D'); place(g, 23, 3, 'D'); place(g, 24, 11, 'D');
  place(g, 14, 7, 'M'); place(g, 33, 7, 'm'); place(g, 19, 11, 'H'); place(g, 28, 3, 'm');
  place(g, 16, 3, 'b'); place(g, 32, 11, '$');
  place(g, 13, 12, 'T'); place(g, 34, 2, 'T');

  // ---- exit vestibule -----------------------------------------------------
  place(g, 37, 9, 'H'); place(g, 40, 8, 'L'); place(g, 42, 4, '$'); place(g, 36, 5, 'T');

  // ---- secret contents ----------------------------------------------------
  place(g, 2, 14, '$'); place(g, 2, 15, 'H');
  place(g, 15, 35, 'M'); place(g, 15, 37, '$');
  place(g, 42, 24, '$'); place(g, 44, 24, 'H');
  place(g, 3, 45, 'm'); place(g, 3, 46, '$');

  return toRows(g);
}
