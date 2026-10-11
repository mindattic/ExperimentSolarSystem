import { Vector3 } from "@babylonjs/core";
import type { Dockable } from "./dockable";
import type { FactionId } from "./factions";
import { GOODS, type GoodId } from "./goods";
import type { ShipContext } from "./shipContext";
import { nearest } from "./vectorUtils";

export interface CargoState {
  readonly good: GoodId;
  readonly qty: number;
  /** Price snapshotted at the moment this cargo was bought - the real profit at sale is
   * whatever the destination's price turns out to be then, not locked in here. */
  readonly buyPrice: number;
}

export interface ChosenLeg {
  readonly destination: Dockable;
  /** Good to buy at the CURRENT dock before departing, if any - null when continuing to carry
   * existing cargo, or when this leg is an empty repositioning fallback. */
  readonly pickup: { good: GoodId; qty: number } | null;
}

/** A candidate leg's score must clear this (profit-per-second) before it's worth taking over the
 * guaranteed-safe fallback tiers below - a barely-break-even trade isn't worth preferring over
 * just repositioning toward home territory. */
const MIN_SCORE_THRESHOLD = 0.01;

function futurePositionOf(dockable: Dockable): Vector3 {
  const out = new Vector3();
  dockable.predictWorldPositionAt(0, out);
  return out;
}

function estimatedTravelSeconds(fromPosition: Vector3, dest: Dockable, cruiseSpeed: number): number {
  const distance = Vector3.Distance(fromPosition, futurePositionOf(dest));
  return Math.max(1, distance / cruiseSpeed);
}

/** Every dockable reachable from `currentDock`, excluding itself and (once at war) any dockable
 * owned by a faction `shipFaction` is at war with - ships avoid enemy territory once war starts,
 * for free, just by never considering it a candidate. */
function reachableDockables(context: ShipContext, currentDock: Dockable, shipFaction: FactionId): Dockable[] {
  return context.getAllDockables().filter((d) => d !== currentDock && !(d.owner !== shipFaction && context.isAtWar(shipFaction, d.owner)));
}

/**
 * Guaranteed-terminating fallback: the nearest dockable of the ship's own faction (other than
 * where it's standing), else the nearest dockable of ANY faction, else (only if somehow nothing
 * else exists) stay put. Shared by chooseNextLeg's own fallback tier and combat.ts's warship
 * patrol/reposition behavior when it has no enemy target - "closest wins" means the same thing
 * everywhere a ship has nothing better to do.
 */
export function fallbackDestination(context: ShipContext, currentDock: Dockable, shipFaction: FactionId, fromPosition: Vector3): Dockable {
  const all = context.getAllDockables().filter((d) => d !== currentDock);
  const ownFaction = all.filter((d) => d.owner === shipFaction);
  return nearest(fromPosition, ownFaction, futurePositionOf) ?? nearest(fromPosition, all, futurePositionOf) ?? currentDock;
}

/**
 * Scores every reachable dockable (and, for an empty hold, every good currently sitting at
 * `currentDock` above its trade floor) by profit RATE (profit / estimated travel time), so a
 * modest nearby trade can beat a larger but much more distant one. Falls back to
 * fallbackDestination if nothing scores above MIN_SCORE_THRESHOLD - a ship must never have no
 * valid next leg.
 */
export function chooseNextLeg(
  context: ShipContext,
  currentDock: Dockable,
  shipFaction: FactionId,
  fromPosition: Vector3,
  cruiseSpeed: number,
  cargoCapacity: number,
  cargo: CargoState | null,
): ChosenLeg {
  const candidates = reachableDockables(context, currentDock, shipFaction);
  let best: ChosenLeg | null = null;
  let bestScore = -Infinity;

  if (cargo) {
    for (const dest of candidates) {
      const travelSeconds = estimatedTravelSeconds(fromPosition, dest, cruiseSpeed);
      const score = ((dest.market.priceOf(cargo.good) - cargo.buyPrice) * cargo.qty) / travelSeconds;
      if (score > bestScore) {
        bestScore = score;
        best = { destination: dest, pickup: null };
      }
    }
  } else {
    for (const dest of candidates) {
      const travelSeconds = estimatedTravelSeconds(fromPosition, dest, cruiseSpeed);
      for (const good of GOODS) {
        const available = currentDock.market.availableToBuy(good, cargoCapacity);
        if (available <= 0) continue;
        const profitPerUnit = dest.market.priceOf(good) - currentDock.market.priceOf(good);
        const score = (profitPerUnit * available) / travelSeconds;
        if (score > bestScore) {
          bestScore = score;
          best = { destination: dest, pickup: { good, qty: available } };
        }
      }
    }
  }

  if (best !== null && bestScore > MIN_SCORE_THRESHOLD) return best;
  return { destination: fallbackDestination(context, currentDock, shipFaction, fromPosition), pickup: null };
}
