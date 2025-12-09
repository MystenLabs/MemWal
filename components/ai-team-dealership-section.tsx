"use client"

import { useEffect, useRef, useState } from "react"

export function AiTeamDealershipSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [callsToday, setCallsToday] = useState(142)
  const [chatsActive, setChatsActive] = useState(8)
  const [appointmentsBooked, setAppointmentsBooked] = useState(23)
  const [partsQuotes, setPartsQuotes] = useState(17)

  useEffect(() => {
    const currentRef = sectionRef.current

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
        }
      },
      {
        threshold: 0.1,
        rootMargin: "0px 0px -100px 0px",
      },
    )

    if (currentRef) {
      observer.observe(currentRef)
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef)
      }
    }
  }, [])

  useEffect(() => {
    if (!isVisible) return

    const intervals = [
      setInterval(() => setCallsToday((prev) => prev + 1), 8000),
      setInterval(() => setChatsActive((prev) => Math.min(prev + 1, 12)), 12000),
      setInterval(() => setAppointmentsBooked((prev) => prev + 1), 15000),
      setInterval(() => setPartsQuotes((prev) => prev + 1), 10000),
    ]

    return () => intervals.forEach(clearInterval)
  }, [isVisible])

  return (
    <section ref={sectionRef} className="py-16 sm:py-24 relative z-10">
      <div className="bg-white/98 backdrop-blur-2xl rounded-[2rem] shadow-[0_20px_80px_-20px_rgba(0,0,0,0.3)] border border-white/40 relative overflow-hidden mx-4">
        <div className="absolute -top-32 -right-32 w-96 h-96 bg-gradient-to-br from-blue-500/20 via-purple-500/10 to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-gradient-to-tr from-orange-500/20 via-pink-500/10 to-transparent rounded-full blur-3xl" />

        <div className="max-w-7xl mx-auto px-4 sm:px-8 lg:px-12 py-8 sm:py-12 lg:py-16 relative z-10">
          <div
            className={`text-center mb-12 sm:mb-16 transition-all duration-1000 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            }`}
          >
            <div className="inline-flex items-center px-5 py-2.5 rounded-full bg-gradient-to-r from-slate-100 to-slate-50 border border-slate-200/80 shadow-sm text-slate-700 text-sm font-semibold mb-6">
              <span className="w-2.5 h-2.5 bg-green-500 rounded-full mr-2.5 animate-pulse shadow-lg shadow-green-500/50"></span>
              AI Working 24/7 - Never Miss a Lead
            </div>
            <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold text-slate-900 mb-4 sm:mb-6 tracking-tight">
              Your AI Team{" "}
              <span className="bg-gradient-to-r from-blue-600 via-purple-600 to-blue-600 bg-clip-text text-transparent bg-[length:200%_auto] animate-gradient">
                Never Sleeps
              </span>
            </h2>
            <p className="text-lg sm:text-xl text-slate-600 max-w-3xl mx-auto leading-relaxed">
              Watch our AI handle real customer interactions around the clock, automatically qualifying leads and
              booking appointments while you focus on growing your dealership.
            </p>
          </div>

          <div
            className={`grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 transition-all duration-1000 delay-200 ${
              isVisible ? "opacity-100" : "opacity-0"
            }`}
          >
            {/* Chat Support - Large widget spanning 2 columns */}
            <div className="lg:col-span-2 bg-gradient-to-br from-slate-50 to-blue-50/30 rounded-2xl p-6 border border-slate-200/60 shadow-lg hover:shadow-xl transition-all duration-300 group">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30">
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">24/7 AI Chat Support</h3>
                    <p className="text-xs text-slate-500">Multi-channel messaging</p>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4 mb-4">
                  {/* Live chat preview */}
                  <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm">
                    <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                      <span className="text-xs font-semibold text-slate-700">Live Chat</span>
                      <div className="ml-auto flex gap-1">
                        {/* Platform badges */}
                        <div className="w-5 h-5 bg-[#25D366] rounded-full flex items-center justify-center">
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
                          </svg>
                        </div>
                        <div className="w-5 h-5 bg-gradient-to-br from-[#00B2FF] to-[#006AFF] rounded-full flex items-center justify-center">
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 0C5.373 0 0 4.975 0 11.111c0 3.497 1.745 6.616 4.472 8.652V24l4.086-2.242c1.09.301 2.246.464 3.442.464 6.627 0 12-4.974 12-11.11C24 4.975 18.627 0 12 0zm1.191 14.963l-3.055-3.26-5.963 3.26L10.732 8l3.131 3.259L19.752 8l-6.561 6.963z" />
                          </svg>
                        </div>
                        <div className="w-5 h-5 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center">
                          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                            />
                          </svg>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex gap-2 animate-slide-in-left">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex-shrink-0"></div>
                        <div className="bg-slate-100 rounded-lg rounded-tl-sm px-3 py-1.5 text-xs text-slate-800">
                          Hi! How can I help?
                        </div>
                      </div>
                      <div className="flex gap-2 justify-end animate-slide-in-right animation-delay-500">
                        <div className="bg-blue-500 rounded-lg rounded-tr-sm px-3 py-1.5 text-xs text-white">
                          Do you have X5 in stock?
                        </div>
                      </div>
                      <div className="flex gap-2 animate-slide-in-left animation-delay-1000">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex-shrink-0"></div>
                        <div className="bg-slate-100 rounded-lg rounded-tl-sm px-3 py-1.5 text-xs text-slate-800">
                          Yes! 3 available. Test drive?
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Metrics */}
                  <div className="space-y-3">
                    <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-500 font-medium">Response Time</span>
                        <span className="text-xs text-green-600 font-bold">Excellent</span>
                      </div>
                      <div className="text-2xl font-bold text-slate-900">
                        <span className="animate-pulse">8</span>
                        <span className="text-sm text-slate-500 ml-1">seconds</span>
                      </div>
                      <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-green-500 to-emerald-500 rounded-full w-[95%] animate-pulse"></div>
                      </div>
                    </div>

                    <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-slate-500 font-medium">Leads Captured</span>
                        <span className="text-xs text-blue-600 font-bold">Today</span>
                      </div>
                      <div className="text-2xl font-bold text-slate-900">
                        <span className="tabular-nums">34</span>
                        <span className="text-sm text-green-600 ml-2">+12%</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Phone Receptionist - Smaller widget */}
                <div className="bg-gradient-to-br from-slate-50 to-green-50/30 rounded-2xl p-6 border border-slate-200/60 shadow-lg hover:shadow-xl transition-all duration-300 group">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="relative">
                      <div className="absolute inset-0 bg-green-500 rounded-xl animate-ping opacity-20"></div>
                      <div className="relative w-10 h-10 bg-gradient-to-br from-green-500 to-emerald-600 rounded-xl flex items-center justify-center shadow-lg shadow-green-500/30">
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                          />
                        </svg>
                      </div>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">AI Phone Receptionist</h3>
                      <p className="text-xs text-slate-500">Voice assistant</p>
                    </div>
                  </div>

                  <div className="bg-white rounded-xl p-4 mb-4 border border-slate-200/60 shadow-sm">
                    <div className="text-center mb-3">
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-100 text-green-700 rounded-full text-xs font-bold mb-2">
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                        Call in Progress
                      </div>
                      <p className="text-sm font-semibold text-slate-900">John Smith</p>
                      <p className="text-xs text-slate-500">Service inquiry</p>
                    </div>
                    <div className="flex items-center justify-center gap-4 text-center pt-3 border-t border-slate-100">
                      <div>
                        <p className="text-xl font-bold text-slate-900 tabular-nums">{callsToday}</p>
                        <p className="text-xs text-slate-500">Calls Today</p>
                      </div>
                      <div className="w-px h-8 bg-slate-200"></div>
                      <div>
                        <p className="text-xl font-bold text-green-600">24/7</p>
                        <p className="text-xs text-slate-500">Available</p>
                      </div>
                    </div>
                  </div>

                  <p className="text-sm text-slate-600">
                    Professional AI answers calls, takes messages, and books appointments when you're busy.
                  </p>
                </div>

                {/* Service Booking - Medium widget */}
                <div className="bg-gradient-to-br from-slate-50 to-purple-50/30 rounded-2xl p-6 border border-slate-200/60 shadow-lg hover:shadow-xl transition-all duration-300 group">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/30">
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">Service Booking</h3>
                      <p className="text-xs text-slate-500">Automated scheduling</p>
                    </div>
                  </div>

                  <div className="bg-white rounded-xl p-4 mb-4 border border-slate-200/60 shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold text-slate-700">Today's Schedule</span>
                      <span className="px-2 py-1 bg-purple-100 text-purple-700 text-xs font-bold rounded">
                        {appointmentsBooked} Booked
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 p-2 bg-purple-50 rounded-lg animate-slide-in-left">
                        <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                        <div className="flex-1">
                          <p className="text-xs font-semibold text-slate-900">Oil Change</p>
                          <p className="text-xs text-slate-500">10:00 AM</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 p-2 bg-purple-50 rounded-lg animate-slide-in-left animation-delay-300">
                        <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                        <div className="flex-1">
                          <p className="text-xs font-semibold text-slate-900">Brake Service</p>
                          <p className="text-xs text-slate-500">2:30 PM</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 p-2 bg-green-50 rounded-lg border border-green-200 animate-scale-in animation-delay-600">
                        <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <p className="text-xs font-semibold text-green-700">Just booked: 4:00 PM</p>
                      </div>
                    </div>
                  </div>

                  <p className="text-sm text-slate-600">
                    Automatically schedules appointments, sends reminders, and manages your workshop calendar.
                  </p>
                </div>

                {/* Parts Inquiry - Medium widget */}
                <div className="lg:col-span-2 bg-gradient-to-br from-slate-50 to-orange-50/30 rounded-2xl p-6 border border-slate-200/60 shadow-lg hover:shadow-xl transition-all duration-300 group">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-orange-600 rounded-xl flex items-center justify-center shadow-lg shadow-orange-500/30">
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                          />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-lg font-bold text-slate-900">Parts Inquiry Assistant</h3>
                        <p className="text-xs text-slate-500">Real-time inventory</p>
                      </div>
                    </div>
                    <span className="px-3 py-1 bg-orange-100 text-orange-700 text-xs font-bold rounded-full">
                      {partsQuotes} Quotes Today
                    </span>
                  </div>

                  <div className="grid sm:grid-cols-3 gap-3 mb-4">
                    <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center">
                          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                        <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-bold rounded">
                          In Stock
                        </span>
                      </div>
                      <p className="text-sm font-bold text-slate-900 mb-1">Brake Pads</p>
                      <p className="text-xs text-slate-500 mb-2">BMW X5 • Stock: 8</p>
                      <p className="text-lg font-bold text-slate-900">€89</p>
                    </div>

                    <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center">
                          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                        <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-bold rounded">
                          In Stock
                        </span>
                      </div>
                      <p className="text-sm font-bold text-slate-900 mb-1">Oil Filter</p>
                      <p className="text-xs text-slate-500 mb-2">Universal • Stock: 24</p>
                      <p className="text-lg font-bold text-slate-900">€24</p>
                    </div>

                    <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl p-4 border-2 border-green-200 shadow-md animate-scale-in">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-8 h-8 bg-gradient-to-br from-green-500 to-emerald-500 rounded-full flex items-center justify-center">
                          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      </div>
                      <p className="text-sm font-bold text-green-800 mb-1">Quote Sent</p>
                      <p className="text-xs text-green-600">Customer notified</p>
                      <p className="text-xs text-green-600 mt-2">via email & SMS</p>
                    </div>
                  </div>

                  <p className="text-sm text-slate-600">
                    Instantly responds to parts availability questions, provides accurate quotes, and processes orders
                    while you focus on sales.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
