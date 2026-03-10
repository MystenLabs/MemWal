import { GET as AuthGET, POST as AuthPOST } from "@/app/(auth)/auth";

export const GET = AuthGET as (...args: any[]) => any;
export const POST = AuthPOST as (...args: any[]) => any;
