import type { FactionId } from "./factions";

/** -100 (open war floor) .. +100 (allied ceiling), 0 = neutral. A slow-moving signal by design -
 * see NEUTRAL_DECAY_PER_SECOND. */
export type Standing = number;

export const STANDING_MIN = -100;
export const STANDING_MAX = 100;
export const WAR_THRESHOLD = -60;
/** War doesn't lift the instant standing crosses back above WAR_THRESHOLD - this hysteresis gap
 * stops standing sitting right at the line from flapping war on/off every tick. */
export const PEACE_THRESHOLD = -20;
export const NEUTRAL_DECAY_PER_SECOND = 0.05;
/** A pair at war only starts drifting back toward peace once this many seconds have passed with
 * no hostile event between them - otherwise an active war would simply decay itself away. */
export const WAR_COOLDOWN_SECONDS = 120;

function pairKey(a: FactionId, b: FactionId): string {
  return [a, b].sort().join("|");
}

/**
 * Per-faction-pair standing, stored by sorted-pair key rather than a single scalar so a third
 * faction later is additive, not a rewrite, even though only two factions exist today. War is a
 * derived query (isAtWar), never a separately-tracked flag, so there's exactly one source of
 * truth for it.
 */
export class FactionRelations {
  private readonly standings = new Map<string, Standing>();
  private readonly lastHostileEventAt = new Map<string, number>();
  private elapsedSeconds = 0;

  get(a: FactionId, b: FactionId): Standing {
    if (a === b) return STANDING_MAX;
    return this.standings.get(pairKey(a, b)) ?? 0;
  }

  isAtWar(a: FactionId, b: FactionId): boolean {
    return a !== b && this.get(a, b) <= WAR_THRESHOLD;
  }

  adjust(a: FactionId, b: FactionId, delta: number): void {
    if (a === b) return;
    const key = pairKey(a, b);
    const next = Math.min(STANDING_MAX, Math.max(STANDING_MIN, this.get(a, b) + delta));
    this.standings.set(key, next);
  }

  recordHostileEvent(a: FactionId, b: FactionId, severity: number): void {
    if (a === b) return;
    this.adjust(a, b, severity);
    this.lastHostileEventAt.set(pairKey(a, b), this.elapsedSeconds);
  }

  tick(dtSeconds: number): void {
    this.elapsedSeconds += dtSeconds;
    for (const key of this.standings.keys()) {
      const current = this.standings.get(key)!;
      const atWar = current <= WAR_THRESHOLD;
      if (atWar) {
        const lastHostile = this.lastHostileEventAt.get(key) ?? -Infinity;
        if (this.elapsedSeconds - lastHostile < WAR_COOLDOWN_SECONDS) continue;
        // Cooled down - drift toward (not past) the peace line, never straight to neutral in one
        // step, so a ceasefire still reads as fragile rather than instantly forgotten.
        const target = PEACE_THRESHOLD + 1;
        const next = current + Math.sign(target - current) * Math.min(Math.abs(target - current), NEUTRAL_DECAY_PER_SECOND * dtSeconds);
        this.standings.set(key, next);
      } else {
        const next = current + Math.sign(-current) * Math.min(Math.abs(current), NEUTRAL_DECAY_PER_SECOND * dtSeconds);
        this.standings.set(key, next);
      }
    }
  }
}
