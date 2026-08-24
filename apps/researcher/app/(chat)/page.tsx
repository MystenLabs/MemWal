import { cookies } from "next/headers";
import { Suspense } from "react";
import { Chat } from "@/components/chat/chat";
import { DataStreamHandler } from "@/components/data/data-stream-handler";
import { resolveChatModelId } from "@/lib/ai/models";
import { generateUUID } from "@/lib/utils";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <NewChatPage />
    </Suspense>
  );
}

async function NewChatPage() {
  const cookieStore = await cookies();
  const id = generateUUID();
  const chatModel = resolveChatModelId(cookieStore.get("chat-model")?.value);

  return (
    <>
      <Chat
        autoResume={false}
        id={id}
        initialChatModel={chatModel}
        initialMessages={[]}
        initialVisibilityType="private"
        isReadonly={false}
        key={id}
      />
      <DataStreamHandler />
    </>
  );
}
