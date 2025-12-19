'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ResetWalletPage() {
  const router = useRouter()
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    // Clear all wallet-related localStorage keys
    if (typeof window !== 'undefined') {
      const keysToRemove: string[] = []

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && (
          key.includes('slush') ||
          key.includes('sui') ||
          key.includes('@mysten') ||
          key.includes('wallet') ||
          key.includes('dapp-kit')
        )) {
          keysToRemove.push(key)
        }
      }

      console.log('Clearing wallet keys:', keysToRemove)
      keysToRemove.forEach(key => localStorage.removeItem(key))

      setCleared(true)

      // Redirect to connect page after 2 seconds
      setTimeout(() => {
        router.push('/connect')
      }, 2000)
    }
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center bg-black text-white">
      <div className="text-center">
        {cleared ? (
          <>
            <div className="text-4xl mb-4">✅</div>
            <h1 className="text-2xl font-bold mb-2">Wallet Reset Complete</h1>
            <p className="text-gray-400">Redirecting to connect page...</p>
          </>
        ) : (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            <h1 className="text-2xl font-bold mb-2">Resetting Wallet...</h1>
            <p className="text-gray-400">Clearing cached wallet data</p>
          </>
        )}
      </div>
    </div>
  )
}
