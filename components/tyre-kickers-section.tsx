"use client"
import { useEffect, useRef } from "react"

export function TyreKickersSection() {
  const sectionRef = useRef<HTMLDivElement>(null)

  const benefits = [
    {
      title: "Instant Answers",
      description:
        "Clutch By Cliste responds to 50+ common questions about NCT, mileage, trade-ins, and pricing instantly across your website, phone, and social channels",
    },
    {
      title: "Qualify Leads",
      description:
        "Automatically filters serious buyers from browsers by asking the right questions tailored to your dealership",
    },
    {
      title: "Save Time",
      description: "Stop answering the same questions repeatedly - let Clutch By Cliste handle the tire kickers",
    },
    {
      title: "24/7 Availability",
      description: "Never miss a serious inquiry while filtering out time-wasters around the clock - on every channel",
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
