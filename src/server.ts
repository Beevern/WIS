import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import { analyze } from "./analyzer";
import { AnalyzeRequest } from "./types";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../fw-intel.html"));
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/analyze", async (req: Request, res: Response) => {
  const body = req.body as Partial<AnalyzeRequest>;

  if (body.localPaste === undefined || body.localPaste === null || typeof body.localPaste !== "string") {
    res.status(400).json({ error: "localPaste must be a string" });
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

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WIWIS backend listening on 0.0.0.0:${PORT}`);
});