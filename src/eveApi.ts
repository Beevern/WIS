import axios, { AxiosInstance } from "axios";
import {
  EsiCharacter,
  EsiCorporation,
  EsiAlliance,
  EsiType,
  EsiKillmail,
  ZkillEntry,
} from "./types";

const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";

// ── Simple in-memory TTL cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

// Cache TTLs
const CHARACTER_TTL = 60 * 60 * 1000;   // 1 hour
const CORP_TTL      = 60 * 60 * 1000;   // 1 hour
const TYPE_TTL      = 24 * 60 * 60 * 1000; // 24 hours
const ZKILL_TTL     = 5  * 60 * 1000;   // 5 min (recent kills change)

const charCache  = new TtlCache<EsiCharacter>();
const corpCache  = new TtlCache<EsiCorporation>();
const allyCache  = new TtlCache<EsiAlliance>();
const typeCache  = new TtlCache<EsiType>();
const zkillCache = new TtlCache<ZkillEntry[]>();
const kmCache    = new TtlCache<EsiKillmail>();

// ── Axios instances ─────────────────────────────────────────────────────────

const esi: AxiosInstance = axios.create({
  baseURL: ESI_BASE,
  timeout: 10_000,
  headers: { "Accept": "application/json" },
});

// zKillboard requires a descriptive User-Agent
const zkill: AxiosInstance = axios.create({
  baseURL: ZKILL_BASE,
  timeout: 15_000,
  headers: {
    "Accept": "application/json",
    "User-Agent": "WIWIS FW Intel Tool - contact your_email@example.com",
  },
});

// ── Rate-limit helper (simple serial queue per host) ───────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function retry<T>(fn: () => Promise<T>, retries = 3, delayMs = 500): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err;
      const status = err?.response?.status;
      // Back off on 429 or 5xx
      if (status === 429 || (status >= 500)) {
        await sleep(delayMs * Math.pow(2, i));
      } else {
        throw err;
      }
    }
  }
  throw new Error("retry exhausted");
}

// ── ESI helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve a list of character names → character IDs via ESI POST /universe/ids/.
 * Sends names as a plain JSON array in the body.
 * Falls back to zKillboard name search for any that ESI misses.
 */
export async function resolveCharacterNames(
  names: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (names.length === 0) return result;

  // ESI /universe/ids/ accepts up to 500 names per request
  const CHUNK = 500;
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    try {
      const resp = await retry(() =>
        esi.post<{
          characters?: Array<{ id: number; name: string }>;
        }>(
          "/universe/ids/",
          chunk,
          {
            params: { datasource: "tranquility" },
            headers: { "Content-Type": "application/json" },
          }
        )
      );
      for (const c of resp.data?.characters ?? []) {
        result.set(c.name, c.id);
      }
    } catch (err: any) {
      console.warn("ESI /universe/ids/ chunk failed:", err?.message);
    }
  }

  // Any names ESI didn't return — try zKillboard character search as fallback
  const missed = names.filter((n) => !result.has(n));
  if (missed.length > 0) {
    console.log(`Falling back to zKill search for ${missed.length} names...`);
    await Promise.allSettled(
      missed.map(async (name) => {
        try {
          const resp = await retry(() =>
            zkill.get<Array<{ character_id: number; name: string }>>(
              `/characters/?name=${encodeURIComponent(name)}`
            )
          );
          const match = (resp.data ?? []).find(
            (c) => c.name.toLowerCase() === name.toLowerCase()
          );
          if (match) result.set(name, match.character_id);
        } catch {
          // silently skip
        }
      })
    );
  }

  return result;
}


export async function getCharacter(id: number): Promise<EsiCharacter | null> {
  const key = String(id);
  const cached = charCache.get(key);
  if (cached) return cached;

  try {
    const resp = await retry(() =>
      esi.get<EsiCharacter>(`/characters/${id}/`, {
        params: { datasource: "tranquility" },
      })
    );
    const c = { ...resp.data, character_id: id };
    charCache.set(key, c, CHARACTER_TTL);
    return c;
  } catch {
    return null;
  }
}

