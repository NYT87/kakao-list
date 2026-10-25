import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { credentialVault, validateSecurityConfiguration } from "./security.js";

describe("security configuration", () => {
  it("fails closed on absent, example and weak secrets", () => {
    for (const value of [
      undefined,
      "short",
      "replace_with_a_long_random_secret",
      "change-me-in-production".repeat(2),
    ])
      assert.throws(() =>
        validateSecurityConfiguration({ SYNC_SERVER_SIGNING_SECRET: value }),
      );
  });
  it("refuses production mock authentication", () => {
    assert.throws(() =>
      validateSecurityConfiguration({
        SYNC_SERVER_SIGNING_SECRET: "a".repeat(64),
        NODE_ENV: "production",
        ALLOW_MOCK_AUTH: "true",
      }),
    );
  });
  it("encrypts recoverable credentials and rejects tampering/wrong keys", () => {
    const vault = credentialVault("a".repeat(64)),
      cipher = vault.encrypt("private-access-token");
    assert.equal(cipher.includes("private-access-token"), false);
    assert.equal(vault.decrypt(cipher), "private-access-token");
    assert.throws(() => credentialVault("b".repeat(64)).decrypt(cipher));
    assert.throws(() => vault.decrypt("plaintext"));
  });
});
