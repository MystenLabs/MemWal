import { clearSession } from "@/lib/auth/session";

export async function POST() {
  await clearSession();
  return Response.json({ success: true });
}
