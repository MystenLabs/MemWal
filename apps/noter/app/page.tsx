"use client";

import { AuthButtonGroup, useAuth } from "@/feature/auth";
import { MarketingBorder } from "@/package/shared/components/border";
import { Button } from "@/shared/components/ui/button";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";

export default function Home() {
  const { isAuthenticated, isLoading } = useAuth();

  return (
    <main className="relative overflow-hidden">
      <motion.div
        initial={{ scale: 4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
        className="fixed inset-0 -z-10"
      >
        <Image src="/bgr-2.webp" alt="Noter" fill className="object-cover invert dark:invert-0" />
      </motion.div>

      <MarketingBorder />

      <div className="flex min-h-screen flex-col z-10">
        {/* Main Content */}
        <main className="container mx-auto flex flex-1 flex-col items-center justify-center px-4">
          <motion.div
            className="text-center"
            initial="hidden"
            animate="visible"
            variants={{
              visible: { transition: { staggerChildren: 0.1, delayChildren: 0.2 } },
              hidden: {},
            }}
          >
            <motion.h2
              className="text-4xl font-bold"
              variants={{
                hidden: { opacity: 0, scale: 0.5 },
                visible: { opacity: 1, scale: 1 },
              }}
              transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
            >
              Welcome to Noter
            </motion.h2>
            <motion.p
              className="mt-4 text-lg text-muted-foreground"
              variants={{
                hidden: { opacity: 0, scale: 0.5 },
                visible: { opacity: 1, scale: 1 },
              }}
              transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
            >
              AI-powered note-taking on Sui blockchain
            </motion.p>

            {isAuthenticated && (
              <motion.div
                className="mt-8"
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
              >
                <Button asChild size="lg">
                  <Link href="/note">Take Notes</Link>
                </Button>
              </motion.div>
            )}

            {!isAuthenticated && !isLoading && (
              <motion.div
                className="mt-8"
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
              >
                <AuthButtonGroup />
              </motion.div>
            )}
          </motion.div>
        </main>
      </div>
    </main>
  );
}
