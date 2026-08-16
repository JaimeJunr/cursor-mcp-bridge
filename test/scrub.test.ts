import { describe, it, expect } from "vitest";
import { scrubSecrets } from "../src/scrub.js";

describe("scrubSecrets", () => {
  it("passes normal text through unchanged", () => {
    const text = "This is a normal sentence with no secrets in it, just plain prose.";
    expect(scrubSecrets(text)).toEqual({ text, redacted: false });
  });

  it("redacts an AWS access key id", () => {
    const { text, redacted } = scrubSecrets("key: AKIAIOSFODNN7EXAMPLE");
    expect(redacted).toBe(true);
    expect(text).toBe("key: [REDACTED]");
  });

  it("redacts a GitHub personal access token", () => {
    const token = "ghp_" + "a".repeat(36);
    const { text, redacted } = scrubSecrets(`token=${token}`);
    expect(redacted).toBe(true);
    expect(text).not.toContain(token);
  });

  it("redacts an OpenAI-style secret key", () => {
    const key = "sk-" + "A1b2C3d4E5f6G7h8I9j0".repeat(2);
    const { text, redacted } = scrubSecrets(`OPENAI_API_KEY=${key}`);
    expect(redacted).toBe(true);
    expect(text).not.toContain(key);
  });

  it("redacts a bearer token", () => {
    const { text, redacted } = scrubSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
    expect(redacted).toBe(true);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("redacts a labeled generic secret", () => {
    const { text, redacted } = scrubSecrets('api_key: "abcd1234EFGH5678ijkl9012MNOP3456"');
    expect(redacted).toBe(true);
    expect(text).toContain("[REDACTED]");
  });

  it("redacts a high-entropy mixed-case alphanumeric string even without a label", () => {
    const secretLike = "aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP";
    const { text, redacted } = scrubSecrets(`random value ${secretLike} in the middle`);
    expect(redacted).toBe(true);
    expect(text).not.toContain(secretLike);
  });

  it("does not redact a plain lowercase git commit SHA (no uppercase, low entropy shape)", () => {
    const sha = "f4e117e9d81a48229b81e04e848dc6a8347d69e12345678";
    const { text, redacted } = scrubSecrets(`commit ${sha} merged`);
    expect(redacted).toBe(false);
    expect(text).toContain(sha);
  });
});
