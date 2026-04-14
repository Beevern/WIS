import {
  AnalyzeRequest,
  AnalysisResult,
  ShipAnalysis,
  PilotMatch,
  RecentLoss,
  ParsedDscan,
  ZkillEntry,
} from "./types";
import {
  resolveCharacterNames,
  getCharacter,
  getCorporation,
  getAlliance,
  resolveTypeName,
  getCharacterShipLosses,
  getCharacterShipKills,
  getKillmail,
  getShipStats,
} from "./eveApi";
import { parseFitting } from "./fitting";

// ── Parsers ─────────────────────────────────────────────────────────────────

// Ship types to exclude from analysis
const EXCLUDED_TYPES = /(scanner|probe|capsule|shuttle|mobile depot|mobile tractor|mobile micro jump|mobile cynosural|mobile scan|cargo container|secure container|freight container|wreck|customs office|control tower|silo|beacon|stargate)/i;

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

    // on-grid = distance is not "-"
    const onGrid = distance !== "-" && distance !== "" && distance != null;

    const existing = data.get(shipType);
    if (existing) {
      existing.count++;
      if (onGrid) existing.onGrid = true;
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

export function parsePilotList(paste: string): string[] {
  return paste
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ── Main analysis ────────────────────────────────────────────────────────────

export async function analyze(req: AnalyzeRequest): Promise<AnalysisResult> {
  const errors: string[] = [];
  const scannedAt = new Date().toISOString();

  // 1. Parse inputs
  const localPilots = parsePilotList(req.localPaste);
  const dscanShips  = parseDscan(req.dscanPaste);
  const dockedNames = req.stationPaste ? parsePilotList(req.stationPaste) : [];

  console.log(`[analyze] ${localPilots.length} pilots in local, ${dscanShips.length} ship types on dscan`);
  console.log(`[analyze] D-scan ships:`, dscanShips.map(s => s.shipName));

  if (localPilots.length === 0) errors.push("No pilots found in local paste.");
  if (dscanShips.length === 0) errors.push("No ships found in d-scan paste.");

  // 2. Resolve pilot names → character IDs
  const nameToId = await resolveCharacterNames(localPilots);
  console.log(`[analyze] Resolved ${nameToId.size}/${localPilots.length} pilot IDs`);
  // ESI may return names in a different canonical casing than what was pasted — build
  // a lowercase fallback so the later .get() never silently misses a resolved pilot.
  const nameToIdLower = new Map<string, number>(
    [...nameToId.entries()].map(([k, v]) => [k.toLowerCase(), v])
  );
  if (nameToId.size === 0) {
    errors.push("Could not resolve any character IDs. Check ESI is reachable.");
  }

  // 3. Docked vs in-space
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

  const pilotsToAnalyze = dockedNames.length > 0 ? inSpacePilots : localPilots;
  console.log(`[analyze] Analyzing ${pilotsToAnalyze.length} pilots (${dockedPilots.length} docked/skipped)`);

  // 4. Resolve all d-scan ship names → type IDs
  const shipTypeIds = new Map<string, number | null>();
  if (dscanShips.length > 0) {
    const shipNames = dscanShips.map(s => s.shipName);

    // Attempt a single bulk POST first (fast path)
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
        const original = shipNames.find(n => n.toLowerCase() === t.name.toLowerCase());
        if (original) shipTypeIds.set(original, t.id);
      }
    } catch (err: any) {
      console.warn("[analyze] Bulk ship type resolution failed:", err?.message);
    }

    // Individual fallback for anything the batch missed — uses resolveTypeName
    // which has retry logic and a 24 h cache, so it handles transient failures.
    const unresolved = shipNames.filter(n => !shipTypeIds.has(n));
    if (unresolved.length > 0) {
      console.log(`[analyze] Falling back to individual resolution for: ${unresolved.join(", ")}`);
      await Promise.all(unresolved.map(async (name) => {
        const id = await resolveTypeName(name);
        shipTypeIds.set(name, id);
      }));
    }

    // Mark any that still failed as null
    for (const { shipName } of dscanShips) {
      if (!shipTypeIds.has(shipName)) shipTypeIds.set(shipName, null);
    }
  }
  for (const [name, id] of shipTypeIds.entries()) {
    console.log(`[analyze] Ship type "${name}" → typeId ${id}`);
  }

  // 5. Fetch losses and most-recent kills per pilot, matched against d-scan
  const pilotDataMap = new Map<
    string,
    { characterId: number; losses: RecentLoss[]; lastKillTime: string | undefined; corpName: string; allianceName?: string }
  >();

  await Promise.all(
    pilotsToAnalyze.map(async (pilotName) => {
      const characterId = nameToId.get(pilotName) ?? nameToIdLower.get(pilotName.toLowerCase());
      if (!characterId) {
        errors.push(`Could not resolve character ID for: ${pilotName}`);
        return;
      }

      const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;

      const char = await getCharacter(characterId);

      let corpName = "Unknown Corp";
      let allianceName: string | undefined;

      if (char) {
        const corp = await getCorporation(char.corporation_id);
        corpName = corp ? `${corp.name} [${corp.ticker}]` : "Unknown Corp";
        if (char.alliance_id) {
          const ally = await getAlliance(char.alliance_id);
          allianceName = ally ? `${ally.name} [${ally.ticker}]` : undefined;
        }
      }

      const matchedLosses: RecentLoss[] = [];

      const killEntries = await getCharacterShipKills(characterId, cutoff).catch((): ZkillEntry[] => []);
      const lastKillTime = killEntries[0]?.killmail_time;

      const resolvedShips = Array.from(shipTypeIds.entries())
        .filter((entry): entry is [string, number] => entry[1] !== null);

      await Promise.all(
        resolvedShips.map(async ([shipName, typeId]) => {
          const zkEntries = await getCharacterShipLosses(characterId, typeId, cutoff);
          console.log(`  [zkill] ${pilotName} × ${shipName}: ${zkEntries.length} losses`);
          await Promise.all(
            zkEntries.map(async (zkEntry: ZkillEntry) => {
              const km = await getKillmail(zkEntry.killmail_id, zkEntry.zkb.hash);
              const killmailTime = km?.killmail_time ?? zkEntry.killmail_time;
              if (!killmailTime || new Date(killmailTime).getTime() < cutoff) return;
              const fitting = km ? await parseFitting(km.victim.items ?? []) : [];
              matchedLosses.push({
                killmailId: zkEntry.killmail_id,
                killmailTime,
                shipTypeId: typeId,
                shipName,
                totalValue: zkEntry.zkb.totalValue,
                fitting,
                solarSystemId: km?.solar_system_id ?? 0,
              });
            })
          );
        })
      );

      // Sort most recent first, then keep only one per ship type
      matchedLosses.sort(
        (a, b) => new Date(b.killmailTime).getTime() - new Date(a.killmailTime).getTime()
      );
      // Deduplicate: only keep the most recent loss per ship type
      const seenTypes = new Set<number>();
      const dedupedLosses: RecentLoss[] = [];
      for (const loss of matchedLosses) {
        if (!seenTypes.has(loss.shipTypeId)) {
          seenTypes.add(loss.shipTypeId);
          dedupedLosses.push(loss);
        }
      }
      matchedLosses.length = 0;
      matchedLosses.push(...dedupedLosses);

      console.log(`[analyze] ${pilotName}: ${matchedLosses.length} matched losses`);

      pilotDataMap.set(pilotName, {
        characterId,
        losses: matchedLosses,
        lastKillTime,
        corpName,
        allianceName,
      });
    })
  );

  // 7. Build output grouped by ship type
  const ships: ShipAnalysis[] = await Promise.all(dscanShips.map(async ({ shipName, count, onGrid }) => {
    const typeId = shipTypeIds.get(shipName) ?? null;
    const matchedPilots: PilotMatch[] = [];

    for (const [pilotName, data] of pilotDataMap.entries()) {
      const relevantLosses = data.losses.filter((l) => l.shipTypeId === typeId);
      if (relevantLosses.length === 0) continue;

      const lastKillTime = data.lastKillTime;

      matchedPilots.push({
        characterId: data.characterId,
        characterName: pilotName,
        corporationName: data.corpName,
        allianceName: data.allianceName,
        matchedLosses: relevantLosses,
        lastKillTime,
      });
    }

    const stats = typeId ? await getShipStats(typeId) : null;
    return { shipName, shipTypeId: typeId, count, onGrid, stats, matchedPilots };
  }));

  console.log(`[analyze] Done. Ships with matches: ${ships.filter(s => s.matchedPilots.length > 0).length}/${ships.length}`);

  return { scannedAt, ships, dockedPilots, inSpacePilots, errors };
}
