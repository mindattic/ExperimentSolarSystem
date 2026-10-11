import { Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3, type LinesMesh } from "@babylonjs/core";
import type { Dockable } from "./dockable";
import type { ShipDef } from "./economyDefs";
import { FACTION_PALETTES, type FactionId } from "./factions";
import { createHullMaterial, createShipIconMaterial, hashSeed, HULL_FACE_UV } from "./hullTexture";
import { buildFlightProfile, computeFlightRotations, evaluateFlightProfile, evaluateFlightRotation, solveRendezvous, type FlightProfile } from "./shipTransit";
import { chooseWarshipDestination, combatUpdate, TRADER_MAX_HULL, WARSHIP_DWELL_SECONDS, WARSHIP_MAX_HULL, type HealthState, type ShipRole } from "./combat";
import { chooseNextLeg, type CargoState } from "./shipTrade";
import type { ShipContext } from "./shipContext";
import { EARTH_RADIUS } from "../solarSystem/scale";
import { createUnlitLineMaterial } from "../solarSystem/celestialOrbit";
import type { ExaminableInfo } from "../ui/examineUI";
import { graphicsSettings } from "../settings/graphicsSettings";

type ShipPhase = "docked" | "transit";

/** Beyond this distance from the camera, a ship's real cube swaps to a small billboarded icon
 * (Homeworld-style) - two states toggled via setEnabled(), the same two-state LOD swap
 * PlanetTerrain.visit() already uses for its own mesh/child swap, just without a quadtree. */
const SHIP_BILLBOARD_DISTANCE = EARTH_RADIUS * 8;
const ICON_SIZE = 40;
/** Ship trajectories are dashed (not solid, like planet/station orbit lines) to read as a
 * moving asset's planned path rather than a fixed orbit - Babylon's built-in CreateDashedLines
 * handles the segment-count bookkeeping internally, no custom shader needed. */
const TRAJECTORY_DASH_SIZE = 200;
const TRAJECTORY_GAP_SIZE = 150;

const tmpPlannedFrom = new Vector3();

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Everything needed to fly (or have flown) one leg: the flight profile itself plus the
 * destination it's headed to and the prograde/retrograde rotations computed for it - bundled
 * together so Ship can double-buffer a whole leg at once (planned -> live, see planNextLeg/
 * departNext) instead of juggling 4 separate mirrored field-pairs. */
interface FlightLeg {
  readonly profile: FlightProfile;
  readonly destination: Dockable;
  readonly qPrograde: Quaternion;
  readonly qRetrograde: Quaternion;
}

function planLeg(from: Vector3, destination: Dockable, arrivalPosition: Vector3, travelSeconds: number): FlightLeg {
  const profile = buildFlightProfile(from, arrivalPosition, travelSeconds);
  const qPrograde = new Quaternion();
  const qRetrograde = new Quaternion();
  computeFlightRotations(profile, qPrograde, qRetrograde);
  return { profile, destination, qPrograde, qRetrograde };
}

/**
 * A ship flying between Bases/Stations, buying low and selling high (traders) or hunting enemy
 * territory (warships - see combat.ts). Alternates "docked" (dwelling, trading/loading) and
 * "transit" (a flip-and-burn flight - see shipTransit.ts - toward a rendezvous-predicted point on
 * the destination's future path, not its current position). `root` is a plain, unparented
 * world-space TransformNode driving position + rotationQuaternion; both the cube mesh and its
 * billboarded-icon LOD swap (see updateLod) are parented to it at the origin, so they always
 * share the same transform without needing to keep two meshes in sync by hand.
 *
 * The whole next leg (destination choice, rendezvous solve, flight profile, prograde/retrograde
 * rotations) is solved the INSTANT a ship docks - dwellSeconds ahead of when it's actually needed
 * - and simply consumed at the moment of departure ("preplan trips and routes the same way the
 * years/orbits are calculated so that they aren't being calculated moment by moment" - the same
 * precompute-once-then-cheaply-apply idea as CelestialOrbit's own position table). See
 * planNextLeg/departNext. Which dockable counts as the "next leg" is decided dynamically every
 * time (chooseNextLeg for traders, chooseWarshipDestination for warships) - only the flight math
 * itself is fixed/preplanned, never the destination choice.
 */
