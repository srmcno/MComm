// LEVEL 1 - INTAKE (40x40). Teaching level: vestibule -> muster hall -> gallery
// -> guard post / machine room -> cross-shaped silo deck -> elevator.
import { G, fill, col, put, place, outlineIfWall, rowIfWall, colIfWall, toRows } from './mapkit.js';

export default function intake() {
  const g = G(40, 40, '#');

  // ---- carve spaces -------------------------------------------------------
  fill(g, 17, 34, 22, 38, ' ');      // intake vestibule (start)
  fill(g, 8, 24, 30, 32, ' ');       // muster hall
  fill(g, 32, 25, 37, 31, ' ');      // decon showers
  fill(g, 4, 27, 6, 29, ' ');        // secret closet A
  col(g, 12, 21, 23, ' ');           // west neck hall->gallery
  col(g, 27, 21, 23, ' ');           // east neck hall->gallery
  fill(g, 6, 18, 36, 20, '_');       // pipe gallery (grating)
  fill(g, 16, 15, 20, 17, ' ');      // pump bay off the gallery (landmark)
  fill(g, 3, 11, 10, 16, ' ');       // guard post
  fill(g, 3, 3, 10, 8, ' ');         // north storage
  col(g, 5, 9, 10, ' ');             // storage <-> guard post neck
  fill(g, 12, 3, 13, 4, ' ');        // secret closet B
  fill(g, 30, 13, 37, 16, ' ');      // machine room
  fill(g, 26, 15, 28, 16, ' ');      // secret closet C
  col(g, 24, 14, 17, ' ');           // deck airlock
  fill(g, 21, 2, 27, 13, '^');       // deck: vertical arm
  fill(g, 14, 6, 33, 10, '^');       // deck: transverse arm
  fill(g, 35, 3, 38, 10, ' ');       // exit vestibule
  put(g, 36, 2, ' ');              // the elevator car sits in its own alcove

  // ---- materials ----------------------------------------------------------
  outlineIfWall(g, 7, 23, 31, 33, '#');    // muster hall: plain concrete
  outlineIfWall(g, 16, 33, 23, 39, '=');   // vestibule: steel
  outlineIfWall(g, 31, 24, 38, 32, 't');   // decon: tile
  rowIfWall(g, 33, 36, 32, ':');           // ...gone bad at the drain end
  outlineIfWall(g, 5, 17, 37, 21, 'p');    // gallery: pipe banks
  outlineIfWall(g, 15, 14, 21, 18, 'v');   // pump bay: vent grates
  outlineIfWall(g, 2, 10, 11, 17, '#');    // guard post
  rowIfWall(g, 3, 10, 10, 'S');            // screen bank on its north wall
  outlineIfWall(g, 2, 2, 11, 9, 'R');      // storage: rust
  outlineIfWall(g, 29, 12, 38, 17, 'C');   // machine room: circuitry
  outlineIfWall(g, 23, 13, 25, 18, '=');   // airlock throat
  put(g, 23, 15, '!'); put(g, 25, 15, '!');
  outlineIfWall(g, 13, 5, 34, 11, 'W');    // deck arms: silo wall
  outlineIfWall(g, 20, 1, 28, 14, 'W');
  put(g, 21, 1, 'N'); put(g, 27, 1, 'N');  // warning placards on the silo lip
  put(g, 13, 8, 'N'); put(g, 34, 8, 'N');
  outlineIfWall(g, 34, 2, 39, 11, '=');    // exit vestibule
  colIfWall(g, 34, 3, 5, '+');             // riveted seam - hints the door below

  // ---- doors --------------------------------------------------------------
  put(g, 19, 33, '-');   // vestibule -> muster hall
  put(g, 12, 22, '-');   // hall -> gallery (west)
  put(g, 27, 22, '-');   // hall -> gallery (east)
  put(g, 31, 28, '-');   // hall -> decon
  put(g, 6, 17, '-');    // gallery -> guard post
  put(g, 33, 17, '-');   // gallery -> machine room
  put(g, 24, 16, '-');   // airlock door
  put(g, 34, 8, '-');    // deck -> exit vestibule

  // ---- secrets ------------------------------------------------------------
  put(g, 7, 28, '%');    // muster hall west wall -> closet A
  put(g, 11, 4, '%');    // storage east wall     -> closet B
  put(g, 29, 15, '%');   // machine room west wall-> closet C

  // ---- start + exit -------------------------------------------------------
  place(g, 19, 37, '@');
  place(g, 36, 2, 'E');

  // ---- vestibule ----------------------------------------------------------
  place(g, 18, 35, 'L'); place(g, 21, 35, 'T');
  place(g, 21, 38, 'h');

  // ---- muster hall: first fight, cover, a lit reward ----------------------
  place(g, 12, 27, 'a'); place(g, 26, 30, 'a');
  put(g, 14, 28, 'B'); put(g, 15, 28, 'B'); put(g, 24, 28, 'B'); put(g, 25, 28, 'B');
  place(g, 13, 30, 'D'); place(g, 25, 26, 'D');
  put(g, 20, 24, 'B'); put(g, 20, 25, 'B');   // barricade breaks the long sightline
  place(g, 17, 26, 'o'); place(g, 22, 30, 'o');
  place(g, 12, 25, 'L'); place(g, 26, 25, 'L'); place(g, 19, 31, 'L');
  place(g, 9, 31, 'h'); place(g, 29, 25, 'm'); place(g, 9, 24, '$');

  // ---- decon showers: the splitter ---------------------------------------
  fill(g, 33, 29, 36, 30, ';');
  place(g, 35, 30, 'a');
  place(g, 34, 26, 'w');
  place(g, 36, 26, 'h'); place(g, 33, 26, 'T');

  // ---- pipe gallery -------------------------------------------------------
  place(g, 30, 19, 'b');
  place(g, 17, 19, 'o');
  place(g, 10, 20, 'm'); place(g, 35, 19, 'm');
  place(g, 14, 18, 'T'); place(g, 21, 20, 'T'); place(g, 29, 18, 'T');

  // ---- pump bay -----------------------------------------------------------
  place(g, 18, 16, 'b');
  place(g, 16, 15, 'M'); place(g, 20, 15, 'o'); place(g, 18, 15, 'L');
  place(g, 17, 17, 'D'); place(g, 19, 17, 'D');

  // ---- guard post ---------------------------------------------------------
  place(g, 5, 13, 'b'); place(g, 9, 15, 'b');
  place(g, 4, 12, 'M'); place(g, 9, 12, 'h'); place(g, 6, 14, 'L');
  place(g, 4, 16, 'D');

  // ---- north storage ------------------------------------------------------
  place(g, 8, 4, 'o'); place(g, 9, 7, 'm'); place(g, 4, 4, '$'); place(g, 6, 6, 'L');

  // ---- machine room -------------------------------------------------------
  place(g, 35, 14, 'a');
  place(g, 31, 13, 'M'); place(g, 36, 16, 'T');

  // ---- secret closets -----------------------------------------------------
  place(g, 4, 27, '$'); place(g, 4, 29, 'H');   // A
  place(g, 12, 3, '$'); place(g, 13, 3, 'H');   // B
  place(g, 26, 16, '$'); place(g, 28, 16, 'M'); // C

  // ---- the deck -----------------------------------------------------------
  put(g, 24, 14, 'Z');
  put(g, 19, 7, 'B'); put(g, 19, 9, 'B'); put(g, 28, 7, 'B'); put(g, 28, 9, 'B');
  place(g, 23, 4, 'D'); place(g, 25, 12, 'D');
  place(g, 16, 8, 'M'); place(g, 31, 8, 'm');
  place(g, 24, 3, 'h'); place(g, 22, 11, 'm');
  place(g, 30, 9, 'a');

  // ---- exit vestibule -----------------------------------------------------
  place(g, 37, 10, 'H'); place(g, 36, 7, 'L'); place(g, 35, 3, 'T');

  return toRows(g);
}
