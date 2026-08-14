/**
 * Delegate-key export is intentionally disabled.
 *
 * Researcher is a demo app and must not become a credential recovery service:
 * an authenticated browser session is sufficient to use server-side memory
 * operations, but it cannot retrieve reusable private-key material.
 */
export async function GET() {
  return Response.json(
    { error: "Delegate private-key export is disabled" },
    { status: 410 }
  );
}

export const POST = GET;
