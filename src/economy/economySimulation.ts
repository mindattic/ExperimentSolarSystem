import type { Dockable } from "./dockable";
import type { ShipDef } from "./economyDefs";
import type { FactionId } from "./factions";
import { tryGrowFleet } from "./fleetGrowth";
import { FactionRelations } from "./relations";
import type { Ship } from "./ship";
import { Treasury } from "./treasury";

/** Only two factions exist today (see factions.ts's FactionId union) - listed explicitly rather
 * than derived, same "small N, explicit beats clever" spirit as economyDefs.ts's own hand-written
 * rosters. Extending to a third faction means adding it here too. */
const FACTIONS: readonly FactionId[] = ["solFederation", "beltConsortium"];

const RELATIONS_TICK_INTERVAL_SECONDS = 1;
const FLEET_GROWTH_CHECK_INTERVAL_SECONDS = 5;
/** Without SOME friction source, war could never start at all: combat is the only other thing
 * that moves standing, but combat only happens between warships, and warships only spawn once a
 * faction is already at war (see fleetGrowth.ts) - a closed loop with no way in. This models two
 * expanding factions organically bumping into each other (contested trade routes, encroachment
 * near the same resource-rich bodies) as a small, infrequent chance of a minor standing hit,
 * independent of combat - slow enough that war takes real sustained play to reach (roughly single
 * digits of minutes at these constants), not a coin-flip on session start, but no longer
 * impossible. */
const FRICTION_CHECK_INTERVAL_SECONDS = 8;
const FRICTION_CHANCE = 0.15;
const FRICTION_MIN = 3;
const FRICTION_MAX = 8;

/**
 * Owns the Treasury and FactionRelations singletons-in-practice and the periodic-tick timers for
 * relations decay and fleet growth - everything EconomyManager needs to drive layers 2-3 without
 * itself knowing how either works. Doesn't touch Scene/Babylon at all (EconomyManager stays the
 * only place that constructs meshes), so `update` returns newly-earned ShipDefs for the caller to
 * instantiate rather than building Ship objects itself.
 */
export class EconomySimulation {
  readonly treasury = new Treasury();
  readonly relations = new FactionRelations();
  private relationsAccumulator = 0;
  private fleetGrowthAccumulator = 0;
  private frictionAccumulator = 0;

  /** Returns any ShipDefs newly earned this call (usually empty) - EconomyManager constructs the
   * actual Ship instances and pushes them into its own roster. */
  update(dtSeconds: number, ships: readonly Ship[], dockables: readonly Dockable[]): ShipDef[] {
    this.relationsAccumulator += dtSeconds;
    if (this.relationsAccumulator >= RELATIONS_TICK_INTERVAL_SECONDS) {
      this.relations.tick(this.relationsAccumulator);
      this.relationsAccumulator = 0;
    }

    this.frictionAccumulator += dtSeconds;
    if (this.frictionAccumulator >= FRICTION_CHECK_INTERVAL_SECONDS) {
      this.frictionAccumulator = 0;
      for (let i = 0; i < FACTIONS.length; i++) {
        for (let j = i + 1; j < FACTIONS.length; j++) {
          if (Math.random() >= FRICTION_CHANCE) continue;
          const severity = -(FRICTION_MIN + Math.random() * (FRICTION_MAX - FRICTION_MIN));
          this.relations.adjust(FACTIONS[i], FACTIONS[j], severity);
        }
      }
    }

    const spawned: ShipDef[] = [];
    this.fleetGrowthAccumulator += dtSeconds;
    if (this.fleetGrowthAccumulator >= FLEET_GROWTH_CHECK_INTERVAL_SECONDS) {
      this.fleetGrowthAccumulator = 0;
      for (const faction of FACTIONS) {
        const atWar = FACTIONS.some((other) => other !== faction && this.relations.isAtWar(faction, other));
        const def = tryGrowFleet(faction, this.treasury, ships, dockables, atWar);
        if (def) spawned.push(def);
      }
    }
    return spawned;
  }
}
