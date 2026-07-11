import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data: users } = await supabase.auth.admin.listUsers();
  const demoUser = users?.users.find(u => u.email === "demo@laygrounded.com");
  
  if (!demoUser) {
    console.log("Demo user not found!");
    return;
  }
  
  console.log("Found demo user:", demoUser.id);
  
  const { data: membership } = await supabase
    .from("company_members")
    .select("company_id")
    .eq("user_id", demoUser.id);
    
  console.log("Membership:", membership);
  
  if (membership && membership.length > 0) {
    const { data: claims } = await supabase
      .from("claims")
      .select("id, vessel, voyage_ref")
      .eq("company_id", membership[0].company_id);
      
    console.log("Claims found:", claims);
  }
}

main().catch(console.error);
