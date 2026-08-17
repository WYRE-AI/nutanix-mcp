import { describe, expect, it } from "vitest";
import {
  credentialsToChildEnv,
  hashCredentials,
  resolveCredentials,
} from "../credentials.js";

function headers(map: Record<string, string>) {
  return (name: string) => map[name];
}

describe("resolveCredentials", () => {
  it("rejects when X-Nutanix-Pc-Host is missing", () => {
    const { creds, error } = resolveCredentials(headers({ "x-nutanix-pc-api-key": "k" }));
    expect(creds).toBeUndefined();
    expect(error).toContain("X-Nutanix-Pc-Host");
  });

  it("rejects host without any auth", () => {
    const { creds, error } = resolveCredentials(headers({ "x-nutanix-pc-host": "pc.example.com" }));
    expect(creds).toBeUndefined();
    expect(error).toContain("X-Nutanix-Pc-Api-Key");
  });

  it("rejects username without password", () => {
    const { error } = resolveCredentials(
      headers({ "x-nutanix-pc-host": "pc.example.com", "x-nutanix-pc-username": "admin" }),
    );
    expect(error).toBeDefined();
  });

  it("rejects password without username", () => {
    const { error } = resolveCredentials(
      headers({ "x-nutanix-pc-host": "pc.example.com", "x-nutanix-pc-password": "s3cret" }),
    );
    expect(error).toBeDefined();
  });

  it("accepts host + api key", () => {
    const { creds, error } = resolveCredentials(
      headers({ "x-nutanix-pc-host": "pc.example.com", "x-nutanix-pc-api-key": "k" }),
    );
    expect(error).toBeUndefined();
    expect(creds).toEqual({ pcHost: "pc.example.com", pcApiKey: "k" });
  });

  it("accepts host + username + password", () => {
    const { creds, error } = resolveCredentials(
      headers({
        "x-nutanix-pc-host": "pc.example.com",
        "x-nutanix-pc-username": "admin",
        "x-nutanix-pc-password": "s3cret",
      }),
    );
    expect(error).toBeUndefined();
    expect(creds).toEqual({ pcHost: "pc.example.com", pcUsername: "admin", pcPassword: "s3cret" });
  });

  it("carries optional port and insecure flags through", () => {
    const { creds } = resolveCredentials(
      headers({
        "x-nutanix-pc-host": "pc.example.com",
        "x-nutanix-pc-api-key": "k",
        "x-nutanix-pc-port": "9441",
        "x-nutanix-pc-insecure": "true",
      }),
    );
    expect(creds).toEqual({
      pcHost: "pc.example.com",
      pcApiKey: "k",
      pcPort: "9441",
      pcInsecure: "true",
    });
  });

  it("treats blank header values as missing", () => {
    const { error } = resolveCredentials(
      headers({ "x-nutanix-pc-host": "  ", "x-nutanix-pc-api-key": "k" }),
    );
    expect(error).toBeDefined();
  });
});

describe("credentialsToChildEnv", () => {
  it("maps the full credential tuple onto the upstream PC_* env vars", () => {
    expect(
      credentialsToChildEnv({
        pcHost: "pc.example.com",
        pcPort: "9441",
        pcUsername: "admin",
        pcPassword: "s3cret",
        pcApiKey: "k",
        pcInsecure: "false",
      }),
    ).toEqual({
      PC_HOST: "pc.example.com",
      PC_PORT: "9441",
      PC_USERNAME: "admin",
      PC_PASSWORD: "s3cret",
      PC_API_KEY: "k",
      PC_INSECURE: "false",
      READ_ONLY_MODE: "true",
    });
  });

  it("omits unset optionals and ALWAYS forces READ_ONLY_MODE=true", () => {
    expect(credentialsToChildEnv({ pcHost: "pc.example.com", pcApiKey: "k" })).toEqual({
      PC_HOST: "pc.example.com",
      PC_API_KEY: "k",
      READ_ONLY_MODE: "true",
    });
  });
});

describe("hashCredentials", () => {
  it("is stable for the same tuple and distinct across tenants", () => {
    const a = { pcHost: "pc.example.com", pcApiKey: "k1" };
    const b = { pcHost: "pc.example.com", pcApiKey: "k2" };
    expect(hashCredentials(a)).toBe(hashCredentials({ ...a }));
    expect(hashCredentials(a)).not.toBe(hashCredentials(b));
    expect(hashCredentials(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not collide when values shift between fields", () => {
    expect(
      hashCredentials({ pcHost: "a", pcUsername: "bc", pcPassword: "p" }),
    ).not.toBe(hashCredentials({ pcHost: "ab", pcUsername: "c", pcPassword: "p" }));
  });
});
