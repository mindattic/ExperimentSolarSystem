import { Vector3 } from "@babylonjs/core";
import type { Dockable } from "./dockable";
import type { FactionId } from "./factions";
import { EARTH_RADIUS } from "../solarSystem/scale";
import { fallbackDestination } from "./shipTrade";
import type { Ship } from "./ship";
import type { ShipContext } from "./shipContext";
import { nearest } from "./vectorUtils";

export type ShipRole = "trader" | "warship";

export interface HealthState {
  hull: number;
  maxHull: number;
}

/** Fraction of a faction's NEW ship spawns that become warships once that faction is at war with
 * anyone - existing/seed ships never convert role mid-life, so a peaceful early game stays
 * visibly peaceful. */
export const WARSHIP_SHARE = 0.25;
export const WARSHIP_DAMAGE_PER_SECOND = 40;
/** Same EARTH_RADIUS-relative convention Ship already uses for SHIP_BILLBOARD_DISTANCE. */
export const WARSHIP_WEAPON_RANGE = EARTH_RADIUS * 3;
export const TRADER_MAX_HULL = 80;
export const WARSHIP_MAX_HULL = 300;
/** How long a dockable must be besieged, uncontested, before it's captured. */
export const SIEGE_DURATION_SECONDS = 90;
/** Warships don't linger once "arrived" at a destination (an enemy dockable or a patrol point) -
 * they reassess almost immediately, unlike a trader's much longer loading dwell. */
export const WARSHIP_DWELL_SECONDS = 5;

function futurePositionOf(dockable: Dockable): Vector3 {
  const out = new Vector3();
  dockable.predictWorldPositionAt(0, out);
  return out;
}

export function isInWeaponRange(fromPosition: Vector3, targetPosition: Vector3): boolean {
  return Vector3.Distance(fromPosition, targetPosition) <= WARSHIP_WEAPON_RANGE;
}

/**
 * A warship's flight destination is always a Dockable - same flight-profile machinery as
 * trading, just choosing WHERE to point it differently: the nearest enemy-owned dockable it's at
 * war with, or (not at war / none exists) the same patrol/reposition fallback a trader uses when
 * it has nothing profitable to do. There's no separate "intercept a moving enemy ship" navigation
 * - ship-vs-ship combat instead happens opportunistically wherever two hostile warships' paths
 * put them within weapon range of each other (see combatUpdate), which in practice means at a
 * contested dockable both sides are converging on.
 */
export function chooseWarshipDestination(context: ShipContext, currentDock: Dockable, shipFaction: FactionId, fromPosition: Vector3): Dockable {
  const enemyDockables = context.getAllDockables().filter((d) => d.owner !== shipFaction && context.isAtWar(shipFaction, d.owner));
  const target = nearest(fromPosition, enemyDockables, futurePositionOf);
  return target ?? fallbackDestination(context, currentDock, shipFaction, fromPosition);
}

/** Applies one frame of ship-vs-ship damage from `attacker` to `victim`, already range-checked by
 * the caller. Destruction is reported via `victim.isDestroyed`, which EconomyManager's own
 * per-ship loop checks after update() and splices out + disposes - ships never remove themselves
 * from a roster they don't own. */
function applyShipDamage(attacker: Ship, victim: Ship, context: ShipContext, dtSeconds: number): void {
  victim.health.hull -= WARSHIP_DAMAGE_PER_SECOND * dtSeconds;
  if (victim.health.hull <= 0 && !victim.isDestroyed) {
    victim.isDestroyed = true;
    context.recordHostileEvent(attacker.faction, victim.faction, -15);
  }
}

/** Advances (or resets) a dockable's siege for one frame. `defenderPresent` is true if any
 * warship of the dockable's OWNING faction is also in weapon range. A second, different attacking
 * faction already besieging it contests the siege back to zero rather than racing it - simplest
 * rule that means a contested siege helps nobody. */
function advanceSiege(dockable: Dockable, attackerFaction: FactionId, defenderPresent: boolean, context: ShipContext, dtSeconds: number): void {
  if (defenderPresent || (dockable.siege.attacker !== null && dockable.siege.attacker !== attackerFaction)) {
    dockable.siege.attacker = null;
    dockable.siege.progressSeconds = 0;
    return;
  }
  dockable.siege.attacker = attackerFaction;
  dockable.siege.progressSeconds += dtSeconds;
  if (dockable.siege.progressSeconds >= SIEGE_DURATION_SECONDS) {
    const previousOwner = dockable.owner;
    dockable.setOwner(attackerFaction);
    dockable.siege.attacker = null;
    dockable.siege.progressSeconds = 0;
    context.recordHostileEvent(previousOwner, attackerFaction, -30);
  }
}

/**
 * Called every frame for every warship (docked or in transit alike - combat is a proximity
 * effect layered on top of ordinary flight, not a separate navigation state): damages any enemy
 * warship currently within weapon range, and advances the siege of any enemy-owned dockable
 * within range that has no defending enemy warship also present. Cheap at today's ship counts (a
 * handful of warships against ~13 dockables), so this runs unthrottled - see market.ts's own
 * comment for the same "small N, no budget-queue needed" reasoning applied to combat instead of
 * production.
 */
export function combatUpdate(ship: Ship, context: ShipContext, dtSeconds: number): void {
  const myPosition = ship.worldPosition;

  for (const other of context.getAllShips()) {
    if (other === ship || other.isDestroyed || other.role !== "warship" || other.faction === ship.faction) continue;
    if (!context.isAtWar(ship.faction, other.faction)) continue;
    if (isInWeaponRange(myPosition, other.worldPosition)) applyShipDamage(ship, other, context, dtSeconds);
  }

  for (const dockable of context.getAllDockables()) {
    if (dockable.owner === ship.faction || !context.isAtWar(ship.faction, dockable.owner)) continue;
    const dockPosition = futurePositionOf(dockable);
    if (!isInWeaponRange(myPosition, dockPosition)) continue;
    const defenderPresent = context
      .getAllShips()
      .some((s) => !s.isDestroyed && s.role === "warship" && s.faction === dockable.owner && isInWeaponRange(dockPosition, s.worldPosition));
    advanceSiege(dockable, ship.faction, defenderPresent, context, dtSeconds);
  }
}
