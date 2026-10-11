import type { Vector3 } from "@babylonjs/core";
import type { CelestialBody } from "../solarSystem/celestialBody";
import type { FactionId } from "./factions";
import type { Market } from "./market";

/** A dockable's ongoing siege, if any - tracked per-dockable rather than per-attacker since only
 * one faction's siege can be progressing at once (a second attacking faction contests it back to
 * zero rather than racing it - see combat.ts's combatUpdate). */
export interface SiegeState {
  attacker: FactionId | null;
  progressSeconds: number;
}

/** Anything a Ship can travel to/from and predict the future position of - Base and Station
 * both implement this. Kept intentionally minimal so shipTransit.ts's rendezvous solver never
 * needs to know which concrete kind of stop it's dealing with. */
export interface Dockable {
  readonly id: string;
  readonly kind: "base" | "station";
  /** The planet this dockable ultimately orbits (directly for Base/Station today) - used by
   * shipTransit.ts's effectiveCruiseSpeed to keep travel time invariant across the actual/
   * gameplay orbital-scale toggle (see orbitalScale.gameplayPositionOf). */
  readonly parentBody: CelestialBody;
  /** The faction that currently benefits from this dockable's production/consumption - distinct
   * from its def's original `faction`, which stays the seed/starting value. Mutated only by
   * setOwner (combat.ts's capture rule). */
  owner: FactionId;
  readonly market: Market;
  readonly siege: SiegeState;
  /** Recolors the mesh to the new faction's palette and flips `owner` - does not touch `market`
   * stock, only who benefits from it going forward. */
  setOwner(faction: FactionId): void;
  /** World-space position this dockable will occupy `secondsFromNow` from now. Writes into
   * `out` and returns it, so callers can reuse a scratch Vector3 across repeated calls (the
   * rendezvous solver in shipTransit.ts calls this several times per solve). */
  predictWorldPositionAt(secondsFromNow: number, out: Vector3): Vector3;
}
