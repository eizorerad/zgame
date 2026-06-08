/* =========================================================================
 * sprites.js — procedural pixel-art sprite factory.
 *
 * Every unit is hand-drawn with a small pixel grid (facing EAST), then baked
 * into 8 rotated facings (and 2 walk frames for infantry) at load time, so
 * runtime rendering is just fast blits. Vehicles bake the HULL and the
 * TURRET separately, letting tank turrets track a target while the hull
 * points along its path — the classic top-down RTS look.
 *
 * Palette comes from CFG.TEAM_PAL[team] so the same art recolours per side
 * (and uses the grey "neutral" palette for abandoned vehicles).
 * ========================================================================= */

const Sprites = {
  cache: {},

  build() {
    // infantry (2 walk frames each)
    for (const type of Object.keys(INFANTRY_TYPES))
      for (const team of ["blue", "red"])
        this.cache["inf:" + type + ":" + team] =
          bake(20, (g, f) => drawInfantry(g, CFG.TEAM_PAL[team], type, f), 2);

    // vehicle hulls + turrets (1 frame, 8 dirs), all three palettes
    for (const type of Object.keys(VEHICLE_TYPES))
      for (const team of ["blue", "red", "neutral"]) {
        const sz = hullSize(type);
        this.cache["hull:" + type + ":" + team] =
          bake(sz, (g) => drawHull(g, CFG.TEAM_PAL[team], type), 1);
        this.cache["turr:" + type + ":" + team] =
          bake(sz, (g) => drawTurret(g, CFG.TEAM_PAL[team], type), 1);
      }

    // pillbox: fixed base + rotating gun
    for (const team of ["blue", "red", "neutral"]) {
      this.cache["gbase:" + team] = bakeStatic(28, (g) => drawGunBase(g, CFG.TEAM_PAL[team]));
      this.cache["gturr:" + team] = bake(28, (g) => drawGunTurret(g, CFG.TEAM_PAL[team]), 1);
    }

    // production buildings (static, detailed pixel art)
    for (const ft of ["robot", "vehicle", "gun"])
      for (const team of ["blue", "red", "neutral"])
        this.cache["bld:" + ft + ":" + team] = bakeStatic(56, (g) => drawBuilding(g, CFG.TEAM_PAL[team], ft));
  },

  infantry(type, team, dir, frame) { return this.cache["inf:" + type + ":" + team][dir][frame]; },
  hull(type, team, dir)            { return this.cache["hull:" + type + ":" + team][dir][0]; },
  turret(type, team, dir)          { return this.cache["turr:" + type + ":" + team][dir][0]; },
  gunBase(team)                    { return this.cache["gbase:" + team]; },
  gunTurret(team, dir)             { return this.cache["gturr:" + team][dir][0]; },
  building(ft, team)               { return this.cache["bld:" + ft + ":" + team]; },
};

/* ---- baking helpers ---------------------------------------------------- */
function makeCanvas(s) { const c = document.createElement("canvas"); c.width = c.height = s; return c; }

function bakeStatic(size, drawFn) {
  const c = makeCanvas(size);
  const g = c.getContext("2d"); g.imageSmoothingEnabled = false;
  g.translate(size / 2, size / 2); drawFn(g);
  return c;
}

function bake(size, drawFn, frames) {
  const baseFrames = [];
  for (let f = 0; f < frames; f++) baseFrames.push(bakeStaticFrame(size, drawFn, f));
  const dirs = [];
  for (let d = 0; d < 8; d++) {
    const frs = [];
    for (let f = 0; f < frames; f++) {
      const c = makeCanvas(size);
      const g = c.getContext("2d"); g.imageSmoothingEnabled = false;
      g.translate(size / 2, size / 2);
      g.rotate(d * Math.PI / 4);
      g.drawImage(baseFrames[f], -size / 2, -size / 2);
      frs.push(c);
    }
    dirs.push(frs);
  }
  return dirs;
}
function bakeStaticFrame(size, drawFn, f) {
  const c = makeCanvas(size);
  const g = c.getContext("2d"); g.imageSmoothingEnabled = false;
  g.translate(size / 2, size / 2); drawFn(g, f);
  return c;
}

// pixel helper (coords are relative to the already-translated centre)
function px(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); }
// crisp pixel disc (no anti-aliasing) — sprites use a 1px lattice for detail
function disc(g, x, y, r, c) { PX.fillCircle(g, x, y, r, c, 1); }

/* =========================================================================
 * INFANTRY  (facing east — weapon points +x)
 * ========================================================================= */
