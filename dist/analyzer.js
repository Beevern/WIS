"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDscan = parseDscan;
exports.parsePilotList = parsePilotList;
exports.analyze = analyze;
const eveApi_1 = require("./eveApi");
const fitting_1 = require("./fitting");
// ── Parsers ─────────────────────────────────────────────────────────────────
/**
 * Parse a d-scan TSV paste.
 * Eve d-scan columns: Name \t Type \t Distance
 * Ship type is the 2nd-to-last whitespace-separated token on each line,
 * which is the "Type" column in the TSV.
 */
function parseDscan(paste) {
    const counts = new Map();
    for (const rawLine of paste.split("\n")) {
        const line = rawLine.trim();
        if (!line)
            continue;
        // TSV split: columns are tab-separated
        const cols = line.split("\t");
        if (cols.length < 2)
            continue;
        // Ship type = second-to-last column
        const shipName = cols[cols.length - 2]?.trim();
        if (!shipName || shipName === "" || shipName === "-")
            continue;
        // Skip non-ship entries (e.g., "Unknown", "Cargo Container", bookmarks…)
        // We keep everything and let the analysis filter
        counts.set(shipName, (counts.get(shipName) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([shipName, count]) => ({
        shipName,
        count,
    }));
}
/**
 * Parse a local / station-guest paste.
 * Expects one full pilot name per line.
 */
function parsePilotList(paste) {
    return paste
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}
// ── Main analysis ────────────────────────────────────────────────────────────
async function analyze(req) {
    const errors = [];
    const scannedAt = new Date().toISOString();
    // 1. Parse inputs
    const localPilots = parsePilotList(req.localPaste);
    const dscanShips = parseDscan(req.dscanPaste);
    const dockedNames = req.stationPaste ? parsePilotList(req.stationPaste) : [];
    if (localPilots.length === 0) {
        errors.push("No pilots found in local paste.");
    }
    if (dscanShips.length === 0) {
        errors.push("No ships found in d-scan paste.");
    }
    // 2. Resolve pilot names → character IDs
    const nameToId = await (0, eveApi_1.resolveCharacterNames)(localPilots);
    // 3. Determine who is in space vs docked
    const dockedSet = new Set(dockedNames.map((n) => n.toLowerCase()));
    const inSpacePilots = [];
    const dockedPilots = [];
    for (const name of localPilots) {
        if (dockedSet.has(name.toLowerCase())) {
            dockedPilots.push(name);
        }
        else {
            inSpacePilots.push(name);
        }
    }
    // Only analyze pilots who are in space (or all if no station paste provided)
    const pilotsToAnalyze = dockedNames.length > 0 ? inSpacePilots : localPilots;
    // 4. Resolve all d-scan ship type names → type IDs (parallel)
    const shipTypeIds = new Map();
    await Promise.all(dscanShips.map(async ({ shipName }) => {
        const id = await (0, eveApi_1.resolveTypeName)(shipName);
        shipTypeIds.set(shipName, id);
    }));
    // 5. Build set of type IDs we care about
    const relevantTypeIds = new Set(Array.from(shipTypeIds.values()).filter((id) => id !== null));
    // 6. For each pilot in space, fetch their recent losses from zKillboard
    //    and filter to those matching d-scan ship types
    const pilotDataMap = new Map();
    await Promise.all(pilotsToAnalyze.map(async (pilotName) => {
        const characterId = nameToId.get(pilotName);
        if (!characterId) {
            errors.push(`Could not resolve character ID for: ${pilotName}`);
            return;
        }
        // Fetch character info (corp/alliance)
        const [char, zkillLosses] = await Promise.all([
            (0, eveApi_1.getCharacter)(characterId),
            (0, eveApi_1.getCharacterLosses)(characterId, 50),
        ]);
        let corpName = "Unknown Corp";
        let allianceName;
        if (char) {
            const corp = await (0, eveApi_1.getCorporation)(char.corporation_id);
            corpName = corp ? `${corp.name} [${corp.ticker}]` : "Unknown Corp";
            if (char.alliance_id) {
                const ally = await (0, eveApi_1.getAlliance)(char.alliance_id);
                allianceName = ally ? `${ally.name} [${ally.ticker}]` : undefined;
            }
        }
        // For each zkill loss, fetch the full killmail and check if the lost ship is on d-scan
        const matchedLosses = [];
        await Promise.all(zkillLosses.map(async (zkEntry) => {
            // Quick check: we need the full km to know the ship type
            const km = await (0, eveApi_1.getKillmail)(zkEntry.killmail_id, zkEntry.zkb.hash);
            if (!km)
                return;
            const lostTypeId = km.victim.ship_type_id;
            if (!relevantTypeIds.has(lostTypeId))
                return;
            // This pilot lost a ship that is currently on d-scan — parse the fit
            const fitting = await (0, fitting_1.parseFitting)(km.victim.items ?? []);
            // Resolve the ship name
            const shipTypeId = lostTypeId;
            // Find the name from our dscanShips mapping
            let shipName = "Unknown Ship";
            for (const [name, id] of shipTypeIds.entries()) {
                if (id === shipTypeId) {
                    shipName = name;
                    break;
                }
            }
            matchedLosses.push({
                killmailId: km.killmail_id,
                killmailTime: km.killmail_time,
                shipTypeId,
                shipName,
                totalValue: zkEntry.zkb.totalValue,
                fitting,
                solarSystemId: km.solar_system_id,
            });
        }));
        // Sort most recent first
        matchedLosses.sort((a, b) => new Date(b.killmailTime).getTime() - new Date(a.killmailTime).getTime());
        pilotDataMap.set(pilotName, {
            characterId,
            losses: matchedLosses,
            corpName,
            allianceName,
        });
    }));
    // 7. Build ShipAnalysis array (one entry per distinct ship on d-scan)
    const ships = dscanShips.map(({ shipName, count }) => {
        const typeId = shipTypeIds.get(shipName) ?? null;
        const matchedPilots = [];
        for (const [pilotName, data] of pilotDataMap.entries()) {
            const relevantLosses = data.losses.filter((l) => l.shipName === shipName);
            if (relevantLosses.length === 0)
                continue;
            matchedPilots.push({
                characterId: data.characterId,
                characterName: pilotName,
                corporationName: data.corpName,
                allianceName: data.allianceName,
                matchedLosses: relevantLosses,
            });
        }
        return {
            shipName,
            shipTypeId: typeId,
            count,
            matchedPilots,
        };
    });
    return {
        scannedAt,
        ships,
        dockedPilots,
        inSpacePilots,
        errors,
    };
}
