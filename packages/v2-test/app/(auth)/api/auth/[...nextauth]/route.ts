import { GET as AuthGET, POST as AuthPOST } from "@/app/(auth)/auth";

// Type cast to satisfy Next.js 16 route handler signature
export const GET = AuthGET as any;
export const POST = AuthPOST as any;