export class Ship {
  readonly def: ShipDef;
  readonly role: ShipRole;
  readonly root: TransformNode;
  readonly cubeMesh: Mesh;
  readonly iconMesh: Mesh;
  readonly health: HealthState;
  /** Set by combat.ts once this ship's hull reaches 0 - EconomyManager's own per-ship loop checks
   * this after update() and splices the ship out + disposes it; a ship never removes itself from
   * a roster it doesn't own. */
  isDestroyed = false;
  /** Traders only - null while empty/seeking a profitable good to carry. */
  cargo: CargoState | null = null;

  currentSpeed = 0;
  etaSeconds = 0;

  private readonly scene: Scene;
  private elapsed = 0;
  private dwellRemaining: number;
  /** The dock this ship is currently sitting at while "docked" - kept so its position can track
   * that dock's own ongoing motion (orbit/spin) every frame instead of freezing wherever it was
   * at the moment of arrival (a station or a surface Base both keep moving while a ship dwells
   * at them). Null while in transit. */
  private currentDock: Dockable | null = null;
  /** The leg currently being flown, null while docked - the sole source of truth for `phase`
   * (see that getter) rather than a separately-tracked flag that could drift out of sync with
   * it. */
  private liveLeg: FlightLeg | null = null;
  /** The next leg's rendezvous solution, computed ahead of time by planNextLeg (called the
   * instant this ship docks, or once at construction for its very first departure) - departNext
   * just consumes this rather than solving anything itself. */
  private plannedLeg: FlightLeg | null = null;
  private trajectoryLine: LinesMesh | null = null;
  /** Shared across every trajectory line this ship ever creates (a ship's faction/accent color
   * never changes) - created once in the constructor rather than fresh in departNext() each
   * time, since Mesh.dispose() doesn't dispose its material by default and this ship departs
   * many times over a session. */
  private readonly trajectoryMaterial: StandardMaterial;
  /** Desired visibility for the NEXT trajectory line created (departNext) - see
   * setTrajectoryVisible(). Defaults to graphicsSettings.showShipTrajectories's value at
   * construction; EconomyManager keeps every ship's flag in sync as the setting changes live. */
  private trajectoryVisible: boolean;

  /** Derived from liveLeg rather than tracked as its own field - "docked"/"transit" are fully
   * determined by whether a leg is currently being flown, so a separate flag could only ever
   * drift out of sync with it (e.g. a future early-return setting one without the other). */
  private get phase(): ShipPhase {
    return this.liveLeg !== null ? "transit" : "docked";
  }

  get faction(): FactionId {
    return this.def.faction;
  }

  get worldPosition(): Vector3 {
    return this.root.position;
  }

  constructor(scene: Scene, def: ShipDef, startDock: Dockable, context: ShipContext) {
    this.scene = scene;
    this.def = def;
    this.role = def.role ?? "trader";
    const maxHull = def.maxHull ?? (this.role === "warship" ? WARSHIP_MAX_HULL : TRADER_MAX_HULL);
    this.health = { hull: maxHull, maxHull };
    this.trajectoryVisible = graphicsSettings.showShipTrajectories;
    // Randomized so a whole roster doesn't all depart in the same frame.
    this.dwellRemaining = def.dwellSeconds * (0.3 + Math.random() * 0.7);
    this.currentDock = startDock;

    this.root = new TransformNode(`${def.id}Root`, scene);
    this.root.rotationQuaternion = new Quaternion();
    startDock.predictWorldPositionAt(0, this.root.position);

    const size = Math.max(6, def.cruiseSpeed * 0.03);
    this.cubeMesh = MeshBuilder.CreateBox(`${def.id}Mesh`, { size, faceUV: HULL_FACE_UV }, scene);
    this.cubeMesh.material = createHullMaterial(scene, def.faction, hashSeed(def.id));
    this.cubeMesh.parent = this.root;

    this.iconMesh = MeshBuilder.CreatePlane(`${def.id}Icon`, { size: ICON_SIZE }, scene);
    this.iconMesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.iconMesh.isPickable = false;
    this.iconMesh.material = createShipIconMaterial(scene, def.faction);
    this.iconMesh.parent = this.root;
    this.iconMesh.setEnabled(false);

    // Same unlit/logarithmic-depth fix CelestialOrbit.createOrbitLine already uses for orbit
    // lines ("ship lines aren't ordered right" otherwise) - see createUnlitLineMaterial's own
    // comment.
    this.trajectoryMaterial = createUnlitLineMaterial(scene, `${def.id}TrajectoryMaterial`, FACTION_PALETTES[def.faction].accent, 0.5);

    // Plans its very first departure too, exactly like every subsequent one arrive() plans -
    // dwellRemaining (not def.dwellSeconds) is the actual lead time until it happens.
    this.planNextLeg(context, this.dwellRemaining);
  }

