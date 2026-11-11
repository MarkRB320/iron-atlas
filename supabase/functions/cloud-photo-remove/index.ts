import { createHandler } from "./handler.mjs";

function platformKey(modern: string, legacy: string) {
  return JSON.parse(Deno.env.get(modern) || "{}").default || Deno.env.get(legacy);
}

Deno.serve(createHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL"),
  publicKey: platformKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
  serviceKey: platformKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
}));
