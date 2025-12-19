'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit'
import { motion } from 'framer-motion'
import Aurora from '@/components/Aurora'
import { Wallet } from 'lucide-react'

export default function ConnectWalletPage() {
  const currentAccount = useCurrentAccount()
  const router = useRouter()

  // Redirect to home/chat when wallet is connected
  useEffect(() => {
    if (currentAccount) {
      router.push('/')
    }
  }, [currentAccount, router])

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      {/* Aurora Background */}
      <div className="fixed inset-0 w-full h-full -z-10">
        <Aurora colorStops={["#333", "#222", "#444"]} amplitude={1.2} blend={0.6} speed={0.8} />
      </div>

      {/* Connect Card */}
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="bg-[#1a1a1a]/80 backdrop-blur-2xl rounded-3xl p-8 border border-white/10 shadow-2xl">
          {/* Logo/Icon */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.5 }}
            className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-white/20 to-white/5 rounded-full flex items-center justify-center border border-white/20"
          >
            <Wallet className="w-10 h-10 text-white" />
          </motion.div>

          {/* Title */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="text-center mb-8"
          >
            <h1 className="text-3xl font-bold text-white mb-2">
              Connect Your Wallet
            </h1>
            <p className="text-gray-400 text-sm">
              Connect your Sui wallet to access your personal memory vault
            </p>
          </motion.div>

          {/* Connect Button */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="flex flex-col items-center gap-4"
          >
            <ConnectButton
              connectText="Connect with Slush Wallet"
              className="w-full h-14 rounded-2xl bg-white hover:bg-gray-100 text-black font-semibold text-lg transition-all duration-200 shadow-lg hover:shadow-white/20"
            />

            <p className="text-gray-500 text-xs text-center mt-4">
              By connecting, you agree to store your memories securely on the Sui blockchain
            </p>
          </motion.div>

          {/* Features */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.5 }}
            className="mt-8 pt-6 border-t border-white/10"
          >
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl mb-1">🔒</div>
                <div className="text-xs text-gray-400">Encrypted</div>
              </div>
              <div>
                <div className="text-2xl mb-1">⛓️</div>
                <div className="text-xs text-gray-400">On-Chain</div>
              </div>
              <div>
                <div className="text-2xl mb-1">🧠</div>
                <div className="text-xs text-gray-400">AI-Powered</div>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Powered by */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.5 }}
          className="text-center mt-6"
        >
          <p className="text-gray-500 text-xs">
            Powered by <span className="text-gray-400">Sui</span> + <span className="text-gray-400">Walrus</span>
          </p>
        </motion.div>
      </motion.div>
    </div>
  )
}
