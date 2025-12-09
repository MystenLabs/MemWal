'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Search, Mic, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ModernChatInputProps {
  onSubmit: (message: string) => void
  isLoading?: boolean
  disabled?: boolean
  placeholder?: string
}

export default function ModernChatInput({ 
  onSubmit, 
  isLoading = false, 
  disabled = false,
  placeholder = "Ask Anything........"
}: ModernChatInputProps) {
  const [input, setInput] = useState('')

  const handleSubmit = () => {
    if (!input.trim() || isLoading || disabled) return
    onSubmit(input)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="w-full max-w-4xl mx-auto space-y-3">
      {/* Main Input Area */}
      <div className="bg-[#2a2a2a] rounded-3xl 36 backdrop-blur-xl border border-white/10">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isLoading || disabled}
          className={cn(
            "min-h-[100px] bg-transparent border-none text-white text-lg",
            "placeholder:text-gray-500 focus-visible:ring-0 focus-visible:ring-offset-0",
            "resize-none w-full"
          )}
        />
      </div>

      {/* Control Bar */}
      <div className="flex items-center justify-between gap-3">
        {/* Left side - Add button */}
        <Button
          type="button"
          size="icon"
          className={cn(
            "w-12 h-12 rounded-full bg-[#2a2a2a] hover:bg-[#353535]",
            "border border-white/10 transition-all duration-200"
          )}
        >
          <Plus className="w-5 h-5 text-gray-300" />
        </Button>

        {/* Middle - Search button */}
        <Button
          type="button"
          className={cn(
            "flex items-center gap-2 h-12 px-6 rounded-full",
            "bg-[#2a2a2a] hover:bg-[#353535]",
            "border border-white/10 transition-all duration-200",
            "text-gray-300"
          )}
        >
          <Search className="w-4 h-4" />
          <span className="text-sm">Search</span>
        </Button>

        {/* Right side - Controls */}
        <div className="flex items-center gap-3">
          {/* Microphone button */}
          <Button
            type="button"
            size="icon"
            className={cn(
              "w-12 h-12 rounded-full bg-[#2a2a2a] hover:bg-[#353535]",
              "border border-white/10 transition-all duration-200"
            )}
          >
            <Mic className="w-5 h-5 text-gray-300" />
          </Button>

          {/* Send button */}
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!input.trim() || isLoading || disabled}
            size="icon"
            className={cn(
              "w-12 h-12 rounded-full transition-all duration-200",
              input.trim() && !isLoading && !disabled
                ? "bg-white hover:bg-gray-100 text-black"
                : "bg-[#2a2a2a] text-gray-500 border border-white/10"
            )}
          >
            <ArrowUp className="w-5 h-5" />
          </Button>
        </div>
      </div>
    </div>
  )
}