function drawInfantry(g, pal, type, frame) {
  const big = type === "psycho";
  const thin = type === "sniper";
  const pyro = type === "pyro";

  // --- legs (walk cycle: stride along the east/west axis) ---
  const s = frame ? 1 : -1;
  px(g, -1 + s * 2, -5, 2, 3, pal.metalLo);   // north leg
  px(g, -1 - s * 2, 3, 2, 3, pal.metalLo);    // south leg
  px(g, s * 2, -5, 2, 1, pal.metal);          // boot highlights
  px(g, -s * 2, 5, 2, 1, pal.metal);

  // --- backpack ---
  if (pyro) {
    px(g, -7, -3, 3, 6, pal.metalLo);         // twin fuel tanks
    px(g, -7, -3, 3, 2, "#c5532a");
    px(g, -7, 1, 3, 2, "#c5532a");
  } else {
    px(g, -6, -2, 2, 4, pal.metalLo);
  }

  // --- torso ---
  const tw = big ? 8 : thin ? 5 : 6;
  const th = big ? 8 : thin ? 5 : 6;
  px(g, -tw / 2, -th / 2, tw, th, pal.dark);
  px(g, -tw / 2 + 1, -th / 2 + 1, tw - 2, th - 2, pal.main);
  px(g, -tw / 2 + 1, -th / 2 + 1, tw - 2, 1, pal.light);  // top sheen

  // shoulders
  px(g, -2, -th / 2 - 1, 2, 2, pal.metal);
  px(g, -2, th / 2 - 1, 2, 2, pal.metal);

  // --- helmet (forward/east), with dark visor slit ---
  px(g, -1, -2, 4, 4, pal.light);
  px(g, 0, -2, 3, 1, "#ffffff");
  px(g, 2, -1, 1, 2, pal.trim);

  // --- weapon ---
  px(g, 0, -1, 3, 2, pal.metal);              // arms
  if (type === "sniper") {
    px(g, 2, 0, 9, 1, "#202020");             // long rifle
    px(g, 1, -1, 2, 2, pal.trim);             // stock
    px(g, 6, -1, 1, 1, "#9ce6ff");            // scope glint
    px(g, 10, 0, 1, 1, "#ffe089");            // muzzle
  } else if (pyro) {
    px(g, 2, -1, 5, 3, "#2a2a2a");            // flamer body
    px(g, 7, -1, 2, 3, "#cf5a26");            // nozzle
    px(g, 9, 0, 1, 1, "#ffd24a");
  } else if (big) {
    px(g, 2, -2, 5, 1, "#202020");            // twin barrels
    px(g, 2, 1, 5, 1, "#202020");
    px(g, 1, -2, 2, 4, pal.trim);
    px(g, 7, -2, 1, 1, "#ffe089"); px(g, 7, 1, 1, 1, "#ffe089");
  } else {
    px(g, 2, 0, 6, 1, "#202020");             // rifle
    px(g, 1, 0, 2, 2, pal.trim);
    px(g, 8, 0, 1, 1, "#ffe089");
  }
}

/* =========================================================================
 * VEHICLES
 * ========================================================================= */
function hullSize(type) {
  return { jeep: 24, light: 28, medium: 32, apc: 30 }[type] || 28;
}

function drawHull(g, pal, type) {
  if (type === "jeep") return drawJeepHull(g, pal);
  // tanks / apc: tracked hull
  const dims = { light: [9, 7], medium: [11, 8], apc: [10, 8] }[type];
  const L = dims[0], W = dims[1];

  // tracks (north & south edges)
  px(g, -L, -W, 2 * L, 3, "#1c1c1c");
  px(g, -L, W - 3, 2 * L, 3, "#1c1c1c");
  for (let x = -L + 1; x < L - 1; x += 3) {        // tread links
    px(g, x, -W, 2, 1, "#3a3a3a");
    px(g, x, W - 1, 2, 1, "#3a3a3a");
  }

  // hull body
  px(g, -L + 1, -W + 3, 2 * L - 2, 2 * W - 6, pal.metalLo);
  px(g, -L + 2, -W + 4, 2 * L - 4, 2 * W - 8, pal.metal);
  // team colour deck stripe + sheen
  px(g, -L + 2, -2, 2 * L - 4, 4, pal.dark);
  px(g, -L + 2, -W + 4, 2 * L - 4, 1, pal.light);
  // front glacis (east)
  px(g, L - 3, -W + 5, 2, 2 * W - 10, pal.dark);
  px(g, L - 1, -1, 1, 2, "#101010");
  // rivets
  px(g, -L + 3, -W + 5, 1, 1, "#101010");
  px(g, -L + 3, W - 6, 1, 1, "#101010");

  if (type === "apc") {                              // rear hatch
    px(g, -L + 2, -3, 3, 6, pal.trim);
    px(g, -L + 2, -1, 3, 2, pal.light);
  }
}

