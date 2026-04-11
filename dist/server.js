"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const analyzer_1 = require("./analyzer");
const app = (0, express_1.default)();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
// ── Middleware ───────────────────────────────────────────────────────────────
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "1mb" }));
// Simple request logger
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});
// ── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
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
app.post("/analyze", async (req, res) => {
    const body = req.body;
    if (!body.localPaste || typeof body.localPaste !== "string") {
        res.status(400).json({ error: "localPaste is required (string)" });
        return;
    }
    if (!body.dscanPaste || typeof body.dscanPaste !== "string") {
        res.status(400).json({ error: "dscanPaste is required (string)" });
        return;
    }
    try {
        const result = await (0, analyzer_1.analyze)({
            localPaste: body.localPaste,
            dscanPaste: body.dscanPaste,
            stationPaste: body.stationPaste,
        });
        res.json(result);
    }
    catch (err) {
        console.error("Analysis error:", err);
        res.status(500).json({ error: "Internal server error", detail: err?.message });
    }
});
// ── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
});
// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`WIWIS backend listening on http://localhost:${PORT}`);
    console.log("Endpoints:");
    console.log("  GET  /health");
    console.log("  POST /analyze");
});
exports.default = app;
