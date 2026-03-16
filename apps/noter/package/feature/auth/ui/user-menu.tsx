/**
 * USER MENU COMPONENT
 * Displays user info and logout option
 */

"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { Avatar } from "@/shared/components/ui/avatar";
import { Button } from "@/shared/components/ui/button";
import { LogOut, Wallet } from "lucide-react";
import { useAuth } from "../hook/use-auth";
import { truncateSuiAddress } from "../domain/zklogin";
import type { UserMenuProps } from "../domain/type";

export function UserMenu({ user, onLogout }: UserMenuProps) {
  const { logout, isLogoutPending } = useAuth();

  const handleLogout = async () => {
    await logout();
    onLogout?.();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-10 w-10 rounded-full">
          <Avatar className="h-10 w-10">
            {user.avatar ? (
              <img
                src={user.avatar}
                alt={user.name || "User"}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-primary/10 text-primary">
                {user.name?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || "?"}
              </div>
            )}
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-56" align="end">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            {user.email && (
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            )}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem disabled className="cursor-default">
          <Wallet className="mr-2 h-4 w-4" />
          <span className="text-xs font-mono">
            {truncateSuiAddress(user.suiAddress)}
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={handleLogout}
          disabled={isLogoutPending}
          className="cursor-pointer"
        >
          <LogOut className="mr-2 h-4 w-4" />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
