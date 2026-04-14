// ── Eve ESI / zKillboard types ──────────────────────────────────────────────

export interface EsiCharacter {
  character_id: number;
  name: string;
  corporation_id: number;
  alliance_id?: number;
}

export interface EsiCorporation {
  name: string;
  ticker: string;
}

export interface EsiAlliance {
  name: string;
  ticker: string;
}

export interface EsiType {
  type_id: number;
  name: string;
  group_id: number;
  dogma_attributes?: DogmaAttribute[];
}

export interface DogmaAttribute {
  attribute_id: number;
  value: number;
}

export interface ZkillEntry {
  killmail_id: number;
  killmail_time?: string;   // zkill includes this — use it to stop pagination early
  zkb: {
    hash: string;
    totalValue: number;
    points: number;
    npc: boolean;
    solo: boolean;
  };
}

export interface EsiKillmail {
  killmail_id: number;
  killmail_time: string;
  victim: {
    character_id?: number;
    ship_type_id: number;
    items: KillItem[];
    position?: { x: number; y: number; z: number };
  };
  attackers: Array<{
    character_id?: number;
    ship_type_id?: number;
    final_blow: boolean;
  }>;
  solar_system_id: number;
}

export interface KillItem {
  item_type_id: number;  // ESI uses item_type_id, NOT type_id
  flag: number;          // slot flag
  quantity_destroyed?: number;
  quantity_dropped?: number;
  singleton?: number;
  items?: KillItem[];    // nested items (e.g. charges inside launchers)
}

// ── WIWIS domain types ──────────────────────────────────────────────────────

export interface ParsedDscan {
  /** raw ship type name from the d-scan line */
  shipName: string;
  /** how many of this ship type appeared */
  count: number;
  /** true if any instance has a real distance (on-grid with you) */
  onGrid: boolean;
}

export interface FittingItem {
  typeId: number;
  typeName: string;
  slot: SlotCategory;
  qty: number;
}

export type SlotCategory =
  | "High Slot"
  | "Mid Slot"
  | "Low Slot"
  | "Rig"
  | "Subsystem"
  | "Drone Bay"
  | "Cargo"
  | "Unknown";

export interface RecentLoss {
  killmailId: number;
  killmailTime: string;
  shipTypeId: number;
  shipName: string;
  totalValue: number;
  fitting: FittingItem[];
  solarSystemId: number;
}

export interface PilotMatch {
  characterId: number;
  characterName: string;
  corporationName: string;
  allianceName?: string;
  /** losses that match a ship currently on d-scan */
  matchedLosses: RecentLoss[];
  /** most recent kill time for this pilot flying a matched ship type (ISO string) */
  lastKillTime?: string;
}

export interface ShipStats {
  shieldResists: { em: number; therm: number; kin: number; exp: number };
  armorResists:  { em: number; therm: number; kin: number; exp: number };
  hullResists:   { em: number; therm: number; kin: number; exp: number };
  bonuses: string[];
  slots: { high: number; mid: number; low: number; rig: number };
}

export interface ShipAnalysis {
  /** ship type name */
  shipName: string;
  shipTypeId: number | null;
  count: number;
  /** true if any instance of this ship is on-grid */
  onGrid: boolean;
  /** base ship stats from ESI dogma */
  stats: ShipStats | null;
  /** pilots who have lost this ship type recently */
  matchedPilots: PilotMatch[];
}

export interface AnalysisResult {
  scannedAt: string;
  ships: ShipAnalysis[];
  dockedPilots: string[];
  inSpacePilots: string[];
  errors: string[];
}

// ── Request body from the frontend ─────────────────────────────────────────

export interface AnalyzeRequest {
  /** one pilot name per line */
  localPaste: string;
  /** TSV from d-scan: Name \t Type \t Distance  (ship type = 2nd-to-last token) */
  dscanPaste: string;
  /** optional: station guests list, one name per line */
  stationPaste?: string;
}
