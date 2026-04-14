"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCharacterNames = resolveCharacterNames;
exports.getCharacter = getCharacter;
exports.getCorporation = getCorporation;
exports.getAlliance = getAlliance;
exports.resolveTypeName = resolveTypeName;
exports.getType = getType;
exports.getShipStats = getShipStats;
exports.getCharacterShipLosses = getCharacterShipLosses;
exports.getCharacterShipKills = getCharacterShipKills;
exports.getKillmail = getKillmail;
const axios_1 = __importDefault(require("axios"));
const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";
class TtlCache {
    constructor() {
        this.store = new Map();
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value, ttlMs) {
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
}
// Cache TTLs
const CHARACTER_TTL = 60 * 60 * 1000; // 1 hour
const CORP_TTL = 60 * 60 * 1000; // 1 hour
const TYPE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const ZKILL_TTL = 5 * 60 * 1000; // 5 min (recent kills change)
const charCache = new TtlCache();
const corpCache = new TtlCache();
const allyCache = new TtlCache();
const typeCache = new TtlCache();
const zkillCache = new TtlCache();
const kmCache = new TtlCache();
// ── Axios instances ─────────────────────────────────────────────────────────
const esi = axios_1.default.create({
    baseURL: ESI_BASE,
    timeout: 10000,
    headers: { "Accept": "application/json" },
});
// zKillboard requires a descriptive User-Agent
const zkill = axios_1.default.create({
    baseURL: ZKILL_BASE,
    timeout: 15000,
    headers: {
        "Accept": "application/json",
        "User-Agent": "WIWIS FW Intel Tool - contact your_email@example.com",
    },
});
// ── Rate-limit helper (simple serial queue per host) ───────────────────────
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function retry(fn, retries = 3, delayMs = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        }
        catch (err) {
            if (i === retries - 1)
                throw err;
            const status = err?.response?.status;
            // Back off on 429 or 5xx
            if (status === 429 || (status >= 500)) {
                await sleep(delayMs * Math.pow(2, i));
            }
            else {
                throw err;
            }
        }
    }
    throw new Error("retry exhausted");
}
// Semaphore: limits concurrent zKillboard requests to avoid 429s
class Semaphore {
    constructor(permits) {
        this.queue = [];
        this.permits = permits;
    }
    async run(fn) {
        if (this.permits > 0) {
            this.permits--;
        }
        else {
            await new Promise(resolve => this.queue.push(resolve));
        }
        try {
            return await fn();
        }
        finally {
            const next = this.queue.shift();
            if (next)
                next();
            else
                this.permits++;
        }
    }
}
// zKillboard allows ~10 req/s; keep well below that
const zkillSem = new Semaphore(4);
// ── ESI helpers ─────────────────────────────────────────────────────────────
/**
 * Resolve a list of character names → character IDs via ESI POST /universe/ids/.
 * Sends names as a plain JSON array in the body.
 * Falls back to zKillboard name search for any that ESI misses.
 */
