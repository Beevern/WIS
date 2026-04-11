# WIWIS Backend — "Who Is in Space"

Intel tool for Eve Online low-sec faction warfare.  
Given a **local paste** and a **d-scan paste**, it cross-references each pilot's
recent killboard history (via zKillboard) and returns structured data showing
which pilots have **previously lost the same ship types** currently visible on
d-scan — along with their exact fitted modules.

---

## Stack

- **Node.js 18+** / **TypeScript**
- **Express** — HTTP server
- **Eve ESI** (`https://esi.evetech.net`) — character resolution, type info, killmails
- **zKillboard API** (`https://zkillboard.com/api`) — recent loss history

---

## Quick Start

```bash
npm install
npm run dev       # ts-node dev server on :3001
# or
npm run build && npm start   # compiled JS
```

---

## API

### `GET /health`

```json
{ "status": "ok", "timestamp": "2024-01-01T00:00:00.000Z" }
```

---

### `POST /analyze`

**Request body:**

```json
{
  "localPaste": "Pilot One\nPilot Two\nPilot Three",
  "dscanPaste": "Object Name\tShip Type\t1,234 km\n...",
  "stationPaste": "Pilot Three"
}
```

| Field | Required | Description |
|---|---|---|
| `localPaste` | ✅ | One full pilot name per line (paste from Eve local channel) |
| `dscanPaste` | ✅ | TSV from Eve d-scan window. Ship type is the 2nd-to-last tab-delimited column |
| `stationPaste` | ❌ | Station guest list (one name per line). Used to filter out docked pilots |

---

**Response:**

```json
{
  "scannedAt": "2024-01-01T12:00:00.000Z",
  "dockedPilots": ["Pilot Three"],
  "inSpacePilots": ["Pilot One", "Pilot Two"],
  "ships": [
    {
      "shipName": "Incursus",
      "shipTypeId": 593,
      "count": 2,
      "matchedPilots": [
        {
          "characterId": 12345678,
          "characterName": "Pilot One",
          "corporationName": "Some Corp [CORP]",
          "allianceName": "Some Alliance [ALLY]",
          "matchedLosses": [
            {
              "killmailId": 999999,
              "killmailTime": "2024-01-01T10:00:00Z",
              "shipTypeId": 593,
              "shipName": "Incursus",
              "totalValue": 5000000,
              "solarSystemId": 30002659,
              "fitting": [
                { "typeId": 2488, "typeName": "Light Neutron Blaster II", "slot": "High Slot", "qty": 3 },
                { "typeId": 5973, "typeName": "1MN Afterburner II",       "slot": "Mid Slot",  "qty": 1 },
                { "typeId": 2281, "typeName": "Small Armor Repairer II",  "slot": "Low Slot",  "qty": 1 }
              ]
            }
          ]
        }
      ]
    }
  ],
  "errors": []
}
```

---

## How It Works

1. **Parse** — local paste → pilot names; d-scan TSV → distinct ship types + counts.
2. **Resolve** — ESI `/universe/ids/` bulk-resolves pilot names to character IDs.
3. **Docked filter** — pilots present in the station guest paste are flagged as docked.
4. **zKillboard** — for each in-space pilot, fetch recent losses (`/losses/characterID/{id}/`).
5. **Killmail match** — for each loss, fetch the full ESI killmail and check whether the lost `ship_type_id` matches any ship currently on d-scan.
6. **Fitting parse** — matched killmails have their `victim.items` decoded using Eve's item flag → slot mapping.
7. **Assemble** — results grouped by ship type, pilots attached under their matched ship.

---

## Caching

All ESI and zKillboard responses are cached in-memory:

| Data | TTL |
|---|---|
| Character info | 1 hour |
| Corporation / Alliance | 1 hour |
| Type info | 24 hours |
| Killmails | 24 hours |
| zKillboard losses | 5 minutes |

---

## Eve D-Scan Paste Format

Eve's d-scan window exports tab-separated values. The **ship type** is in the
**second-to-last column**:

```
Pilot One's Incursus    Incursus    1,234 km
Some POS Structure      Control Tower   123,456 km
```

The parser reads `cols[cols.length - 2]` after splitting on `\t`.

---

## Notes

- zKillboard rate-limits aggressively. Requests include a descriptive `User-Agent` header as required.
- Failed individual lookups are non-fatal — they appear in `errors[]` and the rest of the analysis continues.
- The backend does **not** authenticate with Eve SSO; it uses only public ESI endpoints.
