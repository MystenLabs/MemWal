"use client"

import { useEffect, useRef } from "react"
import { TestimonialsColumn } from "@/components/ui/testimonials-column"

export function TestimonialsSection() {
  const sectionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const elements = entry.target.querySelectorAll(".fade-in-element")
            elements.forEach((element, index) => {
              setTimeout(() => {
                element.classList.add("animate-fade-in-up")
              }, index * 300)
            })
          }
        })
      },
      { threshold: 0.1 },
    )

    if (sectionRef.current) {
      observer.observe(sectionRef.current)
    }

    return () => observer.disconnect()
  }, [])

  const testimonials = [
    {
      text: "personal-data-wallet-sdk let us ship reusable consent screens that legal actually trusts. We finally removed brittle spreadsheets from our onboarding flow.",
      name: "Mike Rodriguez",
      role: "Head of Product, Atlas Identity",
    },
    {
      text: "We handle GDPR/CCPA tickets directly inside the SDK. One hook fires, the export bundle ships, and the requester gets a signed receipt automatically.",
      name: "Sarah Chen",
      role: "Privacy Ops Lead, Horizon Health",
    },
    {
      text: "Our banking app now gives customers a true data wallet. They can share KYC credentials with partners in seconds while we stay audit-ready.",
      name: "Michael Torres",
      role: "GM Digital, Signal Bank",
    },
    {
      text: "Engineering killed three services after integrating the SDK. Consent logs, encryption helpers, and integrations are all handled for us.",
      name: "Jennifer Walsh",
      role: "Director of Engineering, ComplianceOS",
    },
    {
      text: "Developers drop the components into React Native, legal reviews the generated policies, and we launch in new markets without slowing down.",
      name: "David Kim",
      role: "VP Product, Vaultwave",
    },
    {
      text: "We replaced a six-month privacy roadmap with a weekend sprint. The wallet adapters talk to our SIEM and KMS out of the box.",
      name: "Lisa Thompson",
      role: "CTO, GovCloud Labs",
    },
    {
      text: "Consent receipts sync to our data warehouse automatically, giving BI instant insight into who shared what and when.",
      name: "James Wilson",
      role: "Data Platform Lead, BeaconRX",
    },
    {
      text: "Customers trust us more because they can revoke or re-share data themselves. Net promoter scores climbed within weeks.",
      name: "Maria Garcia",
      role: "Customer Experience VP, OpenCare",
    },
  ]

  return (
    <section id="testimonials" ref={sectionRef} className="relative pt-16 pb-16 px-4 sm:px-6 lg:px-8">
      {/* Grid Background */}
      <div className="absolute inset-0 opacity-10">
        <div
          className="h-full w-full"
          style={{
            backgroundImage: `
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
            backgroundSize: "80px 80px",
          }}
        />
      </div>

      <div className="relative max-w-7xl mx-auto">
        {/* Header Section - Keep as user loves it */}
        <div className="text-center mb-16 md:mb-32">
          <div className="fade-in-element opacity-0 translate-y-8 transition-all duration-1000 ease-out inline-flex items-center gap-2 text-white/60 text-sm font-medium tracking-wider uppercase mb-6">
            <div className="w-8 h-px bg-white/30"></div>
            Teams shipping privacy-native apps
            <div className="w-8 h-px bg-white/30"></div>
          </div>
          <h2 className="fade-in-element opacity-0 translate-y-8 transition-all duration-1000 ease-out text-5xl md:text-6xl lg:text-7xl font-light text-white mb-8 tracking-tight text-balance">
            Builders who trust <span className="font-medium italic">personal-data-wallet-sdk</span>
          </h2>
          <p className="fade-in-element opacity-0 translate-y-8 transition-all duration-1000 ease-out text-xl text-white/70 max-w-2xl mx-auto leading-relaxed">
            Discover how product, privacy, and security teams use the SDK to launch consent-first experiences without rebuilding their stack
          </p>
        </div>

        {/* Testimonials Carousel */}
        <div className="fade-in-element opacity-0 translate-y-8 transition-all duration-1000 ease-out relative flex justify-center items-center min-h-[600px] md:min-h-[800px] overflow-hidden">
          <div
            className="flex gap-8 max-w-6xl"
            style={{
              maskImage: "linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)",
            }}
          >
            <TestimonialsColumn testimonials={testimonials.slice(0, 3)} duration={15} className="flex-1" />
            <TestimonialsColumn
              testimonials={testimonials.slice(2, 5)}
              duration={12}
              className="flex-1 hidden md:block"
            />
            <TestimonialsColumn
              testimonials={testimonials.slice(1, 4)}
              duration={18}
              className="flex-1 hidden lg:block"
            />
          </div>
        </div>
      </div>
    </section>
  )
}
