import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const { data, error } = await supabase.auth.admin.createUser({
    email: "demo2@laygrounded.com",
    password: "demo1234",
    email_confirm: true
  });
  console.log("Create Data:", data);
  console.log("Create Error:", error);
}

main().catch(console.error);
