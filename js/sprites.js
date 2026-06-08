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
        this.cache["bld:" + ft + ":" + team] = bakeStatic(80, (g) => drawBuilding(g, CFG.TEAM_PAL[team], ft));
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

// metallic ramp for shaded spheres/panels; metalTone(0..1) picks a step
const METAL_RAMP = ["#2f343a", "#3c424a", "#4b525b", "#5d656e", "#717a84", "#878f99", "#9da6b0", "#b6bfc8", "#d2dae2"];
function metalTone(t) { return METAL_RAMP[Math.max(0, Math.min(METAL_RAMP.length - 1, Math.round(t * (METAL_RAMP.length - 1))))]; }
// 1px checkerboard dither between two colours (grime / weathering)
function dither(g, x, y, w, h, c1, c2) {
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    g.fillStyle = ((x + xx + y + yy) & 1) ? c1 : c2; g.fillRect(x + xx, y + yy, 1, 1);
  }
}

// shared industrial tones
const CON = "#3a3d42", CONL = "#2c2f33", CON2 = "#46494f";
const DRK = "#15171a", MID = "#23262a", STEEL = "#4a4e54";
// roof (top, lit) / front face (darker) / skylight glass
const ROOF = "#52565c", ROOFL = "#4a4e54", ROOFH = "#6a6f76", ROOFS = "#2c2f33";
const FACE = "#34373c", FACEH = "#3e4147", FACES = "#2a2c30";
const GLASS = "#6fb0c8", GLASSH = "#9fd6ec";

function drawBuilding(g, pal, ft) {
  if (ft === "robot") drawRobotFactory(g, pal);
  else if (ft === "vehicle") drawVehicleFactory(g, pal);
  else drawGunFactory(g, pal);
}

/* Buildings: 3/4 view with a tall structure, heavy metallic shading,
 * dithered grime, and a cast shadow. Lit from the top-left. */

/* Robot factory — drum body with a big geodesic metal dome, like Z. */
function drawRobotFactory(g, pal) {
  const MA = pal.main, MD = pal.dark;
  for (let r = 0; r < 6; r++) px(g, -17 + r * 2, 15 + r * 2, 36, 2, "rgba(0,0,0,0.14)");  // cast shadow

  // ---- drum body (metal upper, team skirt, dark archway) ----
  const bx0 = -16, bx1 = 16, by0 = -3, by1 = 17;
  for (let x = bx0; x <= bx1; x++) {
    const nx = Math.abs(x) / 17;
    for (let y = by0; y < by1; y++) {
      if (y >= by1 - 5) g.fillStyle = ((x + y) & 1) ? MD : tint(MD, 0.82);     // team skirt
      else g.fillStyle = metalTone(0.72 - nx * 0.55 - (y - by0) / 46);          // curved metal
      g.fillRect(x, y, 1, 1);
    }
  }
  px(g, bx0, by0, bx1 - bx0 + 1, 2, MA); px(g, bx0, by0, bx1 - bx0 + 1, 1, tint(MA, 1.35)); // team band
  // arched doorway
  px(g, -7, by1 - 10, 14, 10, "#0a0b0d");
  px(g, -6, by1 - 11, 12, 1, "#0a0b0d"); px(g, -4, by1 - 12, 8, 1, "#0a0b0d");
  px(g, -5, by1 - 7, 10, 6, "#15181c");
  px(g, -8, by1 - 10, 1, 10, MA); px(g, 7, by1 - 10, 1, 10, MA);
  px(g, bx0 - 1, by1 - 4, 2, 5, "#26292d"); px(g, bx1, by1 - 4, 2, 5, "#26292d");  // struts
  px(g, -14, by0 + 3, 1, 14, "#26292d"); px(g, 13, by0 + 3, 1, 14, "#3a3f45");     // weld seams

  // ---- geodesic metal dome ----
  const dcx = 0, dcy = -14, R = 17;
  for (let yy = -R; yy <= R; yy++) for (let xx = -R; xx <= R; xx++) {
    if (xx * xx + yy * yy > R * R) continue;
    const nx = xx / R, ny = yy / R, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    let dif = 0.16 + 0.84 * Math.max(0, Math.min(1, nz * 0.65 - nx * 0.22 - ny * 0.52));
    const lon = Math.atan2(nx, nz), lat = Math.asin(Math.max(-1, Math.min(1, ny)));
    const seam = Math.abs(((lon / (Math.PI / 5)) % 1 + 1.5) % 1 - 0.5) < 0.05
              || Math.abs(((lat / (Math.PI / 6)) % 1 + 1.5) % 1 - 0.5) < 0.05;
    if (seam) dif *= 0.7;
    g.fillStyle = metalTone(dif); g.fillRect(dcx + xx, dcy + yy, 1, 1);
  }
  px(g, dcx - 6, dcy - 7, 2, 2, "#eef4fa"); px(g, dcx - 5, dcy - 6, 2, 2, "#cdd9e6");  // specular
  for (let xx = -R; xx <= R; xx++) { const yy = Math.round(Math.sqrt(Math.max(0, R * R - xx * xx))); px(g, dcx + xx, dcy + yy - 1, 1, 1, tint(MA, 0.9)); } // team rim
  px(g, 13, -30, 2, 13, "#15171a");                  // antenna mast (beacon at runtime)
}

