import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { analyze } from "./analyzer";
import { AnalyzeRequest } from "./types";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Simple request logger
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * POST /analyze
 *
 * Body: AnalyzeRequest
 * {
 *   localPaste: string,   // one pilot name per line
 *   dscanPaste: string,   // TSV from Eve d-scan window
 *   stationPaste?: string // optional: station guests list
 * }
 *
 * Returns: AnalysisResult
 */
app.post("/analyze", async (req: Request, res: Response) => {
  const body = req.body as Partial<AnalyzeRequest>;

  if (!body.localPaste || typeof body.localPaste !== "string") {
    res.status(400).json({ error: "localPaste is required (string)" });
    return;
  }
  if (!body.dscanPaste || typeof body.dscanPaste !== "string") {
    res.status(400).json({ error: "dscanPaste is required (string)" });
    return;
  }

  try {
    const result = await analyze({
      localPaste: body.localPaste,
      dscanPaste: body.dscanPaste,
      stationPaste: body.stationPaste,
    });
    res.json(result);
  } catch (err: any) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: "Internal server error", detail: err?.message });
  }
});

// ── 404 fallback ─────────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`WIWIS backend listening on http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  POST /analyze");
});

export default app;
