"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { uuidv7 } from "uuidv7";

export default function NewChatPage() {
  const router = useRouter();

  useEffect(() => {
    // Generate new chat ID and redirect
    const chatId = uuidv7();
    router.replace(`/ai/${chatId}`);
  }, [router]);

  return (
    <div className="flex h-screen items-center justify-center">
      <p className="text-muted-foreground">Creating new chat...</p>
    </div>
  );
}
