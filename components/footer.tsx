"use client"
import type React from "react"
import type { ComponentProps, ReactNode } from "react"
import { motion, useReducedMotion } from "framer-motion"
import { FacebookIcon, InstagramIcon, LinkedinIcon, YoutubeIcon } from "lucide-react"
import Image from "next/image"

interface FooterLink {
  title: string
  href: string
  icon?: React.ComponentType<{ className?: string }>
}

interface FooterSection {
  label: string
  links: FooterLink[]
}

const footerLinks: FooterSection[] = [
  {
    label: "Product",
    links: [
      { title: "SDK Features", href: "#features" },
      { title: "Consent Flows", href: "#ai-team" },
      { title: "Pricing", href: "#roi-calculator" },
      { title: "Contact", href: "#contact" },
    ],
  },
  {
    label: "Company",
    links: [
      { title: "About", href: "/about" },
      { title: "Security", href: "/security" },
      { title: "Privacy Policy", href: "/privacy" },
      { title: "Terms of Service", href: "/terms" },
    ],
  },
  {
    label: "Resources",
    links: [
      { title: "Docs on npm", href: "https://www.npmjs.com/package/personal-data-wallet-sdk" },
      { title: "API Reference", href: "/docs" },
      { title: "Changelog", href: "/changelog" },
      { title: "Support", href: "/support" },
    ],
  },
  {
    label: "Social Links",
    links: [
      { title: "Facebook", href: "#", icon: FacebookIcon },
      { title: "Instagram", href: "#", icon: InstagramIcon },
      { title: "Youtube", href: "#", icon: YoutubeIcon },
      { title: "LinkedIn", href: "#", icon: LinkedinIcon },
    ],
  },
]

export function Footer() {
  return (
    <footer className="md:rounded-t-6xl relative w-full max-w-6xl mx-auto flex flex-col items-center justify-center rounded-t-4xl border-t bg-[radial-gradient(35%_128px_at_50%_0%,theme(backgroundColor.white/8%),transparent)] px-6 py-12 lg:py-16">
      <div className="bg-foreground/20 absolute top-0 right-1/2 left-1/2 h-px w-1/3 -translate-x-1/2 -translate-y-1/2 rounded-full blur" />

      <div className="grid w-full gap-8 xl:grid-cols-3 xl:gap-8">
        <AnimatedContainer className="space-y-4">
          <Image src="/images/cliste-logo.png" alt="Personal Data Wallet SDK Logo" width={64} height={64} className="size-16" />
          <div className="text-muted-foreground mt-8 text-sm md:mt-0 md:block hidden">
            <p>© {new Date().getFullYear()} Personal Data Wallet SDK. All rights reserved.</p>
          </div>
        </AnimatedContainer>

        <div className="mt-10 grid grid-cols-2 gap-8 md:grid-cols-4 xl:col-span-2 xl:mt-0">
          {footerLinks.map((section, index) => (
            <AnimatedContainer key={section.label} delay={0.1 + index * 0.1}>
              <div className="mb-10 md:mb-0">
                <h3 className="text-xs">{section.label}</h3>
                <ul className="text-muted-foreground mt-4 space-y-2 text-sm">
                  {section.links.map((link) => (
                    <li key={link.title}>
                      <a
                        href={link.href}
                        className="hover:text-foreground inline-flex items-center transition-all duration-300"
                      >
                        {link.icon && <link.icon className="me-1 size-4" />}
                        {link.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </AnimatedContainer>
          ))}
        </div>
      </div>

      <div className="md:hidden mt-8 text-center space-y-2">
        <p className="text-muted-foreground text-sm">© {new Date().getFullYear()} Personal Data Wallet SDK.</p>
        <p className="text-muted-foreground text-xs">Crafted by Open Wallet Labs</p>
      </div>

      <div className="hidden md:block mt-8 pt-6 border-t border-foreground/10 w-full">
        <p className="text-muted-foreground text-xs text-center">Crafted by Open Wallet Labs</p>
      </div>
    </footer>
  )
}

type ViewAnimationProps = {
  delay?: number
  className?: ComponentProps<typeof motion.div>["className"]
  children: ReactNode
}

function AnimatedContainer({ className, delay = 0.1, children }: ViewAnimationProps) {
  const shouldReduceMotion = useReducedMotion()

  if (shouldReduceMotion) {
    return children
  }

  return (
    <motion.div
      initial={{ filter: "blur(4px)", translateY: -8, opacity: 0 }}
      whileInView={{ filter: "blur(0px)", translateY: 0, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ delay, duration: 0.8 }}
      className={className}
    >
      {children}
    </motion.div>
  )
}
