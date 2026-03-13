import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getSprintsByUserId } from "@/lib/db/queries";
import { SessionLauncher } from "@/components/research/session-launcher";

async function LauncherContent() {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
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

export default function LauncherPage() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <LauncherContent />
    </Suspense>
  );
}
