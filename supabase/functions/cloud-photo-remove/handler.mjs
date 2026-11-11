const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Cache-Control": "no-store",
};

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 131072) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); } catch { return null; }
}

// Names and images are deliberately excluded from responses and logs.
export function createHandler(config, fetchImpl = globalThis.fetch) {
  return async request => {
    const json = (value, status) => Response.json(value, { status, headers });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ message: "Use POST." }, 405);
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer [^\s]+$/i.test(authorization)) return json({ message: "Sign in to remove cloud photos." }, 401);
    try {
      const body = await readBody(request);
      if (!body || (body.generation !== null && !uuid.test(body.generation)) || !Array.isArray(body.names)
        || !["photo", "withdrawal", "account", "resume"].includes(body.purpose)
        || body.names.length > 100 || body.names.some(name => typeof name !== "string" || name.length > 1024)) {
        return json({ message: "Invalid photo removal request." }, 400);
      }
      if (!config.supabaseUrl || !config.publicKey || !config.serviceKey) throw new Error("Configuration unavailable");
      const signal = AbortSignal.timeout(15000);
      const fetch = (path, init) => fetchImpl(config.supabaseUrl + path, { ...init, signal, redirect: "error", cache: "no-store" });
      const userHeaders = { apikey: config.publicKey, Authorization: authorization, "Content-Type": "application/json" };
      const userResponse = await fetch("/auth/v1/user", { headers: userHeaders });
      if ([401, 403].includes(userResponse.status)) return json({ message: "Sign in to remove cloud photos." }, 401);
      if (!userResponse.ok) throw new Error("Authentication unavailable");
      const user = await userResponse.json();
      if (!uuid.test(user.id)) return json({ message: "Sign in to remove cloud photos." }, 401);
      const prefix = user.id.toLowerCase() + "/";
      if (body.names.some(name => !name.startsWith(prefix) || /(^|\/)\.{1,2}(\/|$)|\\|[\u0000-\u001f]/.test(name))) {
        return json({ message: "Invalid photo removal request." }, 400);
      }
      const serviceHeaders = { apikey: config.serviceKey, "Content-Type": "application/json" };
      if (!config.serviceKey.startsWith("sb_secret_")) serviceHeaders.Authorization = "Bearer " + config.serviceKey;
      let count = 0;
      // Resume an interrupted operation before the requested one. A bounded retry leaves its intent durable.
      for (let attempt = 0; attempt < 3; attempt++) {
        const authorized = await fetch("/rest/v1/rpc/authorize_photo_removal", {
          method: "POST", headers: userHeaders,
          body: JSON.stringify({ p_generation: body.generation, p_purpose: body.purpose, p_names: body.names }),
        });
        if (!authorized.ok) {
          const error = await authorized.json().catch(() => ({}));
          if (error.code === "42501") return json({ message: "Account or backup setting changed. Start this action again." }, 403);
          if (error.code === "P0001") return json({ message: "Invalid photo removal request." }, 400);
          throw new Error("Authorization unavailable");
        }
        const { operation, names } = await authorized.json();
        if (!Array.isArray(names) || names.length > 100 || names.some(name => typeof name !== "string" || !name.startsWith(prefix)
          || /(^|\/)\.{1,2}(\/|$)|\\|[\u0000-\u001f]/.test(name))) throw new Error("Invalid authorization response");
        if (operation === null && names.length === 0) return json({ removed: count }, 200);
        if (!uuid.test(operation) || names.length === 0) throw new Error("Invalid removal operation");
        const removed = await fetch("/storage/v1/object/progress-photos", {
          method: "DELETE", headers: serviceHeaders, body: JSON.stringify({ prefixes: names }),
        });
        if (!removed.ok) throw new Error("Photo removal incomplete");
        const completed = await fetch("/rest/v1/rpc/complete_photo_removal", {
          method: "POST", headers: serviceHeaders, body: JSON.stringify({ p_actor: user.id, p_operation: operation }),
        });
        if (!completed.ok) throw new Error("Photo completion unavailable");
        count += names.length;
      }
      throw new Error("More photo removal work remains");
    } catch {
      return json({ message: "Cloud photo removal is incomplete. Please retry." }, 503);
    }
  };
}
