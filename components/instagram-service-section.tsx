"use client"
import { useEffect, useRef } from "react"

export function InstagramServiceSection() {
  const sectionRef = useRef<HTMLDivElement>(null)

  const benefits = [
    {
      title: "Service Bookings",
      description:
        "Clutch By Cliste automatically schedules service appointments and sends confirmations across all channels - website, phone, and social media, customized to your workflow",
    },
    {
      title: "Parts Inquiries",
      description:
        "Answers questions about parts availability, pricing, and delivery times based on your inventory in real-time, whether customers reach out via phone, website, or social media",
    },
    {
      title: "Order Management",
      description:
        "Processes parts orders and provides tracking updates without human intervention across every customer touchpoint, tailored to your systems",
    },
    {
      title: "Customer Updates",
      description:
        "Keeps customers informed about service progress and parts arrival status 24/7 in your dealership's voice - no matter how they contact you",
    },
  ]

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const elements = entry.target.querySelectorAll(".fade-in-element")
            elements.forEach((element, index) => {
              setTimeout(() => {
                element.classList.add("animate-fade-in-up")
              }, index * 100)
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

  return (
    null
  )
}
