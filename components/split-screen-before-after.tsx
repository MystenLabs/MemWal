"use client"
import { useEffect, useRef, useState } from "react"
import type React from "react"

import Image from "next/image"

export function SplitScreenBeforeAfter() {
  const [sectionInView, setSectionInView] = useState(false)
  const [whatsappInView, setWhatsappInView] = useState(false)
  const [voiceInView, setVoiceInView] = useState(false)
  const [serviceInView, setServiceInView] = useState(false)
  const [tyreKickersInView, setTyreKickersInView] = useState(false)
  const [scrollY, setScrollY] = useState(0)
  const sectionRef = useRef<HTMLDivElement>(null)
  const whatsappSectionRef = useRef<HTMLDivElement>(null)
  const voiceSectionRef = useRef<HTMLDivElement>(null)
  const serviceSectionRef = useRef<HTMLDivElement>(null)
  const tyreKickersSectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observerOptions = {
      threshold: 0.1,
      rootMargin: "0px 0px -100px 0px",
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (entry.target === sectionRef.current) {
            setSectionInView(true)
          } else if (entry.target === whatsappSectionRef.current) {
            setWhatsappInView(true)
          } else if (entry.target === voiceSectionRef.current) {
            setVoiceInView(true)
          } else if (entry.target === serviceSectionRef.current) {
            setServiceInView(true)
          } else if (entry.target === tyreKickersSectionRef.current) {
            setTyreKickersInView(true)
          }
        }
      })
    }, observerOptions)

    if (sectionRef.current) observer.observe(sectionRef.current)
    if (whatsappSectionRef.current) observer.observe(whatsappSectionRef.current)
    if (voiceSectionRef.current) observer.observe(voiceSectionRef.current)
    if (serviceSectionRef.current) observer.observe(serviceSectionRef.current)
    if (tyreKickersSectionRef.current) observer.observe(tyreKickersSectionRef.current)

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const handleScroll = () => {
      if (window.innerWidth >= 1024) {
        setScrollY(window.scrollY)
      }
    }

    window.addEventListener("scroll", handleScroll, { passive: true })

    const handleResize = () => {
      if (window.innerWidth < 1024) {
        setScrollY(0)
      }
    }
    window.addEventListener("resize", handleResize)

    return () => {
      window.removeEventListener("scroll", handleScroll)
      window.removeEventListener("resize", handleResize)
    }
  }, [])

  const getParallaxOffset = (sectionRef: React.RefObject<HTMLDivElement>) => {
    if (!sectionRef.current || typeof window === "undefined" || window.innerWidth < 1024) {
      return 0
    }

    const rect = sectionRef.current.getBoundingClientRect()
    const sectionTop = rect.top + window.scrollY
    const sectionHeight = rect.height
    const windowHeight = window.innerHeight

    // Calculate how far we've scrolled into this section
    const scrollIntoSection = scrollY + windowHeight / 2 - sectionTop
    const scrollProgress = Math.max(0, Math.min(1, scrollIntoSection / sectionHeight))

    // Simple linear movement from 0 to 80px as you scroll through the section
    // This creates smooth downward movement without any jumps
    return scrollProgress * 80
  }

  const whatsappParallax = getParallaxOffset(whatsappSectionRef)
  const voiceParallax = getParallaxOffset(voiceSectionRef)

  return (
    <section ref={sectionRef} className="py-12 sm:py-16 md:py-20 relative z-10">
      <div>
        <div className="bg-white rounded-2xl sm:rounded-3xl p-6 sm:p-8 md:p-12 lg:p-16 shadow-lg">
          <div className="grid lg:grid-cols-[40%_1fr] gap-8 lg:gap-12 items-center">
            <div
              className={`transition-all duration-1000 ease-out ${
                sectionInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              }`}
            >
              <div className="relative aspect-[3/4] rounded-2xl overflow-hidden">
                <Image
                  src="/images/dealership-showroom.jpg"
                  alt="Modern car dealership showroom"
                  fill
                  className="object-cover"
                />
              </div>
            </div>

            <div
              className={`transition-all duration-1000 ease-out delay-200 ${
                sectionInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
              }`}
            >
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-orange-100 to-red-100 border border-orange-200 mb-4">
                <span className="text-orange-600 font-semibold text-sm uppercase tracking-wide">Clutch by Cliste</span>
              </div>

              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-8 lg:mb-12 text-balance">
                <span className="text-slate-900">Never miss a lead with</span>{" "}
                <span className="bg-gradient-to-r from-orange-600 via-orange-500 to-red-500 bg-clip-text text-transparent">
                  Clutch by Cliste
                </span>
              </h2>

              <div className="grid sm:grid-cols-2 gap-6 lg:gap-8">
                <div>
                  <h3 className="font-bold text-slate-900 text-xl mb-3">WhatsApp & Messenger</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Respond instantly to customer inquiries from WhatsApp, Facebook Messenger, and Instagram DMs. Never
                    leave a customer waiting again.
                  </p>
                </div>

                <div>
                  <h3 className="font-bold text-slate-900 text-xl mb-3">Phone Calls 24/7</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Handle unlimited inbound calls around the clock. Answer questions, book test drives, and qualify
                    leads even after hours.
                  </p>
                </div>

                <div>
                  <h3 className="font-bold text-slate-900 text-xl mb-3">Website Chat Widget</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Engage visitors the moment they land on your site. Provide instant answers about inventory, pricing,
                    and availability in real-time.
                  </p>
                </div>

                <div>
                  <h3 className="font-bold text-slate-900 text-xl mb-3">Email & SMS</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Automatically respond to email inquiries and text messages. Keep conversations flowing across every
                    channel your customers prefer.
                  </p>
                </div>

                <div>
                  <h3 className="font-bold text-slate-900 text-xl mb-3">Lead Qualification</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Automatically identify high-intent buyers, capture budget ranges, vehicle preferences, and trade-in
                    details before your team gets involved.
                  </p>
                </div>

                <div>
                  <h3 className="font-bold text-slate-900 text-xl mb-3">Instant Booking</h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    Schedule test drives, service appointments, and viewings automatically. Sync with your calendar and
                    send confirmations instantly.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div ref={whatsappSectionRef} className="mt-16 lg:mt-24 pt-16 lg:pt-24 border-t border-slate-200">
            <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
              <div
                className={`transition-all duration-1000 ease-out ${
                  whatsappInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                }`}
              >
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-orange-100 to-red-100 border border-orange-200 mb-4">
                  <svg className="w-4 h-4 text-orange-600" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
                  </svg>
                  <span className="text-orange-600 font-semibold text-sm uppercase tracking-wide">Messaging</span>
                </div>

                <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-6 text-balance">
                  <span className="text-slate-900">Respond to every message</span>{" "}
                  <span className="bg-gradient-to-r from-orange-600 via-orange-500 to-red-500 bg-clip-text text-transparent">
                    instantly, 24/7
                  </span>
                </h2>

                <p className="text-slate-600 text-lg mb-8 leading-relaxed">
                  Clutch by Cliste handles all your WhatsApp, Messenger, and Instagram DM conversations automatically.
                  Never miss a lead, even after hours or during busy times.
                </p>

                <div className="space-y-4">
                  <div className="flex gap-3">
                    <svg
                      className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <p className="text-slate-700 leading-relaxed">
                      Respond instantly to customer inquiries across WhatsApp, Facebook Messenger, and Instagram DMs.
                      Handle unlimited conversations simultaneously with consistent, professional responses that book
                      test drives and qualify leads automatically.
                    </p>
                  </div>

                  <div className="flex gap-3">
                    <svg
                      className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <p className="text-slate-700 leading-relaxed">
                      Capture complete customer information including vehicle preferences, budget range, trade-in
                      details, and contact information. Every conversation is logged with full history, so your sales
                      team always has context.
                    </p>
                  </div>

                  <div className="flex gap-3">
                    <svg
                      className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <p className="text-slate-700 leading-relaxed">
                      Deliver consistent, on-brand responses that enhance your dealership's reputation. Customers
                      receive instant, helpful answers that feel personal and professional, building trust from the
                      first message.
                    </p>
                  </div>
                </div>
              </div>

              {/* Phone mockups on RIGHT */}
              <div
                className={`transition-all duration-1000 ease-out delay-200 ${
                  whatsappInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                }`}
              >
                <div className="relative h-[550px] lg:h-[700px] max-w-[500px] lg:max-w-none mx-auto">
                  {/* Smaller phone - NO parallax */}
                  <div className="absolute left-0 top-12 w-[160px] lg:w-[45%] z-10">
                    <div className="bg-slate-900 rounded-[2rem] sm:rounded-[2.5rem] p-2 sm:p-3 lg:p-4 shadow-2xl border-[6px] sm:border-8 border-slate-800 aspect-[9/19.5] lg:aspect-auto lg:h-[600px] overflow-hidden">
                      <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-t-xl sm:rounded-t-[1.25rem] px-3 py-2 lg:py-3 flex items-center gap-2">
                        <div className="w-7 h-7 sm:w-8 sm:h-8 lg:w-10 lg:h-10 rounded-full bg-slate-400 flex items-center justify-center text-slate-700 font-semibold text-[10px] sm:text-xs lg:text-sm">
                          JD
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white font-semibold text-[11px] sm:text-xs lg:text-sm truncate">
                            John Doe
                          </div>
                          <div className="text-slate-400 text-[9px] sm:text-[10px] lg:text-xs">Customer</div>
                        </div>
                      </div>
                      <div className="bg-[#0d1418] rounded-b-xl sm:rounded-b-[1.25rem] p-2 sm:p-3 lg:p-4 h-[calc(100%-60px)] lg:h-[calc(100%-80px)] overflow-hidden">
                        <div className="mb-2">
                          <div className="bg-[#1f2c34] rounded-lg rounded-tl-none p-2 inline-block max-w-[90%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              Hello, I'm interested in the BMW X5 you have listed
                            </p>
                            <p className="text-slate-400 text-[8px] lg:text-xs mt-0.5">19:00</p>
                          </div>
                        </div>

                        <div className="mb-2 flex justify-end">
                          <div className="bg-[#005c4b] rounded-lg rounded-tr-none p-2 inline-block max-w-[90%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              We're currently closed. Business hours: 9 AM - 6 PM. We'll respond tomorrow!
                            </p>
                            <p className="text-slate-300 text-[8px] lg:text-xs mt-0.5 text-right">19:00</p>
                          </div>
                        </div>

                        <div className="mb-2">
                          <div className="bg-[#1f2c34] rounded-lg rounded-tl-none p-2 inline-block max-w-[90%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">Hello?</p>
                            <p className="text-slate-400 text-[8px] lg:text-xs mt-0.5">19:10</p>
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <div className="bg-[#005c4b] rounded-lg rounded-tr-none p-2 inline-block max-w-[90%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              We're currently closed. Business hours: 9 AM - 6 PM.
                            </p>
                            <p className="text-slate-300 text-[8px] lg:text-xs mt-0.5 text-right">19:10</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div
                    className="absolute right-0 top-0 w-[200px] lg:w-[60%] z-20 transition-transform duration-500 ease-out will-change-transform"
                    style={{
                      transform: `translateY(${whatsappParallax}px)`,
                    }}
                  >
                    <div className="bg-slate-900 rounded-[2rem] sm:rounded-[2.5rem] p-2 sm:p-3 lg:p-4 shadow-2xl border-[6px] sm:border-8 border-slate-800 aspect-[9/19.5] lg:aspect-auto lg:h-[700px] overflow-hidden">
                      <div className="bg-[#0a5c4a] rounded-t-xl sm:rounded-t-[1.25rem] px-3 py-2 lg:py-3 flex items-center gap-2">
                        <div className="w-7 h-7 sm:w-8 sm:h-8 lg:w-10 lg:h-10 rounded-full bg-slate-400 flex items-center justify-center text-slate-700 font-semibold text-[10px] sm:text-xs lg:text-sm">
                          JD
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white font-semibold text-[11px] sm:text-xs lg:text-sm truncate">
                            John Doe
                          </div>
                          <div className="text-slate-300 text-[9px] sm:text-[10px] lg:text-xs">Customer</div>
                        </div>
                      </div>
                      <div className="bg-[#0d1418] rounded-b-xl sm:rounded-b-[1.25rem] p-2 sm:p-3 lg:p-4 h-[calc(100%-60px)] lg:h-[calc(100%-80px)] overflow-y-auto scrollbar-hide">
                        <div className="mb-2 lg:mb-3">
                          <div className="bg-[#1f2c34] rounded-lg rounded-tl-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              Hello, I'm interested in the BMW X5 you have listed
                            </p>
                            <p className="text-slate-400 text-[8px] lg:text-xs mt-0.5">19:00</p>
                          </div>
                        </div>

                        <div className="mb-2 lg:mb-3 flex justify-end">
                          <div className="bg-[#005c4b] rounded-lg rounded-tr-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              Hi John! Thanks for your interest in the BMW X5. I'd be happy to schedule a test drive. 🚗
                            </p>
                            <p className="text-slate-300 text-[8px] lg:text-xs mt-0.5 text-right">19:00</p>
                          </div>
                        </div>

                        <div className="mb-2 lg:mb-3">
                          <div className="bg-[#1f2c34] rounded-lg rounded-tl-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              That would be great! When are you available?
                            </p>
                            <p className="text-slate-400 text-[8px] lg:text-xs mt-0.5">19:01</p>
                          </div>
                        </div>

                        <div className="mb-2 lg:mb-3 flex justify-end">
                          <div className="bg-[#005c4b] rounded-lg rounded-tr-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              I have availability tomorrow at 10am, 2pm, or 4pm. Which time works best?
                            </p>
                            <p className="text-slate-300 text-[8px] lg:text-xs mt-0.5 text-right">19:01</p>
                          </div>
                        </div>

                        <div className="mb-2 lg:mb-3">
                          <div className="bg-[#1f2c34] rounded-lg rounded-tl-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              2pm works perfect. What's the price?
                            </p>
                            <p className="text-slate-400 text-[8px] lg:text-xs mt-0.5">19:02</p>
                          </div>
                        </div>

                        <div className="mb-2 lg:mb-3 flex justify-end">
                          <div className="bg-[#005c4b] rounded-lg rounded-tr-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              Perfect! I've booked you for 2pm tomorrow. The BMW X5 is €45,900. 2023 model, 15,000km.
                              Financing options?
                            </p>
                            <p className="text-slate-300 text-[8px] lg:text-xs mt-0.5 text-right">19:02</p>
                          </div>
                        </div>

                        <div className="mb-2 lg:mb-3">
                          <div className="bg-[#1f2c34] rounded-lg rounded-tl-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              Yes please! Do you accept trade-ins?
                            </p>
                            <p className="text-slate-400 text-[8px] lg:text-xs mt-0.5">19:03</p>
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <div className="bg-[#005c4b] rounded-lg rounded-tr-none p-2 inline-block max-w-[85%]">
                            <p className="text-white text-[9px] sm:text-[10px] lg:text-sm leading-snug">
                              We accept trade-ins. What vehicle do you have? I can give you an instant estimate. 💰
                            </p>
                            <p className="text-slate-300 text-[8px] lg:text-xs mt-0.5 text-right">19:03</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Voice Agent Section - order is already correct: phones LEFT, text RIGHT */}
            <div ref={voiceSectionRef} className="mt-16 lg:mt-24 pt-16 lg:pt-24 border-t border-slate-200">
              <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
                <div
                  className={`order-2 lg:order-1 transition-all duration-1000 ease-out ${
                    voiceInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                  }`}
                >
                  <div className="relative h-[550px] lg:h-[700px] max-w-[500px] lg:max-w-none mx-auto">
                    <div
                      className="absolute right-0 top-0 w-[200px] lg:w-[60%] z-20 transition-transform duration-500 ease-out will-change-transform"
                      style={{
                        transform: `translateY(${voiceParallax}px)`,
                      }}
                    >
                      <div className="bg-slate-900 rounded-[2rem] sm:rounded-[2.5rem] p-2 sm:p-3 lg:p-4 shadow-2xl border-[6px] sm:border-8 border-slate-800 aspect-[9/19.5] lg:aspect-auto lg:h-[700px] overflow-hidden">
                        <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-t-xl sm:rounded-t-[1.25rem] px-3 py-4 sm:py-5 lg:py-8 text-center border-b border-slate-700">
                          <div className="text-red-400 text-[9px] sm:text-[10px] lg:text-sm mb-2 lg:mb-3 font-medium tracking-wide">
                            MISSED CALL
                          </div>
                          <div className="w-12 h-12 sm:w-14 sm:h-14 lg:w-20 lg:h-20 mx-auto rounded-full bg-gradient-to-br from-red-500 via-red-600 to-red-700 flex items-center justify-center mb-2 sm:mb-3 lg:mb-4 shadow-lg shadow-red-500/30 ring-4 ring-red-500/20">
                            <svg
                              className="w-6 h-6 sm:w-7 sm:h-7 lg:w-10 lg:h-10 text-white"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </div>
                          <div className="text-white font-bold text-xs sm:text-sm lg:text-lg mb-1">Sarah Mitchell</div>
                          <div className="text-slate-400 text-[9px] sm:text-[10px] lg:text-sm font-mono">
                            +353 87 123 4567
                          </div>
                        </div>
                        <div className="bg-slate-900 rounded-b-xl sm:rounded-b-[1.25rem] p-2 sm:p-3 lg:p-4 h-[calc(100%-140px)] lg:h-[calc(100%-200px)] overflow-hidden flex flex-col">
                          <div className="bg-gradient-to-br from-red-500/20 to-red-600/20 border-2 border-red-500/40 rounded-xl p-2 lg:p-3 mb-2 lg:mb-3">
                            <div className="text-center">
                              <div className="text-red-400 text-[10px] sm:text-xs lg:text-sm font-bold mb-1">
                                WE'RE CURRENTLY CLOSED
                              </div>
                              <div className="text-slate-300 text-[8px] sm:text-[10px] lg:text-xs">
                                Office Hours: Mon-Fri
                              </div>
                              <div className="text-white text-[9px] sm:text-[10px] lg:text-sm font-semibold">
                                9:00 AM - 5:00 PM
                              </div>
                            </div>
                          </div>

                          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-2 lg:p-3 mb-2 lg:mb-3">
                            <div className="text-slate-300 text-[9px] sm:text-[10px] lg:text-sm font-semibold mb-1.5">
                              Call Details
                            </div>
                            <div className="space-y-1 text-[8px] sm:text-[9px] lg:text-xs">
                              <div className="flex justify-between">
                                <span className="text-slate-400">Time</span>
                                <span className="text-white font-medium">7:00 PM</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-400">Duration</span>
                                <span className="text-white font-medium">3 rings</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-400">Status</span>
                                <span className="text-red-400 font-semibold">Unanswered</span>
                              </div>
                            </div>
                          </div>

                          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-2 lg:p-3 mb-2 lg:mb-3">
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <svg
                                className="w-3 h-3 lg:w-4 lg:h-4 text-slate-400"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                              >
                                <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
                              </svg>
                              <span className="text-slate-300 text-[9px] sm:text-[10px] lg:text-xs font-medium">
                                Voicemail
                              </span>
                            </div>
                            <div className="text-slate-400 text-[8px] sm:text-[9px] lg:text-xs italic leading-relaxed">
                              "Hi, you've reached Premium Motors. We're currently closed. Please leave a message..."
                            </div>
                          </div>

                          <div className="mt-auto bg-gradient-to-br from-red-500/20 to-red-600/20 border-2 border-red-500/40 rounded-xl p-2 lg:p-3">
                            <div className="flex items-center justify-center gap-1.5">
                              <svg
                                className="w-3 h-3 lg:w-4 lg:h-4 text-red-400"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              <span className="text-red-400 text-[9px] sm:text-[10px] lg:text-sm font-bold uppercase tracking-wide">
                                Lead Lost
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Smaller phone - NO parallax */}
                  <div className="absolute left-0 top-12 w-[160px] lg:w-[45%] z-10">
                    <div className="bg-slate-900 rounded-[2rem] sm:rounded-[2.5rem] p-2 sm:p-3 lg:p-4 shadow-2xl border-[6px] sm:border-8 border-slate-800 aspect-[9/19.5] lg:aspect-auto lg:h-[600px] overflow-hidden">
                      <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-t-xl sm:rounded-t-[1.25rem] px-3 py-4 sm:py-5 lg:py-8 text-center border-b border-slate-700">
                        <div className="text-slate-400 text-[9px] sm:text-[10px] lg:text-sm mb-2 lg:mb-3 font-medium tracking-wide">
                          INCOMING CALL
                        </div>
                        <div className="w-12 h-12 sm:w-14 sm:h-14 lg:w-20 lg:h-20 mx-auto rounded-full bg-gradient-to-br from-orange-500 via-orange-600 to-red-600 flex items-center justify-center mb-2 sm:mb-3 lg:mb-4 shadow-lg shadow-orange-500/30 ring-4 ring-orange-500/20">
                          <svg
                            className="w-6 h-6 sm:w-7 sm:h-7 lg:w-10 lg:h-10 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                            />
                          </svg>
                        </div>
                        <div className="text-white font-bold text-xs sm:text-sm lg:text-lg mb-1">Sarah Mitchell</div>
                        <div className="text-slate-400 text-[9px] sm:text-[10px] lg:text-xs font-mono">
                          +353 87 123 4567
                        </div>
                      </div>

                      <div className="bg-[#0d1418] rounded-b-xl sm:rounded-b-[1.25rem] p-2 sm:p-3 lg:p-4 h-[calc(100%-140px)] lg:h-[calc(100%-200px)] overflow-y-auto scrollbar-hide space-y-2 lg:space-y-3">
                        <div className="bg-gradient-to-br from-slate-800 to-slate-800/80 rounded-xl p-2 sm:p-3 lg:p-4 border border-slate-700">
                          <div className="flex items-center gap-2 mb-2">
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse shadow-lg shadow-green-400/50"></div>
                            <span className="text-white text-[10px] sm:text-xs lg:text-sm font-semibold">
                              Call Active
                            </span>
                            <span className="ml-auto text-slate-400 text-[9px] lg:text-xs font-mono">02:34</span>
                          </div>
                          <div className="h-8 lg:h-12 flex items-center gap-1">
                            {[...Array(20)].map((_, i) => (
                              <div
                                key={i}
                                className="flex-1 bg-gradient-to-t from-orange-500 to-orange-400 rounded-full"
                                style={{
                                  height: `${Math.random() * 60 + 40}%`,
                                  animation: `pulse ${Math.random() * 0.5 + 0.5}s ease-in-out infinite`,
                                }}
                              />
                            ))}
                          </div>
                        </div>

                        <div className="bg-slate-800/50 rounded-xl p-2 sm:p-3 lg:p-4 border border-slate-700/50">
                          <div className="flex items-center gap-2 mb-2 lg:mb-3">
                            <svg
                              className="w-3 h-3 lg:w-4 lg:h-4 text-orange-400"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                            <span className="text-slate-300 text-[9px] sm:text-[10px] lg:text-sm font-semibold">
                              Live Conversation
                            </span>
                          </div>
                          <div className="space-y-2 lg:space-y-3 text-[8px] sm:text-[9px] lg:text-xs">
                            <div className="bg-slate-900/50 rounded-lg p-2 border-l-2 border-orange-500">
                              <div className="text-orange-400 font-semibold mb-0.5">Cliste</div>
                              <div className="text-slate-300 leading-relaxed">
                                "The Audi A4 is available. Would you like to schedule a test drive?"
                              </div>
                            </div>
                            <div className="bg-slate-900/50 rounded-lg p-2 border-l-2 border-blue-500">
                              <div className="text-blue-400 font-semibold mb-0.5">Sarah</div>
                              <div className="text-slate-300 leading-relaxed">
                                "Yes please! What times do you have available this week?"
                              </div>
                            </div>
                            <div className="bg-slate-900/50 rounded-lg p-2 border-l-2 border-orange-500">
                              <div className="text-orange-400 font-semibold mb-0.5">Cliste</div>
                              <div className="text-slate-300 leading-relaxed">
                                "I have tomorrow at 11am, Thursday at 3pm, or Friday at 10am..."
                              </div>
                            </div>
                            <div className="bg-slate-900/50 rounded-lg p-2 border-l-2 border-blue-500">
                              <div className="text-blue-400 font-semibold mb-0.5">Sarah</div>
                              <div className="text-slate-300 leading-relaxed">
                                "Thursday at 3pm works perfectly. What's the price on that model?"
                              </div>
                            </div>
                            <div className="bg-slate-900/50 rounded-lg p-2 border-l-2 border-orange-500">
                              <div className="text-orange-400 font-semibold mb-0.5">Cliste</div>
                              <div className="text-slate-300 leading-relaxed">
                                "The Audi A4 is priced at €32,500. It's a 2023 model with 12,000km. Would you like to
                                discuss financing options?"
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="bg-gradient-to-br from-orange-500/20 to-red-500/20 border-2 border-orange-500/40 rounded-xl p-2 lg:p-3 shadow-lg shadow-orange-500/10">
                          <div className="flex items-center gap-1.5">
                            <svg
                              className="w-3 h-3 lg:w-4 lg:h-4 text-orange-400"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
                              <path
                                fillRule="evenodd"
                                d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zM6 8a1 1 0 000 2h.01a1 1 0 100-2H6zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z"
                                clipRule="evenodd"
                              />
                            </svg>
                            <span className="text-orange-300 text-[9px] sm:text-[10px] lg:text-xs font-bold uppercase tracking-wide">
                              Lead Insights
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-1.5 text-[8px] sm:text-[9px] lg:text-xs">
                            <div className="bg-slate-900/40 rounded-lg p-1.5 border border-orange-500/20">
                              <div className="text-orange-300 font-semibold">High Intent</div>
                              <div className="text-slate-300">Ready to buy</div>
                            </div>
                            <div className="bg-slate-900/40 rounded-lg p-1.5 border border-orange-500/20">
                              <div className="text-orange-300 font-semibold">€30-35k</div>
                              <div className="text-slate-300">Budget range</div>
                            </div>
                            <div className="bg-slate-900/40 rounded-lg p-1.5 border border-orange-500/20 col-span-2">
                              <div className="text-orange-300 font-semibold">Audi A4 • Sedan • Automatic</div>
                              <div className="text-slate-300">Vehicle preferences</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  className={`order-1 lg:order-2 transition-all duration-1000 ease-out delay-200 ${
                    voiceInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                  }`}
                >
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-orange-100 to-red-100 border border-orange-200 mb-4">
                    <svg className="w-4 h-4 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                      />
                    </svg>
                    <span className="text-orange-600 font-semibold text-sm uppercase tracking-wide">Voice Calls</span>
                  </div>

                  <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-6 text-balance">
                    <span className="text-slate-900">Answer every call</span>{" "}
                    <span className="bg-gradient-to-r from-orange-600 via-orange-500 to-red-500 bg-clip-text text-transparent">
                      instantly, 24/7
                    </span>
                  </h2>

                  <p className="text-slate-600 text-lg mb-8 leading-relaxed">
                    Never miss a lead with intelligent phone automation that handles unlimited calls around the clock.
                    Book test drives, answer questions, and qualify leads automatically.
                  </p>

                  <div className="space-y-4">
                    <div className="flex gap-3">
                      <svg
                        className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <p className="text-slate-700 leading-relaxed">
                        Answer every call instantly with natural-sounding conversations that understand your inventory,
                        pricing, and availability. Never lose a customer to voicemail again.
                      </p>
                    </div>

                    <div className="flex gap-3">
                      <svg
                        className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <p className="text-slate-700 leading-relaxed">
                        Book test drives, answer vehicle questions, provide pricing, and handle trade-in inquiries
                        through natural phone conversations that feel completely human.
                      </p>
                    </div>

                    <div className="flex gap-3">
                      <svg
                        className="w-6 h-6 text-green-500 flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <p className="text-slate-700 leading-relaxed">
                        Get real-time insights on every call including customer intent, budget range, and vehicle
                        preferences. Your sales team receives warm leads ready to close.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Service & Parts Section */}
            <div ref={serviceSectionRef} className="mt-12 lg:mt-16 pt-12 lg:pt-16 border-t border-slate-200">
              <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
                <div
                  className={`transition-all duration-1000 ease-out ${
                    serviceInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                  }`}
                >
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-orange-100 to-red-100 border border-orange-200 mb-4">
                    <svg className="w-4 h-4 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    <span className="text-orange-600 font-semibold text-sm uppercase tracking-wide">
                      Service & Parts
                    </span>
                  </div>

                  <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-6 text-balance">
                    <span className="text-slate-900">Automate Service</span>{" "}
                    <span className="bg-gradient-to-r from-orange-600 via-orange-500 to-red-500 bg-clip-text text-transparent">
                      Bookings & Parts
                    </span>
                  </h2>

                  <p className="text-slate-600 text-lg mb-8 leading-relaxed">
                    Handle service appointments and parts inquiries automatically across all your sales channels -
                    website, phone, and social media. Clutch By Cliste manages bookings, answers parts questions, and
                    processes orders seamlessly, all customized to your dealership's operations.
                  </p>

                  <div className="space-y-6">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">Service Bookings</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Clutch By Cliste automatically schedules service appointments and sends confirmations across all
                        channels - website, phone, and social media, customized to your workflow
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">Parts Inquiries</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Answers questions about parts availability, pricing, and delivery times based on your inventory
                        in real-time, whether customers reach out via phone, website, or social media
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
                            <path
                              fillRule="evenodd"
                              d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">Order Management</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Processes parts orders and provides tracking updates without human intervention across every
                        customer touchpoint, tailored to your systems
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                            <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">Customer Updates</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Keeps customers informed about service progress and parts arrival status 24/7 in real-time
                        across messaging, or getting push notifications, all customized to your communication style
                      </p>
                    </div>
                  </div>
                </div>

                <div
                  className={`transition-all duration-1000 ease-out delay-200 ${
                    serviceInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                  }`}
                >
                  <div
                    className="relative max-w-[500px] mx-auto lg:max-w-none overflow-hidden"
                    style={{ height: "650px" }}
                  >
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 lg:rotate-6 w-full max-w-[380px]">
                      <div className="bg-white rounded-3xl overflow-hidden">
                        {/* Chat header */}
                        <div className="bg-gradient-to-r from-orange-500 to-red-500 px-6 py-4 flex items-center gap-3">
                          <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                            <span className="text-white font-bold text-lg">PM</span>
                          </div>
                          <div className="flex-1">
                            <div className="text-white font-bold text-lg">premium_motors</div>
                            <div className="text-orange-100 text-sm">Active now</div>
                          </div>
                        </div>

                        {/* Chat messages */}
                        <div className="p-6 space-y-4 bg-slate-50 h-[500px] overflow-hidden">
                          <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-slate-300 flex-shrink-0"></div>
                            <div className="flex-1">
                              <div className="bg-white rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                                <p className="text-slate-700 text-sm">Hi, I need to book a service for my car</p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1 block">10:15 AM</span>
                            </div>
                          </div>

                          <div className="flex gap-3 justify-end">
                            <div className="flex-1 flex flex-col items-end">
                              <div className="bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm max-w-[85%]">
                                <p className="text-white text-sm">
                                  I'd be happy to help! What type of service do you need? We have slots available this
                                  week.
                                </p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1">10:15 AM</span>
                            </div>
                          </div>

                          <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-slate-300 flex-shrink-0"></div>
                            <div className="flex-1">
                              <div className="bg-white rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                                <p className="text-slate-700 text-sm">
                                  Full service. Also, do you have brake pads in stock?
                                </p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1 block">10:16 AM</span>
                            </div>
                          </div>

                          <div className="flex gap-3 justify-end">
                            <div className="flex-1 flex flex-col items-end">
                              <div className="bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm max-w-[85%]">
                                <p className="text-white text-sm">
                                  Yes! We have brake pads in stock. I can book you in for Thursday at 2 PM and include
                                  the brake pad replacement. Total: €180
                                </p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1">10:16 AM</span>
                            </div>
                          </div>

                          <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-slate-300 flex-shrink-0"></div>
                            <div className="flex-1">
                              <div className="bg-white rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                                <p className="text-slate-700 text-sm">Perfect! Can I order an oil filter too?</p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1 block">10:17 AM</span>
                            </div>
                          </div>

                          <div className="flex gap-3 justify-end">
                            <div className="flex-1 flex flex-col items-end">
                              <div className="bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm max-w-[85%]">
                                <p className="text-white text-sm">
                                  I've added an oil filter (#GF35) to your order. Your appointment is confirmed for
                                  Thursday at 2 PM. See you then!
                                </p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1">10:17 AM</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Tyre Kickers Section - swapped order so chat mockup is on LEFT, text on RIGHT */}
                <div
                  ref={tyreKickersSectionRef}
                  className={`order-2 lg:order-1 transition-all duration-1000 ease-out ${
                    tyreKickersInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                  }`}
                >
                  <div className="relative h-[650px] overflow-hidden">
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 lg:-rotate-6 w-full max-w-[380px]">
                      <div className="bg-white rounded-3xl overflow-hidden">
                        <div className="bg-gradient-to-r from-orange-500 to-red-500 px-6 py-4 flex items-center gap-3">
                          <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                            <span className="text-white font-bold text-lg">PM</span>
                          </div>
                          <div className="flex-1">
                            <div className="text-white font-bold text-lg">Premium Motors</div>
                            <div className="text-orange-100 text-sm">Active now</div>
                          </div>
                        </div>

                        <div className="p-6 space-y-4 bg-slate-50 h-[500px] overflow-hidden">
                          <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-slate-300 flex-shrink-0"></div>
                            <div className="flex-1">
                              <div className="bg-white rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                                <p className="text-slate-700 text-sm">What's the NCT status on the BMW?</p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1 block">14:23</span>
                            </div>
                          </div>

                          <div className="flex gap-3 justify-end">
                            <div className="flex-1 flex flex-col items-end">
                              <div className="bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm max-w-[85%]">
                                <p className="text-white text-sm">
                                  The BMW has a fresh NCT valid until March 2026. Full service history available!
                                </p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1">14:23</span>
                            </div>
                          </div>

                          <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-slate-300 flex-shrink-0"></div>
                            <div className="flex-1">
                              <div className="bg-white rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                                <p className="text-slate-700 text-sm">How many miles?</p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1 block">14:24</span>
                            </div>
                          </div>

                          <div className="flex gap-3 justify-end">
                            <div className="flex-1 flex flex-col items-end">
                              <div className="bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm max-w-[85%]">
                                <p className="text-white text-sm">
                                  45,000 miles with full dealer service history. Would you like to schedule a test
                                  drive?
                                </p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1">14:24</span>
                            </div>
                          </div>

                          <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-slate-300 flex-shrink-0"></div>
                            <div className="flex-1">
                              <div className="bg-white rounded-2xl rounded-tl-none px-4 py-3 shadow-sm">
                                <p className="text-slate-700 text-sm">Do you take trade-ins?</p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1 block">14:25</span>
                            </div>
                          </div>

                          <div className="flex gap-3 justify-end">
                            <div className="flex-1 flex flex-col items-end">
                              <div className="bg-gradient-to-r from-orange-500 to-red-500 rounded-2xl rounded-tr-none px-4 py-3 shadow-sm max-w-[85%]">
                                <p className="text-white text-sm">
                                  Yes! We offer competitive trade-in values. What vehicle are you looking to trade?
                                </p>
                              </div>
                              <span className="text-xs text-slate-400 mt-1">14:25</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Text on RIGHT desktop, ABOVE on mobile */}
                <div
                  className={`order-1 lg:order-2 transition-all duration-1000 ease-out delay-200 ${
                    tyreKickersInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
                  }`}
                >
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-orange-100 to-red-100 border border-orange-200 mb-4">
                    <svg className="w-4 h-4 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                      />
                    </svg>
                    <span className="text-orange-600 font-semibold text-sm uppercase tracking-wide">
                      Smart Filtering
                    </span>
                  </div>

                  <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mb-6 text-balance">
                    <span className="text-slate-900">Handle Tyre Kickers</span>{" "}
                    <span className="bg-gradient-to-r from-orange-600 via-orange-500 to-red-500 bg-clip-text text-transparent">
                      Automatically
                    </span>
                  </h2>

                  <p className="text-slate-600 text-lg mb-8 leading-relaxed">
                    Stop wasting time on repetitive questions. Clutch By Cliste instantly answers common inquiries about
                    NCT, mileage, trade-ins, and pricing while qualifying serious buyers - across your website widget,
                    phone calls, and social media channels, all tailored to your dealership's specific needs.
                  </p>

                  <div className="space-y-6">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">Instant Answers</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Clutch By Cliste responds to 50+ common questions about NCT, mileage, trade-ins, and pricing
                        instantly across your website, phone, and social channels
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
                            <path
                              fillRule="evenodd"
                              d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm9.707 5.707a1 1 0 00-1.414-1.414L9 12.586l-1.293-1.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">Qualify Leads</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Automatically filters serious buyers from browsers by asking the right questions tailored to
                        your dealership
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">Save Time</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Stop answering the same questions repeatedly - let Clutch By Cliste handle the tire kickers
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
                          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                        <h3 className="font-bold text-slate-900 text-lg">24/7 Availability</h3>
                      </div>
                      <p className="text-slate-600 text-sm leading-relaxed ml-12">
                        Never miss a serious inquiry while filtering out time-wasters around the clock - on every
                        channel
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
