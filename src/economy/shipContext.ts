import type { Dockable } from "./dockable";
import type { FactionId } from "./factions";
import type { Ship } from "./ship";

/** Resolves a route-stop id (a Base's bodyName or a Station's id) to its Dockable. */
export type StopResolver = (id: string) => Dockable;

/**
 * Everything a Ship (trading or fighting) needs to reach the rest of the simulation, as a small
 * callback bag rather than a reference to EconomyManager/EconomySimulation directly - the same
 * decoupling idea resolveStop already used before this existed, just widened to cover the new
 * layers. EconomyManager builds one of these (bound to its EconomySimulation) and hands it to
 * every Ship it constructs, seed fleet and fleet-growth spawns alike.
 */
export interface ShipContext {
  resolveStop: StopResolver;
  /** Every Base/Station that currently exists, for route/target scoring - bases/stations never
   * spawn or despawn, so this array is stable in length even though ships grow. */
  getAllDockables(): readonly Dockable[];
  /** Every ship that currently exists (including this one), for warship targeting. */
  getAllShips(): readonly Ship[];
  isAtWar(a: FactionId, b: FactionId): boolean;
  creditTreasury(faction: FactionId, amount: number): void;
  recordHostileEvent(a: FactionId, b: FactionId, severity: number): void;
}
