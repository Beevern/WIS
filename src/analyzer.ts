/**
 * analyzer.ts — Core analysis pipeline for the Who's in Space? tool.
 *
 * Takes raw pastes from the user (local chat, d-scan, station guest list) and
 * produces an AnalysisResult: for each ship type on d-scan, which pilots in local
 * have recently lost that ship, and what fitting were they flying?
 *
 * Pipeline overview (see analyze() for details):
 *   1. Parse all three input pastes into structured data.
 *   2. Resolve pilot names → character IDs via ESI.
 *   3. Separate docked pilots (in station guest list) from in-space pilots.
 *   4. Resolve d-scan ship names → type IDs via ESI.
 *   5. Phase 1: For each in-space pilot × each ship type, check zKillboard for a
 *      recent loss. If found, fetch the full ESI killmail and parse the fitting.
 *      Corp/alliance data is NOT fetched here — only pilots with at least one match
 *      advance to Phase 2, saving many unnecessary ESI calls.
 *   6. Phase 2: Fetch corp and alliance info for matched pilots only.
 *   7. Group everything by ship type and return the final AnalysisResult.
 */

import {
  AnalyzeRequest,
  AnalysisResult,
  ShipAnalysis,
  PilotMatch,
  RecentLoss,
  ParsedDscan,
} from "./types";
import {
  resolveCharacterNames,
  getCharacter,
  getCorporation,
  getAlliance,
  resolveTypeName,
  getCharacterShipLosses,
  getCharacterLatestKillShipType,
  getKillmail,
  getShipStats,
  getType,
} from "./eveApi";
import { parseFitting } from "./fitting";

// ── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Ship types to silently skip when parsing d-scan output.
 * These are always present in any system and carry no intel value.
 */
const EXCLUDED_TYPES = /(scanner|probe|capsule|shuttle|mobile depot|mobile tractor|mobile micro jump|mobile cynosural|mobile scan|cargo container|secure container|freight container|wreck|customs office|control tower|silo|beacon|stargate)/i;

/**
 * Parse a raw d-scan paste into a list of ParsedDscan entries.
 *
 * D-scan output is TSV with (at minimum) columns: Name \t Type \t Distance.
 * We read the 2nd-to-last column as ship type and last column as distance.
 *
 * Multiple rows of the same ship type are collapsed into a single entry
 * with count > 1. If any row has a real distance (not "-"), onGrid is set to true.
 */
export function parseDscan(paste: string): ParsedDscan[] {
  const data = new Map<string, { count: number; onGrid: boolean }>();

  for (const rawLine of paste.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const cols = line.split("\t");
    if (cols.length < 2) continue;

    const shipType = cols[cols.length - 2]?.trim();
    const distance = cols[cols.length - 1]?.trim();

    if (!shipType || shipType === "" || shipType === "-") continue;
    if (EXCLUDED_TYPES.test(shipType)) continue;

    // A real distance value (not "-") means the ship is on the same grid as you
    const onGrid = distance !== "-" && distance !== "" && distance != null;

    const existing = data.get(shipType);
    if (existing) {
      existing.count++;
      if (onGrid) existing.onGrid = true; // any on-grid sighting marks the type as on-grid
    } else {
      data.set(shipType, { count: 1, onGrid });
    }
  }

  return Array.from(data.entries()).map(([shipName, { count, onGrid }]) => ({
    shipName,
    count,
    onGrid,
  }));
}

/**
 * Parse a raw pilot list paste (local chat or station guest list) into an array of names.
 * Simply splits on newlines and strips blank lines.
 */
