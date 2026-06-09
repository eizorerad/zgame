/* =========================================================================
 * config.js — global constants & data tables
 * Tunables for the whole game live here so balancing is one file away.
 * ========================================================================= */

const CFG = {
  TILE: 16,            // pixel size of one grid tile
  COLS: 92,            // map width  in tiles (~2x the old area)
  ROWS: 56,            // map height in tiles
  VIEW_W: 1024,        // on-screen viewport (the world is larger; camera pans)
  VIEW_H: 640,

  // Production: Actual = Base / (1 + sectorsOwned * MULT)
  SECTOR_SPEED_MULT: 0.18,

  // Flag capture happens on contact within this pixel radius
  FLAG_CAPTURE_RADIUS: 16,

  // Contested capture: seconds for a unit to claim a NEUTRAL flag. Stealing an
  // enemy flag costs ~2x (neutralize, then claim). Abandoned attempts decay.
  CAPTURE_TIME: 4.5,
  CAPTURE_DECAY: 0.6,        // decay speed as a fraction of fill speed

  // How wide a unit "sees" for autonomous aggression (pixels)
  DEFAULT_AGGRO: 120,

  // Units are drawn (and collide) larger; movement is globally slowed.
  UNIT_SCALE: 1.45,
  SPEED_SCALE: 0.5,

  // Fort
  FORT_HP: 500,
  FORT_TURRET_RANGE: 150,
  FORT_TURRET_DMG: 14,
  FORT_TURRET_COOLDOWN: 0.7,

  // Repair: units near a friendly fort/factory recover this much per second
  REPAIR_RANGE: 70,
  REPAIR_RATE: 10,

  // Tanks crush enemy infantry they roll over
  CRUSH_DMG: 999,

  // ---- HQ mana economy (defensive comeback) ----
  MANA_MAX: 260,
  MANA_REGEN: 1.4,          // per second, passive
  MANA_ON_LOSE: 45,         // granted to a team each time it loses a sector
  // StarCraft-style upgrades bought with mana (attack / defence, 3 levels)
  UPGRADE_STEP: 0.15,       // +15% damage or -damage-taken per level
  UPGRADE_MAX: 3,
  UPGRADE_COST: [40, 80, 140],

  // Desert palette (tuned to the classic Z look)
  COLORS: {
    sand:   "#caa46a",
    sand2:  "#c09a5c",
    sand3:  "#b88f4f",
    speck:  "#d8b97e",
    cliff:  "#8a6f43",
    cliffHi:"#a98a55",
    cliffLo:"#5f4a28",
    road:   "#9a9488",
    roadLo: "#86806f",
    roadLine:"#cfc8b4",
    water:  "#3f74a8",
    water2: "#356492",
    waterHi:"#5f97c8",
    bridge: "#7a5a32",
    bridgeLo:"#5e4526",
    scrub:  "#7d8a3c",
    cactus: "#3f7a3a",
    cactusHi:"#5aa552",
    wall:   "#b89a5e",       // sandbags
    wallLo: "#8a7038",
    neutral:"#9a9a9a",
    blue:   "#4da6ff",
    blueDk: "#1a4d80",
    red:    "#ff5b5b",
    redDk:  "#802121",
  },

  // Team art palettes used by the sprite generator
  TEAM_PAL: {
    blue:    { main:"#4da6ff", dark:"#1c5a99", light:"#bcdcff", metal:"#39505f", metalLo:"#26333d", trim:"#0e3a63" },
    red:     { main:"#ff6a5b", dark:"#a33024", light:"#ffc2b2", metal:"#5a3a34", metalLo:"#3a221e", trim:"#5a160d" },
    neutral: { main:"#9a9a9a", dark:"#5f5f5f", light:"#cccccc", metal:"#4a4a4a", metalLo:"#2e2e2e", trim:"#333333" },
  },
};

const TEAM = { NEUTRAL: "neutral", BLUE: "blue", RED: "red" };
function enemyOf(team) { return team === TEAM.BLUE ? TEAM.RED : TEAM.BLUE; }

/* ---- terrain ------------------------------------------------------------- */
const TERR = { SAND: 0, CLIFF: 1, WALL: 2, ROAD: 3, WATER: 4, BRIDGE: 5, SCRUB: 6 };
// movement speed multiplier per terrain (impassable ones unused)
const TERRAIN_SPEED = { 0: 1.0, 1: 0, 2: 0, 3: 1.55, 4: 0, 5: 1.0, 6: 0.55 };

