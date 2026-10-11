// ── Eve ESI / zKillboard types ──────────────────────────────────────────────
// These interfaces mirror the JSON shapes returned by the EVE ESI API
// (https://esi.evetech.net) and the zKillboard API (https://zkillboard.com).

/** A character (player) record from ESI /characters/{id}/ */
export interface EsiCharacter {
  character_id: number;
  name: string;
  corporation_id: number;
  alliance_id?: number; // optional — not all characters belong to an alliance
}

/** A corporation record from ESI /corporations/{id}/ */
export interface EsiCorporation {
  name: string;
  ticker: string; // short tag shown in [brackets] in-game
}

/** An alliance record from ESI /alliances/{id}/ */
export interface EsiAlliance {
  name: string;
  ticker: string;
}

/**
 * An inventory type record from ESI /universe/types/{id}/.
 * Used for both ships and modules. dogma_attributes holds numeric game stats
 * (resistances, slot counts, etc.) and is only present when fetched individually.
 */
export interface EsiType {
  type_id: number;
  name: string;
  group_id: number;
  dogma_attributes?: DogmaAttribute[]; // present on full /universe/types/{id}/ responses
}

/** A single dogma attribute key-value pair (e.g. attribute_id 271 = shield EM resonance). */
export interface DogmaAttribute {
  attribute_id: number;
  value: number;
}

/**
 * A single entry from the zKillboard API (kills or losses endpoint).
 * zKill returns an array of these; we usually only need the first (most recent).
 */
export interface ZkillEntry {
  killmail_id: number;
  killmail_time?: string;   // zkill includes this — use it to stop pagination early
  zkb: {
    hash: string;       // needed to fetch the full killmail from ESI
    totalValue: number; // ISK value of the loss
    points: number;
    npc: boolean;       // true if the kill was by NPCs only
    solo: boolean;      // true if the attacker was alone
  };
}

/**
 * A full killmail from ESI /killmails/{id}/{hash}/.
 * Contains the victim's ship, items lost, and a list of attackers.
 */
export interface EsiKillmail {
  killmail_id: number;
  killmail_time: string;    // ISO 8601 timestamp
  victim: {
    character_id?: number;  // may be absent for NPC victims
    ship_type_id: number;
    items: KillItem[];      // modules/items that were on the ship
    position?: { x: number; y: number; z: number };
  };
  attackers: Array<{
    character_id?: number;
    ship_type_id?: number;
    final_blow: boolean;    // true for the attacker who landed the killing hit
  }>;
  solar_system_id: number;
}

/**
 * A single item from a killmail victim's items array.
 * The `flag` field encodes which slot the item was in (see fitting.ts FLAG_TO_SLOT).
 */
export interface KillItem {
  item_type_id: number;  // ESI uses item_type_id, NOT type_id
  flag: number;          // slot flag (27-34 = high slots, 19-26 = mid, 11-18 = low, etc.)
  quantity_destroyed?: number;
  quantity_dropped?: number;
  singleton?: number;    // 1 if the item is a unique/fitted module (not a stack)
  items?: KillItem[];    // nested items (e.g. charges inside launchers)
}

// ── WIWIS domain types ──────────────────────────────────────────────────────
// These types represent the app's internal data model, not raw API responses.

/** One ship-type entry parsed from a d-scan paste. */
export interface ParsedDscan {
  /** raw ship type name from the d-scan line */
  shipName: string;
  /** how many of this ship type appeared in the d-scan */
  count: number;
  /** true if any instance has a real distance (on-grid with you, not just in system) */
  onGrid: boolean;
}

/** A resolved module/item from a killmail fitting, ready to display. */
export interface FittingItem {
  typeId: number;
  typeName: string;   // resolved from ESI
  slot: SlotCategory;
  qty: number;        // total quantity (destroyed + dropped)
}

/** The slot category a fitting item occupies. Mirrors EVE's ship fitting UI. */
export type SlotCategory =
  | "High Slot"
  | "Mid Slot"
  | "Low Slot"
  | "Rig"
  | "Subsystem"
  | "Drone Bay"
  | "Cargo"
  | "Unknown";

/** A recent killmail loss for a specific pilot + ship type pairing. */
export interface RecentLoss {
  killmailId: number;
  killmailTime: string;       // ISO 8601 — used for recency sorting and display
  shipTypeId: number;
  shipName: string;
  totalValue: number;         // ISK value from zKillboard
  fitting: FittingItem[];     // modules parsed from the killmail victim items
  solarSystemId: number;
  lastKillTime?: string;      // most recent kill in this ship type (ISO 8601) — may be undefined
}

/**
 * A pilot from local who has a recent loss matching a ship type on d-scan.
 * This is the core result object — one PilotMatch per pilot per ship type.
 */
export interface PilotMatch {
  characterId: number;
  characterName: string;
  corporationName: string;
  allianceName?: string;
  /** losses that match a ship currently on d-scan */
  matchedLosses: RecentLoss[];
  /** time of the pilot's most recent kill overall (ISO string) */
  lastKillTime?: string;
  /** name of the ship the pilot was flying in their most recent kill */
  lastKillShipName?: string;
  /** true when the pilot's most recent kill was in this exact ship type — they are actively flying it */
  isLikelyActive?: boolean;
}

/**
 * Base ship stats pulled from ESI dogma attributes.
 * Resistances are expressed as percentages (0–100), not resonance values.
 */
export interface ShipStats {
  shieldResists: { em: number; therm: number; kin: number; exp: number };
  armorResists:  { em: number; therm: number; kin: number; exp: number };
  hullResists:   { em: number; therm: number; kin: number; exp: number };
  bonuses: string[];  // role/skill bonus descriptions (currently unused)
  slots: { high: number; mid: number; low: number; rig: number };
}

/**
 * The top-level result for a single ship type seen on d-scan.
 * Groups all pilot matches and base ship stats under one ship name.
 */
export interface ShipAnalysis {
  /** ship type name */
  shipName: string;
  shipTypeId: number | null;  // null if ESI couldn't resolve the name to an ID
  count: number;              // how many of this ship appeared on d-scan
  /** true if any instance of this ship is on-grid (not just in system) */
  onGrid: boolean;
  /** base ship stats from ESI dogma — null if type couldn't be resolved */
  stats: ShipStats | null;
  /** pilots from local who have recently lost this ship type */
  matchedPilots: PilotMatch[];
}

/** The full response object returned by the /analyze endpoint. */
export interface AnalysisResult {
  scannedAt: string;        // ISO 8601 timestamp of when the analysis ran
  ships: ShipAnalysis[];    // one entry per distinct ship type on d-scan
  dockedPilots: string[];   // pilots excluded because they appear in the station guest list
  inSpacePilots: string[];  // pilots not in the station list (analyzed)
  errors: string[];         // non-fatal warnings (e.g. ESI failures)
}

// ── Request body from the frontend ─────────────────────────────────────────

/** The JSON body accepted by POST /analyze. All fields are raw paste text. */
export interface AnalyzeRequest {
  /** one pilot name per line — copied from the in-game local chat member list */
  localPaste: string;
  /** TSV from d-scan: Name \t Type \t Distance  (ship type = 2nd-to-last token) */
  dscanPaste: string;
  /** optional: station guests list, one name per line — used to skip docked pilots */
  stationPaste?: string;
}
