import { WARSHIP_SHARE } from "./combat";
import type { Dockable } from "./dockable";
import type { ShipDef } from "./economyDefs";
import type { FactionId } from "./factions";
import type { Ship } from "./ship";
import type { Treasury } from "./treasury";

/** Up from the 11-ship seed roster - conservative given no prior profiling exists at a larger
 * ship count (see combat.ts/market.ts's own "small N" performance notes). Lower this first if
 * frame time regresses once a fleet actually approaches it. */
export const FLEET_CAP = 40;
export const SHIP_SPAWN_COST = 3000;

const NAME_PREFIXES: Record<FactionId, readonly string[]> = {
  solFederation: ["MV", "ISV", "SFS"],
  beltConsortium: ["IS", "FV", "BCS"],
};
const NAME_ROOTS: Record<FactionId, readonly string[]> = {
  solFederation: ["Horizon", "Meridian", "Aurora", "Pathfinder", "Vanguard", "Resolve", "Endeavor", "Concord"],
  beltConsortium: ["Rustwind", "Tumbleweed", "Gravedigger", "Scrapline", "Dustrunner", "Ironclad", "Blackrock", "Grit"],
};

const usedNames = new Set<string>();
let nextSuffix = 1;

function generateShipName(faction: FactionId): string {
  const prefixes = NAME_PREFIXES[faction];
  const roots = NAME_ROOTS[faction];
  for (let attempt = 0; attempt < prefixes.length * roots.length; attempt++) {
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const root = roots[Math.floor(Math.random() * roots.length)];
    const name = `${prefix} ${root}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  // Combination space exhausted (shouldn't happen at FLEET_CAP's scale, but bounded rather than
  // looping forever if it ever does) - fall back to a guaranteed-unique numeric suffix.
  const name = `${prefixes[0]} Unit ${nextSuffix++}`;
  usedNames.add(name);
  return name;
}

function countShipsOf(faction: FactionId, ships: readonly Ship[]): number {
  return ships.reduce((n, s) => n + (s.faction === faction ? 1 : 0), 0);
}

/** The owned dockable with the highest total stock-to-baseline ratio across what it produces -
 * the economy's own glut is the signal that more hauling capacity is needed there, rather than
 * spawning at a random or fixed location. */
function pickSpawnPoint(faction: FactionId, dockables: readonly Dockable[]): Dockable | null {
  const owned = dockables.filter((d) => d.owner === faction);
  let best: Dockable | null = null;
  let bestGlut = -Infinity;
  for (const dockable of owned) {
    const glut = dockable.market.glutScore();
    if (glut > bestGlut) {
      bestGlut = glut;
      best = dockable;
    }
  }
  return best;
}

function averageCruiseSpeed(faction: FactionId, ships: readonly Ship[]): number {
  const same = ships.filter((s) => s.faction === faction);
  if (same.length === 0) return 700;
  return same.reduce((sum, s) => sum + s.def.cruiseSpeed, 0) / same.length;
}

let nextShipCounter = 1;

/**
 * Checks whether `faction` can and should grow its fleet right now, debiting its treasury and
 * returning a new ShipDef if so (EconomyManager constructs the actual Ship from it, using the
 * def's own route[0] as the start dockable id - the same lookup every seed ship already goes
 * through). Called periodically (not every frame) from EconomySimulation.update.
 */
export function tryGrowFleet(faction: FactionId, treasury: Treasury, ships: readonly Ship[], dockables: readonly Dockable[], atWar: boolean): ShipDef | null {
  if (countShipsOf(faction, ships) >= FLEET_CAP) return null;
  if (!treasury.debit(faction, SHIP_SPAWN_COST)) return null;

  const homeDock = pickSpawnPoint(faction, dockables);
  if (!homeDock) {
    treasury.credit(faction, SHIP_SPAWN_COST); // refund - nowhere to spawn, shouldn't normally happen
    return null;
  }

  const role = atWar && Math.random() < WARSHIP_SHARE ? "warship" : "trader";
  return {
    id: `${faction}-fleet-${nextShipCounter++}`,
    name: generateShipName(faction),
    faction,
    crew: role === "warship" ? 15 : 6,
    cargo: role === "warship" ? "Munitions" : "General cargo",
    cargoCapacity: role === "warship" ? 0 : 30,
    cruiseSpeed: averageCruiseSpeed(faction, ships) * (0.85 + Math.random() * 0.3),
    route: [homeDock.id],
    dwellSeconds: 20,
    role,
  };
}