async function resolveCharacterNames(names) {
    const result = new Map();
    if (names.length === 0)
        return result;
    // ESI /universe/ids/ accepts up to 500 names per request
    const CHUNK = 500;
    for (let i = 0; i < names.length; i += CHUNK) {
        const chunk = names.slice(i, i + CHUNK);
        try {
            const resp = await retry(() => esi.post("/universe/ids/", chunk, {
                params: { datasource: "tranquility" },
                headers: { "Content-Type": "application/json" },
            }));
            for (const c of resp.data?.characters ?? []) {
                result.set(c.name, c.id);
            }
        }
        catch (err) {
            console.warn("ESI /universe/ids/ chunk failed:", err?.message);
        }
    }
    // Any names ESI didn't return — retry individually so one bad name can't block the rest
    const missed = names.filter((n) => !result.has(n));
    if (missed.length > 0) {
        console.log(`Falling back to individual ESI lookups for ${missed.length} names...`);
        await Promise.allSettled(missed.map(async (name) => {
            try {
                const resp = await esi.post("/universe/ids/", [name], {
                    params: { datasource: "tranquility" },
                    headers: { "Content-Type": "application/json" },
                });
                const c = resp.data?.characters?.[0];
                if (c)
                    result.set(c.name, c.id);
            }
            catch {
                // name doesn't exist in EVE — skip silently
            }
        }));
    }
    return result;
}
async function getCharacter(id) {
    const key = String(id);
    const cached = charCache.get(key);
    if (cached)
        return cached;
    try {
        const resp = await retry(() => esi.get(`/characters/${id}/`, {
            params: { datasource: "tranquility" },
        }));
        const c = { ...resp.data, character_id: id };
        charCache.set(key, c, CHARACTER_TTL);
        return c;
    }
    catch {
        return null;
    }
}
async function getCorporation(id) {
    const key = String(id);
    const cached = corpCache.get(key);
    if (cached)
        return cached;
    try {
        const resp = await retry(() => esi.get(`/corporations/${id}/`, {
            params: { datasource: "tranquility" },
        }));
        corpCache.set(key, resp.data, CORP_TTL);
        return resp.data;
    }
    catch {
        return null;
    }
}
async function getAlliance(id) {
    const key = String(id);
    const cached = allyCache.get(key);
    if (cached)
        return cached;
    try {
        const resp = await retry(() => esi.get(`/alliances/${id}/`, {
            params: { datasource: "tranquility" },
        }));
        allyCache.set(key, resp.data, CORP_TTL);
        return resp.data;
    }
    catch {
        return null;
    }
}
/**
 * Resolve a ship type name → type_id via ESI POST /universe/ids/.
 * Same endpoint used for character resolution — /search/ is deprecated.
 */
