'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useCurrentAccount } from '@mysten/dapp-kit'
import Showcase from '@/components/showcase'

export default function HomePage() {
  const currentAccount = useCurrentAccount()
  const router = useRouter()

  // Redirect to connect page if wallet is not connected
  useEffect(() => {
    if (!currentAccount) {
      router.push('/connect')
    }
  }, [currentAccount, router])

  // Show loading while checking wallet or redirecting
  if (!currentAccount) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
      </div>
    )
  }

  // Show chat when wallet is connected
  return <Showcase />
}
