const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const axios = require("axios");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

function isDisallowedHost(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host === "169.254.169.254" ||
      host.startsWith("169.254.")
    ) {
      return true;
    }
    return false;
  } catch (_) {
    return true;
  }
}

function sanitizeHeaders(rawHeaders = {}) {
  const blocked = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "transfer-encoding",
  ]);
  const clean = {};
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (v === undefined || v === null) continue;
    if (blocked.has(k.toLowerCase())) continue;
    clean[k] = String(v);
  }
  return clean;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Server-side HTTP proxy for browser mode (bypasses CORS for platform scrapers & tools)
app.post("/api/proxy", async (req, res) => {
  try {
    const {
      url,
      method = "GET",
      headers = {},
      data,
      params,
      responseType,
      redirect = "follow",
      timeout = 30000,
      disableSSLValidation = false,
    } = req.body || {};

    if (!url || isDisallowedHost(url)) {
      return res.status(400).json({ status: 0, error: "Invalid or disallowed URL" });
    }

    const axiosConfig = {
      url,
      method: String(method).toUpperCase(),
      headers: sanitizeHeaders(headers),
      params: params && typeof params === "object" ? params : undefined,
      data: data !== undefined ? data : undefined,
      timeout: Math.min(Math.max(Number(timeout) || 30000, 1000), 180000),
      responseType: "arraybuffer",
      maxRedirects: redirect === "manual" ? 0 : 10,
      validateStatus: () => true,
    };

    if (disableSSLValidation) {
      axiosConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }

    const upstream = await axios(axiosConfig);

    const outHeaders = {};
    for (const [k, v] of Object.entries(upstream.headers || {})) {
      if (Array.isArray(v)) {
        outHeaders[k.toLowerCase()] = k.toLowerCase() === "set-cookie" ? v.join("\n") : v.join(", ");
      } else if (v !== undefined) {
        outHeaders[k.toLowerCase()] = String(v);
      }
    }

    const buf = Buffer.isBuffer(upstream.data)
      ? upstream.data
      : Buffer.from(upstream.data || "");

    const isBinary = responseType === "arraybuffer" || responseType === "blob";
    const finalUrl = upstream.request?.res?.responseUrl || url;

    return res.json({
      status: upstream.status,
      headers: outHeaders,
      data: isBinary ? buf.toString("base64") : buf.toString("utf-8"),
      isBase64: isBinary,
      url: finalUrl,
    });
  } catch (err) {
    return res.status(502).json({
      status: 0,
      error: err?.message || "Upstream proxy request failed",
    });
  }
});

// Streaming media download proxy for browser mode
app.get("/api/download", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    const filename = String(req.query.filename || "mori_download").replace(/[\r\n"]/g, "_");
    let customHeaders = {};
    if (req.query.headers) {
      try {
        customHeaders = JSON.parse(String(req.query.headers));
      } catch (_) {}
    }

    if (!targetUrl || isDisallowedHost(String(targetUrl))) {
      return res.status(400).send("Invalid download URL");
    }

    const upstream = await axios({
      url: String(targetUrl),
      method: "GET",
      headers: sanitizeHeaders(customHeaders),
      responseType: "stream",
      timeout: 60000,
      maxRedirects: 10,
      validateStatus: () => true,
    });

    if (upstream.status >= 400) {
      return res.status(upstream.status).send("Upstream download failed");
    }

    const contentType =
      upstream.headers["content-type"] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    if (upstream.headers["content-length"]) {
      res.setHeader("Content-Length", upstream.headers["content-length"]);
    }
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );

    upstream.data.pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send(err?.message || "Download proxy error");
    }
  }
});

// Serve @zakisheriff/liquid-glass stylesheet and assets
const liquidGlassDist = path.join(
  __dirname,
  "node_modules/@zakisheriff/liquid-glass/dist",
);
app.get("/vendor/liquid-glass/styles.css", (_req, res) => {
  res.sendFile(path.join(liquidGlassDist, "index.css"));
});
app.use("/vendor/liquid-glass", express.static(liquidGlassDist));

// Serve root /assets (icons, screenshots) referenced by public/index.html
app.use("/assets", express.static(path.join(__dirname, "assets")));

// Serve landing page optionally under /landing
app.use("/landing", express.static(path.join(__dirname, "landing")));

// Serve main Mori web application from /public
app.use(express.static(path.join(__dirname, "public")));

// Fallback to public/index.html
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Mori server running at http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
