import { createHandler } from "./handler.mjs";

const serviceKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default
  || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(createHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL"),
  serviceKey,
  projectId: Deno.env.get("REVENUECAT_PROJECT_ID"),
  revenueCatKey: Deno.env.get("REVENUECAT_V2_SECRET_KEY"),
}));
