import { BASE_DEFS, STATION_DEFS } from "./economyDefs";
import type { GoodsVector } from "./goods";

export interface ProductionProfile {
  /** Units/sec added to stock (throttled to 0 once that good's own stock hits maxStock - see
   * Market.tick). */
  readonly produces: GoodsVector;
  /** Units/sec removed from stock - never throttled, a colony keeps eating even out of a full
   * warehouse. */
  readonly consumes: GoodsVector;
  /** Stock level treated as "normal" per good - Market.priceOf's baseline. Goods omitted here
   * default to DEFAULT_BASELINE. */
  readonly baselineStock?: GoodsVector;
  /** Hard per-good stock ceiling - production stalls at it rather than overflowing (models
   * "warehouse space"). Goods omitted here default to DEFAULT_MAX_STOCK. */
  readonly maxStock?: GoodsVector;
}

export const DEFAULT_BASELINE = 300;
export const DEFAULT_MAX_STOCK = 1200;

/**
 * One entry per Base (keyed by bodyName, matching Base.id) and Station (keyed by its own id,
 * matching Station.id) - hand-authored rather than derived, same spirit as economyDefs.ts's own
 * BASE_OVERRIDES: only 13 dockables exist today, small enough that explicit beats clever, and it
 * keeps each body's production legible next to its real-world character (Mercury/Venus/Moon
 * mining ore, Mars/marsRelay holding ice, Earth/earthYard as the industrial core, the outer
 * bodies producing fuel/exotic materials the inner system can't). Earth and earthYard are the
 * system's only food/electronics/metals producers on purpose - every other dockable has to import
 * at least one of those, which is what actually drives ships to fly instead of idling at a
 * single profitable loop.
 */
export const PRODUCTION_DEFS: Partial<Record<string, ProductionProfile>> = {
  // --- Bases (landable bodies) ---
  Mercury: { produces: { ore: 1.4 }, consumes: { food: 0.4, water: 0.3 } },
  Venus: { produces: { ore: 0.9, exoticMaterials: 0.1 }, consumes: { food: 0.5, water: 0.5 } },
  Earth: { produces: { food: 2.2, electronics: 0.6 }, consumes: { ore: 1.0, fuel: 0.4, water: 0.6 } },
  Moon: { produces: { water: 1.0, ore: 0.8 }, consumes: { food: 0.5 } },
  Mars: { produces: { water: 1.3, food: 0.5 }, consumes: { machinery: 0.3, electronics: 0.2 } },
  Pluto: { produces: { exoticMaterials: 0.5, fuel: 0.6 }, consumes: { food: 0.4, machinery: 0.15 } },
  Eris: { produces: { exoticMaterials: 0.6 }, consumes: { food: 0.3, machinery: 0.1 } },

  // --- Stations ---
  earthYard: { produces: { metals: 1.2, machinery: 0.5 }, consumes: { ore: 1.6, electronics: 0.3 } },
  marsRelay: { produces: { water: 0.8 }, consumes: { food: 0.4, machinery: 0.2 } },
  venusRelay: { produces: { exoticMaterials: 0.2 }, consumes: { food: 0.3, water: 0.3 } },
  plutoOutpost: { produces: { exoticMaterials: 0.7 }, consumes: { food: 0.4, fuel: 0.2 } },
  jupiterHighport: { produces: { fuel: 1.5 }, consumes: { food: 0.4, machinery: 0.2 } },
  saturnRingStation: { produces: { exoticMaterials: 0.8 }, consumes: { food: 0.3, machinery: 0.2 } },
};

const KNOWN_IDS = new Set<string>([...BASE_DEFS.map((d) => d.bodyName), ...STATION_DEFS.map((d) => d.id)]);
for (const id of Object.keys(PRODUCTION_DEFS)) {
  if (!KNOWN_IDS.has(id)) {
    throw new Error(`PRODUCTION_DEFS has an entry for "${id}", which isn't a real Base bodyName or Station id.`);
  }
}
