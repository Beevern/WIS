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
exports.getCharacterLosses = getCharacterLosses;
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
// ── ESI helpers ─────────────────────────────────────────────────────────────
/**
 * Resolve a list of character names → character IDs via ESI bulk endpoint.
 */
async function resolveCharacterNames(names) {
    const result = new Map();
    if (names.length === 0)
        return result;
    const chunks = chunkArray(names, 500); // ESI limit
    for (const chunk of chunks) {
        try {
            const resp = await retry(() => esi.post("/universe/ids/", chunk, { params: { datasource: "tranquility" } }));
            for (const item of resp.data) {
                if (item.category === "character") {
                    result.set(item.name, item.id);
                }
            }
        }
        catch (err) {
            console.warn("ESI name resolution failed for chunk:", err);
        }
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
 * Resolve a ship type name → type_id via ESI search.
 */
async function resolveTypeName(name) {
    const key = `name:${name}`;
    const cached = typeCache.get(key);
    if (cached)
        return cached.type_id;
    try {
        const resp = await retry(() => esi.get("/search/", {
            params: {
                categories: "inventory_type",
                search: name,
                strict: true,
                datasource: "tranquility",
            },
        }));
        const ids = resp.data.inventory_type;
        if (!ids || ids.length === 0)
            return null;
        // Cache a stub so we can cache the id
        typeCache.set(key, { type_id: ids[0], name }, TYPE_TTL);
        return ids[0];
    }
    catch {
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
// ── zKillboard helpers ──────────────────────────────────────────────────────
/**
 * Fetch recent losses for a character from zKillboard.
 * Returns up to `limit` entries (default 25).
 */
async function getCharacterLosses(characterId, limit = 25) {
    const key = `losses:${characterId}`;
    const cached = zkillCache.get(key);
    if (cached)
        return cached;
    try {
        const resp = await retry(() => zkill.get(`/losses/characterID/${characterId}/`));
        const entries = (resp.data || []).slice(0, limit);
        zkillCache.set(key, entries, ZKILL_TTL);
        return entries;
    }
    catch (err) {
        console.warn(`zKill fetch failed for ${characterId}:`, err?.message);
        return [];
    }
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
function chunkArray(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }
    return result;
}
