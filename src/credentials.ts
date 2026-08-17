/**
 * Gateway credential contract for the Nutanix Prism Central bridge.
 *
 * The conduit gateway forwards per-tenant Prism Central credentials as HTTP
 * headers on every /mcp request. This module maps those headers onto the
 * environment variables the upstream nutanix/ntnx-api-mcp-server child
 * process reads, and enforces the validity rule the gateway relies on.
 *
 * Contract (must match conduit's vendor-config EXACTLY):
 *   X-Nutanix-Pc-Host     -> PC_HOST      (required)
 *   X-Nutanix-Pc-Port     -> PC_PORT      (optional, upstream default 9440)
 *   X-Nutanix-Pc-Username -> PC_USERNAME  \  required together, unless
 *   X-Nutanix-Pc-Password -> PC_PASSWORD  /  an API key is supplied
 *   X-Nutanix-Pc-Api-Key  -> PC_API_KEY   (alternative to username/password)
 *   X-Nutanix-Pc-Insecure -> PC_INSECURE  (optional, "true"/"false")
 *
 * Valid = pcHost present AND (apiKey present OR username+password present).
 */
import { createHash } from "node:crypto";

/** Exact gateway header names (lowercased by Node/fetch on receipt). */
export const GATEWAY_HEADERS = [
  "X-Nutanix-Pc-Host",
  "X-Nutanix-Pc-Port",
  "X-Nutanix-Pc-Username",
  "X-Nutanix-Pc-Password",
  "X-Nutanix-Pc-Api-Key",
  "X-Nutanix-Pc-Insecure",
] as const;

export interface NutanixCredentials {
  pcHost: string;
  pcPort?: string;
  pcUsername?: string;
  pcPassword?: string;
  pcApiKey?: string;
  pcInsecure?: string;
}

/**
 * Resolve per-request credentials from a (lowercase-name) header accessor.
 * Returns `{ creds }` on success or `{ error }` naming what is missing.
 */
export function resolveCredentials(
  getHeader: (lowerName: string) => string | undefined,
): { creds?: NutanixCredentials; error?: string } {
  const pcHost = getHeader("x-nutanix-pc-host")?.trim();
  const pcPort = getHeader("x-nutanix-pc-port")?.trim();
  const pcUsername = getHeader("x-nutanix-pc-username")?.trim();
  const pcPassword = getHeader("x-nutanix-pc-password")?.trim();
  const pcApiKey = getHeader("x-nutanix-pc-api-key")?.trim();
  const pcInsecure = getHeader("x-nutanix-pc-insecure")?.trim();

  if (!pcHost) {
    return { error: "Missing required header X-Nutanix-Pc-Host." };
  }
  if (!pcApiKey && !(pcUsername && pcPassword)) {
    return {
      error:
        "Missing Prism Central auth: send X-Nutanix-Pc-Api-Key, or both " +
        "X-Nutanix-Pc-Username and X-Nutanix-Pc-Password.",
    };
  }

  return {
    creds: {
      pcHost,
      ...(pcPort ? { pcPort } : {}),
      ...(pcUsername ? { pcUsername } : {}),
      ...(pcPassword ? { pcPassword } : {}),
      ...(pcApiKey ? { pcApiKey } : {}),
      ...(pcInsecure ? { pcInsecure } : {}),
    },
  };
}

/**
 * Environment variables for the upstream child process.
 *
 * READ_ONLY_MODE is ALWAYS forced to "true": v1 of this bridge ships
 * read-only (the upstream rejects all non-GET operations before they reach
 * Prism Central). This is a deliberate fleet decision, not an upstream
 * accident — see README/CHANGELOG before changing it.
 */
export function credentialsToChildEnv(creds: NutanixCredentials): Record<string, string> {
  return {
    PC_HOST: creds.pcHost,
    ...(creds.pcPort ? { PC_PORT: creds.pcPort } : {}),
    ...(creds.pcUsername ? { PC_USERNAME: creds.pcUsername } : {}),
    ...(creds.pcPassword ? { PC_PASSWORD: creds.pcPassword } : {}),
    ...(creds.pcApiKey ? { PC_API_KEY: creds.pcApiKey } : {}),
    ...(creds.pcInsecure ? { PC_INSECURE: creds.pcInsecure } : {}),
    READ_ONLY_MODE: "true",
  };
}

/** Stable pool key for a credential tuple. */
export function hashCredentials(creds: NutanixCredentials): string {
  const tuple = [
    creds.pcHost,
    creds.pcPort ?? "",
    creds.pcUsername ?? "",
    creds.pcPassword ?? "",
    creds.pcApiKey ?? "",
    creds.pcInsecure ?? "",
  ].join("\0");
  return createHash("sha256").update(tuple).digest("hex").slice(0, 16);
}
