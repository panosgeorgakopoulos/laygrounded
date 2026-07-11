import { POST } from "./src/app/api/init-demo/route";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function main() {
  const req = new Request("http://localhost:3000/api/init-demo", { method: "POST" });
  const res = await POST(req);
  console.log("Status:", res.status);
  console.log("Body:", await res.json());
}

main().catch(console.error);
