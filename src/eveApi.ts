/**
 * eveApi.ts — All network calls to the EVE ESI API and zKillboard API.
 *
 * Provides:
 *   - In-memory TTL caches for characters, corps, alliances, types, killmails, and zKill results
 *   - Axios instances pre-configured for ESI and zKillboard (with correct User-Agent)
 *   - A retry helper with exponential back-off for 429 / 5xx errors
 *   - A semaphore to cap concurrent zKillboard requests (avoid 429s)
 *   - Exported async functions used by analyzer.ts to look up EVE data
 */

import axios, { AxiosInstance } from "axios";
import {
  EsiCharacter,
  EsiCorporation,
  EsiAlliance,
  EsiType,
  EsiKillmail,
  ZkillEntry,
} from "./types";

// Base URLs for the two external APIs we talk to
const ESI_BASE   = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";

// ── Simple in-memory TTL cache ──────────────────────────────────────────────
// Avoids hammering ESI/zKill for data that doesn't change often.
// Entries are lazily evicted on read (no background timer needed).

interface CacheEntry<T> {
  value: T;
  expiresAt: number; // epoch ms after which this entry is considered stale
}

/**
 * Generic TTL cache backed by a plain Map.
 * Expired entries are deleted on .get() — no proactive sweeping.
 */
class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key); // lazy eviction
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

// How long to cache each data type.
// Character/corp data rarely changes mid-session; zKill data changes every few minutes.
const CHARACTER_TTL = 60 * 60 * 1000;      // 1 hour — names/corps don't change mid-session
const CORP_TTL      = 60 * 60 * 1000;      // 1 hour
const TYPE_TTL      = 24 * 60 * 60 * 1000; // 24 hours — ship names/categories are static
const ZKILL_TTL     = 5  * 60 * 1000;      // 5 minutes — recent kills change frequently

// Per-entity caches — keyed by numeric ID (as string) or composite strings
const charCache  = new TtlCache<EsiCharacter>();
const corpCache  = new TtlCache<EsiCorporation>();
const allyCache  = new TtlCache<EsiAlliance>();
const typeCache  = new TtlCache<EsiType>();
const zkillCache = new TtlCache<ZkillEntry[]>();
const kmCache    = new TtlCache<EsiKillmail>(); // killmails are immutable — cache forever in practice

// ── Axios instances ─────────────────────────────────────────────────────────

/** Axios instance pre-configured for the EVE ESI API. */
const esi: AxiosInstance = axios.create({
  baseURL: ESI_BASE,
  timeout: 10_000, // 10 s — ESI can be slow under load
  headers: { "Accept": "application/json" },
});

/**
 * Axios instance pre-configured for zKillboard.
 * zKillboard requires a descriptive User-Agent string that identifies the application
 * and provides contact information. Requests without a proper User-Agent may be blocked.
 */
const zkill: AxiosInstance = axios.create({
  baseURL: ZKILL_BASE,
  timeout: 10_000,
  headers: {
    "Accept": "application/json",
    "User-Agent": "WIWIS FW Intel Tool - contact ign Riot Mar",
  },
});

// ── Rate-limit helper (simple serial queue per host) ───────────────────────

/** Promise-based sleep helper used by the retry back-off logic. */
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper with exponential back-off.
 * Retries on HTTP 429 (rate-limited) and 5xx (server errors).
 * Any other error (4xx, network) is thrown immediately without retrying.
 *
 * @param fn       - The async function to call and potentially retry.
 * @param retries  - Total number of attempts (default 3).
 * @param delayMs  - Base delay in ms; doubled each retry (default 500 ms).
 */
async function retry<T>(fn: () => Promise<T>, retries = 3, delayMs = 500): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err; // last attempt — propagate the error
      const status = err?.response?.status;
      // Only back off for rate-limiting or server errors; re-throw client errors immediately
      if (status === 429 || (status >= 500)) {
        await sleep(delayMs * Math.pow(2, i)); // 500 ms, 1000 ms, 2000 ms, ...
      } else {
        throw err;
      }
    }
  }
  throw new Error("retry exhausted");
}

/**
 * Semaphore: limits the number of concurrent async operations.
 * Used to cap zKillboard requests so we don't hit their rate limit.
 * When all permits are taken, callers queue up and run in FIFO order.
 */
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = []; // callbacks waiting for a permit

  constructor(permits: number) { this.permits = permits; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Acquire a permit (or wait in queue if none available)
    if (this.permits > 0) {
      this.permits--;
    } else {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      // Release permit — wake the next waiter if any, otherwise increment free count
      const next = this.queue.shift();
      if (next) next();
      else this.permits++;
    }
  }
}

