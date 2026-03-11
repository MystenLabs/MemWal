import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/shared/lib/trpc/router";
import { createContext } from "@/shared/lib/trpc/init";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
  });

export { handler as GET, handler as POST };
