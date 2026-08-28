// Meta's Data Deletion Callback. Meta POSTs a `signed_request` when a customer
// asks the platform to delete the data FablePeak holds for them. The HMAC
// signature is the only authentication this endpoint has, so it is verified
// before anything else and every failure returns 400 with no side effects.
import { sbDelete, sbInsert, sbSelect, sbUpdate } from "../_shared/db.ts";

/** Both Meta apps may register the same callback URL, so each configured app
 * secret is tried in turn and the one that verifies also names the platform. */
const CALLBACK_APPS: Array<{ secretEnv: string; platform: string }> = [
  { secretEnv: "META_APP_SECRET", platform: "facebook" },
  { secretEnv: "INSTAGRAM_APP_SECRET", platform: "instagram" },
];

type Dependencies = {
  env: (key: string) => string | undefined;
  listConnections: typeof sbSelect;
  deleteConnections: typeof sbDelete;
  updateConnections: typeof sbUpdate;
  recordRequest: typeof sbInsert;
  confirmationCode: () => string;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Compare in time independent of how many leading bytes already match, so a
 * caller cannot search for a valid signature one byte at a time. */
function signaturesMatch(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Returns the signed payload when `secret` produced this signature, else null.
 * The signature covers the base64url payload exactly as it arrived, so the raw
 * segment — not a re-encoding of the parsed JSON — is what gets signed. */
export async function verifySignedRequest(
  signedRequest: string,
  secret: string,
): Promise<{ user_id: string } | null> {
  const [encodedSignature, encodedPayload, extra] = signedRequest.split(".");
  if (!encodedSignature || !encodedPayload || extra !== undefined) return null;
  let signature: Uint8Array;
  let payload: Record<string, unknown>;
  try {
    signature = fromBase64Url(encodedSignature);
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload)));
  } catch {
    return null;
  }
  if (String(payload?.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(encodedPayload),
  ));
  if (!signaturesMatch(signature, expected)) return null;
  const userId = String(payload.user_id ?? "");
  return userId ? { user_id: userId } : null;
}

/** Meta form-encodes the callback, but accept a JSON body or a query parameter
 * so a provider console "test" request is not misreported as tampering. */
async function readSignedRequest(req: Request): Promise<string> {
  const fromQuery = new URL(req.url).searchParams.get("signed_request");
  if (fromQuery) return fromQuery;
  const body = await req.text().catch(() => "");
  if (!body) return "";
  const fromForm = new URLSearchParams(body).get("signed_request");
  if (fromForm) return fromForm;
  try {
    return String(JSON.parse(body).signed_request ?? "");
  } catch {
    return "";
  }
}

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    env: key => Deno.env.get(key),
    listConnections: sbSelect,
    deleteConnections: sbDelete,
    updateConnections: sbUpdate,
    recordRequest: sbInsert,
    confirmationCode: () => Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map(byte => byte.toString(16).padStart(2, "0")).join(""),
    ...overrides,
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    const apps = CALLBACK_APPS
      .map(app => ({ platform: app.platform, secret: dependencies.env(app.secretEnv) }))
      .filter((app): app is { platform: string; secret: string } => !!app.secret);
    // Without a secret nothing can be verified. Reporting that honestly is the
    // only safe answer; a 200 here would confirm deletions that never happened.
    if (!apps.length) return json({ error: "deletion callback is not configured" }, 503);

    const signedRequest = await readSignedRequest(req);
    if (!signedRequest) return json({ error: "invalid signed_request" }, 400);

    let verified: { platform: string; user_id: string } | null = null;
    for (const app of apps) {
      const payload = await verifySignedRequest(signedRequest, app.secret);
      if (payload) {
        verified = { platform: app.platform, user_id: payload.user_id };
        break;
      }
    }
    if (!verified) return json({ error: "invalid signed_request" }, 400);

    try {
      // Conservative match: only identifiers the verifying app actually scopes.
      // An Instagram callback id is the stored Instagram account id. A Facebook
      // callback carries the authorizing person's app-scoped user id, which is
      // never a Page id, so Facebook also matches the ASID captured on the
      // connection at connect and at token renewal. Rows written before that
      // capture hold no ASID and still take the documented manual path.
      const identifier = encodeURIComponent(verified.user_id);
      const platform = encodeURIComponent(verified.platform);
      // Two single-column filters instead of one PostgREST `or=` list: each
      // value is then percent-encoded whole, leaving no quoting rule to get
      // wrong on an endpoint anyone can POST to.
      const filters = [`platform=eq.${platform}&external_id=eq.${identifier}`];
      if (verified.platform === "facebook") {
        filters.push(`platform=eq.facebook&meta->>asid=eq.${identifier}`);
      }

      const matched: Array<Record<string, any>> = [];
      for (const filter of filters) {
        const rows = await dependencies.listConnections(
          "social_connections", `select=id,brand_id,platform,is_default&${filter}`);
        if (!rows.length) continue;
        await dependencies.deleteConnections("social_connections", filter);
        for (const row of rows) {
          if (!matched.some(seen => seen.id === row.id)) matched.push(row);
        }
      }
      // Mirror disconnect_account: a workspace with another authorized
      // profile for this platform keeps a selected publishing account.
      for (const removed of matched.filter(row => row.is_default)) {
        const remaining = await dependencies.listConnections("social_connections",
          `select=id&brand_id=eq.${encodeURIComponent(removed.brand_id)}` +
          `&platform=eq.${encodeURIComponent(removed.platform)}` +
          `&status=eq.active&order=connected_at.asc&limit=1`);
        if (remaining[0]) {
          await dependencies.updateConnections("social_connections",
            `id=eq.${encodeURIComponent(remaining[0].id)}`, { is_default: true });
        }
      }

      const confirmationCode = dependencies.confirmationCode();
      await dependencies.recordRequest("provider_deletion_requests", {
        provider_user_id: verified.user_id,
        platform: verified.platform,
        status: matched.length ? "completed" : "no_matching_connection",
        confirmation_code: confirmationCode,
      });

      const origin = (dependencies.env("APP_ORIGIN") ?? "https://fablepeak.com")
        .replace(/\/+$/, "");
      return json({
        url: `${origin}/data-deletion.html?code=${encodeURIComponent(confirmationCode)}`,
        confirmation_code: confirmationCode,
      });
    } catch (error) {
      return json({ error: String((error as Error).message ?? error).slice(0, 500) }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());
