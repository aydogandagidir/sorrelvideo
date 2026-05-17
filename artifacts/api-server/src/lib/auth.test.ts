import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth";

describe("auth helpers — password hashing", () => {
  it("hashes a password into an Argon2id-formatted string", async () => {
    const hash = await hashPassword("supersecret123");
    // Argon2id encoded format: $argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash.length).toBeGreaterThan(50);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const a = await hashPassword("samepassword");
    const b = await hashPassword("samepassword");
    expect(a).not.toBe(b);
  });

  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(
      true,
    );
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("returns false rather than throwing for malformed hashes", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});
