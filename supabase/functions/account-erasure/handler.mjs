const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const anonymousCustomer = /^\$RCAnonymousID:[0-9a-f]{32}$/;

async function invocationHash(header) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header);
  if (!match) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function retryDelay(response) {
  const value = response.headers.get("retry-after");
  const seconds = /^\d+$/.test(value || "") ? Number(value) : (Date.parse(value || "") - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(5, Math.min(86400, Math.ceil(seconds))) : 300;
}

// Only processes previously requested account erasures. No customer identifier is logged or returned.
export function createHandler(config, fetchImpl = globalThis.fetch) {
  return async request => {
    const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    const tokenHash = await invocationHash(request.headers.get("authorization") || "");
    if (!tokenHash) return reply({ message: "Unauthorized" }, 401);
    if (request.method !== "POST") return reply({ message: "Use POST" }, 405);
    if (!config.supabaseUrl || !config.serviceKey || !/^proj[a-z0-9]+$/i.test(config.projectId || "")
      || !config.revenueCatKey) return reply({ message: "Erasure service unavailable" }, 503);

    const serviceHeaders = { apikey: config.serviceKey, "Content-Type": "application/json" };
    if (!config.serviceKey.startsWith("sb_secret_")) serviceHeaders.Authorization = "Bearer " + config.serviceKey;
    const rcBase = "https://api.revenuecat.com/v2/projects/" + encodeURIComponent(config.projectId);
    const rcHeaders = { Authorization: "Bearer " + config.revenueCatKey };
    const send = (url, options) => fetchImpl(url, {
      ...options, signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store",
    });
    async function rpc(name, args) {
      const response = await send(config.supabaseUrl + "/rest/v1/rpc/" + name, {
        method: "POST", headers: serviceHeaders, body: JSON.stringify(args),
      });
      if (!response.ok) throw new Error("Queue operation unavailable");
      return response.json();
    }
    try {
      const accepted = await rpc("consume_account_erasure_invocation", { p_hash: tokenHash });
      if (accepted !== true) return reply({ message: "Unauthorized" }, 401);
      // Confirm this project exists and this key can read it before interpreting a customer's 404.
      const project = await send(rcBase + "/customers?limit=1", { headers: rcHeaders });
      if (!project.ok || !Array.isArray((await project.json()).items)) throw new Error("Provider unavailable");
      const jobs = await rpc("claim_account_erasures", { p_limit: 5, p_lease_seconds: 120 });
      if (!Array.isArray(jobs) || jobs.length > 5) throw new Error("Invalid queue response");

      async function process(job) {
        if (!uuid.test(job.id) || !uuid.test(job.lease_token)) return "errors";
        const identity = { p_id: job.id, p_lease_token: job.lease_token };
        async function defer(code, seconds) {
          const saved = await rpc("defer_account_erasure", {
            ...identity, p_error_code: code, p_retry_after: seconds,
          });
          return saved === true ? "deferred" : "errors";
        }
        async function handleFailure(response) {
          if (response.status === 429) return defer("rate_limited", retryDelay(response));
          if ([401, 403].includes(response.status)) return defer("auth", 3600);
          return defer(response.status >= 500 ? "temporary" : "invalid_response", 300);
        }
        try {
          if (job.project_id !== config.projectId) return defer("project_mismatch", 3600);
          if (!uuid.test(job.customer_id) && !anonymousCustomer.test(job.customer_id)) {
            return defer("configuration", 3600);
          }
          const customerUrl = rcBase + "/customers/" + encodeURIComponent(job.customer_id);
          let current = await send(customerUrl, { headers: rcHeaders });
          if (current.status !== 404 && !current.ok) return handleFailure(current);
          if (current.status !== 404) {
            const deleted = await send(customerUrl, { method: "DELETE", headers: rcHeaders });
            if (!deleted.ok && deleted.status !== 404) return handleFailure(deleted);
            current = await send(customerUrl, { headers: rcHeaders });
          }
          if (current.status === 404) {
            const completed = await rpc("complete_account_erasure", identity);
            return completed === true ? "completed" : "errors";
          }
          if (current.ok) return defer("verification_pending", 60);
          return handleFailure(current);
        } catch {
          // A timeout may follow a committed provider deletion. A later GET settles that ambiguity.
          return defer("temporary", 300);
        }
      }
      const results = await Promise.allSettled(jobs.map(process));
      const summary = { claimed: jobs.length, completed: 0, deferred: 0, errors: 0 };
      for (const result of results) {
        const outcome = result.status === "fulfilled" ? result.value : "errors";
        summary[outcome]++;
      }
      return reply(summary);
    } catch {
      return reply({ message: "Erasure service unavailable. Requested erasures remain queued." }, 503);
    }
  };
}
