import { SidebarFloat } from "@/app/components/sidebar-float";
import { AuthGuard } from "@/feature/auth";

export default function AILayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="relative h-screen">
        <SidebarFloat />
        <main className="h-full">{children}</main>
      </div>
    </AuthGuard>
  );
}