function drawJeepHull(g, pal) {
  // wheels
  for (const [wx, wy] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
    disc(g, wx, wy, 3, "#161616");
    disc(g, wx, wy, 1.3, "#3a3a3a");
  }
  // chassis
  px(g, -6, -4, 12, 8, pal.metalLo);
  px(g, -5, -3, 10, 6, pal.main);
  px(g, -5, -3, 10, 1, pal.light);
  // seats / open top
  px(g, -3, -2, 4, 4, pal.metalLo);
  // roll bar
  px(g, -1, -4, 1, 8, "#202020");
  // hood (east)
  px(g, 4, -3, 2, 6, pal.dark);
}

function drawTurret(g, pal, type) {
  if (type === "jeep") {                             // pintle MG
    disc(g, -1, 0, 2.4, pal.dark);
    px(g, 0, -1, 7, 2, "#1c1c1c");
    px(g, 6, -1, 2, 1, "#444");
    return;
  }
  if (type === "apc") {                              // light MG cupola
    disc(g, 0, 0, 3.2, pal.dark);
    disc(g, 0, 0, 2.2, pal.main);
    px(g, 2, -1, 6, 2, "#1c1c1c");
    px(g, 0, -1, 2, 1, pal.light);
    return;
  }
  // tank turret
  const r = type === "medium" ? 6 : 5;
  const bl = type === "medium" ? 13 : 11;
  disc(g, 0, 0, r + 0.5, "#101010");
  disc(g, 0, 0, r, pal.metal);
  disc(g, -0.5, -0.5, r - 1.5, pal.main);
  px(g, -1.5, -1.5, 2, 2, pal.light);                // hatch sheen
  // mantlet + barrel (east)
  px(g, r - 2, -2, 3, 4, pal.metalLo);
  px(g, r, -1.5, bl - r, 3, "#1c1c1c");
  px(g, bl - 2, -1, 2, 2, "#333");                   // muzzle brake
}

/* ---- pillbox (immobile gun emplacement) -------------------------------- */
function drawGunBase(g, pal) {
  // sandbag ring
  for (let a = 0; a < 8; a++) {
    const x = Math.cos(a / 8 * 7) * 9, y = Math.sin(a / 8 * 7) * 9;
    disc(g, x, y, 3, CFG.COLORS.wall);
    disc(g, x, y, 2, CFG.COLORS.wallLo);
  }
  // bunker
  disc(g, 0, 0, 7, pal.metalLo);
  disc(g, 0, 0, 6, pal.metal);
  disc(g, -1, -1, 3, pal.dark);
}
function drawGunTurret(g, pal) {
  disc(g, 0, 0, 4, pal.main);
  disc(g, -1, -1, 2, pal.light);
  px(g, 3, -2, 9, 4, pal.metalLo);
  px(g, 4, -1, 8, 2, "#1c1c1c");
  px(g, 11, -2, 1, 4, "#333");
}

/* =========================================================================
 * PRODUCTION BUILDINGS — detailed pixel art, drawn facing the camera.
 * Animated bits (status lights, beacon, smoke) are layered at runtime.
 * ========================================================================= */
function tint(hex, f) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(0, 2), 16) * f)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(2, 4), 16) * f)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(4, 6), 16) * f)));
  return `rgb(${r},${g},${b})`;
}

// shared industrial tones
const CON = "#3a3d42", CONL = "#2c2f33", CON2 = "#46494f";
const DRK = "#15171a", MID = "#23262a", STEEL = "#4a4e54";

function drawBuilding(g, pal, ft) {
  if (ft === "robot") drawRobotFactory(g, pal);
  else if (ft === "vehicle") drawVehicleFactory(g, pal);
  else drawGunFactory(g, pal);
}

/* Robot factory — domed silo with a hangar door (the classic Z look). */
function drawRobotFactory(g, pal) {
  const M = pal.metal, ML = pal.metalLo, D = pal.dark, MA = pal.main;
  px(g, -20, 16, 40, 4, "rgba(0,0,0,0.28)");          // shadow

  // cylindrical silo body with column shading
  px(g, -15, -6, 30, 22, ML);
  px(g, -14, -6, 28, 22, CON);
  px(g, -13, -6, 9, 22, CON2);
  px(g, -6, -6, 5, 22, tint(CON, 1.18));
  px(g, 9, -6, 5, 22, CONL);

  // dome
  for (let i = 0; i < 15; i++) {
    const t = i / 15, w = Math.round(16 * Math.sqrt(1 - t * t)), y = -7 - i;
    px(g, -w, y, 2 * w, 1, ML);
    px(g, -w + 1, y, Math.max(1, Math.round(w * 1.0)), 1, M);
    px(g, -Math.round(w * 0.35), y, Math.max(1, Math.round(w * 0.5)), 1, tint(M, 1.22));
  }
  px(g, -16, -7, 32, 2, MA); px(g, -16, -7, 32, 1, tint(MA, 1.3));   // team band

  px(g, 12, -26, 2, 9, DRK);                           // antenna mast (beacon at runtime)

  // hangar door
  px(g, -8, 3, 16, 12, DRK);
  for (let y = 5; y < 15; y += 3) px(g, -7, y, 14, 1, MID);
  px(g, -9, 2, 18, 2, D); px(g, -9, 2, 18, 1, tint(MA, 1.2));

  // emblem sign (robot head)
  px(g, -7, -3, 14, 5, "#0c0d0f");
  px(g, -3, -2, 6, 4, MA); px(g, -2, -1, 1, 1, "#0c0d0f"); px(g, 1, -1, 1, 1, "#0c0d0f");

  px(g, -13, 0, 3, 3, "#ffd24a"); px(g, 10, 0, 3, 3, "#ffd24a");      // lit windows
  px(g, -14, -5, 1, 1, "#101010"); px(g, 13, -4, 1, 1, "#101010");    // rivets
}

