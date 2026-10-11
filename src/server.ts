/**
 * server.ts — Express HTTP server for the Who's in Space? (WIWIS) backend.
 *
 * Exposes three endpoints:
 *   GET  /          → serves fw-intel.html (the single-page frontend)
 *   GET  /health    → health-check, returns JSON {status:"ok"}
 *   POST /analyze   → main analysis endpoint; accepts {localPaste, dscanPaste, stationPaste}
 *                     and returns an AnalysisResult (see types.ts)
 *
 * All heavy lifting (ESI calls, zKillboard lookups, fitting parsing) is done
 * inside analyzer.ts, which is called here via analyze().
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import { analyze } from "./analyzer";
import { AnalyzeRequest } from "./types";

const app = express();
// Use PORT env var if set (e.g. in production), otherwise default to 3000
const PORT = Number(process.env.PORT) || 3000;

// Allow requests from any origin — needed when the frontend and backend are on different ports
app.use(cors());
// Accept JSON bodies up to 1 MB (local lists can get large)
app.use(express.json({ limit: "1mb" }));

// Request logger middleware — logs every incoming request with its timestamp, method, and path
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Serve the single-page frontend HTML
app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../fw-intel.html"));
});

// Serve the EVE item type CSV used for type-ID → name resolution (optional asset)
app.get("/invTypes.csv", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../invTypes.csv"));
});

// Simple health-check — useful for monitoring or confirming the server is up
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Maximum time the analyze() call is allowed to run before we give up and return 503.
// Large local lists make many parallel ESI + zKill requests, so 2 minutes is generous.
const ANALYZE_TIMEOUT_MS = 120_000;

/**
 * POST /analyze
 * Body: { localPaste: string, dscanPaste: string, stationPaste?: string }
 *
 * Calls analyze() and returns the AnalysisResult as JSON.
 * A 2-minute timeout is enforced — if exceeded, returns 503 with an error message.
 */
app.post("/analyze", async (req: Request, res: Response) => {
  const body = req.body as Partial<AnalyzeRequest>;

  // Validate required fields before doing any work
  if (body.localPaste === undefined || body.localPaste === null || typeof body.localPaste !== "string") {
    res.status(400).json({ error: "localPaste must be a string" });
    return;
  }

  if (!body.dscanPaste || typeof body.dscanPaste !== "string") {
    res.status(400).json({ error: "dscanPaste is required (string)" });
    return;
  }

  // Race the analysis against a hard timeout to avoid hanging requests indefinitely
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("analysis_timeout")), ANALYZE_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([
      analyze({
        localPaste: body.localPaste,
        dscanPaste: body.dscanPaste,
        stationPaste: body.stationPaste,
      }),
      timeoutPromise,
    ]);
    res.json(result);
  } catch (err: any) {
    if (err?.message === "analysis_timeout") {
      console.warn("Analysis timed out after", ANALYZE_TIMEOUT_MS, "ms");
      res.status(503).json({ error: "Analysis timed out — try with fewer pilots or a smaller d-scan angle." });
    } else {
      console.error("Analysis error:", err);
      res.status(500).json({ error: "Internal server error", detail: err?.message });
    }
  }
});

// Catch-all 404 handler for any unrecognised routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Start the server on all interfaces (0.0.0.0) so it's reachable from LAN, not just localhost
app.listen(PORT, "0.0.0.0", () => {
  console.log(`WIWIS backend listening on 0.0.0.0:${PORT}`);
});