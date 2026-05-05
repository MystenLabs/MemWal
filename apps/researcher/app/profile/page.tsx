"use client";

import {
  ArrowLeft,
  Copy,
  Check,
  KeyRound,
  Shield,
  User,
  Eye,
  EyeOff,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface ProfileData {
  id: string;
  email: string;
  publicKey: string | null;
  suiAddress: string | null;
  accountId: string | null;
  authMethod: "enoki" | "key";
  hasPrivateKey: boolean;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
      onClick={handleCopy}
      title={`Copy ${label}`}
      type="button"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/profile")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setProfile(data))
      .catch(() => setProfile(null))
      .finally(() => setLoading(false));
  }, []);

  const handleExportKey = async () => {
    if (privateKey) {
      setShowKey(!showKey);
      return;
    }
    setKeyLoading(true);
    try {
      const res = await fetch("/api/auth/profile/export-key", {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setPrivateKey(data.privateKey);
        setShowKey(true);
      }
    } catch {
      // silently fail
    } finally {
      setKeyLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="size-6 animate-pulse rounded-full bg-muted" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground text-sm">Not signed in</p>
        <Link href="/login">
          <Button variant="outline" size="sm">
            Sign in
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-dvh w-full justify-center bg-background">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-[40%] left-1/2 h-[80%] w-[80%] -translate-x-1/2 rounded-full bg-gradient-to-b from-primary/[0.04] to-transparent blur-3xl dark:from-primary/[0.06]" />
      </div>

      <div className="relative z-10 w-full max-w-[480px] px-6 py-12">
        {/* Back link */}
        <Link
          className="mb-8 inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
          href="/"
        >
          <ArrowLeft className="size-3.5" />
          Back to chat
        </Link>

        {/* Header */}
        <div className="mb-8 flex items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <User className="size-5 text-foreground" strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="font-semibold text-xl tracking-tight">Profile</h1>
            <p className="text-muted-foreground text-sm">
              {profile.authMethod === "enoki"
                ? "Signed in with Google"
                : "Signed in with delegate key"}
            </p>
          </div>
        </div>

        {/* Account info card */}
        <div className="mb-4 rounded-xl border bg-card shadow-sm">
          <div className="border-b px-5 py-3">
            <h2 className="flex items-center gap-2 font-medium text-sm">
              <Shield className="size-3.5 text-muted-foreground" />
              MemWal Account
            </h2>
          </div>

          <div className="divide-y">
            {profile.suiAddress && (
              <div className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">Sui Address</p>
                  <p className="truncate font-mono text-sm">
                    {truncateAddress(profile.suiAddress)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <CopyButton
                    value={profile.suiAddress}
                    label="Sui address"
                  />
                  <a
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    href={`https://suiscan.xyz/testnet/account/${profile.suiAddress}`}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="View on Suiscan"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              </div>
            )}

            {profile.accountId && (
              <div className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">Account ID</p>
                  <p className="truncate font-mono text-sm">
                    {truncateAddress(profile.accountId)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <CopyButton value={profile.accountId} label="Account ID" />
                  <a
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    href={`https://suiscan.xyz/testnet/object/${profile.accountId}`}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="View on Suiscan"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              </div>
            )}

            {profile.publicKey && (
              <div className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">Public Key</p>
                  <p className="truncate font-mono text-sm">
                    {truncateAddress(profile.publicKey)}
                  </p>
                </div>
                <CopyButton value={profile.publicKey} label="Public Key" />
              </div>
            )}
          </div>
        </div>

        {/* Export delegate key card */}
        {profile.hasPrivateKey && (
          <div className="mb-4 rounded-xl border bg-card shadow-sm">
            <div className="border-b px-5 py-3">
              <h2 className="flex items-center gap-2 font-medium text-sm">
                <KeyRound className="size-3.5 text-muted-foreground" />
                Delegate Key
              </h2>
            </div>

            <div className="px-5 py-4">
              <p className="mb-3 text-muted-foreground text-xs leading-relaxed">
                Use this key to connect other apps (chatbot, CLI, OpenClaw) to
                your MemWal account. Keep it private.
              </p>

              {showKey && privateKey ? (
                <div className="mb-3 rounded-lg border bg-muted/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <code className="break-all font-mono text-xs leading-relaxed">
                      {privateKey}
                    </code>
                    <CopyButton value={privateKey} label="Private Key" />
                  </div>
                </div>
              ) : null}

              <Button
                className="w-full"
                disabled={keyLoading}
                onClick={handleExportKey}
                size="sm"
                variant="outline"
              >
                {keyLoading ? (
                  "Loading..."
                ) : showKey ? (
                  <>
                    <EyeOff className="size-3.5" />
                    Hide Key
                  </>
                ) : (
                  <>
                    <Eye className="size-3.5" />
                    Reveal Delegate Key
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Session actions */}
        <div className="rounded-xl border bg-card px-5 py-3 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-sm">Session active</p>
            <Button
              onClick={async () => {
                await fetch("/api/auth/signout", { method: "POST" });
                window.location.href = "/login";
              }}
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
            >
              Sign out
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
