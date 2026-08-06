// Application-layer encryption for provider credentials stored in Postgres.
// Supabase disk encryption and RLS remain useful defenses; this additional
// envelope means a database-only disclosure does not reveal usable tokens.
const PREFIX = "fp1";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(padded);
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return buffer;
}

async function key(rawKey: string): Promise<CryptoKey> {
  const bytes = fromB64url(rawKey.trim());
  if (bytes.byteLength !== 32) {
    throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function tokenIsEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

export async function encryptToken(
  value: string | null | undefined,
  rawKey = Deno.env.get("SOCIAL_TOKEN_ENCRYPTION_KEY") ?? "",
): Promise<string | null> {
  if (!value) return null;
  if (tokenIsEncrypted(value)) return value;
  if (!rawKey) throw new Error("Token encryption is not configured on the server.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, await key(rawKey), new TextEncoder().encode(value),
  );
  return `${PREFIX}.${b64url(iv)}.${b64url(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(
  value: string | null | undefined,
  rawKey = Deno.env.get("SOCIAL_TOKEN_ENCRYPTION_KEY") ?? "",
): Promise<string | null> {
  if (!value) return null;
  // Legacy plaintext rows remain readable and are encrypted on their next
  // successful OAuth connection or token refresh.
  if (!tokenIsEncrypted(value)) return value;
  if (!rawKey) throw new Error("Token encryption is not configured on the server.");
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Stored token is malformed.");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(parts[1]) },
      await key(rawKey),
      fromB64url(parts[2]),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Stored token could not be decrypted. Check the server encryption key.");
  }
}
