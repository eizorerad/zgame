/* =========================================================================
 * config.js — global constants & data tables
 * Tunables for the whole game live here so balancing is one file away.
 * ========================================================================= */

const CFG = {
  TILE: 16,            // pixel size of one grid tile
  COLS: 64,            // map width  in tiles
  ROWS: 40,            // map height in tiles

  // Production: Actual = Base / (1 + sectorsOwned * MULT)
  SECTOR_SPEED_MULT: 0.18,

  // Flag capture happens on contact within this pixel radius
  FLAG_CAPTURE_RADIUS: 14,

  // How wide a unit "sees" for autonomous aggression (pixels)
  DEFAULT_AGGRO: 120,

  // Fort
  FORT_HP: 500,
  FORT_TURRET_RANGE: 150,
  FORT_TURRET_DMG: 14,
  FORT_TURRET_COOLDOWN: 0.7,

  COLORS: {
    neutral: "#b8b8b8",
    blue: "#4da6ff",
    blueDk: "#1a4d80",
    red: "#ff5b5b",
    redDk: "#802121",
    grass: "#2f4a2a",
    grass2: "#27401f",
    rock: "#6b6457",
    rockDk: "#4a4439",
    wall: "#7a6b50",
    bridge: "#5a4632",
  },
};

const TEAM = { NEUTRAL: "neutral", BLUE: "blue", RED: "red" };

function enemyOf(team) {
  return team === TEAM.BLUE ? TEAM.RED : TEAM.BLUE;
}

/* ---- Infantry types -------------------------------------------------------
 * baseTime  : seconds to build at 0 sectors
 * radius/hp/speed/range/dmg/cooldown are runtime stats
 * sniper    : chance to bypass vehicle armour & kill the driver outright
 * ------------------------------------------------------------------------- */
const INFANTRY_TYPES = {
  grunt:  { name: "Grunt",  baseTime: 8,  hp: 30,  speed: 46, range: 70,  dmg: 6,  cooldown: 0.45, radius: 5, aggro: 120 },
  psycho: { name: "Psycho", baseTime: 14, hp: 55,  speed: 58, range: 40,  dmg: 16, cooldown: 0.30, radius: 6, aggro: 170 },
  sniper: { name: "Sniper", baseTime: 18, hp: 24,  speed: 40, range: 150, dmg: 10, cooldown: 1.3,  radius: 5, aggro: 190, snipeChance: 0.35 },
  pyro:   { name: "Pyro",   baseTime: 16, hp: 40,  speed: 48, range: 55,  dmg: 22, cooldown: 0.5,  radius: 6, aggro: 130 },
};

/* ---- Vehicle types --------------------------------------------------------
 * armour : separate pool that absorbs hits before the driver is exposed
 * Vehicles are inert until an infantry unit crews them.
 * ------------------------------------------------------------------------- */
const VEHICLE_TYPES = {
  jeep:    { name: "Jeep",       baseTime: 20, armour: 60,  speed: 78, range: 90,  dmg: 8,  cooldown: 0.4, radius: 9,  aggro: 150 },
  light:   { name: "Light Tank", baseTime: 35, armour: 130, speed: 56, range: 110, dmg: 18, cooldown: 0.9, radius: 11, aggro: 170 },
  medium:  { name: "Med Tank",   baseTime: 60, armour: 220, speed: 44, range: 130, dmg: 30, cooldown: 1.2, radius: 13, aggro: 190 },
};

/* ---- Gun emplacements (built by gun factories, immobile) ---------------- */
const GUN_TYPES = {
  pillbox: { name: "Pillbox", baseTime: 30, armour: 180, speed: 0, range: 160, dmg: 22, cooldown: 0.9, radius: 11, aggro: 200, immobile: true },
};

// Which unit list a factory of a given kind can produce
const FACTORY_OUTPUT = {
  robot:   { table: INFANTRY_TYPES, kind: "infantry", keys: ["grunt", "psycho", "sniper", "pyro"] },
  vehicle: { table: VEHICLE_TYPES,  kind: "vehicle",  keys: ["jeep", "light", "medium"] },
  gun:     { table: GUN_TYPES,      kind: "gun",      keys: ["pillbox"] },
};
