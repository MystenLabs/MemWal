import { router } from "./init";
import { authRouter } from "@/feature/auth/api/route";
import { noteRouter } from "@/feature/note/api/route";
import { memoryRouter } from "@/feature/memory/api/route";
import { chatRouter } from "@/feature/chat/api/route";

export const appRouter = router({
  auth: authRouter,
  note: noteRouter,
  memory: memoryRouter,
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;