/* Vehicle factory — concrete hall, sawtooth glass roof, green readout. */
function drawVehicleFactory(g, pal) {
  const MA = pal.main;
  for (let r = 0; r < 5; r++) px(g, -23 + r * 2, 13 + r * 2, 46, 2, "rgba(0,0,0,0.14)");

  // ---- front face (dithered concrete + grime) ----
  dither(g, -22, -2, 44, 14, FACE, FACES);
  px(g, -22, -2, 3, 14, FACEH); px(g, 17, -2, 5, 14, FACES);
  px(g, -22, -2, 44, 2, ROOFS);
  px(g, 6, -2, 1, 14, "#26282c"); px(g, -6, -2, 1, 14, "#26282c");   // rust streaks
  // big bay door with a vehicle silhouette inside
  px(g, -12, 0, 24, 12, "#101216");
  for (let y = 2; y < 12; y += 2) px(g, -11, y, 22, 1, "#1c1f24");
  px(g, -7, 6, 14, 4, "#23262b"); px(g, -4, 4, 8, 3, "#2a2e34"); px(g, 3, 5, 4, 2, "#2a2e34"); // tank shape
  px(g, -13, -1, 26, 2, MA); px(g, -13, -1, 26, 1, tint(MA, 1.35));
  px(g, 15, 0, 5, 11, "#0a0b0d");                                    // status-light sockets
  px(g, -21, -1, 2, 13, "#2a2e34"); for (let y = 0; y < 12; y += 2) px(g, -21, -1 + y, 2, 1, "#3a3f45"); // ladder

  // ---- roof ----
  dither(g, -21, -26, 42, 24, ROOF, ROOFL);
  px(g, -21, -26, 42, 3, MA); px(g, -21, -26, 42, 1, tint(MA, 1.3)); // team stripe
  // sawtooth north-light skylights
  for (let x = -18; x < 17; x += 8) {
    px(g, x, -22, 7, 18, "#3f444a");
    px(g, x, -22, 7, 2, ROOFS);
    px(g, x + 1, -19, 5, 13, GLASS);
    for (let gy = -19; gy < -6; gy += 2) px(g, x + 1, gy, 5, 1, tint(GLASS, 0.82)); // glazing bars
    px(g, x + 1, -19, 5, 2, GLASSH);
  }
  px(g, -20, -24, 40, 1, STEEL); px(g, -20, -25, 40, 1, "#5e636a");  // gantry rail
  // rooftop kit
  px(g, -20, -31, 5, 7, "#242424"); px(g, -21, -32, 7, 2, ROOFS); px(g, -20, -31, 2, 7, "#343434"); px(g, -19, -33, 3, 2, "#1a1a1a"); // chimney
  px(g, 12, -31, 9, 6, STEEL); px(g, 12, -31, 9, 1, "#5e636a"); for (let x = 13; x < 21; x += 2) px(g, x, -30, 1, 4, "#3a3f45"); // AC unit
  disc(g, -14, -29, 3, "#6a6f76"); disc(g, -14, -29, 1, "#9aa1a9"); // vent fan
  // edges
  px(g, -21, -26, 1, 24, ROOFH); px(g, 20, -26, 1, 24, ROOFS); px(g, -21, -3, 42, 1, ROOFS);
}

/* Gun factory — armored bunker, plated roof, radar, ammo. */
function drawGunFactory(g, pal) {
  const MA = pal.main;
  for (let r = 0; r < 4; r++) px(g, -18 + r * 2, 13 + r * 2, 38, 2, "rgba(0,0,0,0.14)");

  // front face
  dither(g, -18, 0, 36, 12, FACE, FACES);
  px(g, -18, 0, 3, 12, FACEH); px(g, 13, 0, 5, 12, FACES);
  px(g, -18, 0, 36, 2, ROOFS);
  px(g, -7, 2, 14, 10, "#0a0b0d");                                   // reinforced door
  px(g, -8, 1, 16, 2, MA); px(g, -8, 1, 16, 1, tint(MA, 1.2));
  px(g, -7, 5, 14, 1, MID); px(g, -7, 9, 14, 1, MID);

  // armored plated roof (bevelled plates)
  dither(g, -17, -16, 34, 16, ROOF, ROOFL);
  for (let x = -16; x < 15; x += 8) for (let y = -15; y < -1; y += 7) {
    px(g, x + 1, y, 7, 6, "#565a60"); px(g, x + 1, y, 7, 1, "#6a6f76"); px(g, x + 1, y, 1, 6, "#646b72"); px(g, x + 1, y + 5, 7, 1, ROOFS);
  }
  disc(g, 0, -8, 5, "#3a3d42"); disc(g, 0, -8, 3, MA); disc(g, -1, -9, 1, tint(MA, 1.3)); // hatch (beacon at runtime)
  px(g, -16, -16, 5, 2, MA); px(g, 11, -16, 5, 2, MA);             // team caps
  // radar dish on a corner
  px(g, 12, -19, 1, 4, STEEL); disc(g, 12, -20, 3, "#6a6f76"); disc(g, 12, -20, 2, "#3a3f45"); px(g, 12, -20, 1, 1, MA);
  // ammo crates + sandbags
  for (const cx of [-22, 16]) { px(g, cx, 7, 7, 6, "#6b5a3a"); px(g, cx, 7, 7, 1, "#86714a"); px(g, cx + 3, 7, 1, 6, "#4a3d28"); px(g, cx, 10, 7, 1, "#4a3d28"); }
  disc(g, -16, 12, 3, CFG.COLORS.wall); disc(g, 16, 12, 3, CFG.COLORS.wall);
  px(g, -17, -16, 1, 16, ROOFH); px(g, 16, -16, 1, 16, ROOFS); px(g, -17, -1, 34, 1, ROOFS);
}
