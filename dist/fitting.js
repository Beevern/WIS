"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFitting = parseFitting;
const eveApi_1 = require("./eveApi");
// Eve item flag → slot category mapping
// Full flag list: https://esi.evetech.net/ui/#/Assets/get_characters_character_id_assets
const FLAG_TO_SLOT = {
    // High slots
    27: "High Slot", 28: "High Slot", 29: "High Slot", 30: "High Slot",
    31: "High Slot", 32: "High Slot", 33: "High Slot", 34: "High Slot",
    // Mid slots
    19: "Mid Slot", 20: "Mid Slot", 21: "Mid Slot", 22: "Mid Slot",
    23: "Mid Slot", 24: "Mid Slot", 25: "Mid Slot", 26: "Mid Slot",
    // Low slots
    11: "Low Slot", 12: "Low Slot", 13: "Low Slot", 14: "Low Slot",
    15: "Low Slot", 16: "Low Slot", 17: "Low Slot", 18: "Low Slot",
    // Rigs
    92: "Rig", 93: "Rig", 94: "Rig",
    // Subsystems
    125: "Subsystem", 126: "Subsystem", 127: "Subsystem", 128: "Subsystem", 129: "Subsystem",
    // Drones / cargo
    87: "Drone Bay",
    5: "Cargo",
};
function flagToSlot(flag) {
    return FLAG_TO_SLOT[flag] ?? "Unknown";
}
/**
 * Given the raw items array from an ESI killmail victim, resolve type names
 * and return a structured fitting list.
 *
 * Only includes fitted items (high/mid/low/rig/sub) and drones by default;
 * cargo is omitted unless includeCargo=true.
 */
async function parseFitting(items, includeCargo = false) {
    const fittingItems = [];
    // Deduplicate by (typeId, flag) so stacked items merge
    const grouped = new Map();
    for (const item of items) {
        const slotCat = flagToSlot(item.flag);
        if (!includeCargo && slotCat === "Cargo")
            continue;
        if (slotCat === "Unknown")
            continue;
        const key = `${item.type_id}:${item.flag}`;
        const qty = (item.quantity_destroyed ?? 0) + (item.quantity_dropped ?? 0);
        if (grouped.has(key)) {
            grouped.get(key).qty += qty;
        }
        else {
            grouped.set(key, { item, qty: Math.max(qty, 1) });
        }
    }
    // Resolve all type names in parallel (cache makes this fast)
    const entries = Array.from(grouped.entries());
    const resolved = await Promise.allSettled(entries.map(async ([, { item, qty }]) => {
        const type = await (0, eveApi_1.getType)(item.type_id);
        return {
            typeId: item.type_id,
            typeName: type?.name ?? `Unknown [${item.type_id}]`,
            slot: flagToSlot(item.flag),
            qty,
        };
    }));
    for (const r of resolved) {
        if (r.status === "fulfilled") {
            fittingItems.push(r.value);
        }
    }
    // Sort by slot order then name
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
