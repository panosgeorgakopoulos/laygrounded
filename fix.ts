import { createClient } from "@supabase/supabase-js";
import { seedScenarios } from "./src/lib/seed-data.ts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing env");
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function fix() {
  const vessels = seedScenarios.map(s => s.vessel);
  const { data } = await supabase.from("claims").select("id").in("vessel", vessels);
  
  if (data && data.length > 0) {
    const ids = data.map(d => d.id);
    const { error } = await supabase.from("claims").delete().in("id", ids);
    if (error) {
      console.error("Error deleting:", error);
    } else {
      console.log(`Deleted ${ids.length} old seed claims.`);
    }
  } else {
    console.log("No seed claims found.");
  }
}

fix();
