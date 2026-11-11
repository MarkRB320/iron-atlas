const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const supported = new Set(["coach_setup", "coach_join", "coach_clients", "coach_assign"]);
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Cache-Control": "no-store",
};

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readOperation(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "Missing operation.");
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32768) {
      await reader.cancel();
      throw new RequestError(413, "Plan is too large.");
    }
    body += decoder.decode(value, { stream: true });
  }
  let payload;
  try { payload = JSON.parse(body + decoder.decode()); } catch { /* invalid below */ }
  const { operation, args = {} } = payload || {};
  if (!supported.has(operation) || !args || typeof args !== "object" || Array.isArray(args)) {
    throw new RequestError(400, "Invalid Coach operation.");
  }
  // Construct each RPC's arguments explicitly. Identity and subscription state are server inputs.
  if (operation === "coach_clients") return { operation, params: {} };
  if ((operation === "coach_assign" || operation === "coach_join") && !uuid.test(args.p_generation)) {
    throw new RequestError(400, "Refresh cloud consent before continuing.");
  }
  if (operation === "coach_assign") {
    if (!uuid.test(args.p_client) || !args.p_plan || typeof args.p_plan !== "object" || Array.isArray(args.p_plan)) {
      throw new RequestError(400, "Invalid plan or client.");
    }
    return { operation, params: { p_client: args.p_client, p_plan: args.p_plan, p_generation: args.p_generation } };
  }
  const name = typeof args.p_name === "string" ? args.p_name.trim() : "";
  if (name.length > 60 || (operation === "coach_setup" && !name)) throw new RequestError(400, "Enter a name of up to 60 characters.");
  if (operation === "coach_setup") return { operation, params: { p_name: name } };
  const code = typeof args.p_code === "string" ? args.p_code.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new RequestError(400, "Enter the six-character trainer code.");
  if (args.p_sharing_version !== "2026-11-02") throw new RequestError(400, "Acknowledge the current trainer sharing notice.");
  return { operation, params: { p_code: code, p_name: name, p_generation: args.p_generation, p_sharing_version: args.p_sharing_version } };
}

async function hasCoach(config, trainer, environment, fetch) {
  const url = new URL("https://api.revenuecat.com/v2/projects/" + encodeURIComponent(config.projectId) +
    "/customers/" + encodeURIComponent(trainer) + "/subscriptions");
  url.searchParams.set("environment", environment);
  url.searchParams.set("limit", "100");
  const seen = new Set();
  for (;;) {
    const response = await fetch(url, { headers: { Authorization: "Bearer " + config.revenueCatKey } });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("RevenueCat unavailable");
    const page = await response.json();
    if (page.object !== "list" || !Array.isArray(page.items)) throw new Error("Invalid subscription list");
    const paid = page.items.some(sub => sub.environment === environment && sub.gives_access === true &&
      sub.entitlements?.items?.some(ent => ent.lookup_key === config.coachEntitlement && ent.state !== "archived"));
    if (paid || !page.next_page) return paid;
    // Keep our own origin, account and environment on every page, even when next_page omits the filter.
    const cursor = page.items.at(-1)?.id;
    if (!cursor || seen.has(cursor)) throw new Error("Invalid subscription cursor");
    seen.add(cursor);
    url.searchParams.set("starting_after", cursor);
  }
}

export function createHandler(config, fetchImpl = globalThis.fetch) {
  const sandbox = new Set((config.sandboxAccounts || "").toLowerCase().split(",").map(id => id.trim()).filter(Boolean));
  return async request => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const json = (value, status) => Response.json(value, { status, headers });
    if (request.method !== "POST") return json({ message: "Use POST." }, 405);
    try {
      const auth = request.headers.get("authorization") || "";
      if (!/^Bearer [^\s]+$/i.test(auth)) throw new RequestError(401, "Sign in to use Coach.");
      if (!config.supabaseUrl || !config.publicKey || !config.serviceKey || !config.projectId || !config.revenueCatKey || !config.coachEntitlement) {
        throw new Error("Missing server configuration");
      }
      const { operation, params } = await readOperation(request);
      const signal = AbortSignal.timeout(15000);
      const fetch = (url, init) => fetchImpl(url, { ...init, signal, redirect: "error", cache: "no-store" });
      const userResponse = await fetch(config.supabaseUrl + "/auth/v1/user", {
        headers: { apikey: config.publicKey, Authorization: auth },
      });
      if ([401, 403].includes(userResponse.status)) throw new RequestError(401, "Sign in to use Coach.");
      if (!userResponse.ok) throw new Error("Auth unavailable");
      const user = await userResponse.json();
      if (!uuid.test(user.id) || user.is_anonymous === true || !user.email_confirmed_at) {
        throw new RequestError(403, "Confirm your account email to use Coach.");
      }
      const actor = user.id.toLowerCase();
      const rpc = async (name, args) => {
        const rpcHeaders = { apikey: config.serviceKey, "Content-Type": "application/json" };
        if (!config.serviceKey.startsWith("sb_secret_")) rpcHeaders.Authorization = "Bearer " + config.serviceKey;
        const res = await fetch(config.supabaseUrl + "/rest/v1/rpc/" + name, {
          method: "POST", headers: rpcHeaders, body: JSON.stringify(args),
        });
        if (!res.ok) {
          const error = await res.json().catch(() => ({}));
          if (error.code === "42501") throw new RequestError(403, "Cloud consent is unavailable or changed. Refresh before continuing.");
          if (error.code === "P0001") throw new RequestError(400, error.message);
          if (error.code === "23514") throw new RequestError(400, "Check the name or plan size and try again.");
          throw new Error("Database unavailable");
        }
        const body = await res.text();
        return body ? JSON.parse(body) : null;
      };
      if (await rpc("coach_request_allowed", { p_actor: actor }) !== true) throw new RequestError(429, "Wait a minute, then try again.");
      let trainer = actor;
      if (operation === "coach_join") {
        trainer = await rpc("coach_join_target", { p_code: params.p_code });
        if (!uuid.test(trainer) || sandbox.has(trainer) !== sandbox.has(actor)) throw new RequestError(404, "No trainer has that code.");
        params.p_trainer = trainer;
      }
      if (!await hasCoach(config, trainer, sandbox.has(trainer) ? "sandbox" : "production", fetch)) {
        throw new RequestError(403, operation === "coach_join" ? "This trainer’s Coach subscription is inactive." : "An active Coach subscription is required.");
      }
      return json(await rpc(operation + "_checked", { ...params, p_actor: actor }), 200);
    } catch (err) {
      if (err instanceof RequestError) return json({ message: err.message }, err.status);
      return json({ message: "Coach is temporarily unavailable. Please try again." }, 503);
    }
  };
}
