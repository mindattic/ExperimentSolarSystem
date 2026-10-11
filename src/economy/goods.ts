/** The tradeable goods every Market deals in. Eight goods split into three rough tiers (raw:
 * food/water/ore/fuel, refined: metals/machinery/electronics, rare: exoticMaterials) - coarse
 * enough to keep per-dockable bookkeeping cheap, varied enough that routes actually differ. */
export type GoodId = "food" | "water" | "ore" | "metals" | "machinery" | "fuel" | "electronics" | "exoticMaterials";

export const GOODS: readonly GoodId[] = ["food", "water", "ore", "metals", "machinery", "fuel", "electronics", "exoticMaterials"];

/** Reference price per unit at equilibrium stock (see market.ts's priceOf) - roughly scaled by
 * how refined/rare a good is, not tied to any real-world commodity pricing. */
export const BASE_PRICE: Record<GoodId, number> = {
  food: 10,
  water: 8,
  ore: 15,
  fuel: 20,
  metals: 40,
  machinery: 90,
  electronics: 150,
  exoticMaterials: 400,
};

/** Sparse per-good rate/quantity table - defs omit goods they don't touch rather than listing
 * every GoodId at 0. */
export type GoodsVector = Partial<Record<GoodId, number>>;
