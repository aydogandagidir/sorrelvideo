import { afterEach, describe, expect, it } from "vitest";
import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";

const ORIG_PUBLIC = process.env.PUBLIC_OBJECT_SEARCH_PATHS;
const ORIG_PRIVATE = process.env.PRIVATE_OBJECT_DIR;

afterEach(() => {
  if (ORIG_PUBLIC === undefined) delete process.env.PUBLIC_OBJECT_SEARCH_PATHS;
  else process.env.PUBLIC_OBJECT_SEARCH_PATHS = ORIG_PUBLIC;
  if (ORIG_PRIVATE === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = ORIG_PRIVATE;
});

describe("ObjectStorageService — path validation", () => {
  const svc = new ObjectStorageService();

  it("rejects paths that do not begin with /objects/", async () => {
    await expect(svc.getObjectEntityFile("/random/x")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("normalizes a GCS storage.googleapis.com URL into an /objects/ path", () => {
    process.env.PRIVATE_OBJECT_DIR = "/sorrel-private/uploads";
    const normalized = svc.normalizeObjectEntityPath(
      "https://storage.googleapis.com/sorrel-private/uploads/abc-123",
    );
    expect(normalized).toBe("/objects/abc-123");
  });

  it("returns non-GCS paths unchanged", () => {
    const out = svc.normalizeObjectEntityPath("/objects/already-normalized");
    expect(out).toBe("/objects/already-normalized");
  });
});

describe("ObjectStorageService — search path config", () => {
  it("throws a configuration error when PUBLIC_OBJECT_SEARCH_PATHS is missing", () => {
    const svc = new ObjectStorageService();
    delete process.env.PUBLIC_OBJECT_SEARCH_PATHS;
    expect(() => svc.getPublicObjectSearchPaths()).toThrow(
      /PUBLIC_OBJECT_SEARCH_PATHS/,
    );
  });

  it("parses a comma-separated list of paths", () => {
    process.env.PUBLIC_OBJECT_SEARCH_PATHS = "/a, /b ,/c";
    const svc = new ObjectStorageService();
    expect(svc.getPublicObjectSearchPaths()).toEqual(["/a", "/b", "/c"]);
  });
});
