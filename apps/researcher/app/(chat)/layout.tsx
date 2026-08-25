import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { DataStreamProvider } from "@/components/data/data-stream-provider";
import { SourceProcessingProvider } from "@/components/chat/source-processing-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getSession } from "@/lib/auth/session";

export default function Layout({ children }: { children: React.ReactNode }) {
  // No pyodide <Script> here anymore: it was template leftover (Vercel
  // ai-chatbot's Python code-runner) that nothing in this app calls — no
  // loadPyodide/runPython usage exists. It cost a multi-MB CDN download on
  // every chat page and, as of Next 16, beforeInteractive in a nested layout
  // throws "Encountered a script tag while rendering React component".
  return (
    <>
      <DataStreamProvider>
        <SourceProcessingProvider>
          <Suspense fallback={<div className="flex h-dvh" />}>
            <SidebarWrapper>{children}</SidebarWrapper>
          </Suspense>
        </SourceProcessingProvider>
      </DataStreamProvider>
    </>
  );
}

async function SidebarWrapper({ children }: { children: React.ReactNode }) {
  const [session, cookieStore] = await Promise.all([getSession(), cookies()]);
  const isCollapsed = cookieStore.get("sidebar_state")?.value !== "true";

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar user={session?.user} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
