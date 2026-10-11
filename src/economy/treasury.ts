import type { FactionId } from "./factions";

export const START_CREDITS = 5000;

/** Per-faction credit balance, fed by Ship.arrive's completed trades and spent by fleetGrowth.ts.
 * Pure in-memory - no persistence, matching that no save/load system exists anywhere else in
 * this repo and none should be added here. */
export class Treasury {
  private readonly balances = new Map<FactionId, number>();

  balanceOf(faction: FactionId): number {
    return this.balances.get(faction) ?? START_CREDITS;
  }

  credit(faction: FactionId, amount: number): void {
    if (amount <= 0) return;
    this.balances.set(faction, this.balanceOf(faction) + amount);
  }

  /** Returns false (and charges nothing) if the faction can't afford it. */
  debit(faction: FactionId, amount: number): boolean {
    if (this.balanceOf(faction) < amount) return false;
    this.balances.set(faction, this.balanceOf(faction) - amount);
    return true;
  }
}
