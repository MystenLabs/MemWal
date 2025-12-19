'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Search, Mic, ArrowUp, Stars, Link, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { motion, AnimatePresence } from 'framer-motion'
import Aurora from './Aurora'
import { EncryptedText } from '@/components/ui/encrypted-text'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt?: Date
}

type ProcessStep = {
  id: number
  title: string
  description: string
  status: 'pending' | 'in-progress' | 'completed'
}

const PROCESS_STEPS: ProcessStep[] = [
  {
    id: 1,
    title: 'MESSAGE RECEIVED',
    description: 'POST /api/chat/stream\nMessage + userAddress + sessionId sent to backend',
    status: 'pending'
  },
  {
    id: 2,
    title: 'STORE IN POSTGRESQL',
    description: 'Save message to `chat_messages` table\nUpdate session\'s `updatedAt` timestamp',
    status: 'pending'
  },
  {
    id: 3,
    title: 'SEARCH RELEVANT MEMORIES',
    description: 'pdw.search.vector(userMessage, { limit: 5 })\nQueries HNSW index on Sui blockchain',
    status: 'pending'
  },
  {
    id: 4,
    title: 'AI GENERATES RESPONSE',
    description: 'Gemini AI receives current message + memories + chat history\nGenerates personalized response',
    status: 'pending'
  },
  {
    id: 5,
    title: 'EXTRACT KNOWLEDGE',
    description: 'pdw.graph.extract(conversation)\nIdentifies memorable facts and relationships',
    status: 'pending'
  },
  {
    id: 6,
    title: 'GENERATE EMBEDDINGS',
    description: 'pdw.embeddings.generate(memoryContent)\nCreates 768-dimension vector',
    status: 'pending'
  },
  {
    id: 7,
    title: 'ENCRYPT WITH SEAL',
    description: 'pdw.encryption.encryptWithKeyId(data, keyId)\nIdentity-based encryption using MemoryCap',
    status: 'pending'
  },
  {
    id: 8,
    title: 'STORE ON BLOCKCHAIN',
    description: 'Upload to Walrus → Register on Sui\nHNSW index entry + ownership record',
    status: 'pending'
  },
  {
    id: 9,
    title: 'LINK REFERENCES',
    description: 'Update PostgreSQL with memoryId + walrusHash\nBridge off-chain chat and on-chain memory',
    status: 'pending'
  },
  {
    id: 10,
    title: 'STREAM RESPONSE',
    description: 'AI response streamed to frontend\nAssistant message saved to PostgreSQL',
    status: 'pending'
  }
]

