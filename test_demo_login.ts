import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: "demo@laygrounded.com",
    password: "demo1234"
  });
  
  if (error) {
    console.error("Login failed:", error.message);
    return;
  }
  
  console.log("Logged in! User ID:", data.user.id);
  
  const { data: claims, error: claimsErr } = await supabase
    .from("claims")
    .select("*");
    
  if (claimsErr) console.error("Claims err:", claimsErr);
  else console.log("Claims fetched natively (RLS applied):", claims?.length || 0, "claims");
  
  const { data: membership } = await supabase
    .from("company_members")
    .select("*");
    
  console.log("Company Memberships:", membership);
}

main().catch(console.error);
