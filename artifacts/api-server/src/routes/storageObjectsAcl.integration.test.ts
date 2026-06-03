import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createSession } from "../lib/auth";
import { ObjectPermission, type ObjectAclPolicy } from "../lib/objectAcl";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * Integration coverage for GET /api/storage/objects/* — the private-object read
 * route — driven END-TO-END through the real app with a real DB-backed session,
 * proving the IDOR is closed at the HTTP boundary:
 *
 *   1. unauthenticated         → 401 (the gate runs before any storage call);
 *   2. authenticated non-owner → 403 (canAccessObjectEntity denies a private
 *      object whose ACL owner is someone else, AND fail-closes a no-ACL object);
 *   3. owner                   → 200 and the bytes stream back.
 *
 * The unit-level storage.test.ts already asserts `canAccessObjectEntity` in
 * isolation; this file proves the ROUTE actually consults it and maps its
 * boolean to 200/403 — i.e. that the auth/ownership BRANCH is wired, not just
 * the predicate.
 *
 * GCS IS NOT EXERCISED. A real bucket is impractical (and out of scope — the
 * task is "assert the gate, not GCS"), so `../lib/objectStorage` is mocked: the
 * fake `ObjectStorageService` resolves an in-memory "object" by path, runs the
 * REAL `canAccessObject` ACL logic against a test-controlled policy (so the
 * route's `ObjectPermission.READ` argument and fail-closed semantics are genuine),
 * and streams a known body for `downloadObject`. The route handler — auth gate,
 * ownership branch, 404 mapping, and the stream pipe — is the real code.
 */

const STREAM_BODY = "private-object-bytes";

// A single in-memory object keyed by its storage path; the test sets its ACL.
const h = vi.hoisted(() => ({
  acl: null as ObjectAclPolicy | null,
  exists: true,
}));

vi.mock("../lib/objectStorage", async (importActual) => {
  const actual = await importActual<typeof import("../lib/objectStorage")>();
  const { canAccessObject } = await import("../lib/objectAcl");

  // Minimal File stand-in: getObjectAclPolicy (used by the real canAccessObject)
  // reads `metadata.metadata["custom:aclPolicy"]`.
  const fakeFile = () =>
    ({
      name: "uploads/abc-123",
      getMetadata: async () => [
        h.acl
          ? { metadata: { "custom:aclPolicy": JSON.stringify(h.acl) } }
          : { metadata: {} },
      ],
    }) as unknown as import("@google-cloud/storage").File;

  class FakeObjectStorageService {
    async getObjectEntityFile(objectPath: string) {
      if (!objectPath.startsWith("/objects/") || !h.exists) {
        throw new actual.ObjectNotFoundError();
      }
      return fakeFile();
    }

    // Delegate to the REAL ACL evaluator so the route's gate is genuinely tested
    // (owner-only for private, fail-closed when no policy).
    async canAccessObjectEntity({
      userId,
      objectFile,
      requestedPermission,
    }: {
      userId?: string;
      objectFile: import("@google-cloud/storage").File;
      requestedPermission?: ObjectPermission;
    }) {
      return canAccessObject({
        userId,
        objectFile,
        requestedPermission: requestedPermission ?? ObjectPermission.READ,
      });
    }

    async downloadObject() {
      return new Response(STREAM_BODY, {
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  return {
    ...actual,
    ObjectStorageService: FakeObjectStorageService,
  };
});

// Imported AFTER the mock so the storage router constructs the fake service.
const app = (await import("../app")).default;

const OBJECT_URL = "/api/storage/objects/uploads/abc-123";

beforeEach(async () => {
  await truncateAll();
  h.acl = null;
  h.exists = true;
});

describe.runIf(INTEGRATION_AVAILABLE)("GET /api/storage/objects/*", () => {
  it("401s an unauthenticated request before touching storage", async () => {
    const res = await request(app).get(OBJECT_URL);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403s an authenticated NON-owner of a private object", async () => {
    const ownerId = await createFreeUser();
    const strangerId = await createFreeUser();
    const sid = await createSession({ userId: strangerId });
    h.acl = { owner: ownerId, visibility: "private" };

    const res = await request(app)
      .get(OBJECT_URL)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("403s when the object has NO ACL policy (fail closed)", async () => {
    const userId = await createFreeUser();
    const sid = await createSession({ userId });
    h.acl = null; // no policy stamped

    const res = await request(app)
      .get(OBJECT_URL)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("streams the bytes to the OWNER of a private object (200)", async () => {
    const ownerId = await createFreeUser();
    const sid = await createSession({ userId: ownerId });
    h.acl = { owner: ownerId, visibility: "private" };

    const res = await request(app)
      .get(OBJECT_URL)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe(STREAM_BODY);
  });

  it("404s the owner when the object does not exist (after passing auth)", async () => {
    const ownerId = await createFreeUser();
    const sid = await createSession({ userId: ownerId });
    h.exists = false;

    const res = await request(app)
      .get(OBJECT_URL)
      .set("Authorization", `Bearer ${sid}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Object not found" });
  });
});
