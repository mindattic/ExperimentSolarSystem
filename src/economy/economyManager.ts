import type { Node, Scene, Vector3 } from "@babylonjs/core";
import type { SolarSystem } from "../solarSystem/solarSystem";
import { Base } from "./base";
import { Station } from "./station";
import { Ship } from "./ship";
import type { Dockable } from "./dockable";
import { BASE_DEFS, STATION_DEFS, SHIP_DEFS } from "./economyDefs";
import { EconomySimulation } from "./economySimulation";
import { FACTION_PALETTES, type FactionId } from "./factions";
import type { ShipContext, StopResolver } from "./shipContext";
import type { ExaminableInfo } from "../ui/examineUI";

function findBody(solarSystem: SolarSystem, name: string) {
  const body = solarSystem.bodies.find((b) => b.def.name === name);
  if (!body) throw new Error(`EconomyManager: no body named "${name}" in solarSystem.bodies`);
  return body;
}

/** One row per faction for FactionStatusUI - treasury/fleet size/standing-vs-the-other-faction,
 * read-only summary of EconomySimulation's state the same way ExaminableInfo is a read-only
 * summary of a Base/Station/Ship. */
export interface FactionSummary {
  faction: FactionId;
  label: string;
  treasury: number;
  shipCount: number;
  /** Standing against every OTHER faction, keyed by that faction's label - just one entry today
   * (two factions total), but shaped to stay correct if a third is ever added. */
  standings: { againstLabel: string; standing: number; atWar: boolean }[];
}

/** Owns every Base/Station/Ship, builds the seed roster from economyDefs.ts once SolarSystem's
 * bodies exist, and drives every Ship/Base/Station's per-frame update plus the economy simulation
 * (markets, treasury, fleet growth, faction relations, combat) that sits on top of them. */
export class EconomyManager {
  private readonly scene: Scene;
  private readonly bases: Base[] = [];
  private readonly stations: Station[] = [];
  /** Public (not just private) so SelectionUI/main.ts can look ships up by reference for
   * selection/orbit-tracking purposes - see findShipForMesh below. Mutable (fleet growth pushes
   * into it, combat destruction splices out of it) even though the reference itself is readonly -
   * `.push`/`.splice` are still legal on a readonly-reference array. */
  readonly ships: Ship[];
  private readonly stopsById = new Map<string, Dockable>();
  private readonly simulation = new EconomySimulation();

  /** Bound once (not per-frame) so every Ship.update() call can reuse the same function
   * reference instead of allocating a fresh closure each frame. */
  private readonly resolveStop: StopResolver = (id: string): Dockable => {
    const stop = this.stopsById.get(id);
    if (!stop) throw new Error(`EconomyManager: no Base/Station with id "${id}" (check ShipDef.route)`);
    return stop;
  };

  /** The single callback bag every Ship (trading or fighting) uses to reach the rest of the
   * simulation, bound once for the same reason resolveStop is - see shipContext.ts's own doc
   * comment for why this exists instead of Ship importing EconomyManager/EconomySimulation
   * directly. */
  private readonly context: ShipContext = {
    resolveStop: this.resolveStop,
    getAllDockables: (): readonly Dockable[] => [...this.bases, ...this.stations],
    getAllShips: (): readonly Ship[] => this.ships,
    isAtWar: (a, b) => this.simulation.relations.isAtWar(a, b),
    creditTreasury: (faction, amount) => this.simulation.treasury.credit(faction, amount),
    recordHostileEvent: (a, b, severity) => this.simulation.relations.recordHostileEvent(a, b, severity),
  };

