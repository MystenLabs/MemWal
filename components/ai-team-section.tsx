"use client"

import { useState, useEffect, useRef } from "react"
import { MessageCircle, Clock, Zap, Shield, Lock, CheckCircle } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { cn } from "@/lib/utils"

const conversations = [
  {
    title: "Instant KYC credential share",
    icon: Shield,
    color: "emerald",
    messages: [
      {
        text: "I'm onboarding with CarbonPay—need to verify my identity.",
        sender: "customer",
        delay: 0,
      },
      {
        text: "Select the credential you'd like to share. Passport, national ID, or proof-of-address?",
        sender: "ai",
        delay: 1000,
        processing: true,
      },
      {
        text: "Use my passport but limit it to 24 hours.",
        sender: "customer",
        delay: 2500,
      },
      {
        text: "Done. Passport encrypted, consent window set to 24h, CarbonPay notified, and the audit receipt is ready.",
        sender: "ai",
        delay: 3500,
        processing: true,
        status: "encrypted",
      },
      {
        text: "Great—send me the receipt link too.",
        sender: "customer",
        delay: 5000,
      },
      {
        text: "Shared. You can revoke at any time inside your wallet.",
        sender: "ai",
        delay: 6000,
        status: "completed",
      },
    ],
  },
  {
    title: "Scoped health data consent",
    icon: Lock,
    color: "blue",
    messages: [
      { text: "Dr. Chen requested my latest labs.", sender: "customer", delay: 0 },
      {
        text: "Do you want to release glucose + cholesterol only, or full record?",
        sender: "ai",
        delay: 1000,
        processing: true,
      },
      { text: "Glucose + cholesterol, expires in 7 days.", sender: "customer", delay: 2500 },
      {
        text: "Applied scope, tokenized, and stored proof in your SIEM connector.",
        sender: "ai",
        delay: 4000,
        processing: true,
        status: "scoped",
      },
      { text: "Notify me if it's accessed more than twice.", sender: "customer", delay: 5500 },
      {
        text: "Alert configured—I'll ping Slack + email if activity spikes.",
        sender: "ai",
        delay: 6500,
        status: "completed",
      },
    ],
  },
  {
    title: "On-demand data export",
    icon: CheckCircle,
    color: "violet",
    messages: [
      {
        text: "It's midnight. I want a full export for my records.",
        sender: "customer",
        delay: 0,
      },
      {
        text: "Packaging verified profile, activity, and credentials into an encrypted bundle.",
        sender: "ai",
        delay: 1000,
        processing: true,
      },
      { text: "Make it JSON + PDF summary.", sender: "customer", delay: 2500 },
      {
        text: "Ready. Download link mailed + stored in your secure inbox. I'll auto-expire it in 72h.",
        sender: "ai",
        delay: 4000,
        processing: true,
        status: "exported",
      },
      {
        text: "Thanks. Remind me to purge stale exports monthly.",
        sender: "customer",
        delay: 5500,
      },
      {
        text: "Scheduled. You'll get a digest on the first business day each month.",
        sender: "ai",
        delay: 6500,
        status: "completed",
      },
    ],
  },
]