async function resolveTypeName(name) {
    const key = `name:${name}`;
    const cached = typeCache.get(key);
    if (cached)
        return cached.type_id;
    try {
        const resp = await retry(() => esi.post("/universe/ids/", [name], {
            params: { datasource: "tranquility" },
            headers: { "Content-Type": "application/json" },
        }));
        const types = resp.data?.inventory_types;
        if (!types || types.length === 0) {
            console.warn(`resolveTypeName: no match for "${name}"`);
            return null;
        }
        // Find exact match (case-insensitive)
        const match = types.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? types[0];
        typeCache.set(key, { type_id: match.id, name: match.name }, TYPE_TTL);
        return match.id;
    }
    catch (err) {
        console.warn(`resolveTypeName failed for "${name}":`, err?.message);
        return null;
    }
}
async function getType(typeId) {
    const key = String(typeId);
    const cached = typeCache.get(key);
    if (cached)
        return cached;
    try {
        const resp = await retry(() => esi.get(`/universe/types/${typeId}/`, {
            params: { datasource: "tranquility" },
        }));
        typeCache.set(key, resp.data, TYPE_TTL);
        return resp.data;
    }
    catch {
        return null;
    }
}
// ── Ship stats ──────────────────────────────────────────────────────────────
// Dogma attribute IDs we care about
const ATTR = {
    shieldEmRes: 271,
    shieldThermRes: 274,
    shieldKinRes: 273,
    shieldExpRes: 272,
    armorEmRes: 267,
    armorThermRes: 270,
    armorKinRes: 269,
    armorExpRes: 268,
    // Ship structure (hull) resonance attributes — SDE attribute IDs for player ships
    // Note: 974-977 are upwell/sovereignty structure attributes, not ship hull attributes
    hullEmRes: 113,
    hullThermRes: 110,
    hullKinRes: 109,
    hullExpRes: 111,
    hiSlots: 14,
    medSlots: 13,
    lowSlots: 12,
    rigSlots: 1137,
};
async function getShipStats(typeId) {
    const type = await getType(typeId);
    if (!type || !type.dogma_attributes)
        return null;
    const attrMap = new Map();
    for (const a of type.dogma_attributes) {
        attrMap.set(a.attribute_id, a.value);
    }
    const resist = (id) => {
        const raw = attrMap.get(id);
        if (raw === undefined)
            return 0;
        // resonance: 1.0 = 0% resist, 0.0 = 100% resist. Clamp to [0,100] to guard against stale/wrong IDs.
        return Math.max(0, Math.min(100, Math.round((1 - raw) * 100)));
    };
    const slot = (id) => Math.round(attrMap.get(id) ?? 0);
    // Build bonus strings from description (simplified — just slot counts + known bonuses)
    const bonuses = [];
    if (type.dogma_attributes) {
        // Role bonus / skill bonuses would need dogma effects — for now show slot layout
    }
    return {
        shieldResists: {
            em: resist(ATTR.shieldEmRes),
            therm: resist(ATTR.shieldThermRes),
            kin: resist(ATTR.shieldKinRes),
            exp: resist(ATTR.shieldExpRes),
        },
        armorResists: {
            em: resist(ATTR.armorEmRes),
            therm: resist(ATTR.armorThermRes),
            kin: resist(ATTR.armorKinRes),
            exp: resist(ATTR.armorExpRes),
        },
        hullResists: {
            em: resist(ATTR.hullEmRes),
            therm: resist(ATTR.hullThermRes),
            kin: resist(ATTR.hullKinRes),
            exp: resist(ATTR.hullExpRes),
        },
        bonuses,
        slots: {
            high: slot(ATTR.hiSlots),
            mid: slot(ATTR.medSlots),
            low: slot(ATTR.lowSlots),
            rig: slot(ATTR.rigSlots),
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
async function getCharacterShipLosses(characterId, shipTypeId, sinceMs) {
    const cacheHour = Math.floor(sinceMs / (60 * 60 * 1000));
    const key = `losses:${characterId}:${shipTypeId}:${cacheHour}`;
    const cached = zkillCache.get(key);
    if (cached)
        return cached;
    const all = [];
    for (let page = 1; page <= 10; page++) {
        try {
            const resp = await zkillSem.run(() => retry(() => zkill.get(`/losses/characterID/${characterId}/shipTypeID/${shipTypeId}/page/${page}/`)));
            const entries = resp.data ?? [];
            if (entries.length === 0)
                break;
            // zkill returns newest-first; stop once we hit entries older than the window
            const withinWindow = entries.filter(e => {
                if (!e.killmail_time)
                    return true; // keep if date unknown, filter later
                return new Date(e.killmail_time).getTime() >= sinceMs;
            });
            all.push(...withinWindow);
            // If any entry on this page was outside the window we've covered the cutoff
            const hitCutoff = entries.some(e => e.killmail_time && new Date(e.killmail_time).getTime() < sinceMs);
            if (hitCutoff || entries.length < 200)
                break;
        }
        catch (err) {
            console.warn(`zKill fetch failed for char=${characterId} ship=${shipTypeId}:`, err?.message);
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
async function getCharacterShipKills(characterId, sinceMs) {
    const cacheHour = Math.floor(Date.now() / (60 * 60 * 1000));
    const key = `kills:${characterId}:${cacheHour}`;
    const cached = zkillCache.get(key);
    if (cached)
        return cached;
    const all = [];
    try {
        const resp = await zkillSem.run(() => retry(() => zkill.get(`/kills/characterID/${characterId}/page/1/`)));
        const entries = resp.data ?? [];
        const withinWindow = entries.filter(e => {
            if (!e.killmail_time)
                return true;
            return new Date(e.killmail_time).getTime() >= sinceMs;
        });
        all.push(...withinWindow);
    }
    catch (err) {
        console.warn(`zKill kills fetch failed for char=${characterId}:`, err?.message);
    }
    zkillCache.set(key, all, ZKILL_TTL);
    return all;
}
/**
 * Fetch the full killmail from ESI using the zkill hash.
 */
async function getKillmail(killmailId, hash) {
    const key = String(killmailId);
    const cached = kmCache.get(key);
    if (cached)
        return cached;
    try {
        const resp = await retry(() => esi.get(`/killmails/${killmailId}/${hash}/`, { params: { datasource: "tranquility" } }));
        kmCache.set(key, resp.data, 24 * 60 * 60 * 1000);
        return resp.data;
    }
    catch {
        return null;
    }
}
// ── Utilities ───────────────────────────────────────────────────────────────
