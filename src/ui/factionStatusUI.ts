import type { FactionSummary } from "../economy/economyManager";

/**
 * A small always-on corner readout of each faction's treasury/fleet size/standing, plus a
 * transient war banner when any pair is at war - follows SettingsMenu's own pattern (markup
 * already in index.html, this class just getElementById's it and refreshes text), not a pooled/
 * projected overlay like ExamineUI since this is a fixed HUD panel, not per-entity labels.
 */
export class FactionStatusUI {
  private readonly getSummaries: () => FactionSummary[];
  private readonly panelEl: HTMLElement;
  private readonly warBadgeEl: HTMLElement;

  constructor(getSummaries: () => FactionSummary[]) {
    this.getSummaries = getSummaries;
    this.panelEl = document.getElementById("factionStatusPanel")!;
    this.warBadgeEl = document.getElementById("warBadge")!;
  }

  update(): void {
    const summaries = this.getSummaries();
    this.panelEl.textContent = summaries.map((s) => `${s.label}\n  Treasury: ${s.treasury.toFixed(0)}\n  Ships: ${s.shipCount}`).join("\n");

    const atWarPairs = summaries.flatMap((s) => s.standings.filter((rel) => rel.atWar).map((rel) => [s.label, rel.againstLabel].sort().join(" vs ")));
    const uniquePairs = [...new Set(atWarPairs)];
    this.warBadgeEl.hidden = uniquePairs.length === 0;
    if (uniquePairs.length > 0) this.warBadgeEl.textContent = `AT WAR: ${uniquePairs.join(", ")}`;
  }
}