export function AITeamSection() {
  const sectionRef = useRef<HTMLElement>(null) // Added section ref for intersection observer
  const [isVisible, setIsVisible] = useState(false)
  const [currentConversation, setCurrentConversation] = useState(0)
  const [displayedMessages, setDisplayedMessages] = useState<any[]>([])
  const [isTyping, setIsTyping] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          console.log("[v0] AI Team Section is now visible")
          setIsVisible(true)
        }
      },
      {
        threshold: 0.1,
        rootMargin: "0px 0px -100px 0px",
      },
    )

    if (sectionRef.current) {
      observer.observe(sectionRef.current)
    }

    return () => {
      if (sectionRef.current) {
        observer.unobserve(sectionRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth'
      })
    }
  }, [displayedMessages, isTyping])

  useEffect(() => {
    const conversation = conversations[currentConversation]
    setDisplayedMessages([])
    setIsTyping(false)

    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    let messageIndex = 0

    const showNextMessage = () => {
      if (messageIndex >= conversation.messages.length) {
        // Wait 3 seconds then move to next conversation
        timeoutRef.current = setTimeout(() => {
          setCurrentConversation((prev) => (prev + 1) % conversations.length)
        }, 3000)
        return
      }

      const message = conversation.messages[messageIndex]

      timeoutRef.current = setTimeout(() => {
        if (message.sender === "ai") {
          setIsTyping(true)
          timeoutRef.current = setTimeout(() => {
            setDisplayedMessages((prev) => [...prev, message])
            setIsTyping(false)
            messageIndex++
            showNextMessage()
          }, 800) // Reduced typing delay from 1500ms to 800ms for faster replies
        } else {
          setDisplayedMessages((prev) => [...prev, message])
          messageIndex++
          showNextMessage()
        }
      }, message.delay)
    }

    showNextMessage()

    // Cleanup timeout on unmount or conversation change
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [currentConversation])

  const CurrentIcon = conversations[currentConversation].icon

  return (
    <section id="ai-team" ref={sectionRef} className="relative z-10">
      <div className="bg-white rounded-[3rem] m-8 pt-16 sm:pt-24 pb-16 sm:pb-24 px-4 relative overflow-hidden">
        <div className="container mx-auto px-4 relative z-10">
          <div className="text-center mb-16">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 bg-slate-50 border border-slate-200 text-slate-700 px-4 py-2 rounded-full text-sm font-medium mb-6"
            >
              <MessageCircle className="w-4 h-4" />
              Live consent flows from the SDK
            </motion.div>

            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="text-4xl md:text-5xl font-bold text-slate-900 mb-4"
            >
              Watch data wallets handle{" "}
              <span className="bg-gradient-to-r from-slate-600 to-slate-400 bg-clip-text text-transparent">
                real consent requests
              </span>
            </motion.h2>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.6, delay: 0.4 }}
              className="text-xl text-slate-600 max-w-2xl mx-auto"
            >
              This is the exact drop-in chat experience teams embed to request, scope, and revoke personal data without
              writing new microservices.
            </motion.p>
          </div>

          <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-20 max-w-7xl mx-auto">
            {/* Left side - Text content */}
            <div className="w-full lg:w-1/2 flex flex-col justify-center lg:h-[600px] space-y-6 lg:space-y-8 order-2 lg:order-1">
              <motion.div
                initial={{ opacity: 0, x: -30 }}
                animate={isVisible ? { opacity: 1, x: 0 } : { opacity: 0, x: -30 }}
                transition={{ duration: 0.6, delay: 0.6 }}
              >
                <div className="flex items-center gap-3 mb-4 lg:mb-6">
                  <motion.div
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                    className={cn(
                      "w-10 h-10 rounded-full flex items-center justify-center",
                      conversations[currentConversation].color === "emerald" && "bg-emerald-100",
                      conversations[currentConversation].color === "blue" && "bg-blue-100",
                      conversations[currentConversation].color === "violet" && "bg-violet-100"
                    )}
                  >
                    <CurrentIcon className={cn(
                      "w-5 h-5",
                      conversations[currentConversation].color === "emerald" && "text-emerald-600",
                      conversations[currentConversation].color === "blue" && "text-blue-600",
                      conversations[currentConversation].color === "violet" && "text-violet-600"
                    )} />
                  </motion.div>
                  <h3 className="text-2xl lg:text-3xl font-bold text-slate-900">
                    {conversations[currentConversation].title}
                  </h3>
                </div>

                <div className="space-y-3 lg:space-y-4 text-base lg:text-lg text-slate-700 leading-relaxed">
                  <p>
                    The SDK ships with audited chat components, hook-based state, and encryption helpers so you can ask
                    for sensitive data the right way—anytime, anywhere.
                  </p>

                  <p>
                    Conversations stay on-brand while the wallet handles storage, key rotation, and audit trails in the
                    background.
                  </p>

                  <p className="text-lg lg:text-xl font-semibold text-slate-900">
                    Your users finally keep ownership, and you ship faster.
                  </p>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: -30 }}
                animate={isVisible ? { opacity: 1, x: 0 } : { opacity: 0, x: -30 }}
                transition={{ duration: 0.6, delay: 0.8 }}
              >
                <div className="p-4 lg:p-6 bg-slate-50 rounded-xl border-l-4 border-slate-900">
                  <p className="text-slate-800 font-medium text-sm lg:text-base">
                    "We rewrote our consent experience in a week. Legal signed off immediately because every wallet
                    event ships with immutable proofs."
                  </p>
                  <p className="text-xs lg:text-sm text-slate-600 mt-2">— Priya Rao, Chief Privacy Officer at Signal Bank</p>
                </div>
              </motion.div>
            </div>

            {/* Right side - Phone mockup */}
            <div className="w-full lg:w-1/2 flex justify-center order-1 lg:order-2">
              <div className="max-w-md w-full">
                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
                  transition={{ duration: 0.6, delay: 0.6 }}
                  className="relative"
                >
                  <div className="bg-slate-900 rounded-[2.5rem] p-2 shadow-2xl">
                    <div className="bg-black rounded-[2rem] p-1">
                      <div className="bg-white rounded-[1.5rem] overflow-hidden">
                        {/* Status bar */}
                        <div className="bg-slate-50 px-6 py-3 flex justify-between items-center text-sm">
                          <div className="flex items-center gap-1">
                            <motion.div 
                              animate={{ scale: [1, 1.2, 1] }}
                              transition={{ duration: 2, repeat: Infinity }}
                              className="w-2 h-2 bg-slate-900 rounded-full"
                            />
                            <span className="font-medium text-slate-700">Personal Data Wallet</span>
                          </div>
                          <div className="flex items-center gap-1 text-slate-500">
                            <Clock className="w-3 h-3" />
                            <span className="text-xs">24/7</span>
                          </div>
                        </div>

                        <div className="bg-slate-900 px-6 py-4 text-white">
                          <div className="flex items-center gap-3">
                            <img src="/images/michael-ai-agent.jpg" alt="PDW Agent" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                            <div className="flex-1">
                              <h3 className="font-semibold text-sm">PDW Assistant</h3>
                              <p className="text-xs text-slate-300">sdk personal-data-wallet</p>
                            </div>
                            <motion.div 
                              animate={{ opacity: [1, 0.5, 1] }}
                              transition={{ duration: 2, repeat: Infinity }}
                              className="text-xs text-green-400 flex items-center gap-1"
                            >
                              <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                              Online
                            </motion.div>
                          </div>
                        </div>

                        {/* Chat messages */}
                        <div
                          ref={chatContainerRef}
                          className="h-96 overflow-y-scroll scrollbar-hide p-4 space-y-3 bg-slate-50"
                          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
                        >
                          <AnimatePresence mode="popLayout">
                            {displayedMessages.map((message, index) => (
                              <motion.div
                                key={index}
                                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                transition={{ duration: 0.3 }}
                                className={cn(
                                  "flex",
                                  message.sender === "customer" ? "justify-end" : "justify-start"
                                )}
                              >
                                {message.sender === "ai" && (
                                  <img
                                    src="/images/michael-ai-agent.jpg"
                                    alt="PDW Agent"
                                    className="w-6 h-6 rounded-full object-cover mr-2 mt-1 flex-shrink-0"
                                  />
                                )}
                                <div
                                  className={cn(
                                    "max-w-[80%] p-3 rounded-2xl text-sm leading-relaxed relative",
                                    message.sender === "customer"
                                      ? "bg-slate-900 text-white rounded-br-md"
                                      : "bg-white text-slate-800 shadow-sm border border-slate-200 rounded-bl-md"
                                  )}
                                >
                                  {message.text.split("\n").map((line, i) => (
                                    <div key={i}>{line}</div>
                                  ))}
                                  {message.status && (
                                    <motion.div
                                      initial={{ opacity: 0, height: 0 }}
                                      animate={{ opacity: 1, height: "auto" }}
                                      className="mt-2 pt-2 border-t border-slate-200 text-xs flex items-center gap-1"
                                    >
                                      <CheckCircle className="w-3 h-3 text-green-600" />
                                      <span className="text-green-600 font-medium capitalize">{message.status}</span>
                                    </motion.div>
                                  )}
                                </div>
                                {message.sender === "customer" && (
                                  <div className="w-6 h-6 rounded-full bg-slate-400 ml-2 mt-1 flex-shrink-0 flex items-center justify-center text-xs text-white font-medium">
                                    C
                                  </div>
                                )}
                              </motion.div>
                            ))}
                          </AnimatePresence>

                          {/* Typing indicator */}
                          <AnimatePresence>
                            {isTyping && (
                              <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="flex justify-start items-start"
                              >
                                <img src="/images/michael-ai-agent.jpg" alt="PDW Agent" className="w-6 h-6 rounded-full object-cover mr-2 mt-1 flex-shrink-0" />
                                <div className="bg-white p-3 rounded-2xl rounded-bl-md shadow-sm border border-slate-200">
                                  <div className="flex space-x-1">
                                    <motion.div 
                                      animate={{ y: [0, -5, 0] }}
                                      transition={{ duration: 0.6, repeat: Infinity, ease: "easeInOut" }}
                                      className="w-2 h-2 bg-slate-400 rounded-full"
                                    />
                                    <motion.div
                                      animate={{ y: [0, -5, 0] }}
                                      transition={{ duration: 0.6, repeat: Infinity, ease: "easeInOut", delay: 0.1 }}
                                      className="w-2 h-2 bg-slate-400 rounded-full"
                                    />
                                    <motion.div
                                      animate={{ y: [0, -5, 0] }}
                                      transition={{ duration: 0.6, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
                                      className="w-2 h-2 bg-slate-400 rounded-full"
                                    />
                                  </div>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        <div className="p-4 bg-white border-t border-slate-200">
                          <div className="flex items-center gap-3 bg-slate-100 rounded-full px-4 py-2">
                            <span className="text-slate-500 text-sm lg:text-base flex-1">
                              {isTyping ? "Processing..." : "Wallet is responding..."}
                            </span>
                            <motion.div 
                              animate={{ rotate: isTyping ? 360 : 0 }}
                              transition={{ duration: 2, repeat: isTyping ? Infinity : 0, ease: "linear" }}
                              className="w-6 h-6 bg-slate-900 rounded-full flex items-center justify-center"
                            >
                              <Zap className="w-3 h-3 text-white" />
                            </motion.div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
