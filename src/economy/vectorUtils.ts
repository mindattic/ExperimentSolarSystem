import { Vector3 } from "@babylonjs/core";

/** Nearest entry in `candidates` to `from`, or null if candidates is empty - shared by
 * shipTrade.ts's trader fallback and combat.ts's warship target search, so "closest wins" means
 * the same thing everywhere a ship picks from a list of places/targets. */
export function nearest<T>(from: Vector3, candidates: readonly T[], positionOf: (item: T) => Vector3): T | null {
  let best: T | null = null;
  let bestDistSq = Infinity;
  for (const candidate of candidates) {
    const d = Vector3.DistanceSquared(from, positionOf(candidate));
    if (d < bestDistSq) {
      bestDistSq = d;
      best = candidate;
    }
  }
  return best;
}
