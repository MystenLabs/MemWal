import { router } from "./init";
import { authRouter } from "@/feature/auth/api/route";
import { noteRouter } from "@/feature/note/api/route";

export const appRouter = router({
  auth: authRouter,
  note: noteRouter,
});

export type AppRouter = typeof appRouter;
