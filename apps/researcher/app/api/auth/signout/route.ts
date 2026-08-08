import { clearSession } from "@/lib/auth/session";
import { isSameOriginRequest } from "@/lib/auth/request-security";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin" }, { status: 403 });
  }

  await clearSession();
  return Response.json({ success: true });
}