// zKillboard allows ~10 req/s; cap at 4 concurrent to stay comfortably under the limit
const zkillSem = new Semaphore(4);

// ── ESI helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve a list of character names → character IDs via ESI POST /universe/ids/.
 *
 * ESI accepts up to 500 names per request, so we chunk large lists.
 * Names that ESI doesn't return in the bulk call are retried individually —
 * one bad/misspelled name in the array can cause ESI to drop the entire chunk,
 * so the individual fallback ensures one bad pilot doesn't block the others.
 *
 * Returns a Map of { name → characterId }. Names with no ESI match are omitted.
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

  // Retry any names ESI didn't return, one at a time.
  // One misspelled/deleted character in a bulk request can cause ESI to return nothing.
  const missed = names.filter((n) => !result.has(n));
  if (missed.length > 0) {
    console.log(`Falling back to individual ESI lookups for ${missed.length} names...`);
    await Promise.allSettled(
      missed.map(async (name) => {
        try {
          const resp = await esi.post<{
            characters?: Array<{ id: number; name: string }>;
          }>(
            "/universe/ids/",
            [name],
            {
              params: { datasource: "tranquility" },
              headers: { "Content-Type": "application/json" },
            }
          );
          const c = resp.data?.characters?.[0];
          if (c) result.set(c.name, c.id);
        } catch {
          // Name truly doesn't exist in EVE (deleted/NPC/typo) — skip silently
        }
      })
    );
  }

  return result;
}


/** Fetch a character's public data from ESI. Returns null on any error. */
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
    // ESI doesn't include character_id in the response body — inject it manually
    const c = { ...resp.data, character_id: id };
    charCache.set(key, c, CHARACTER_TTL);
    return c;
  } catch {
    return null;
  }
}

/** Fetch a corporation's public data (name + ticker) from ESI. Returns null on error. */
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

/** Fetch an alliance's public data (name + ticker) from ESI. Returns null on error. */
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
 * Resolve a ship (or item) type name → ESI type_id.
 * Uses POST /universe/ids/ with inventory_types — the old /search/ endpoint is deprecated.
 * Prefers an exact case-insensitive match; falls back to the first result if none found.
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
    // Prefer exact case-insensitive match; if ambiguous, take the first result
    const match = types.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? types[0];
    typeCache.set(key, { type_id: match.id, name: match.name } as EsiType, TYPE_TTL);
    return match.id;
  } catch (err: any) {
    console.warn(`resolveTypeName failed for "${name}":`, err?.message);
    return null;
  }
}

/**
 * Fetch full type data including dogma_attributes from ESI /universe/types/{id}/.
 * Used by getShipStats() to read resistance and slot-count attributes.
 */
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

/**
 * Dogma attribute IDs for the stats we care about.
 * These come from the EVE Static Data Export (SDE); they're stable across patches.
 *
 * Resistance values in EVE are stored as "resonance" (0.0–1.0), where:
 *   0.0 = 100% resist (immune)   1.0 = 0% resist (no protection)
 * We convert to a percentage in getShipStats() below.
 */
const ATTR = {
  shieldEmRes:    271,
  shieldThermRes: 274,
  shieldKinRes:   273,
  shieldExpRes:   272,
  armorEmRes:     267,
  armorThermRes:  270,
  armorKinRes:    269,
  armorExpRes:    268,
  // Ship structure (hull) resonance attributes — SDE attribute IDs for player ships.
  // Note: 974-977 are upwell/sovereignty structure attributes, not ship hull attributes.
  hullEmRes:      113,
  hullThermRes:   110,
  hullKinRes:     109,
  hullExpRes:     111,
  hiSlots:        14,   // number of high slots
  medSlots:       13,   // number of mid slots
  lowSlots:       12,   // number of low slots
  rigSlots:       1137, // number of rig slots
};

import { ShipStats } from "./types";

/**
 * Fetch base ship stats (resistances + slot layout) from ESI dogma attributes.
 *
 * Resistance percentages are converted from EVE's internal resonance format:
 *   resist% = round((1 - resonance) * 100), clamped to [0, 100].
 *
 * Returns null if the type ID is unresolvable or has no dogma data (e.g. non-ship types).
 */