function StepVisualizer({ steps, currentStep, visibleSteps }: { steps: ProcessStep[]; currentStep: number; visibleSteps: number }) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as steps are revealed
  useEffect(() => {
    if (containerRef.current && visibleSteps > 0) {
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: 'smooth'
      })
    }
  }, [visibleSteps])

  // Auto-scroll to center the current step when processing
  useEffect(() => {
    if (containerRef.current && currentStep >= 0) {
      const container = containerRef.current
      const currentStepElement = container.children[currentStep] as HTMLElement
      
      if (currentStepElement) {
        const containerHeight = container.clientHeight
        const elementTop = currentStepElement.offsetTop
        const elementHeight = currentStepElement.clientHeight
        const scrollTop = elementTop - (containerHeight / 2) + (elementHeight / 2)
        
        container.scrollTo({
          top: scrollTop,
          behavior: 'smooth'
        })
      }
    }
  }, [currentStep])

  return (
    <div ref={containerRef} className="space-y-3 h-full overflow-y-auto hide-scroll overflow-visible p-3">
      <AnimatePresence>
        {steps.slice(0, visibleSteps).map((step, index) => {
          const isActive = index < currentStep
          const isCurrent = index === currentStep
          const isPending = index > currentStep

          return (
            <motion.div
              key={step.id}
              initial={{ opacity: 0, x: 30, scale: 0.85 }}
              animate={{ 
                opacity: 1, 
                x: 0, 
                scale: isCurrent ? 1.02 : 1,
              }}
              transition={{ 
                duration: 0.6, 
                delay: index * 0.08,
                ease: [0.25, 0.1, 0.25, 1],
                scale: { duration: 0.4 },
                opacity: { duration: 0.5 }
              }}
              className={cn(
                "p-4 rounded-2xl border-0.5 transition-all duration-700 ease-out backdrop-blur-2xl bg-gradient-to-br",
                {
                  'border-white/40 from-white/10 via-white/5 to-transparent text-white shadow-lg shadow-white/5': isActive && !isCurrent,
                  'border-white/60 from-white/15 via-white/10 to-white/5 text-white': isCurrent,
                  'border-white/20 from-white/5 via-transparent to-transparent text-gray-300': isPending
                }
              )}
              style={isCurrent ? {
                boxShadow: '0 0 25px 4px rgba(255, 255, 255, 0.1), 0 0 15px 1px rgba(255, 255, 255, 0.08), 0 6px 24px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
              } : isActive ? {
                boxShadow: '0 4px 20px rgba(255, 255, 255, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.05)'
              } : {
                boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)'
              }}
            >
              <div className="flex items-center gap-3 mb-2">
                <motion.div 
                  animate={isCurrent ? { 
                    scale: [1, 1.2, 1],
                  } : { scale: 1 }}
                  transition={{ 
                    repeat: isCurrent ? Infinity : 0, 
                    duration: 2,
                    ease: "easeInOut"
                  }}
                  className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-500",
                    {
                      'bg-white/90 text-black shadow-lg': isActive && !isCurrent,
                      'bg-white text-black': isCurrent,
                      'bg-white/5 text-gray-300 border-2 border-white/20': isPending
                    }
                  )}
                  style={isCurrent ? {
                    boxShadow: '0 0 20px 3px rgba(255, 255, 255, 0.25), 0 0 10px 1px rgba(255, 255, 255, 0.35)'
                  } : undefined}
                >
                  {step.id}
                </motion.div>
                <div className={cn(
                  "font-semibold text-sm transition-all duration-500",
                  {
                    'text-white': isActive || isCurrent,
                    'text-gray-300': isPending
                  }
                )}>
                    <span>{step.title}</span>
                </div>
              </div>
              <div className={cn(
                "text-xs ml-11 whitespace-pre-line leading-relaxed transition-all duration-500",
                {
                  'opacity-90 text-gray-300': isActive && !isCurrent,
                  'opacity-100 text-gray-200': isCurrent,
                  'opacity-95 text-gray-400': isPending
                }
              )}>
                <span>{step.description}</span>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

function ThinkingIndicator() {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="flex items-center gap-3 px-5 pb-4"
    >
      <span className="font-black">AI is thinking...</span>
    </motion.div>
  )
}

type Memory = {
  id: string
  content: string
  blobId?: string
  category?: string
  importance?: number
  createdAt?: number
}

export default function Showcase() {
  const [currentStep, setCurrentStep] = useState(-1)
  const [memories, setMemories] = useState<Memory[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [visibleSteps, setVisibleSteps] = useState(0)
  const [hasStartedChat, setHasStartedChat] = useState(false)
  const [isMemorySheetOpen, setIsMemorySheetOpen] = useState(false)
  const [showStepsPanel, setShowStepsPanel] = useState(false)
  const [isLoadingMemories, setIsLoadingMemories] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Fetch memories from blockchain on mount
  useEffect(() => {
    fetchMemoriesFromBlockchain()
  }, [])

  const simulateProcessSteps = () => {
    // Show the steps panel
    setShowStepsPanel(true)
    setVisibleSteps(0)
    setCurrentStep(-1)
    
    // First show all steps gradually
    PROCESS_STEPS.forEach((_, index) => {
      setTimeout(() => {
        setVisibleSteps(index + 1)
      }, index * 500)
    })

    // Then progress through them
    PROCESS_STEPS.forEach((_, index) => {
      setTimeout(() => {
        setCurrentStep(index)
      }, (PROCESS_STEPS.length * 500) + (index * 400))
    })
    
    // Hide the panel after all steps are done
    const totalDuration = (PROCESS_STEPS.length * 500) + (PROCESS_STEPS.length * 400) + 500
    setTimeout(() => {
      setShowStepsPanel(false)
    }, totalDuration)
  }

  // Fetch memories from blockchain
  const fetchMemoriesFromBlockchain = async () => {
    try {
      setIsLoadingMemories(true)
      const response = await fetch('/api/memories/list')
      const data = await response.json()
      
      if (data.success && data.memories) {
        setMemories(data.memories)
        console.log(`✅ Loaded ${data.memories.length} memories from blockchain`)
      }
    } catch (error) {
      console.error('Failed to fetch memories:', error)
    } finally {
      setIsLoadingMemories(false)
    }
  }

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length])

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return
    
    if (!hasStartedChat) {
      setHasStartedChat(true)
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      createdAt: new Date()
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsLoading(true)
    setIsProcessing(true)
    simulateProcessSteps()

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content
          }))
        })
      })

      if (!response.ok) throw new Error('Failed to fetch')

      const data = response.body
      if (!data) return

      const reader = data.getReader()
      const decoder = new TextDecoder()
      
      const assistantMessageId = (Date.now() + 1).toString()
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        createdAt: new Date()
      }

      setMessages(prev => [...prev, assistantMessage])

      let fullText = ''
      let scrollTimeout: NodeJS.Timeout | null = null

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const textChunk = decoder.decode(value, { stream: true })
          fullText += textChunk
          
          // Update by replacing the entire content to avoid duplication
          setMessages(prev => prev.map(msg => 
            msg.id === assistantMessageId 
              ? { ...msg, content: fullText }
              : msg
          ))

          // Throttled auto-scroll to bottom during streaming
          if (scrollTimeout) clearTimeout(scrollTimeout)
          scrollTimeout = setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
          }, 50)
        }
        
        // Final scroll after streaming completes
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      } catch (streamError) {
        console.error('Stream error:', streamError)
      }

      // Extract and store memories on blockchain using PDW
      try {
        const memoryResponse = await fetch('/api/chat/extract-memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userMessage: userMessage.content,
            assistantResponse: fullText
          })
        })
        
        const memoryData = await memoryResponse.json()
        
        if (memoryData.saved && memoryData.memory) {
          console.log('🔗 Memory stored on blockchain:', {
            id: memoryData.memoryId,
            blobId: memoryData.blobId,
            category: memoryData.category
          })
          
          // Refresh memories from blockchain
          await fetchMemoriesFromBlockchain()
        } else {
          console.log('💭 No personal data to store:', memoryData.reason || 'No reason given')
        }
      } catch (memoryError) {
        console.error('Memory extraction error:', memoryError)
      }

    } catch (error) {
      console.error('Error:', error)
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Sorry, I encountered an error. Please try again.',
        createdAt: new Date()
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
      setIsProcessing(false)
      setCurrentStep(-1)
    }
  }

  return (
    <div className="h-screen flex overflow-hidden relative">
      <div className="fixed inset-0 w-full h-full -z-10">
        {/* <div className="absolute inset-0 bg-[rgba(10,10,10,0.35)] bg-[linear-gradient(to_top,rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(to_left,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:36px_36px] backdrop-blur-[1px]" /> */}
        <Aurora colorStops={["#333", "#222", "#444"]} amplitude={1.2} blend={0.6} speed={0.8} />
      </div>
      {/* Chat Interface */}
      <motion.div 
        animate={{ 
          width: showStepsPanel ? "75%" : "100%" 
        }}
        transition={{ 
          duration: 0.8, 
          ease: "easeInOut" 
        }}
        className="flex flex-col items-center justify-center p-8 max-md:p-2 h-screen overflow-y-scroll hide-scroll"
      >
        <div className="w-full max-w-2xl ">
          {/* Header */}
          <div className="text-center mb-10 relative" style={{ minHeight: hasStartedChat ? '100px' : '250px' }}>
            {/* AI Visual - Always visible */}
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ 
                scale: hasStartedChat ? 1.75 : 1, 
                opacity: 1,
                width: hasStartedChat ? '80px' : '80px',
                height: hasStartedChat ? '80px' : '80px',
                y: hasStartedChat ? 0 : 0
              }}
              transition={{ duration: 0.8, ease: [0.25, 0.1, 0.25, 1] }}
              className={`bg-gradient-to-br from-white/20 to-white/5 backdrop-blur-xl rounded-full mx-auto flex items-center justify-center border-white/20 shadow-2xl shadow-white/50 overflow-hidden ${hasStartedChat ? 'border-2' : 'border-4'}`}
              style={{ position: 'relative', zIndex: 10 }}
            >
              <video src="/ai-visual.mp4" autoPlay muted loop className="w-full h-full object-cover rounded-full grayscale" />
            </motion.div>
            
            {/* Title and Subtitle - Absolute positioned */}
            <AnimatePresence>
              {!hasStartedChat && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5 }}
                  className="absolute left-0 right-0"
                  style={{ top: '110px' }}
                >
                  <motion.h1 
                    initial={{ y: 20, scale: 0.8 }}
                    animate={{ y: 0, scale: 1 }}
                    exit={{ scale: 0.3, y: -20 }}
                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                    className="text-5xl font-bold text-white mb-3 max-md:text-2xl"
                  >
                    Good Morning, User
                  </motion.h1>
                  <motion.p 
                    initial={{ y: 20, scale: 0.8 }}
                    animate={{ y: 0, scale: 1 }}
                    exit={{ scale: 0.3, y: -20 }}
                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1], delay: 0.05 }}
                    className="text-xl text-gray-300"
                  >
                    How Can I <span className="text-white font-medium">Assist You Today?</span>
                  </motion.p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Messages */}
          <div className="flex-1 space-y-4">
            <AnimatePresence>
              {messages.length === 0 && !hasStartedChat && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-center text-gray-400"
                >
                  {/* <p>Start a conversation to see the blockchain memory system in action!</p> */}
                </motion.div>
              )}
            </AnimatePresence>
            
            <AnimatePresence>
              {messages.map((message, index) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.3, delay: index * 0.05 }}
                  className={cn(
                    "flex",
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[75%] px-5 py-3.5 rounded-3xl shadow-lg",
                      message.role === 'user'
                        ? 'bg-white text-black font-medium'
                        : 'text-gray-100'
                    )}
                  >
                    {message.content}
                    {message.role === 'assistant' && memories.length > 0 && 
                     (message.content.includes('remember') || message.content.includes('recall')) && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="mt-3 font-black pt-2 flex items-center gap-2"
                      >
                        <Link className="w-4 h-4" /> Referenced from blockchain memory
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            
            <AnimatePresence>
              {(isLoading || isProcessing) && <ThinkingIndicator />}
            </AnimatePresence>
            <div ref={messagesEndRef} />
          </div>

          {/* Modern Chat Input */}
          <div className="sticky bottom-0">
            <form onSubmit={onSubmit} className="space-y-3">
              {/* Main Input Area */}
              <div className="bg-[#2a2a2a]/80 backdrop-blur-xl rounded-3xl p-2 border border-white/20 shadow-2xl hover:shadow-white/20 hover:border-white/20 transition-all duration-300">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      const form = e.currentTarget.closest('form')
                      if (form) {
                        form.requestSubmit()
                      }
                    }
                  }}
                  placeholder="Ask Anything... "
                  disabled={isLoading || isProcessing}
                  className={cn(
                    "min-h-[120px] bg-transparent border-none text-white text-lg rounded-2xl p-4",
                    "placeholder:text-gray-500 focus-visible:ring-0 focus-visible:ring-offset-0",
                    "resize-none w-full"
                  )}
                />
              </div>

              {/* Control Bar */}
              <div className="flex items-center justify-between gap-3 max-md:items-start">
                <div className="flex gap-2 max-md:flex-wrap">
                {/* Left side - Add button */}
                <Button
                  type="button"
                  size="icon"
                  className={cn(
                    "w-12 h-12 rounded-full bg-[#2a2a2a]/80 hover:bg-[#353535]/80 backdrop-blur-xl",
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
                    "bg-[#2a2a2a]/80 hover:bg-[#353535]/80 backdrop-blur-xl",
                    "border border-white/10 transition-all duration-200",
                    "text-gray-300"
                  )}
                >
                  <Search className="w-4 h-4" />
                  <span className="text-sm">Search</span>
                </Button>

                <AnimatePresence>
              {memories.length > 0 && (
                         <Button
                         type="button"
                         onClick={() => setIsMemorySheetOpen(true)}
                         className={cn(
                           "flex items-center gap-2 h-12 px-6 rounded-full",
                           "bg-[#2a2a2a]/80 hover:bg-[#353535]/80 backdrop-blur-xl",
                           "border border-white/10 transition-all duration-200",
                           "text-gray-300"
                         )}
                       >
                         <span className='font-bold'>{memories.length} {memories.length === 1 ? 'memory' : 'memories'} stored</span>
                       </Button>
              )}
            </AnimatePresence>
                </div>


                {/* Right side - Controls */}
                <div className="flex items-center gap-3">
                  {/* Microphone button */}
                  <Button
                    type="button"
                    size="icon"
                    className={cn(
                      "w-12 h-12 rounded-full bg-[#2a2a2a]/80 hover:bg-[#353535]/80 backdrop-blur-xl",
                      "border border-white/10 transition-all duration-200"
                    )}
                  >
                    <Mic className="w-5 h-5 text-gray-300" />
                  </Button>

                  {/* Send button */}
                  <Button
                    type="submit"
                    disabled={!input.trim() || isLoading || isProcessing}
                    size="icon"
                    className={cn(
                      "w-12 h-12 rounded-full transition-all duration-200",
                      input.trim() && !isLoading && !isProcessing
                        ? "bg-white hover:bg-gray-100 text-black shadow-lg"
                        : "bg-[#2a2a2a]/80 text-gray-500 border border-white/10 backdrop-blur-xl"
                    )}
                  >
                    <ArrowUp className="w-5 h-5" />
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </motion.div>

      {/* Process Steps Panel - Absolute positioned */}
      <AnimatePresence>
        {showStepsPanel && (
          <motion.div 
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ 
              duration: 0.7, 
              ease: [0.25, 0.1, 0.25, 1]
            }}
            className="fixed right-0 top-0 w-1/4 h-full z-20"
          >
            <div className="h-full relative">
              <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] via-transparent to-transparent pointer-events-none" />
              <StepVisualizer steps={PROCESS_STEPS} currentStep={currentStep} visibleSteps={visibleSteps} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Memory Sheet */}
      <Sheet open={isMemorySheetOpen} onOpenChange={setIsMemorySheetOpen}>
        <SheetContent side="right" className="w-[400px] sm:w-[540px] bg-background/20 border-none backdrop-blur-sm p-3 overflow-y-auto hide-scroll">
          <div className="space-y-3">
              {isLoadingMemories ? (
              <div className="text-center py-12 text-gray-400">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
                <p>Loading memories from blockchain...</p>
              </div>
            ) : memories.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Stars className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No memories stored yet</p>
                <p className="text-sm mt-2">Share personal information to save memories on blockchain</p>
              </div>
            ) : (
              memories.map((memory, index) => (
                <motion.div
                  key={memory.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="group relative p-4 bg-gradient-to-br from-white/10 via-white/5 to-transparent backdrop-blur-xl rounded-xl border border-white/20 hover:from-white/15 hover:border-white/30 transition-all duration-300"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    {memory.category && (
                      <span className="text-xs px-2 py-1 rounded-full bg-white/10 text-gray-300 border border-white/20">
                        {memory.category}
                      </span>
                    )}
                    {memory.importance && (
                      <span className="text-xs text-yellow-400">
                        {'⭐'.repeat(Math.min(memory.importance, 10) / 2)}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-200 text-sm leading-relaxed pr-8">
                    {memory.content}
                  </p>
                  <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
                    {/* <span className="flex items-center gap-1">
                      <Link className="w-3 h-3" />
                      Blockchain Memory
                    </span> */}
                    {memory.blobId && (
                      <span className="font-mono text-[10px] opacity-60">
                        {memory.blobId.substring(0, 40)}...
                      </span>
                    )}
                  </div>
                </motion.div>
              ))
            )}
          </div>

          {memories.length > 0 && (
            <div className="">
              <Button
                onClick={fetchMemoriesFromBlockchain}
                variant="outline"
                className="w-full bg-white/5 border-white/20 text-gray-300 hover:bg-white/10 hover:border-white/30"
                disabled={isLoadingMemories}
              >
                <Link className="w-4 h-4 mr-2" />
                {isLoadingMemories ? 'Refreshing...' : 'Refresh from Blockchain'}
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}