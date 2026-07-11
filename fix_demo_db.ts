import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log("Looking up demo@laygrounded.com...");
  const { data: userId } = await supabase.rpc("get_user_id_by_email", { email_addr: "demo@laygrounded.com" });
  
  if (userId) {
    console.log("Found demo user:", userId);
    
    // Reset password
    const { error: resetErr } = await supabase.auth.admin.updateUserById(userId, { password: "demo1234" });
    if (resetErr) console.error("Reset password err:", resetErr);
    else console.log("Successfully reset password to demo1234.");
    
    // Let's also check if they have a company
    const { data: membership } = await supabase.from("company_members").select("*").eq("user_id", userId).maybeSingle();
    console.log("Membership:", membership);
    
  } else {
    console.log("Demo user REALLY doesn't exist. Creating...");
    const { data, error } = await supabase.auth.admin.createUser({
      email: "demo@laygrounded.com",
      password: "demo1234",
      email_confirm: true
    });
    console.log("Create Data:", data);
    console.log("Create Err:", error);
  }
}

main().catch(console.error);