  update(deltaSeconds: number, cameraWorldPosition: Vector3, context: ShipContext): void {
    if (this.isDestroyed) return;

    if (this.phase === "transit") {
      const leg = this.liveLeg!;
      this.elapsed = Math.min(this.elapsed + deltaSeconds, leg.profile.totalSeconds);
      this.currentSpeed = evaluateFlightProfile(leg.profile, this.elapsed, this.root.position);
      evaluateFlightRotation(leg.profile, this.elapsed, leg.qPrograde, leg.qRetrograde, this.root.rotationQuaternion!);
      this.etaSeconds = leg.profile.totalSeconds - this.elapsed;
      if (this.elapsed >= leg.profile.totalSeconds) this.arrive(context);
    } else {
      this.currentSpeed = 0;
      this.etaSeconds = 0;
      // Stays glued to its dock's own current position every frame instead of freezing at
      // arrival - a station keeps orbiting (and a surface Base keeps spinning with its planet)
      // for the whole dwell period.
      this.currentDock!.predictWorldPositionAt(0, this.root.position);
      this.dwellRemaining -= deltaSeconds;
      if (this.dwellRemaining <= 0) this.departNext();
    }

    if (this.role === "warship") combatUpdate(this, context, deltaSeconds);
    this.updateLod(cameraWorldPosition);
  }

  toExamineInfo(): ExaminableInfo {
    const cargoText = this.role === "warship" ? "Armed" : this.cargo ? `Carrying: ${capitalize(this.cargo.good)} x${this.cargo.qty.toFixed(0)}` : "Seeking cargo";
    const info: ExaminableInfo = {
      worldPosition: this.root.position,
      name: this.def.name,
      faction: FACTION_PALETTES[this.def.faction].label,
      kind: "Ship",
      crew: this.def.crew,
      cargo: cargoText,
      hull: this.health.hull,
      maxHull: this.health.maxHull,
    };
    if (this.role === "warship") info.role = "warship";
    if (this.phase === "transit") {
      info.speedUnitsPerSec = this.currentSpeed;
      info.etaSeconds = this.etaSeconds;
    }
    return info;
  }

  dispose(): void {
    this.trajectoryLine?.dispose();
    this.trajectoryMaterial.dispose();
    this.cubeMesh.dispose();
    this.iconMesh.dispose();
    this.root.dispose();
  }

  private updateLod(cameraWorldPosition: Vector3): void {
    const distance = Vector3.Distance(cameraWorldPosition, this.root.getAbsolutePosition());
    const showCube = distance < SHIP_BILLBOARD_DISTANCE;
    this.cubeMesh.setEnabled(showCube);
    this.iconMesh.setEnabled(!showCube);
  }

  private arrive(context: ShipContext): void {
    // Snaps to the destination's ACTUAL current position, erasing the fixed-point solver's
    // small residual error - cheap, and always exactly correct regardless of iteration count.
    const destination = this.liveLeg!.destination;
    destination.predictWorldPositionAt(0, this.root.position);
    this.currentDock = destination;
    this.liveLeg = null;
    this.trajectoryLine?.dispose();
    this.trajectoryLine = null;

    if (this.role === "trader" && this.cargo) {
      // Snapshotted at the moment of sale, not locked in when the leg was planned - an honest
      // consequence of a market that keeps moving during a long flight.
      const sellPrice = destination.market.priceOf(this.cargo.good);
      destination.market.sell(this.cargo.good, this.cargo.qty);
      context.creditTreasury(this.def.faction, (sellPrice - this.cargo.buyPrice) * this.cargo.qty);
      this.cargo = null;
    }

    const dwell = this.role === "warship" ? WARSHIP_DWELL_SECONDS : this.def.dwellSeconds;
    this.dwellRemaining = dwell;
    // Immediately plans the NEXT departure, `dwell` seconds ahead of when it's actually needed -
    // see planNextLeg's own comment.
    this.planNextLeg(context, dwell);
  }

