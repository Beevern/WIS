"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFitting = parseFitting;
const axios_1 = __importDefault(require("axios"));
const FLAG_TO_SLOT = {
    27: "High Slot", 28: "High Slot", 29: "High Slot", 30: "High Slot",
    31: "High Slot", 32: "High Slot", 33: "High Slot", 34: "High Slot",
    19: "Mid Slot", 20: "Mid Slot", 21: "Mid Slot", 22: "Mid Slot",
    23: "Mid Slot", 24: "Mid Slot", 25: "Mid Slot", 26: "Mid Slot",
    11: "Low Slot", 12: "Low Slot", 13: "Low Slot", 14: "Low Slot",
    15: "Low Slot", 16: "Low Slot", 17: "Low Slot", 18: "Low Slot",
    92: "Rig", 93: "Rig", 94: "Rig",
    125: "Subsystem", 126: "Subsystem", 127: "Subsystem", 128: "Subsystem", 129: "Subsystem",
    87: "Drone Bay",
    5: "Cargo",
};
function flagToSlot(flag) {
    return FLAG_TO_SLOT[flag] ?? "Unknown";
}
// Cache: typeId → { name, categoryId }
const typeCache = new Map();
// EVE category IDs to exclude (ammo/charges = 8, deployables = 22, etc.)
const EXCLUDED_CATEGORY_IDS = new Set([
    8, // Charge (ammo)
    18, // Drone (skip drones from high slot confusion)
]);
/**
 * Resolve type IDs → name + categoryId via ESI.
 * Uses /universe/names/ for names, then /universe/types/{id}/ for category.
 * Filters invalid IDs before batching to avoid 404s.
 */
async function resolveTypes(typeIds) {
    const result = new Map();
    const needName = [];
    const needCategory = [];
    for (const id of typeIds) {
        if (!id || id <= 0)
            continue;
        if (typeCache.has(id)) {
            result.set(id, typeCache.get(id));
        }
        else {
            needName.push(id);
        }
    }
    if (needName.length === 0)
        return result;
    const unique = Array.from(new Set(needName));
    // Step 1: get names in bulk
    const nameMap = new Map();
    const CHUNK = 1000;
    for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        try {
            const resp = await axios_1.default.post("https://esi.evetech.net/latest/universe/names/", chunk, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
            for (const item of resp.data)
                nameMap.set(item.id, item.name);
            console.log(`[fitting] /universe/names/ resolved ${resp.data.length}/${chunk.length}`);
        }
        catch (err) {
            console.warn(`[fitting] /universe/names/ failed: ${err?.response?.status} ${err?.message}`);
            // Fall back: fetch names individually
            for (const id of chunk) {
                try {
                    const r = await axios_1.default.get(`https://esi.evetech.net/latest/universe/types/${id}/?datasource=tranquility`, { timeout: 8000 });
                    if (r.data?.name) {
                        nameMap.set(id, r.data.name);
                        // We have category_id too — cache it directly
                        typeCache.set(id, { name: r.data.name, categoryId: r.data.category_id ?? 0 });
                        result.set(id, typeCache.get(id));
                    }
                }
                catch { /* skip */ }
            }
        }
    }
    // Step 2: for IDs we got a name but not yet a category, fetch /universe/types/{id}/
    for (const id of unique) {
        if (typeCache.has(id))
            continue; // already have category from fallback above
        if (!nameMap.has(id))
            continue; // couldn't resolve name at all
        needCategory.push(id);
    }
    // Fetch categories in parallel batches of 20
    const BATCH = 20;
    for (let i = 0; i < needCategory.length; i += BATCH) {
        const batch = needCategory.slice(i, i + BATCH);
        await Promise.all(batch.map(async (id) => {
            try {
                const r = await axios_1.default.get(`https://esi.evetech.net/latest/universe/types/${id}/?datasource=tranquility`, { timeout: 8000 });
                const entry = { name: nameMap.get(id), categoryId: r.data?.category_id ?? 0 };
                typeCache.set(id, entry);
                result.set(id, entry);
            }
            catch {
                // Use name without category (categoryId=0, won't be excluded)
                const entry = { name: nameMap.get(id), categoryId: 0 };
                typeCache.set(id, entry);
                result.set(id, entry);
            }
        }));
    }
    return result;
}
async function parseFitting(items, includeCargo = false) {
    // Group by typeId (not typeId+flag) so duplicate modules across slots merge
    // Key: typeId:slotCategory to keep slot info but merge same module in same slot type
    const grouped = new Map();
    for (const item of items) {
        if (!item.item_type_id || item.item_type_id <= 0)
            continue;
        const slotCat = flagToSlot(item.flag);
        if (!includeCargo && slotCat === "Cargo")
            continue;
        if (slotCat === "Unknown")
            continue;
        // Group by typeId + slot category (merge same module regardless of exact slot number)
        const key = `${item.item_type_id}:${slotCat}`;
        const qty = (item.quantity_destroyed ?? 0) + (item.quantity_dropped ?? 0);
        if (grouped.has(key)) {
            grouped.get(key).qty += qty;
        }
        else {
            grouped.set(key, { item, qty: Math.max(qty, 1) });
        }
    }
    if (grouped.size === 0)
        return [];
    const allTypeIds = Array.from(grouped.values()).map(({ item }) => item.item_type_id);
    const typeMap = await resolveTypes(allTypeIds);
    const fittingItems = [];
    for (const [, { item, qty }] of grouped.entries()) {
        const typeInfo = typeMap.get(item.item_type_id);
        if (!typeInfo)
            continue;
        const slotCat = flagToSlot(item.flag);
        // Filter ammo: exclude charges (categoryId=8) in high/mid slots
        if (EXCLUDED_CATEGORY_IDS.has(typeInfo.categoryId) && slotCat !== "Drone Bay")
            continue;
        // Filter high slot items with qty > 8 (ships have at most 8 high slots; higher counts indicate ammo)
        if (slotCat === "High Slot" && qty > 8)
            continue;
        fittingItems.push({
            typeId: item.item_type_id,
            typeName: typeInfo.name,
            slot: slotCat,
            qty,
        });
    }
    const slotOrder = [
        "High Slot", "Mid Slot", "Low Slot", "Rig", "Subsystem", "Drone Bay", "Cargo", "Unknown",
    ];
    fittingItems.sort((a, b) => {
        const si = slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot);
        if (si !== 0)
            return si;
        return a.typeName.localeCompare(b.typeName);
    });
    return fittingItems;
}
