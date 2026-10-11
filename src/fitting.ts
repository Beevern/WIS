/**
 * fitting.ts — Converts raw ESI killmail item arrays into human-readable fitting lists.
 *
 * EVE killmails record every item on a destroyed ship using numeric `flag` values
 * (e.g. 27 = first high slot) and `item_type_id` references. This module:
 *   1. Maps flag numbers → slot categories (High Slot, Mid Slot, etc.)
 *   2. Resolves type IDs → human-readable names via ESI /universe/names/
 *   3. Fetches category IDs via ESI /universe/types/{id}/ to filter out ammo/charges
 *   4. Returns a sorted, deduplicated FittingItem[] ready to display in the UI
 */

import { FittingItem, KillItem, SlotCategory } from "./types";
import axios from "axios";

/**
 * Maps EVE killmail item flag numbers to their slot category.
 * Flag ranges come from the EVE SDE (Static Data Export):
 *   Flags 27-34 = High Slots 1-8
 *   Flags 19-26 = Mid Slots 1-8
 *   Flags 11-18 = Low Slots 1-8
 *   Flags 92-94 = Rig Slots 1-3
 *   Flags 125-129 = Subsystem Slots 1-5
 *   Flag 87 = Drone Bay
 *   Flag 5  = Cargo Hold
 */
const FLAG_TO_SLOT: Record<number, SlotCategory> = {
  27: "High Slot", 28: "High Slot", 29: "High Slot", 30: "High Slot",
  31: "High Slot", 32: "High Slot", 33: "High Slot", 34: "High Slot",
  19: "Mid Slot", 20: "Mid Slot", 21: "Mid Slot", 22: "Mid Slot",
  23: "Mid Slot", 24: "Mid Slot", 25: "Mid Slot", 26: "Mid Slot",
  11: "Low Slot", 12: "Low Slot", 13: "Low Slot", 14: "Low Slot",
  15: "Low Slot", 16: "Low Slot", 17: "Low Slot", 18: "Low Slot",
  92: "Rig", 93: "Rig", 94: "Rig",
  125: "Subsystem", 126: "Subsystem", 127: "Subsystem", 128: "Subsystem", 129: "Subsystem",
  87: "Drone Bay",
  5:  "Cargo",
};

/** Convert a raw killmail flag number to a display slot category. */
function flagToSlot(flag: number): SlotCategory {
  return FLAG_TO_SLOT[flag] ?? "Unknown";
}

// In-memory cache to avoid re-fetching the same type IDs across multiple killmails.
// Key: typeId, Value: { name, categoryId }
const typeCache = new Map<number, { name: string; categoryId: number }>();

/**
 * EVE category IDs to exclude from fitting display.
 * We don't want ammo or drones cluttering the fitting readout.
 *   8  = Charge (all ammunition types)
 *   18 = Drone (already shown in Drone Bay if needed; also avoids high-slot confusion)
 */
const EXCLUDED_CATEGORY_IDS = new Set([
  8,   // Charge (ammo)
  18,  // Drone (skip drones from high slot confusion)
]);

/**
 * Resolve a list of type IDs → { name, categoryId } via ESI.
 *
 * Two-step process:
 *   Step 1: POST /universe/names/ to bulk-resolve names (up to 1000 per request).
 *           If that fails, falls back to individual GET /universe/types/{id}/ calls.
 *   Step 2: GET /universe/types/{id}/ for any IDs that still need a category_id.
 *           Done in parallel batches of 20 to avoid flooding ESI.
 *
 * Results are cached in `typeCache` to avoid re-fetching across calls.
 */