/* Vehicle factory — wide hall, gantry, big bay door, status panel, stack. */
function drawVehicleFactory(g, pal) {
  const M = pal.metal, ML = pal.metalLo, D = pal.dark, MA = pal.main;
  px(g, -24, 16, 48, 4, "rgba(0,0,0,0.28)");

  // main hall
  px(g, -22, -8, 44, 24, ML);
  px(g, -21, -7, 42, 22, CON);
  for (let x = -20; x < 21; x += 3) px(g, x, -3, 2, 17, CON2);        // corrugation
  px(g, -21, 12, 42, 3, CONL);

  // roof + stepped skylights + gantry
  px(g, -23, -12, 46, 5, D); px(g, -23, -12, 46, 1, tint(MA, 1.2));
  for (let x = -20; x < 20; x += 8) { px(g, x, -11, 6, 1, M); px(g, x + 1, -12, 4, 1, tint(M, 1.25)); }
  px(g, -18, -15, 36, 2, STEEL); px(g, -18, -16, 36, 1, "#5e636a");

  // chimney
  px(g, -20, -23, 5, 12, "#2a2a2a"); px(g, -21, -24, 7, 2, D); px(g, -20, -23, 2, 12, "#3a3a3a");

  // big segmented vehicle bay door
  px(g, -12, -1, 24, 15, DRK);
  for (let y = 1; y < 14; y += 3) px(g, -11, y, 22, 1, MID);
  px(g, -13, -2, 26, 2, MA); px(g, -13, -2, 26, 1, tint(MA, 1.3));
  px(g, -3, 3, 6, 7, "#0c0d0f"); px(g, -2, 4, 4, 5, MA);             // bay number plate

  px(g, 15, -6, 5, 12, "#0c0d0f");                                    // status-light sockets
  px(g, -23, -6, 2, 16, "#3a3a3a"); px(g, -24, -2, 3, 2, "#2a2a2a"); // side pipe
  for (let x = -18; x < -2; x += 5) px(g, x, -6, 3, 3, "#ffd24a");    // window row
  px(g, 20, -6, 1, 1, "#101010"); px(g, -21, -6, 1, 1, "#101010");
}

/* Gun factory — armored bunker with battered walls and ammo crates. */
function drawGunFactory(g, pal) {
  const ML = pal.metalLo, D = pal.dark, MA = pal.main;
  px(g, -20, 16, 40, 4, "rgba(0,0,0,0.28)");

  // battered (sloped) walls — widen toward the base
  for (let i = 0; i < 6; i++) { const w = 28 + i * 2; px(g, -Math.round(w / 2), -6 + i * 3, w, 3, i < 2 ? ML : CON); }
  px(g, -15, -6, 30, 20, CON);
  px(g, -15, 8, 30, 4, CONL);
  px(g, -17, -9, 34, 4, D); px(g, -17, -9, 34, 1, STEEL);            // armored roof slab

  // reinforced door
  px(g, -7, 2, 14, 12, DRK);
  px(g, -8, 1, 16, 2, MA); px(g, -8, 1, 16, 1, tint(MA, 1.2));
  px(g, -7, 5, 14, 1, MID); px(g, -7, 9, 14, 1, MID);

  // roof sign + shell emblem
  px(g, -6, -8, 12, 3, "#0c0d0f");
  px(g, -5, -7, 8, 1, MA); px(g, -1, -9, 2, 4, MA);

  // ammo crates
  for (const cx of [-20, 15]) {
    px(g, cx, 6, 7, 7, "#6b5a3a"); px(g, cx, 6, 7, 1, "#86714a");
    px(g, cx + 3, 6, 1, 7, "#4a3d28"); px(g, cx, 9, 7, 1, "#4a3d28");
  }
  disc(g, -16, 12, 3, CFG.COLORS.wall); disc(g, 16, 12, 3, CFG.COLORS.wall);  // sandbags
  px(g, -13, -7, 4, 2, STEEL); px(g, 9, -7, 4, 2, STEEL);            // vents
}