  constructor(scene: Scene, solarSystem: SolarSystem) {
    this.scene = scene;
    for (const def of BASE_DEFS) {
      const base = new Base(scene, def, findBody(solarSystem, def.bodyName));
      this.stopsById.set(base.id, base);
      this.bases.push(base);
    }
    for (const def of STATION_DEFS) {
      const station = new Station(scene, def, findBody(solarSystem, def.orbitsAround));
      this.stopsById.set(station.id, station);
      this.stations.push(station);
    }

    this.ships = SHIP_DEFS.map((def) => new Ship(scene, def, this.resolveStop(def.route[def.startRouteIndex ?? 0]), this.context));
  }

  setShipTrajectoriesVisible(visible: boolean): void {
    for (const ship of this.ships) ship.setTrajectoryVisible(visible);
  }

  /** Every Base/Station whose parentBody is `bodyName` - used by SelectionUI's breadcrumb
   * navigation (see BreadcrumbNode in selection.ts) to show a body's docked Bases/Stations as
   * its children, the same way a planet's own moons are. */
  getDockablesForBody(bodyName: string): (Base | Station)[] {
    const result: (Base | Station)[] = [];
    for (const base of this.bases) if (base.parentBody.def.name === bodyName) result.push(base);
    for (const station of this.stations) if (station.parentBody.def.name === bodyName) result.push(station);
    return result;
  }

  /** Walks up from a picked mesh's parent chain looking for a ship's root - same pattern as
   * SelectionUI's own findBodyIndexForMesh, generalized for a different entity kind. */
  findShipForMesh(mesh: Node | null): Ship | null {
    let current = mesh;
    while (current) {
      const ship = this.ships.find((s) => s.root === current);
      if (ship) return ship;
      current = current.parent;
    }
    return null;
  }

  /** @param cameraWorldPosition Used for Ship's cube<->billboard-icon LOD swap - ships are
   * scattered system-wide, unlike SolarSystem.update's focused-body-local convention, so this
   * needs the camera's true world position regardless of which mode/camera is currently active. */
  update(deltaSeconds: number, cameraWorldPosition: Vector3): void {
    for (const base of this.bases) base.update(deltaSeconds);
    for (const station of this.stations) station.update(deltaSeconds);

    for (const ship of this.ships) ship.update(deltaSeconds, cameraWorldPosition, this.context);
    // Destruction is reported, not self-applied (see Ship.isDestroyed's own comment) - sweep and
    // dispose after every ship has had its turn this frame, same "manager owns the collection"
    // ownership EconomyManager already has over construction.
    for (let i = this.ships.length - 1; i >= 0; i--) {
      if (this.ships[i].isDestroyed) {
        this.ships[i].dispose();
        this.ships.splice(i, 1);
      }
    }

    const dockables = this.context.getAllDockables();
    for (const def of this.simulation.update(deltaSeconds, this.ships, dockables)) {
      this.ships.push(new Ship(this.scene, def, this.resolveStop(def.route[0]), this.context));
    }
  }

  /** Everything ExamineUI can show a placard for - the UI class never needs to know about
   * Base/Station/Ship directly, only this plain-object shape. */
  getExamineInfo(): ExaminableInfo[] {
    const info: ExaminableInfo[] = [];
    for (const base of this.bases) info.push(base.toExamineInfo());
    for (const station of this.stations) info.push(station.toExamineInfo());
    for (const ship of this.ships) info.push(ship.toExamineInfo());
    return info;
  }

  /** Everything FactionStatusUI needs - see FactionSummary's own doc comment. */
  getFactionSummary(): FactionSummary[] {
    const factions = Object.keys(FACTION_PALETTES) as FactionId[];
    return factions.map((faction) => ({
      faction,
      label: FACTION_PALETTES[faction].label,
      treasury: this.simulation.treasury.balanceOf(faction),
      shipCount: this.ships.filter((s) => s.faction === faction).length,
      standings: factions
        .filter((other) => other !== faction)
        .map((other) => ({
          againstLabel: FACTION_PALETTES[other].label,
          standing: this.simulation.relations.get(faction, other),
          atWar: this.simulation.relations.isAtWar(faction, other),
        })),
    }));
  }
}
