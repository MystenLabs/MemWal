import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { getSession } from "@/lib/auth/session";
import { Chat } from "@/components/chat/chat";
import { DataStreamHandler } from "@/components/data/data-stream-handler";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { getChatById, getMessagesByChatId, getSprintsByIds } from "@/lib/db/queries";
import { convertToUIMessages } from "@/lib/utils";

export default function Page(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <ChatPage params={props.params} />
    </Suspense>
  );
}

async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chat = await getChatById({ id });

  if (!chat) {
    redirect("/");
  }

  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  if (chat.visibility === "private") {
    if (!session.user) {
      return notFound();
    }

    if (session.user.id !== chat.userId) {
      return notFound();
    }
  }

  const messagesFromDb = await getMessagesByChatId({
    id,
  });

  const uiMessages = convertToUIMessages(messagesFromDb);

  const cookieStore = await cookies();
  const chatModelFromCookie = cookieStore.get("chat-model");

  const chatModel = chatModelFromCookie?.value ?? DEFAULT_CHAT_MODEL;

  // Fetch sprint data if chat has associated sprints
  const sprintIds = chat.sprintIds ?? [];
  const sprintData =
    sprintIds.length > 0 && session.user
      ? await getSprintsByIds({ sprintIds, userId: session.user.id })
      : [];

  const initialSprintData = sprintData.map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    tags: s.tags,
    sources: s.sources,
    memoryCount: s.memoryCount,
  }));

  return (
    <>
      <Chat
        autoResume={true}
        id={chat.id}
        initialChatModel={chatModel}
        initialMessages={uiMessages}
        initialVisibilityType={chat.visibility}
        isReadonly={session?.user?.id !== chat.userId}
        initialSprintIds={sprintIds.length > 0 ? sprintIds : undefined}
        initialSprintData={initialSprintData.length > 0 ? initialSprintData : undefined}
      />
      <DataStreamHandler />
    </>
  );
}
