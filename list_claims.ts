import { createClient } from "@supabase/supabase-js";
import { seedScenarios } from "./src/lib/seed-data.ts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl!, supabaseKey!);

async function run() {
  const vessels = seedScenarios.map(s => s.vessel);
  const { data } = await supabase.from("claims").select("id, vessel").in("vessel", vessels);
  console.log(JSON.stringify(data, null, 2));
}
run();
