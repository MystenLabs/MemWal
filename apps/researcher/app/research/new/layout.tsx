import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function LauncherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.user) {
    redirect("/login");
  }

  return <>{children}</>;
}
