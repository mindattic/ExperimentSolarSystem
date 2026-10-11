import { BASE_PRICE, GOODS, type GoodId } from "./goods";
import { DEFAULT_BASELINE, DEFAULT_MAX_STOCK, type ProductionProfile } from "./productionDefs";

/** price(good) scales inversely with stock relative to baseline, clamped to a 0.4x-3.0x band -
 * low stock (scarce) sells high, a glut sells low. Inverse-linear rather than sqrt/logistic:
 * directly reviewable behavior over a curve shape nobody would eyeball-verify anyway. */
const MIN_PRICE_MULT = 0.4;
const MAX_PRICE_MULT = 3.0;
/** Floor on the stock value used in the price formula's denominator - avoids a divide-by-zero
 * once a good is fully depleted, without needing a branch. */
const STOCK_EPSILON = 0.01;
/** A good below this fraction of baseline stock isn't offered for pickup - a ship doesn't buy a
 * producer down to literally nothing. */
export const MIN_TRADE_STOCK_FRACTION = 0.15;

/**
 * One Market per Dockable (owned by the Base/Station itself, not a parallel map elsewhere),
 * tracking live stock for every good it produces/consumes/trades plus the price that stock
 * implies. Cheap enough (a handful of goods, ~13 dockables total) to tick unthrottled every
 * frame from the owning Base/Station's own update() - see that class's own comment for why no
 * budget-queue is needed here.
 */
export class Market {
  private readonly stock = new Map<GoodId, number>();
  private readonly profile: ProductionProfile | undefined;

  constructor(profile: ProductionProfile | undefined) {
    this.profile = profile;
    for (const good of GOODS) {
      this.stock.set(good, this.baselineOf(good));
    }
  }

  private baselineOf(good: GoodId): number {
    return this.profile?.baselineStock?.[good] ?? DEFAULT_BASELINE;
  }

  private maxStockOf(good: GoodId): number {
    return this.profile?.maxStock?.[good] ?? DEFAULT_MAX_STOCK;
  }

  stockOf(good: GoodId): number {
    return this.stock.get(good) ?? 0;
  }

  /** Snapshot of every good's current stock, for UI/examine-placard display. */
  allStock(): ReadonlyMap<GoodId, number> {
    return this.stock;
  }

  tick(dtSeconds: number): void {
    for (const good of GOODS) {
      const current = this.stockOf(good);
      const produceRate = this.profile?.produces?.[good] ?? 0;
      const consumeRate = this.profile?.consumes?.[good] ?? 0;
      const maxStock = this.maxStockOf(good);
      // Production throttles to 0 once a good is already at its cap (a producer doesn't keep
      // manufacturing into a full warehouse); consumption is never throttled - a colony still
      // eats even if nothing is being shipped out, which is what makes scarcity actually bite.
      const effectiveProduce = current >= maxStock ? 0 : produceRate;
      const next = current + (effectiveProduce - consumeRate) * dtSeconds;
      this.stock.set(good, Math.max(0, Math.min(maxStock, next)));
    }
  }

  priceOf(good: GoodId): number {
    const stock = Math.max(this.stockOf(good), STOCK_EPSILON);
    const mult = Math.min(MAX_PRICE_MULT, Math.max(MIN_PRICE_MULT, this.baselineOf(good) / stock));
    return BASE_PRICE[good] * mult;
  }

  /** A ship buying here never takes the market below MIN_TRADE_STOCK_FRACTION of baseline - a
   * producer stays a producer instead of being bought out to zero. Returns how much was actually
   * available to buy (may be less than requested, or 0). */
  availableToBuy(good: GoodId, requestedQty: number): number {
    const floor = this.baselineOf(good) * MIN_TRADE_STOCK_FRACTION;
    return Math.max(0, Math.min(requestedQty, this.stockOf(good) - floor));
  }

  buy(good: GoodId, qty: number): void {
    this.stock.set(good, Math.max(0, this.stockOf(good) - qty));
  }

  sell(good: GoodId, qty: number): void {
    const maxStock = this.maxStockOf(good);
    this.stock.set(good, Math.min(maxStock, this.stockOf(good) + qty));
  }

  /** Sum, across every good this market produces, of how far over baseline its stock currently
   * sits - fleetGrowth.ts's signal for "goods are piling up unsold here, this dockable needs more
   * hauling capacity" when picking where to spawn a new ship. Consuming-only goods don't count -
   * a market that only eats a good isn't the one with a surplus of it. */
  glutScore(): number {
    let score = 0;
    for (const good of GOODS) {
      if ((this.profile?.produces?.[good] ?? 0) <= 0) continue;
      score += this.stockOf(good) / this.baselineOf(good);
    }
    return score;
  }

  /** Short "Ore 420 · Metals 90" summary of this market's traded goods (anything it produces or
   * consumes), for ExaminableInfo's `cargo` field - replaces the old static flavor-text string
   * with the market's actual live state. */
  summarize(): string {
    const traded = GOODS.filter((g) => (this.profile?.produces?.[g] ?? 0) > 0 || (this.profile?.consumes?.[g] ?? 0) > 0);
    if (traded.length === 0) return "No trade goods";
    return traded.map((g) => `${g[0].toUpperCase()}${g.slice(1)} ${this.stockOf(g).toFixed(0)}`).join(" · ");
  }
}
