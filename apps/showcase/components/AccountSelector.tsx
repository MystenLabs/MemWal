'use client'

import { useAccounts, useCurrentAccount, useSwitchAccount } from '@mysten/dapp-kit'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'

function formatAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

interface AccountSelectorProps {
  onSelect?: (address: string) => void
  showTitle?: boolean
}

export function AccountSelector({ onSelect, showTitle = true }: AccountSelectorProps) {
  const accounts = useAccounts()
  const currentAccount = useCurrentAccount()
  const { mutate: switchAccount } = useSwitchAccount()

  const handleSelectAccount = (account: typeof accounts[0]) => {
    switchAccount(
      { account },
      {
        onSuccess: () => {
          onSelect?.(account.address)
        },
      }
    )
  }

  if (accounts.length === 0) {
    return null
  }

  return (
    <div className="w-full">
      {showTitle && (
        <h3 className="text-lg font-semibold text-white mb-4 text-center">
          Select Account
        </h3>
      )}

      <div className="space-y-2">
        {accounts.map((account, index) => (
          <motion.div
            key={account.address}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
          >
            <Button
              variant="outline"
              onClick={() => handleSelectAccount(account)}
              className={cn(
                "w-full h-14 justify-between px-4 rounded-xl",
                "bg-[#2a2a2a]/60 hover:bg-[#353535]/80 backdrop-blur-xl",
                "border transition-all duration-200",
                account.address === currentAccount?.address
                  ? "border-green-500/50 bg-green-500/10"
                  : "border-white/10 hover:border-white/30"
              )}
            >
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center text-xl",
                  account.address === currentAccount?.address
                    ? "bg-green-500/20"
                    : "bg-white/10"
                )}>
                  👛
                </div>
                <div className="text-left">
                  <div className="font-mono text-sm text-white">
                    {formatAddress(account.address)}
                  </div>
                  <div className="text-xs text-gray-500">
                    Account {index + 1}
                  </div>
                </div>
              </div>

              {account.address === currentAccount?.address && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-green-400">Selected</span>
                  <span className="text-green-400">✓</span>
                </div>
              )}
            </Button>
          </motion.div>
        ))}
      </div>

      {accounts.length > 0 && (
        <p className="text-xs text-gray-500 text-center mt-4">
          {accounts.length} account{accounts.length > 1 ? 's' : ''} available from your wallet
        </p>
      )}
    </div>
  )
}