async function resolveTypes(typeIds: number[]): Promise<Map<number, { name: string; categoryId: number }>> {
  const result = new Map<number, { name: string; categoryId: number }>();
  const needName: number[] = [];
  const needCategory: number[] = [];

  // Separate IDs we already have cached from those we need to fetch
  for (const id of typeIds) {
    if (!id || id <= 0) continue;
    if (typeCache.has(id)) {
      result.set(id, typeCache.get(id)!);
    } else {
      needName.push(id);
    }
  }

  if (needName.length === 0) return result;

  const unique = Array.from(new Set(needName));

  // Step 1: bulk-resolve names via POST /universe/names/ (1000 IDs per chunk)
  const nameMap = new Map<number, string>();
  const CHUNK = 1000;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    try {
      const resp = await axios.post<Array<{ id: number; name: string; category: string }>>(
        "https://esi.evetech.net/latest/universe/names/",
        chunk,
        { headers: { "Content-Type": "application/json" }, timeout: 15000 }
      );
      for (const item of resp.data) nameMap.set(item.id, item.name);
      console.log(`[fitting] /universe/names/ resolved ${resp.data.length}/${chunk.length}`);
    } catch (err: any) {
      console.warn(`[fitting] /universe/names/ failed: ${err?.response?.status} ${err?.message}`);
      // Fallback: fetch each ID individually — slower but more resilient to partial 404s
      for (const id of chunk) {
        try {
          const r = await axios.get<{ name: string; category_id: number }>(
            `https://esi.evetech.net/latest/universe/types/${id}/?datasource=tranquility`,
            { timeout: 8000 }
          );
          if (r.data?.name) {
            nameMap.set(id, r.data.name);
            // Bonus: we also get category_id here, so skip Step 2 for this ID
            typeCache.set(id, { name: r.data.name, categoryId: r.data.category_id ?? 0 });
            result.set(id, typeCache.get(id)!);
          }
        } catch { /* skip unresolvable IDs silently */ }
      }
    }
  }

  // Step 2: for IDs that have a name but still no category, fetch /universe/types/{id}/
  for (const id of unique) {
    if (typeCache.has(id)) continue; // already got category from fallback above
    if (!nameMap.has(id)) continue;  // couldn't resolve name at all — skip
    needCategory.push(id);
  }

  // Fetch categories in parallel batches of 20 to stay well within ESI rate limits
  const BATCH = 20;
  for (let i = 0; i < needCategory.length; i += BATCH) {
    const batch = needCategory.slice(i, i + BATCH);
    await Promise.all(batch.map(async (id) => {
      try {
        const r = await axios.get<{ category_id: number }>(
          `https://esi.evetech.net/latest/universe/types/${id}/?datasource=tranquility`,
          { timeout: 8000 }
        );
        const entry = { name: nameMap.get(id)!, categoryId: r.data?.category_id ?? 0 };
        typeCache.set(id, entry);
        result.set(id, entry);
      } catch {
        // If the category fetch fails, still include the item with categoryId=0
        // (categoryId=0 won't match any exclusion rule, so the item passes through)
        const entry = { name: nameMap.get(id)!, categoryId: 0 };
        typeCache.set(id, entry);
        result.set(id, entry);
      }
    }));
  }

  return result;
}

/**
 * Parse the raw `items` array from an ESI killmail victim into a display-ready FittingItem[].
 *
 * @param items      - Raw KillItem array from the killmail victim object.
 * @param includeCargo - If false (default), items in the Cargo slot are excluded.
 * @returns          - Sorted array of FittingItem, ordered by slot then name.
 *
 * Filtering applied:
 *   - Items with unknown/invalid flag are skipped.
 *   - Cargo items skipped unless includeCargo=true.
 *   - Ammo (category 8) and drones (category 18) are excluded.
 *   - High-slot items with qty > 8 are treated as ammo stacks and excluded.
 *   - Multiple copies of the same module in the same slot type are merged (qty summed).
 */
export async function parseFitting(
  items: KillItem[],
  includeCargo = false
): Promise<FittingItem[]> {

  // Group items by typeId + slot category.
  // This merges e.g. two Medium Shield Extenders in mid slots into one entry with qty=2.
  const grouped = new Map<string, { item: KillItem; qty: number }>();

  for (const item of items) {
    if (!item.item_type_id || item.item_type_id <= 0) continue;

    const slotCat = flagToSlot(item.flag);
    if (!includeCargo && slotCat === "Cargo") continue;
    if (slotCat === "Unknown") continue;

    const key = `${item.item_type_id}:${slotCat}`;
    const qty = (item.quantity_destroyed ?? 0) + (item.quantity_dropped ?? 0);
    if (grouped.has(key)) {
      grouped.get(key)!.qty += qty;
    } else {
      // qty of 0 means a fitted (not stacked) module — treat as 1
      grouped.set(key, { item, qty: Math.max(qty, 1) });
    }
  }

  if (grouped.size === 0) return [];

  // Resolve all type IDs to names + category IDs in one batch call
  const allTypeIds = Array.from(grouped.values()).map(({ item }) => item.item_type_id);
  const typeMap = await resolveTypes(allTypeIds);

  const fittingItems: FittingItem[] = [];
  for (const [, { item, qty }] of grouped.entries()) {
    const typeInfo = typeMap.get(item.item_type_id);
    if (!typeInfo) continue; // type ID couldn't be resolved — skip

    const slotCat = flagToSlot(item.flag);

    // Remove ammo/charges from all slots (but keep drone bay items)
    if (EXCLUDED_CATEGORY_IDS.has(typeInfo.categoryId) && slotCat !== "Drone Bay") continue;

    // Additional ammo guard: a high-slot item with qty > 8 is almost certainly missiles/charges
    if (slotCat === "High Slot" && qty > 8) continue;

    fittingItems.push({
      typeId: item.item_type_id,
      typeName: typeInfo.name,
      slot: slotCat,
      qty,
    });
  }

  // Sort by slot order (high → mid → low → rig → subsystem → drone → cargo),
  // then alphabetically within each slot so the output is stable and readable.
  const slotOrder: SlotCategory[] = [
    "High Slot", "Mid Slot", "Low Slot", "Rig", "Subsystem", "Drone Bay", "Cargo", "Unknown",
  ];
  fittingItems.sort((a, b) => {
    const si = slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot);
    if (si !== 0) return si;
    return a.typeName.localeCompare(b.typeName);
  });

  return fittingItems;
}