/* ---- veterancy ----------------------------------------------------------
 * Kills promote a unit through ranks, each granting combat bonuses. Pure Z:
 * grunts that survive become terrifying.
 * ----------------------------------------------------------------------- */
const VET = {
  thresholds: [0, 2, 5, 9],          // kills needed for rank 0..3
  names: ["Rookie", "Trained", "Veteran", "Hero"],
  dmgPerRank: 0.20,
  hpPerRank: 0.18,
  rangePerRank: 0.06,
  cooldownPerRank: -0.05,            // faster firing
};

/* ---- Infantry types ----------------------------------------------------- */
const INFANTRY_TYPES = {
  grunt:  { name: "Grunt",  baseTime: 8,  hp: 30,  speed: 46, range: 70,  dmg: 6,  cooldown: 0.45, radius: 5, aggro: 120 },
  psycho: { name: "Psycho", baseTime: 14, hp: 55,  speed: 58, range: 40,  dmg: 16, cooldown: 0.30, radius: 6, aggro: 170 },
  sniper: { name: "Sniper", baseTime: 18, hp: 24,  speed: 40, range: 155, dmg: 10, cooldown: 1.3,  radius: 5, aggro: 195, snipeChance: 0.35 },
  pyro:   { name: "Pyro",   baseTime: 16, hp: 40,  speed: 48, range: 55,  dmg: 22, cooldown: 0.5,  radius: 6, aggro: 130 },
};

/* ---- Vehicle types ------------------------------------------------------ */
const VEHICLE_TYPES = {
  jeep:    { name: "Jeep",       baseTime: 20, armour: 60,  speed: 82, range: 95,  dmg: 8,  cooldown: 0.35, radius: 9,  aggro: 150 },
  light:   { name: "Light Tank", baseTime: 35, armour: 130, speed: 56, range: 115, dmg: 18, cooldown: 0.9,  radius: 12, aggro: 175 },
  medium:  { name: "Med Tank",   baseTime: 60, armour: 230, speed: 44, range: 135, dmg: 32, cooldown: 1.2,  radius: 14, aggro: 195 },
  apc:     { name: "APC",        baseTime: 30, armour: 160, speed: 64, range: 80,  dmg: 7,  cooldown: 0.4,  radius: 13, aggro: 150 },
};

/* ---- Gun emplacements (built by gun factories, immobile) ---------------- */
const GUN_TYPES = {
  pillbox: { name: "Pillbox", baseTime: 30, armour: 200, speed: 0, range: 165, dmg: 24, cooldown: 0.85, radius: 12, aggro: 210, immobile: true },
};

const FACTORY_OUTPUT = {
  robot:   { table: INFANTRY_TYPES, kind: "infantry", keys: ["grunt", "psycho", "sniper", "pyro"] },
  vehicle: { table: VEHICLE_TYPES,  kind: "vehicle",  keys: ["jeep", "light", "medium", "apc"] },
  gun:     { table: GUN_TYPES,      kind: "gun",      keys: ["pillbox"] },
};

// short RTS-style flavour notes shown in the factory popup
const UNIT_NOTES = {
  grunt:  "Cheap rifleman. Win with numbers.",
  psycho: "Reckless brawler, lethal up close.",
  sniper: "Long range. Kills vehicle crews.",
  pyro:   "Short-range flamer. Melts groups.",
  jeep:   "Fast scout with a mounted gun.",
  light:  "Light tank. Mobile armour.",
  medium: "Heavy armour, slow, big punch.",
  apc:    "Tough transport, light gun.",
  pillbox:"Immobile gun nest. Pure defence.",
};

// HQ (Fort) command-panel options
const FORT_TRAIN_KEYS = ["grunt", "psycho", "sniper", "pyro", "jeep", "light", "medium", "apc"];
const INSTANT_KEYS    = ["grunt", "psycho", "sniper", "pyro", "jeep", "light", "medium", "apc", "pillbox"];
const UPGRADE_DEFS = [
  { key: "infAtk", name: "Inf Atk" },
  { key: "infDef", name: "Inf Def" },
  { key: "vehAtk", name: "Veh Atk" },
  { key: "vehDef", name: "Veh Def" },
];