  /** Solves the next leg's full destination choice + rendezvous/flight profile `leadSeconds`
   * ahead of the actual departure (called the instant this ship docks, with the fresh dwell
   * period as lead time, or once at construction for the very first departure) - departNext then
   * just consumes the result instead of solving anything itself. Predicts this ship's own
   * departure position (currentDock's position `leadSeconds` from now, not its current position)
   * since it keeps tracking a moving dock right up until it actually leaves (see update()'s
   * docked branch) - solving from where it will BE, not where it happens to be sitting right now.
   * Traders pick up cargo here too (if chooseNextLeg found something worth buying) - loaded while
   * docked, at the price the market shows at the moment of the decision. */
  private planNextLeg(context: ShipContext, leadSeconds: number): void {
    this.currentDock!.predictWorldPositionAt(leadSeconds, tmpPlannedFrom);

    let destination: Dockable;
    if (this.role === "warship") {
      destination = chooseWarshipDestination(context, this.currentDock!, this.def.faction, tmpPlannedFrom);
    } else {
      const chosen = chooseNextLeg(context, this.currentDock!, this.def.faction, tmpPlannedFrom, this.def.cruiseSpeed, this.def.cargoCapacity, this.cargo);
      destination = chosen.destination;
      if (chosen.pickup) {
        const buyPrice = this.currentDock!.market.priceOf(chosen.pickup.good);
        this.currentDock!.market.buy(chosen.pickup.good, chosen.pickup.qty);
        this.cargo = { good: chosen.pickup.good, qty: chosen.pickup.qty, buyPrice };
      }
    }

    const result = solveRendezvous(this.currentDock!, tmpPlannedFrom, destination, this.def.cruiseSpeed, leadSeconds);
    this.plannedLeg = planLeg(tmpPlannedFrom, destination, result.arrivalPosition, result.travelSeconds);
  }

  /** Consumes whatever planNextLeg already solved (back when this ship docked, or at
   * construction for the first departure) - no solving happens here, just applying an
   * already-made plan, the same "precompute once, apply cheaply" idea as CelestialOrbit's own
   * position table. */
  private departNext(): void {
    this.liveLeg = this.plannedLeg!;
    this.plannedLeg = null;
    this.currentDock = null;
    // Snaps to the planned departure point in case update()'s per-frame dock-tracking above drifted
    // even slightly from the exact position planNextLeg predicted (floating-point residual only -
    // both read the same dock's predictWorldPositionAt, just moments apart).
    this.root.position.copyFrom(this.liveLeg.profile.from);
    this.elapsed = 0;

    this.trajectoryLine?.dispose();
    this.trajectoryLine = MeshBuilder.CreateDashedLines(
      `${this.def.id}Trajectory`,
      { points: [this.liveLeg.profile.from, this.liveLeg.profile.to], dashSize: TRAJECTORY_DASH_SIZE, gapSize: TRAJECTORY_GAP_SIZE },
      this.scene,
    );
    // Reuses the one shared trajectoryMaterial created in the constructor (see its own comment)
    // rather than a fresh one each departure - Mesh.dispose() doesn't dispose its material by
    // default, and a ship departs many times over a session.
    this.trajectoryLine.material = this.trajectoryMaterial;
    this.trajectoryLine.isPickable = false;
    this.trajectoryLine.setEnabled(this.trajectoryVisible);
  }

  /** Applies immediately to the current trajectory line (if any) and is remembered for the next
   * one departNext() creates - see EconomyManager.setShipTrajectoriesVisible. */
  setTrajectoryVisible(visible: boolean): void {
    this.trajectoryVisible = visible;
    this.trajectoryLine?.setEnabled(visible);
  }
}
