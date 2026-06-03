import { describe, expect, it } from "vitest";
import type { File } from "@google-cloud/storage";
import request from "supertest";
import app from "../app";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  ObjectPermission,
  setObjectAclPolicy,
  type ObjectAclPolicy,
} from "../lib/objectAcl";

const OWNER = "user-owner";
const STRANGER = "user-stranger";

/**
 * Build a minimal stand-in for a GCS `File` whose `getMetadata()` returns the
 * given ACL policy under the `custom:aclPolicy` key — the exact shape
 * `getObjectAclPolicy` reads. `exists()` is stubbed so `setObjectAclPolicy`'s
 * existence guard passes in the owner-stamping test.
 */
function fakeFile(policy: ObjectAclPolicy | null): File {
  const metadata = policy
    ? { metadata: { "custom:aclPolicy": JSON.stringify(policy) } }
    : { metadata: {} };
  return {
    name: "uploads/abc-123",
    exists: async () => [true],
    getMetadata: async () => [metadata],
    setMetadata: async () => undefined,
  } as unknown as File;
}

// The route-level auth gate is exercised against the real `app` (mirrors
// projects.test.ts / websiteToVideo.test.ts): without a DB-backed session the
// request hits the unauthenticated path. Forging a cross-tenant session needs a
// DB, so the *ownership* decision the route delegates to is asserted directly
// against the ACL service instead — together they prove the IDOR is closed:
// 401 for no session, 403 for a non-owner, file served only for the owner.
describe("GET /api/storage/objects/* — auth gate", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app).get("/api/storage/objects/uploads/abc-123");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects an unauthenticated request before touching storage", async () => {
    // A deeply-nested / odd path still 401s — the gate runs first, so a leaked
    // object path is never resolved without a session.
    const res = await request(app).get(
      "/api/storage/objects/uploads/a/b/c/d.png",
    );
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/storage/uploads/finalize — auth gate", () => {
  it("returns 401 when no session is present", async () => {
    const res = await request(app)
      .put("/api/storage/uploads/finalize")
      .send({ objectPath: "/objects/uploads/abc-123" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 before validating the body (auth gate is first)", async () => {
    const res = await request(app)
      .put("/api/storage/uploads/finalize")
      .send({});
    expect(res.status).toBe(401);
  });
});

describe("ObjectStorageService.canAccessObjectEntity — ownership", () => {
  const svc = new ObjectStorageService();

  it("denies READ when the object has no ACL policy (fail closed)", async () => {
    const allowed = await svc.canAccessObjectEntity({
      userId: STRANGER,
      objectFile: fakeFile(null),
      requestedPermission: ObjectPermission.READ,
    });
    expect(allowed).toBe(false);
  });

  it("denies READ to a non-owner of a private object (cross-tenant → 403)", async () => {
    const allowed = await svc.canAccessObjectEntity({
      userId: STRANGER,
      objectFile: fakeFile({ owner: OWNER, visibility: "private" }),
      requestedPermission: ObjectPermission.READ,
    });
    expect(allowed).toBe(false);
  });

  it("denies READ when the request is unauthenticated (no userId)", async () => {
    const allowed = await svc.canAccessObjectEntity({
      objectFile: fakeFile({ owner: OWNER, visibility: "private" }),
      requestedPermission: ObjectPermission.READ,
    });
    expect(allowed).toBe(false);
  });

  it("allows READ to the owner of a private object", async () => {
    const allowed = await svc.canAccessObjectEntity({
      userId: OWNER,
      objectFile: fakeFile({ owner: OWNER, visibility: "private" }),
      requestedPermission: ObjectPermission.READ,
    });
    expect(allowed).toBe(true);
  });
});

describe("ObjectStorageService finalize — owner ACL is stamped private", () => {
  it("writes an owner-scoped private policy to the object metadata", async () => {
    let written: ObjectAclPolicy | undefined;
    const file = {
      name: "uploads/abc-123",
      exists: async () => [true],
      setMetadata: async (meta: {
        metadata: Record<string, string>;
      }) => {
        written = JSON.parse(meta.metadata["custom:aclPolicy"]);
      },
    } as unknown as File;

    await setObjectAclPolicy(file, { owner: OWNER, visibility: "private" });

    expect(written).toEqual({ owner: OWNER, visibility: "private" });
  });
});
