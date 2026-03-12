import { redirect } from "next/navigation";
import { auth } from "@/app/(auth)/auth";
import { getSprintsByUserId } from "@/lib/db/queries";
import { SessionLauncher } from "@/components/research/session-launcher";

export default async function LauncherPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/api/auth/guest");
  }

  const sprints = await getSprintsByUserId({ userId: session.user.id });

  if (sprints.length === 0) {
    redirect("/");
  }

  const serializedSprints = sprints.map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    reportContent: s.reportContent,
    citations: s.citations,
    sources: s.sources,
    tags: s.tags,
    chatId: s.chatId,
    blobId: s.blobId,
    memoryCount: s.memoryCount,
    createdAt: s.createdAt.toISOString(),
  }));

  return <SessionLauncher sprints={serializedSprints} />;
}