export async function getShipStats(typeId: number): Promise<ShipStats | null> {
  const type = await getType(typeId);
  if (!type || !type.dogma_attributes) return null;

  // Build a quick-lookup map: attribute_id → value
  const attrMap = new Map<number, number>();
  for (const a of type.dogma_attributes) {
    attrMap.set(a.attribute_id, a.value);
  }

  // Convert a resonance attribute to a resistance percentage
  const resist = (id: number) => {
    const raw = attrMap.get(id);
    if (raw === undefined) return 0;
    // Clamp to [0,100] as a guard against stale or wrong attribute IDs
    return Math.max(0, Math.min(100, Math.round((1 - raw) * 100)));
  };
  // Read a slot-count attribute (always an integer)
  const slot = (id: number) => Math.round(attrMap.get(id) ?? 0);

  // Role/skill bonuses would require parsing dogma effects, which is complex.
  // For now this is left as an empty array; the UI doesn't display it yet.
  const bonuses: string[] = [];

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
 * Fetch the single most recent loss for a character + ship type from zKillboard.
 * zKill returns results newest-first, so page 1 entry 0 is all we need.
 * Returns [] if the pilot has never lost that ship type or the most recent loss
 * is older than sinceMs.
 */
export async function getCharacterShipLosses(
  characterId: number,
  shipTypeId: number,
  sinceMs: number
): Promise<ZkillEntry[]> {
  const key = `losses:${characterId}:${shipTypeId}`;
  const cached = zkillCache.get(key);
  if (cached) return cached;

  try {
    const resp = await zkillSem.run(() => retry(() =>
      zkill.get<ZkillEntry[]>(
        `/losses/characterID/${characterId}/shipTypeID/${shipTypeId}/page/1/`
      )
    ));
    const entries = Array.isArray(resp.data) ? resp.data : [];
    const first = entries[0];

    // No losses ever, or most recent is already past the cutoff — skip ESI fetch
    if (!first) { zkillCache.set(key, [], ZKILL_TTL); return []; }
    if (first.killmail_time && new Date(first.killmail_time).getTime() < sinceMs) {
      zkillCache.set(key, [], ZKILL_TTL);
      return [];
    }

    const result = [first];
    zkillCache.set(key, result, ZKILL_TTL);
    return result;
  } catch (err: any) {
    console.warn(`zKill ship-losses fetch failed for char=${characterId} ship=${shipTypeId}:`, err?.message);
    return [];
  }
}

/**
 * Find the most recent kill where a character was flying a specific ship type.
 *
 * zKillboard's simple API /kills/characterID/{id}/shipTypeID/{id}/ filters on the
 * VICTIM's ship type (what was destroyed), not the attacker's ship. To find kills
 * where the character was the one FLYING that ship, we must:
 *   1. Fetch the character's recent kills (no ship filter) — newest first.
 *   2. For each entry, fetch the ESI killmail and check the attacker list for this
 *      character's ship_type_id.
 *   3. Return the first match.
 *
 * We check at most MAX_CHECK killmails to bound the cost. Killmails are cached for
 * 24 h, so repeated calls across ship types for the same pilot are cheap.
 */
export async function getCharacterShipKillsByType(
  characterId: number,
  shipTypeId: number
): Promise<ZkillEntry | null> {
  const key = `kills-in-ship:${characterId}:${shipTypeId}`;
  const cached = zkillCache.get(key);
  if (cached) return cached[0] ?? null;

  const MAX_CHECK = 10; // check up to 10 recent kills before giving up

  try {
    const resp = await zkillSem.run(() => retry(() =>
      zkill.get<ZkillEntry[]>(`/kills/characterID/${characterId}/page/1/`)
    ));
    const entries = Array.isArray(resp.data) ? resp.data : [];

    for (const entry of entries.slice(0, MAX_CHECK)) {
      const km = await getKillmail(entry.killmail_id, entry.zkb.hash);
      if (!km) continue;
      const attacker = km.attackers.find(a => a.character_id === characterId);
      if (attacker?.ship_type_id === shipTypeId) {
        zkillCache.set(key, [entry], ZKILL_TTL);
        return entry;
      }
    }

    zkillCache.set(key, [], ZKILL_TTL);
    return null;
  } catch (err: any) {
    console.warn(`getCharacterShipKillsByType failed for char=${characterId} ship=${shipTypeId}:`, err?.message);
    return null;
  }
}

/**
 * Fetch the single most recent kill (any ship) for a character from zKillboard.
 * Used to determine "last activity (kill)" — zKill has no API filter for attacker
 * ship type, so we take the latest kill regardless of ship and compare against the loss date.
 */
export async function getCharacterLatestKill(characterId: number): Promise<ZkillEntry | null> {
  const key = `latest-kill:${characterId}`;
  const cached = zkillCache.get(key);
  if (cached) return cached[0] ?? null;

  try {
    const resp = await zkillSem.run(() => retry(() =>
      zkill.get<ZkillEntry[]>(`/kills/characterID/${characterId}/page/1/`)
    ));
    const entries = Array.isArray(resp.data) ? resp.data : [];
    const first = entries[0] ?? null;
    zkillCache.set(key, first ? [first] : [], ZKILL_TTL);
    return first;
  } catch (err: any) {
    console.warn(`zKill latest-kill fetch failed for char=${characterId}:`, err?.message);
    return null;
  }
}

/**
 * Get the ship type a character was flying in their single most recent kill.
 *
 * Fetches the most recent kill entry via getCharacterLatestKill, then fetches
 * the full ESI killmail and finds the character's attacker entry to read their
 * ship_type_id. Both underlying calls are cached, so repeated calls are cheap.
 *
 * Returns null if the character has no recent kills or doesn't appear as an attacker.
 */
export async function getCharacterLatestKillShipType(
  characterId: number
): Promise<{ shipTypeId: number; killTime: string } | null> {
  const latestKill = await getCharacterLatestKill(characterId);
  if (!latestKill) return null;

  const km = await getKillmail(latestKill.killmail_id, latestKill.zkb.hash);
  if (!km) return null;

  const attacker = km.attackers.find(a => a.character_id === characterId);
  if (!attacker?.ship_type_id) return null;

  return { shipTypeId: attacker.ship_type_id, killTime: km.killmail_time };
}

/**
 * Fetch ALL recent losses for a character from zKillboard (no ship type filter).
 * One call per pilot instead of one call per (pilot × ship type).
 * The analyzer filters by ship type after fetching the ESI killmail.
 */
export async function getCharacterAllLosses(
  characterId: number,
  sinceMs: number
): Promise<ZkillEntry[]> {
  const cacheHour = Math.floor(Date.now() / (60 * 60 * 1000));
  const key = `alllosses:${characterId}:${cacheHour}`;
  const cached = zkillCache.get(key);
  if (cached) return cached;

  const all: ZkillEntry[] = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const resp = await zkillSem.run(() => retry(() =>
        zkill.get<ZkillEntry[]>(
          `/losses/characterID/${characterId}/page/${page}/`
        )
      ));
      const entries = Array.isArray(resp.data) ? resp.data : [];
      if (entries.length === 0) break;

      // zKill returns newest-first; stop once we pass the cutoff
      const withinWindow = entries.filter(e =>
        !e.killmail_time || new Date(e.killmail_time).getTime() >= sinceMs
      );
      all.push(...withinWindow);

      const hitCutoff = entries.some(
        e => e.killmail_time && new Date(e.killmail_time).getTime() < sinceMs
      );
      if (hitCutoff || entries.length < 200) break;
    } catch (err: any) {
      console.warn(`zKill all-losses fetch failed for char=${characterId}:`, err?.message);
      break;
    }
  }

  zkillCache.set(key, all, ZKILL_TTL);
  return all;
}

/**
 * Fetch the most recent kill for a character (any ship) from zKillboard.
 * Only page 1 is fetched — we just need the most recent kill timestamp.
 * Isolated with its own try/catch so it never breaks loss matching.
 */
export async function getCharacterShipKills(
  characterId: number,
  sinceMs: number
): Promise<ZkillEntry[]> {
  const cacheHour = Math.floor(Date.now() / (60 * 60 * 1000));
  const key = `kills:${characterId}:${cacheHour}`;
  const cached = zkillCache.get(key);
  if (cached) return cached;

  const all: ZkillEntry[] = [];
  try {
    const resp = await zkillSem.run(() => retry(() =>
      zkill.get<ZkillEntry[]>(
        `/kills/characterID/${characterId}/page/1/`
      )
    ));
    const entries = Array.isArray(resp.data) ? resp.data : [];
    const withinWindow = entries.filter(e => {
      if (!e.killmail_time) return true;
      return new Date(e.killmail_time).getTime() >= sinceMs;
    });
    all.push(...withinWindow);
  } catch (err: any) {
    console.warn(`zKill kills fetch failed for char=${characterId}:`, err?.message);
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
  } catch (err: any) {
    console.warn(`getKillmail failed for ${killmailId}:`, err?.message);
    return null;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────


