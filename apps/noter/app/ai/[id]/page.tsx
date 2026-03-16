import { ChatContainer } from "@/feature/chat/index";

type ChatPageProps = {
  params: Promise<{ id: string }>;
};

export default async function ChatPage({ params }: ChatPageProps) {
  const { id } = await params;

  return (
    <main className="h-full">
      <ChatContainer chatId={id} />
    </main>
  );
}