export function parsePilotList(paste: string): string[] {
  return paste
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ── Main analysis ────────────────────────────────────────────────────────────

/**
 * Run the full analysis pipeline and return an AnalysisResult.
 *
 * This is the single entry point called by the /analyze HTTP endpoint.
 * All heavy lifting (ESI + zKill calls) runs inside here, with heavy
 * use of Promise.all() to parallelise network requests.
 */
export async function analyze(req: AnalyzeRequest): Promise<AnalysisResult> {
  const errors: string[] = [];
  const scannedAt = new Date().toISOString();

  // ── Step 1: Parse raw input pastes ──────────────────────────────────────
  const localPilots = parsePilotList(req.localPaste);
  const dscanShips  = parseDscan(req.dscanPaste);
  const dockedNames = req.stationPaste ? parsePilotList(req.stationPaste) : [];

  console.log(`[analyze] ${localPilots.length} pilots in local, ${dscanShips.length} ship types on dscan`);
  console.log(`[analyze] D-scan ships:`, dscanShips.map(s => s.shipName));

  if (localPilots.length === 0) errors.push("No pilots found in local paste.");
  if (dscanShips.length === 0) errors.push("No ships found in d-scan paste.");

  // ── Step 2: Resolve pilot names → character IDs ──────────────────────────
  const nameToId = await resolveCharacterNames(localPilots);
  console.log(`[analyze] Resolved ${nameToId.size}/${localPilots.length} pilot IDs`);

  // ESI may return names in a different canonical casing than what was pasted.
  // Build a lowercase fallback map so .get() never silently misses a resolved pilot.
  const nameToIdLower = new Map<string, number>(
    [...nameToId.entries()].map(([k, v]) => [k.toLowerCase(), v])
  );
  if (nameToId.size === 0) {
    errors.push("Could not resolve any character IDs. Check ESI is reachable.");
  }

  // ── Step 3: Separate docked pilots from in-space pilots ──────────────────
  // If no station paste was provided, all pilots are treated as in-space.
  const dockedSet = new Set(dockedNames.map((n) => n.toLowerCase()));
  const inSpacePilots: string[] = [];
  const dockedPilots: string[] = [];

  for (const name of localPilots) {
    if (dockedSet.has(name.toLowerCase())) {
      dockedPilots.push(name);
    } else {
      inSpacePilots.push(name);
    }
  }

  // Only analyze pilots who are actually in space — docked pilots can't be flying anything
  const pilotsToAnalyze = dockedNames.length > 0 ? inSpacePilots : localPilots;
  console.log(`[analyze] Analyzing ${pilotsToAnalyze.length} pilots (${dockedPilots.length} docked/skipped)`);

  // ── Step 4: Resolve all d-scan ship names → ESI type IDs ────────────────
  // We need type IDs to query zKillboard by ship type.
  // Fast path: try one bulk POST to ESI /universe/ids/ for all ship names at once.
  // Slow path: resolve individually for any names the bulk call missed (uses resolveTypeName()
  //            which has its own retry logic and a 24-hour cache).
  const shipTypeIds = new Map<string, number | null>();
  if (dscanShips.length > 0) {
    const shipNames = dscanShips.map(s => s.shipName);

    // Attempt bulk resolution in a single POST
    try {
      const resp = await (await import("axios")).default.post<{
        inventory_types?: Array<{ id: number; name: string }>;
      }>(
        "https://esi.evetech.net/latest/universe/ids/",
        shipNames,
        {
          params: { datasource: "tranquility" },
          headers: { "Content-Type": "application/json" },
        }
      );
      const types = resp.data?.inventory_types ?? [];
      for (const t of types) {
        // Match back to the original casing in the d-scan
        const original = shipNames.find(n => n.toLowerCase() === t.name.toLowerCase());
        if (original) shipTypeIds.set(original, t.id);
      }
    } catch (err: any) {
      console.warn("[analyze] Bulk ship type resolution failed:", err?.message);
    }

    // Fall back to individual resolution for anything the batch missed
    const unresolved = shipNames.filter(n => !shipTypeIds.has(n));
    if (unresolved.length > 0) {
      console.log(`[analyze] Falling back to individual resolution for: ${unresolved.join(", ")}`);
      await Promise.all(unresolved.map(async (name) => {
        const id = await resolveTypeName(name);
        shipTypeIds.set(name, id);
      }));
    }

    // Ensure every ship name has an entry — null means it couldn't be resolved
    for (const { shipName } of dscanShips) {
      if (!shipTypeIds.has(shipName)) shipTypeIds.set(shipName, null);
    }
  }
  for (const [name, id] of shipTypeIds.entries()) {
    console.log(`[analyze] Ship type "${name}" → typeId ${id}`);
  }

  // Only ships whose type IDs were successfully resolved can be queried on zKillboard
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 days cutoff
  const resolvedShips = Array.from(shipTypeIds.entries())
    .filter((entry): entry is [string, number] => entry[1] !== null);

  // Reverse map: typeId → d-scan ship name (for fast name lookup in Phase 1)
  const typeIdToShipName = new Map<number, string>(
    resolvedShips.map(([name, id]) => [id, name])
  );

  // ── Step 5: Phase 1 — Find matched losses + most recent kill ship ────────
  // For every pilot:
  //   a) Check each d-scan ship type for a recent loss (existing logic).
  //   b) Fetch their single most recent kill and check what ship they were flying.
  //      If that ship is on d-scan, this pilot will be marked "LIKELY" under it.
  //
  // Both checks run in parallel per pilot. Corp/alliance is NOT fetched here —
  // we only enrich pilots that produce at least one result (loss OR likely match).
  const pilotMatchMap = new Map<string, {
    characterId: number;
    losses: RecentLoss[];
    latestKillShipTypeId: number | null;
    latestKillShipName: string | null;
    latestKillTime: string | null;
  }>();

  await Promise.all(
    pilotsToAnalyze.map(async (pilotName) => {
      const characterId = nameToId.get(pilotName) ?? nameToIdLower.get(pilotName.toLowerCase());
      if (!characterId) {
        errors.push(`Could not resolve character ID for: ${pilotName}`);
        return;
      }

      // Run loss checks (per ship type) and the latest-kill lookup in parallel
      const [matchedLosses, latestKillInfo] = await Promise.all([
        Promise.all(
          resolvedShips.map(async ([shipName, typeId]): Promise<RecentLoss | null> => {
            const zkEntry = (await getCharacterShipLosses(characterId, typeId, cutoff))[0];
            if (!zkEntry) return null;

            const km = await getKillmail(zkEntry.killmail_id, zkEntry.zkb.hash);
            const killmailTime = km?.killmail_time ?? zkEntry.killmail_time;
            if (!killmailTime || new Date(killmailTime).getTime() < cutoff) return null;

            const fitting = km ? await parseFitting(km.victim.items ?? []) : [];
            return {
              killmailId: zkEntry.killmail_id,
              killmailTime,
              shipTypeId: typeId,
              shipName,
              totalValue: zkEntry.zkb.totalValue,
              fitting,
              solarSystemId: km?.solar_system_id ?? 0,
            };
          })
        ).then(results => results.filter((l): l is RecentLoss => l !== null)),

        // Single call: what ship was this pilot flying in their last kill?
        getCharacterLatestKillShipType(characterId),
      ]);

      // Only include this pilot if they have losses OR their last kill ship is on d-scan
      const latestKillShipOnDscan = latestKillInfo
        ? resolvedShips.some(([, id]) => id === latestKillInfo.shipTypeId)
        : false;

      // Resolve the name of the ship from their last kill
      let latestKillShipName: string | null = null;
      if (latestKillInfo?.shipTypeId) {
        latestKillShipName = typeIdToShipName.get(latestKillInfo.shipTypeId) ?? null;
        if (!latestKillShipName) {
          const t = await getType(latestKillInfo.shipTypeId);
          latestKillShipName = t?.name ?? null;
        }
      }

      console.log(`[analyze] ${pilotName}: ${matchedLosses.length} losses, last kill ship=${latestKillInfo?.shipTypeId ?? 'none'} (${latestKillShipName ?? '?'}) onDscan=${latestKillShipOnDscan}`);

      if (matchedLosses.length > 0 || latestKillShipOnDscan) {
        pilotMatchMap.set(pilotName, {
          characterId,
          losses: matchedLosses,
          latestKillShipTypeId: latestKillInfo?.shipTypeId ?? null,
          latestKillShipName,
          latestKillTime: latestKillInfo?.killTime ?? null,
        });
      }
    })
  );

  // ── Step 6: Phase 2 — Enrich matched pilots with corp/alliance ────────────
  // Runs for all pilots in pilotMatchMap (loss-based AND likely-only pilots).
  const pilotDataMap = new Map<string, {
    characterId: number;
    losses: RecentLoss[];
    corpName: string;
    allianceName?: string;
    latestKillShipTypeId: number | null;
    latestKillShipName: string | null;
    latestKillTime: string | null;
  }>();

  await Promise.all(
    [...pilotMatchMap.entries()].map(async ([pilotName, { characterId, losses, latestKillShipTypeId, latestKillShipName, latestKillTime }]) => {
      const char = await getCharacter(characterId);
      let corpName = "Unknown Corp";
      let allianceName: string | undefined;
      if (char) {
        const [corp, ally] = await Promise.all([
          getCorporation(char.corporation_id),
          char.alliance_id ? getAlliance(char.alliance_id) : Promise.resolve(null),
        ]);
        corpName = corp ? `${corp.name} [${corp.ticker}]` : "Unknown Corp";
        allianceName = ally ? `${ally.name} [${ally.ticker}]` : undefined;
      }
      pilotDataMap.set(pilotName, { characterId, losses, corpName, allianceName, latestKillShipTypeId, latestKillShipName, latestKillTime });
    })
  );

  // ── Step 7: Build the final output grouped by ship type ──────────────────
  const ships: ShipAnalysis[] = await Promise.all(dscanShips.map(async ({ shipName, count, onGrid }) => {
    const typeId = shipTypeIds.get(shipName) ?? null;
    const matchedPilots: PilotMatch[] = [];

    for (const [pilotName, data] of pilotDataMap.entries()) {
      const relevantLosses = data.losses.filter((l) => l.shipTypeId === typeId);
      const isLikely = typeId !== null && data.latestKillShipTypeId === typeId;

      if (relevantLosses.length > 0) {
        // Loss-based match — also flag as likely if their last kill was also in this ship
        matchedPilots.push({
          characterId: data.characterId,
          characterName: pilotName,
          corporationName: data.corpName,
          allianceName: data.allianceName,
          matchedLosses: relevantLosses,
          lastKillTime: data.latestKillTime ?? undefined,
          lastKillShipName: data.latestKillShipName ?? undefined,
          isLikelyActive: isLikely,
        });
      } else if (isLikely) {
        // Likely-only match — no recent losses for this ship, but last kill was in it
        matchedPilots.push({
          characterId: data.characterId,
          characterName: pilotName,
          corporationName: data.corpName,
          allianceName: data.allianceName,
          matchedLosses: [],
          lastKillTime: data.latestKillTime ?? undefined,
          lastKillShipName: data.latestKillShipName ?? undefined,
          isLikelyActive: true,
        });
      }
    }

    const stats = typeId ? await getShipStats(typeId) : null;
    return { shipName, shipTypeId: typeId, count, onGrid, stats, matchedPilots };
  }));

  console.log(`[analyze] Done. Ships with matches: ${ships.filter(s => s.matchedPilots.length > 0).length}/${ships.length}`);

  return { scannedAt, ships, dockedPilots, inSpacePilots, errors };
}
