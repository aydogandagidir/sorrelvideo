import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  FinalizeUploadBody,
  FinalizeUploadResponse,
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * PUT /storage/uploads/finalize
 *
 * Stamp the per-object owner ACL after the client has PUT the file bytes to the
 * presigned URL returned by `request-url`. This is the second half of the
 * two-phase upload: the object does not exist at `request-url` time, so its ACL
 * (which `GET /storage/objects/*` enforces) can only be written here, once the
 * bytes have landed.
 *
 * The owner is always the authenticated caller — the client cannot pick an
 * owner — and visibility is forced to `private`. Without this step the object
 * has no ACL policy and is unreadable (the read route fails closed), so callers
 * MUST finalize an upload before the file can be served back.
 */
router.put("/storage/uploads/finalize", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = FinalizeUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const objectPath = await objectStorageService.trySetObjectEntityAclPolicy(
      parsed.data.objectPath,
      { owner: req.user.id, visibility: "private" },
    );

    res.json(FinalizeUploadResponse.parse({ objectPath }));
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      // The client claimed an upload that does not exist (never PUT, or a forged
      // path). Don't leak which it is.
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error finalizing upload");
    res.status(500).json({ error: "Failed to finalize upload" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        // The downloadObject helper returns a Fetch-style ReadableStream<Uint8Array>;
        // node:stream's typings expect the looser ReadableStream<any>, so widen here.
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve a private object entity from PRIVATE_OBJECT_DIR.
 *
 * These files are per-tenant private uploads, addressed by an unguessable UUID
 * path. The UUID is NOT an authorization boundary — anyone who learns the path
 * (logs, referrer headers, a leaked link) could otherwise read the object. So
 * the route is gated twice:
 *
 *   1. Authentication — `req.isAuthenticated()` (401 otherwise).
 *   2. Per-object ownership — `canAccessObjectEntity` reads the object's stored
 *      ACL policy and only returns true for the owner, a matching ACL rule, or a
 *      `public`-visibility READ. Objects with NO ACL policy fail closed (403),
 *      so a file can never be served cross-tenant just because its path leaked.
 *
 * Owner ACLs are stamped by `PUT /storage/uploads/finalize` after the client
 * has PUT the bytes to the presigned URL (see below).
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const canAccess = await objectStorageService.canAccessObjectEntity({
      userId: req.user.id,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });
    if (!canAccess) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        // The downloadObject helper returns a Fetch-style ReadableStream<Uint8Array>;
        // node:stream's typings expect the looser ReadableStream<any>, so widen here.
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
