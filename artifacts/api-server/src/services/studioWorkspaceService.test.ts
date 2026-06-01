import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import fs from "fs/promises";
import {
  deleteFile,
  ensureWorkspace,
  listFiles,
  readFile,
  renameFile,
  resolveWorkspaceDir,
  safeResolve,
  WorkspacePathError,
  writeFile,
} from "./studioWorkspaceService";

const USER = "user-1";
const PROJECT = "42";

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(async () => {
  prevEnv = process.env.STUDIO_WORKSPACE_DIR;
  // A fresh, unique tmp dir per test keeps them isolated and parallel-safe.
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sorrel-studio-ws-"));
  process.env.STUDIO_WORKSPACE_DIR = tmpRoot;
});

afterEach(async () => {
  if (prevEnv === undefined) {
    delete process.env.STUDIO_WORKSPACE_DIR;
  } else {
    process.env.STUDIO_WORKSPACE_DIR = prevEnv;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("resolveWorkspaceDir", () => {
  it("scopes the sandbox to <root>/<userId>/<projectId>", () => {
    const dir = resolveWorkspaceDir(USER, PROJECT);
    expect(dir).toBe(path.resolve(tmpRoot, USER, PROJECT));
  });

  it("rejects a userId that tries to climb out of the root", () => {
    expect(() => resolveWorkspaceDir("../../etc", PROJECT)).toThrow(
      WorkspacePathError,
    );
  });

  it("rejects a projectId that tries to climb out of the user dir", () => {
    expect(() => resolveWorkspaceDir(USER, "../../../etc")).toThrow(
      WorkspacePathError,
    );
  });
});

describe("write/read round-trip", () => {
  it("writes then reads identical UTF-8 content", async () => {
    await writeFile(USER, PROJECT, "src/index.ts", "export const x = 1;\n");
    const read = await readFile(USER, PROJECT, "src/index.ts");
    expect(read).toBe("export const x = 1;\n");
  });

  it("overwrites an existing file", async () => {
    await writeFile(USER, PROJECT, "a.txt", "first");
    await writeFile(USER, PROJECT, "a.txt", "second");
    expect(await readFile(USER, PROJECT, "a.txt")).toBe("second");
  });

  it("creates parent directories (mkdir -p) on write", async () => {
    await writeFile(USER, PROJECT, "deep/nested/dir/file.txt", "ok");
    expect(await readFile(USER, PROJECT, "deep/nested/dir/file.txt")).toBe(
      "ok",
    );
  });

  it("returns null when reading an absent file", async () => {
    expect(await readFile(USER, PROJECT, "missing.txt")).toBeNull();
  });
});

describe("listFiles", () => {
  it("returns relative POSIX paths of all files, recursively and sorted", async () => {
    await writeFile(USER, PROJECT, "b.txt", "b");
    await writeFile(USER, PROJECT, "a.txt", "a");
    await writeFile(USER, PROJECT, "nested/dir/c.txt", "c");

    const files = await listFiles(USER, PROJECT);
    expect(files).toEqual(["a.txt", "b.txt", "nested/dir/c.txt"]);
    // POSIX separators even on Windows.
    expect(files.every((f) => !f.includes("\\"))).toBe(true);
  });

  it("returns an empty array for a workspace that does not exist", async () => {
    expect(await listFiles(USER, "does-not-exist")).toEqual([]);
  });

  it("does not leak files across projects", async () => {
    await writeFile(USER, "p1", "only-in-p1.txt", "x");
    expect(await listFiles(USER, "p2")).toEqual([]);
  });
});

describe("renameFile", () => {
  it("moves content to the new path and removes the old one", async () => {
    await writeFile(USER, PROJECT, "old.txt", "payload");
    await renameFile(USER, PROJECT, "old.txt", "renamed/new.txt");

    expect(await readFile(USER, PROJECT, "old.txt")).toBeNull();
    expect(await readFile(USER, PROJECT, "renamed/new.txt")).toBe("payload");
  });
});

describe("deleteFile", () => {
  it("removes an existing file", async () => {
    await writeFile(USER, PROJECT, "doomed.txt", "bye");
    await deleteFile(USER, PROJECT, "doomed.txt");
    expect(await readFile(USER, PROJECT, "doomed.txt")).toBeNull();
  });

  it("is a no-op for an absent file (idempotent)", async () => {
    await expect(
      deleteFile(USER, PROJECT, "never-existed.txt"),
    ).resolves.toBeUndefined();
  });
});

describe("ensureWorkspace", () => {
  const SEED = { entryFile: "composition.html", html: "<h1>seed</h1>" };

  it("seeds the entry file on first call", async () => {
    await ensureWorkspace(USER, PROJECT, SEED);
    expect(await readFile(USER, PROJECT, "composition.html")).toBe(
      "<h1>seed</h1>",
    );
  });

  it("does not overwrite an edited file on a second call", async () => {
    await ensureWorkspace(USER, PROJECT, SEED);
    // Simulate a user edit.
    await writeFile(USER, PROJECT, "composition.html", "<h1>edited</h1>");

    await ensureWorkspace(USER, PROJECT, SEED);
    expect(await readFile(USER, PROJECT, "composition.html")).toBe(
      "<h1>edited</h1>",
    );
  });

  it("creates the workspace directory if it is missing", async () => {
    await ensureWorkspace(USER, "fresh-project", SEED);
    const dir = resolveWorkspaceDir(USER, "fresh-project");
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("safeResolve traversal guard", () => {
  it("allows an in-sandbox relative path", () => {
    const root = path.resolve(tmpRoot, USER, PROJECT);
    expect(safeResolve(root, "sub/file.txt")).toBe(
      path.join(root, "sub", "file.txt"),
    );
  });

  it("allows an empty path (resolves to the root itself)", () => {
    const root = path.resolve(tmpRoot, USER, PROJECT);
    expect(safeResolve(root, "")).toBe(root);
  });

  it("rejects a relative path that escapes upward", () => {
    const root = path.resolve(tmpRoot, USER, PROJECT);
    expect(() => safeResolve(root, "../../etc")).toThrow(WorkspacePathError);
  });

  it("rejects a POSIX absolute path", () => {
    const root = path.resolve(tmpRoot, USER, PROJECT);
    expect(() => safeResolve(root, "/etc/passwd")).toThrow(WorkspacePathError);
  });

  it("attaches HTTP status 400 to the thrown error", () => {
    const root = path.resolve(tmpRoot, USER, PROJECT);
    try {
      safeResolve(root, "../escape");
      expect.unreachable("safeResolve should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspacePathError);
      expect((err as WorkspacePathError).status).toBe(400);
    }
  });
});

describe("path-traversal is rejected by every disk operation", () => {
  const TRAVERSAL = "../../etc/passwd";
  const ABSOLUTE = path.resolve(os.tmpdir(), "outside-the-sandbox.txt");

  it("readFile rejects traversal and absolute paths with status 400", async () => {
    await expect(readFile(USER, PROJECT, TRAVERSAL)).rejects.toMatchObject({
      status: 400,
    });
    await expect(readFile(USER, PROJECT, ABSOLUTE)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("writeFile rejects traversal and absolute paths with status 400", async () => {
    await expect(
      writeFile(USER, PROJECT, TRAVERSAL, "x"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      writeFile(USER, PROJECT, ABSOLUTE, "x"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("deleteFile rejects traversal and absolute paths with status 400", async () => {
    await expect(deleteFile(USER, PROJECT, TRAVERSAL)).rejects.toMatchObject({
      status: 400,
    });
    await expect(deleteFile(USER, PROJECT, ABSOLUTE)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("renameFile rejects traversal/absolute in either argument with status 400", async () => {
    await writeFile(USER, PROJECT, "safe.txt", "x");
    // Escaping source.
    await expect(
      renameFile(USER, PROJECT, TRAVERSAL, "ok.txt"),
    ).rejects.toMatchObject({ status: 400 });
    // Escaping destination.
    await expect(
      renameFile(USER, PROJECT, "safe.txt", TRAVERSAL),
    ).rejects.toMatchObject({ status: 400 });
    // Absolute destination.
    await expect(
      renameFile(USER, PROJECT, "safe.txt", ABSOLUTE),
    ).rejects.toMatchObject({ status: 400 });
  });
});
