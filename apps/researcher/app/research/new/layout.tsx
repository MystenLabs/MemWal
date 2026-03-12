import { redirect } from "next/navigation";
import { auth } from "@/app/(auth)/auth";

export default async function LauncherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/api/auth/guest");
  }

  return <>{children}</>;
}