export async function getCorporation(id: number): Promise<EsiCorporation | null> {
  const key = String(id);
  const cached = corpCache.get(key);
  if (cached) return cached;

  try {
    const resp = await retry(() =>
      esi.get<EsiCorporation>(`/corporations/${id}/`, {
        params: { datasource: "tranquility" },
      })
    );
    corpCache.set(key, resp.data, CORP_TTL);
    return resp.data;
  } catch {
    return null;
  }
}

export async function getAlliance(id: number): Promise<EsiAlliance | null> {
  const key = String(id);
  const cached = allyCache.get(key);
  if (cached) return cached;

  try {
    const resp = await retry(() =>
      esi.get<EsiAlliance>(`/alliances/${id}/`, {
        params: { datasource: "tranquility" },
      })
    );
    allyCache.set(key, resp.data, CORP_TTL);
    return resp.data;
  } catch {
    return null;
  }
}

/**
 * Resolve a ship type name → type_id via ESI POST /universe/ids/.
 * Same endpoint used for character resolution — /search/ is deprecated.
 */
export async function resolveTypeName(name: string): Promise<number | null> {
  const key = `name:${name}`;
  const cached = typeCache.get(key);
  if (cached) return cached.type_id;

  try {
    const resp = await retry(() =>
      esi.post<{ inventory_types?: Array<{ id: number; name: string }> }>(
        "/universe/ids/",
        [name],
        {
          params: { datasource: "tranquility" },
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    const types = resp.data?.inventory_types;
    if (!types || types.length === 0) {
      console.warn(`resolveTypeName: no match for "${name}"`);
      return null;
    }
    // Find exact match (case-insensitive)
    const match = types.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? types[0];
    typeCache.set(key, { type_id: match.id, name: match.name } as EsiType, TYPE_TTL);
    return match.id;
  } catch (err: any) {
    console.warn(`resolveTypeName failed for "${name}":`, err?.message);
    return null;
  }
}

export async function getType(typeId: number): Promise<EsiType | null> {
  const key = String(typeId);
  const cached = typeCache.get(key);
  if (cached) return cached;

  try {
    const resp = await retry(() =>
      esi.get<EsiType>(`/universe/types/${typeId}/`, {
        params: { datasource: "tranquility" },
      })
    );
    typeCache.set(key, resp.data, TYPE_TTL);
    return resp.data;
  } catch {
    return null;
  }
}

// ── Ship stats ──────────────────────────────────────────────────────────────

// Dogma attribute IDs we care about
const ATTR = {
  shieldEmRes:    271,
  shieldThermRes: 274,
  shieldKinRes:   273,
  shieldExpRes:   272,
  armorEmRes:     267,
  armorThermRes:  270,
  armorKinRes:    269,
  armorExpRes:    268,
  // Ship structure (hull) resonance attributes — SDE attribute IDs for player ships
  // Note: 974-977 are upwell/sovereignty structure attributes, not ship hull attributes
  hullEmRes:      113,
  hullThermRes:   110,
  hullKinRes:     109,
  hullExpRes:     111,
  hiSlots:        14,
  medSlots:       13,
  lowSlots:       12,
  rigSlots:       1137,
};

import { ShipStats } from "./types";

export async function getShipStats(typeId: number): Promise<ShipStats | null> {
  const type = await getType(typeId);
  if (!type || !type.dogma_attributes) return null;

  const attrMap = new Map<number, number>();
  for (const a of type.dogma_attributes) {
    attrMap.set(a.attribute_id, a.value);
  }

  const resist = (id: number) => {
    const raw = attrMap.get(id);
    if (raw === undefined) return 0;
    // resonance: 1.0 = 0% resist, 0.0 = 100% resist. Clamp to [0,100] to guard against stale/wrong IDs.
    return Math.max(0, Math.min(100, Math.round((1 - raw) * 100)));
  };
  const slot = (id: number) => Math.round(attrMap.get(id) ?? 0);

  // Build bonus strings from description (simplified — just slot counts + known bonuses)
  const bonuses: string[] = [];
  if (type.dogma_attributes) {
    // Role bonus / skill bonuses would need dogma effects — for now show slot layout
  }

  return {
    shieldResists: {
      em:    resist(ATTR.shieldEmRes),
      therm: resist(ATTR.shieldThermRes),
      kin:   resist(ATTR.shieldKinRes),
      exp:   resist(ATTR.shieldExpRes),
    },
    armorResists: {
      em:    resist(ATTR.armorEmRes),
      therm: resist(ATTR.armorThermRes),
      kin:   resist(ATTR.armorKinRes),
      exp:   resist(ATTR.armorExpRes),
    },
    hullResists: {
      em:    resist(ATTR.hullEmRes),
      therm: resist(ATTR.hullThermRes),
      kin:   resist(ATTR.hullKinRes),
      exp:   resist(ATTR.hullExpRes),
    },
    bonuses,
    slots: {
      high: slot(ATTR.hiSlots),
      mid:  slot(ATTR.medSlots),
      low:  slot(ATTR.lowSlots),
      rig:  slot(ATTR.rigSlots),
    },
  };
}

// ── zKillboard helpers ──────────────────────────────────────────────────────


/**
 * Fetch losses for a specific character + ship type from zKillboard.
 * Uses characterID + shipTypeID filters (both proven to work).
 * Paginates newest-first and stops as soon as a page contains an entry
 * older than sinceMs, so we never over-fetch.
 */
export async function getCharacterShipLosses(
  characterId: number,
  shipTypeId: number,
  sinceMs: number
): Promise<ZkillEntry[]> {
  const cacheHour = Math.floor(sinceMs / (60 * 60 * 1000));
  const key = `losses:${characterId}:${shipTypeId}:${cacheHour}`;
  const cached = zkillCache.get(key);
  if (cached) return cached;

  const all: ZkillEntry[] = [];
  for (let page = 1; page <= 10; page++) {
    try {
      const resp = await retry(() =>
        zkill.get<ZkillEntry[]>(
          `/losses/characterID/${characterId}/shipTypeID/${shipTypeId}/page/${page}/`
        )
      );
      const entries = resp.data ?? [];
      if (entries.length === 0) break;

      // zkill returns newest-first; stop once we hit entries older than the window
      const withinWindow = entries.filter(e => {
        if (!e.killmail_time) return true; // keep if date unknown, filter later
        return new Date(e.killmail_time).getTime() >= sinceMs;
      });
      all.push(...withinWindow);

      // If any entry on this page was outside the window we've covered the cutoff
      const hitCutoff = entries.some(
        e => e.killmail_time && new Date(e.killmail_time).getTime() < sinceMs
      );
      if (hitCutoff || entries.length < 200) break;
    } catch (err: any) {
      console.warn(`zKill fetch failed for char=${characterId} ship=${shipTypeId}:`, err?.message);
      break;
    }
  }

  zkillCache.set(key, all, ZKILL_TTL);
  return all;
}

/**
 * Fetch the full killmail from ESI using the zkill hash.
 */
export async function getKillmail(
  killmailId: number,
  hash: string
): Promise<EsiKillmail | null> {
  const key = String(killmailId);
  const cached = kmCache.get(key);
  if (cached) return cached;

  try {
    const resp = await retry(() =>
      esi.get<EsiKillmail>(
        `/killmails/${killmailId}/${hash}/`,
        { params: { datasource: "tranquility" } }
      )
    );
    kmCache.set(key, resp.data, 24 * 60 * 60 * 1000);
    return resp.data;
  } catch {
    return null;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────


