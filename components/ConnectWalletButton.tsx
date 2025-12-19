'use client'

import { ConnectButton, useCurrentAccount, useDisconnectWallet, useConnectWallet, useWallets, useAccounts, useSwitchAccount } from '@mysten/dapp-kit'
import { Button } from '@/components/ui/button'
import { Wallet, LogOut, Copy, Check, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from '@/components/ui/dropdown-menu'

function formatAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function ConnectWalletButton() {
  const currentAccount = useCurrentAccount()
  const accounts = useAccounts()
  const { mutate: disconnect } = useDisconnectWallet()
  const { mutate: connect } = useConnectWallet()
  const { mutate: switchAccount } = useSwitchAccount()
  const wallets = useWallets()
  const [copied, setCopied] = useState(false)

  const copyAddress = async () => {
    if (currentAccount?.address) {
      await navigator.clipboard.writeText(currentAccount.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleSwitchAccount = (account: typeof accounts[0]) => {
    switchAccount({ account })
  }

  const handleChangeWallet = (wallet: typeof wallets[0]) => {
    // Disconnect current wallet first, then connect to new one
    disconnect()
    setTimeout(() => {
      connect({ wallet })
    }, 100)
  }

  const handleFullDisconnect = () => {
    // Disconnect and clear Slush wallet data
    disconnect()
    // Clear Slush wallet localStorage keys
    if (typeof window !== 'undefined') {
      const keysToRemove = Object.keys(localStorage).filter(
        key => key.includes('slush') || key.includes('sui-wallet') || key.includes('@mysten')
      )
      keysToRemove.forEach(key => localStorage.removeItem(key))
      // Reload to reset wallet state
      window.location.reload()
    }
  }

  if (currentAccount) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "flex items-center gap-2 h-10 px-4 rounded-full",
              "bg-[#2a2a2a]/80 hover:bg-[#353535]/80 backdrop-blur-xl",
              "border border-white/20 hover:border-white/30 transition-all duration-200",
              "text-white"
            )}
          >
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="font-mono text-sm">
              {formatAddress(currentAccount.address)}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56 bg-[#1a1a1a]/95 backdrop-blur-xl border-white/20 z-[10000]"
          sideOffset={5}
        >
          {/* Copy Address */}
          <DropdownMenuItem
            onClick={copyAddress}
            className="flex items-center gap-2 text-gray-300 hover:text-white cursor-pointer"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
            <span>{copied ? 'Copied!' : 'Copy Address'}</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator className="bg-white/10" />

          {/* Switch Account - if multiple accounts */}
          {accounts.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="flex items-center gap-2 text-gray-300 hover:text-white cursor-pointer">
                <RefreshCw className="w-4 h-4" />
                <span>Switch Account</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="bg-[#1a1a1a]/95 backdrop-blur-xl border-white/20">
                  {accounts.map((account) => (
                    <DropdownMenuItem
                      key={account.address}
                      onClick={() => handleSwitchAccount(account)}
                      className={cn(
                        "flex items-center gap-2 text-gray-300 hover:text-white cursor-pointer",
                        account.address === currentAccount.address && "bg-white/10"
                      )}
                    >
                      <Wallet className="w-4 h-4" />
                      <span className="font-mono text-xs">{formatAddress(account.address)}</span>
                      {account.address === currentAccount.address && (
                        <Check className="w-3 h-3 ml-auto text-green-400" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          )}

          {/* Change Wallet Provider - Submenu */}
          {wallets.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="flex items-center gap-2 text-gray-300 hover:text-white cursor-pointer">
                <Wallet className="w-4 h-4" />
                <span>Change Wallet</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="bg-[#1a1a1a]/95 backdrop-blur-xl border-white/20">
                  {wallets.map((wallet) => (
                    <DropdownMenuItem
                      key={wallet.name}
                      onClick={() => handleChangeWallet(wallet)}
                      className="flex items-center gap-2 text-gray-300 hover:text-white cursor-pointer"
                    >
                      {wallet.icon && (
                        <img
                          src={wallet.icon}
                          alt={wallet.name}
                          className="w-4 h-4 rounded"
                        />
                      )}
                      <span>{wallet.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          )}

          <DropdownMenuSeparator className="bg-white/10" />

          {/* Disconnect */}
          <DropdownMenuItem
            onClick={() => disconnect()}
            className="flex items-center gap-2 text-gray-300 hover:text-white cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Disconnect</span>
          </DropdownMenuItem>

          {/* Full Reset - Clear all wallet data */}
          <DropdownMenuItem
            onClick={handleFullDisconnect}
            className="flex items-center gap-2 text-red-400 hover:text-red-300 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            <span>Reset Wallet</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <ConnectButton
      connectText={
        <span className="flex items-center gap-2">
          <Wallet className="w-4 h-4" />
          Connect Wallet
        </span>
      }
      className={cn(
        "flex items-center gap-2 h-10 px-5 rounded-full",
        "bg-white hover:bg-gray-100 text-black font-medium",
        "transition-all duration-200 shadow-lg hover:shadow-white/20"
      )}
    />
  )
}
