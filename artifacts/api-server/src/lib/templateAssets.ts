/**
 * Serve a vendored template asset (image/audio) to the preview iframe. Shared
 * by the template and project asset routes so the allow-list + MIME map + stream
 * logic live in ONE place.
 *
 * SECURITY: `:name` is matched EXACTLY against the manifest's declared asset
 * names for the module (`assetsForModule`) — it is never used to build a path
 * until it has passed that membership check, so a traversal payload
 * (`..%2f..%2fsecret`) can't escape the asset dir. Mirrors the thumbnails route.
 */
import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";
import { COMPOSITIONS_DIR } from "../services/renderService";
import { assetsForModule } from "../services/registryTemplates";

const ASSET_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

/**
 * Stream `compositions/assets/<module>/<name>` if `name` is a declared asset of
 * `module`, else 404. Brand-neutral + committed, so cacheable. Uses a read
 * stream (NOT res.sendFile) — Express 5's send() rejects absolute paths with
 * spaces (this repo lives under ".../Artificial Inteligence/..."), the same
 * workaround as the video + thumbnail routes.
 */
export function serveTemplateAsset(
  res: Response,
  module: string,
  name: string,
): void {
  const allowed = new Set(assetsForModule(module));
  if (!allowed.has(name)) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  const filePath = path.join(COMPOSITIONS_DIR, "assets", module, name);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.setHeader(
    "Content-Type",
    ASSET_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
  );
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(filePath).pipe(res);
}
