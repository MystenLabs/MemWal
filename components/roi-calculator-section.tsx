"use client"

import { useState, useEffect } from "react"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card } from "@/components/ui/card"
import { TrendingUp, Users, DollarSign, Clock } from "lucide-react"

interface CalculatorInputs {
  monthlyVisitors: number
  currentConversionRate: number
  averageOrderValue: number
  businessType: string
}

export function ROICalculatorSection() {
  const [inputs, setInputs] = useState<CalculatorInputs>({
    monthlyVisitors: 10000,
    currentConversionRate: 2,
    averageOrderValue: 150,
    businessType: "ecommerce",
  })

  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
          }
        })
      },
      { threshold: 0.1 },
    )

    const section = document.getElementById("roi-calculator")
    if (section) {
      observer.observe(section)
    }

    return () => observer.disconnect()
  }, [])

  const getBusinessDefaults = () => {
    const businessDefaults = {
      ecommerce: { avgOrder: 85, maxOrder: 500, conversion: 35, response: 80, satisfaction: 45 },
      retail: { avgOrder: 65, maxOrder: 300, conversion: 30, response: 75, satisfaction: 40 },
      realestate: { avgOrder: 5000, maxOrder: 50000, conversion: 40, response: 85, satisfaction: 50 },
      hospitality: { avgOrder: 180, maxOrder: 1000, conversion: 25, response: 70, satisfaction: 35 },
      healthcare: { avgOrder: 250, maxOrder: 2000, conversion: 45, response: 90, satisfaction: 55 },
      finance: { avgOrder: 1200, maxOrder: 10000, conversion: 35, response: 85, satisfaction: 50 },
      automotive: { avgOrder: 25000, maxOrder: 100000, conversion: 30, response: 75, satisfaction: 40 },
      default: { avgOrder: 150, maxOrder: 2000, conversion: 35, response: 80, satisfaction: 45 },
    }

    return businessDefaults[inputs.businessType as keyof typeof businessDefaults] || businessDefaults.default
  }

  useEffect(() => {
    const defaults = getBusinessDefaults()
    setInputs((prev) => ({ ...prev, averageOrderValue: defaults.avgOrder }))
  }, [inputs.businessType])

  const businessConfig = getBusinessDefaults()
  const improvements = {
    conversion: businessConfig.conversion,
    response: businessConfig.response,
    satisfaction: businessConfig.satisfaction,
  }

  // Current metrics
  const currentLeads = Math.round((inputs.monthlyVisitors * inputs.currentConversionRate) / 100)
  const currentRevenue = currentLeads * inputs.averageOrderValue

  // Improved metrics with AI chatbot
  const newConversionRate = inputs.currentConversionRate * (1 + improvements.conversion / 100)
  const newLeads = Math.round((inputs.monthlyVisitors * newConversionRate) / 100)
  const newRevenue = newLeads * inputs.averageOrderValue

  // Gains
  const additionalLeads = newLeads - currentLeads
  const additionalRevenue = newRevenue - currentRevenue
  const revenueIncrease = ((newRevenue - currentRevenue) / currentRevenue) * 100

  return (
    <section id="roi-calculator" className="py-16 md:py-20 px-4 relative">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div
          className={`text-center mb-12 md:mb-16 transition-all duration-700 ${isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 backdrop-blur-sm mb-6">
            <TrendingUp className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-white/80">Privacy impact model</span>
          </div>

          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-4 md:mb-6 text-balance">
            See how much{" "}
            <span className="bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
              data ownership
            </span>
            you can unlock
          </h2>

          <p className="text-lg md:text-xl text-gray-300 max-w-2xl mx-auto text-balance">
            Estimate the verified users, request throughput, and dollars saved once your team drops in personal-data-wallet-sdk.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-8 lg:gap-10 items-stretch">
          {/* Calculator Inputs */}
          <div
            className={`transition-all duration-700 delay-200 ${isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
          >
            <Card className="p-6 md:p-8 bg-[radial-gradient(35%_128px_at_50%_0%,theme(backgroundColor.white/15%),theme(backgroundColor.white/5%))] border-white/20 backdrop-blur-sm shadow-2xl h-full flex flex-col">
              <h3 className="text-xl md:text-2xl font-semibold text-white mb-6 md:mb-8">Your data program</h3>

              <div className="space-y-8 flex-1">
                {/* Business Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">Industry</label>
                  <Select
                    value={inputs.businessType}
                    onValueChange={(value) => setInputs((prev) => ({ ...prev, businessType: value }))}
                  >
                    <SelectTrigger className="bg-gray-700/50 border-gray-600 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700">
                      <SelectItem value="ecommerce">Marketplace / Consumer</SelectItem>
                      <SelectItem value="retail">Retail & Loyalty</SelectItem>
                      <SelectItem value="realestate">PropTech</SelectItem>
                      <SelectItem value="hospitality">Travel & Hospitality</SelectItem>
                      <SelectItem value="healthcare">Healthcare / Life Sciences</SelectItem>
                      <SelectItem value="finance">Fintech</SelectItem>
                      <SelectItem value="automotive">Mobility</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Monthly Visitors */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    Monthly wallet sessions:{" "}
                    <span className="text-white font-semibold">{inputs.monthlyVisitors.toLocaleString()}</span>
                  </label>
                  <Slider
                    value={[inputs.monthlyVisitors]}
                    onValueChange={([value]) => setInputs((prev) => ({ ...prev, monthlyVisitors: value }))}
                    max={100000}
                    min={1000}
                    step={1000}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>1K</span>
                    <span>100K</span>
                  </div>
                </div>

                {/* Conversion Rate */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    Current consent completion rate:{" "}
                    <span className="text-white font-semibold">{inputs.currentConversionRate}%</span>
                  </label>
                  <Slider
                    value={[inputs.currentConversionRate]}
                    onValueChange={([value]) => setInputs((prev) => ({ ...prev, currentConversionRate: value }))}
                    max={10}
                    min={0.5}
                    step={0.1}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>0.5%</span>
                    <span>10%</span>
                  </div>
                </div>

                {/* Average Order Value */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    Value per verified user:{" "}
                    <span className="text-white font-semibold">€{inputs.averageOrderValue.toLocaleString()}</span>
                  </label>
                  <Slider
                    value={[inputs.averageOrderValue]}
                    onValueChange={([value]) => setInputs((prev) => ({ ...prev, averageOrderValue: value }))}
                    max={businessConfig.maxOrder}
                    min={25}
                    step={inputs.businessType === "automotive" || inputs.businessType === "realestate" ? 1000 : 25}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>€25</span>
                    <span>€{businessConfig.maxOrder.toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex-1"></div>
              </div>

              <div className="mt-6 lg:hidden">
                <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-primary/10 border border-primary/20">
                  <div className="animate-bounce">
                    <svg className="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 14l-7 7m0 0l-7-7m7 7V3"
                      />
                    </svg>
                  </div>
                  <span className="text-sm text-primary font-medium">Scroll down to see your results</span>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-gray-700/50">
                <div className="space-y-4">
                  <h4 className="text-sm font-semibold text-gray-300 mb-3">💡 Wallet Insights</h4>
                  <div className="space-y-3">
                    <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5">
                      <div className="w-2 h-2 rounded-full bg-primary mt-2 flex-shrink-0"></div>
                      <div>
                        <p className="text-sm text-gray-300">
                          <span className="font-medium text-white">Average improvement:</span> Teams see{" "}
                          {businessConfig.conversion}% more completed consent flows within 30 days
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5">
                      <div className="w-2 h-2 rounded-full bg-primary mt-2 flex-shrink-0"></div>
                      <div>
                        <p className="text-sm text-gray-300">
                          <span className="font-medium text-white">Fulfillment time:</span> Requests close{" "}
                          {businessConfig.response}% faster thanks to automation
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3 p-3 rounded-lg bg-white/5">
                      <div className="w-2 h-2 rounded-full bg-primary mt-2 flex-shrink-0"></div>
                      <div>
                        <p className="text-sm text-gray-300">
                          <span className="font-medium text-white">User trust:</span> Increases by{" "}
                          {businessConfig.satisfaction}% once users can self-manage data sharing
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* Results */}
          <div
            className={`transition-all duration-700 delay-400 ${isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
          >
            <Card className="p-6 md:p-8 bg-[radial-gradient(35%_128px_at_50%_0%,theme(backgroundColor.white/15%),theme(backgroundColor.white/5%))] border-white/20 backdrop-blur-sm shadow-2xl h-full flex flex-col">
              <h3 className="text-xl md:text-2xl font-semibold text-white mb-6 md:mb-8">
                Your potential with personal-data-wallet-sdk
              </h3>

              <div className="space-y-6 flex-1">
                {/* Current vs New Metrics */}
                <div className="grid grid-cols-2 gap-3 md:gap-4">
                  <div className="text-center p-3 md:p-4 rounded-lg bg-gray-700/30">
                    <div className="text-xs md:text-sm text-gray-400 mb-1">Current</div>
                    <div className="text-xl md:text-2xl font-bold text-white">{currentLeads}</div>
                    <div className="text-xs text-gray-400">consents/month</div>
                  </div>
                  <div className="text-center p-3 md:p-4 rounded-lg bg-white/10 border border-white/20">
                    <div className="text-xs md:text-sm text-gray-300 mb-1">With PDW SDK</div>
                    <div className="text-xl md:text-2xl font-bold text-white">{newLeads}</div>
                    <div className="text-xs text-gray-300">consents/month</div>
                  </div>
                </div>

                <div className="space-y-3 md:space-y-4">
                  <div className="flex items-center justify-between p-3 md:p-4 rounded-lg bg-white/5 border border-white/10">
                    <div className="flex items-center gap-3">
                      <Users className="w-4 h-4 md:w-5 md:h-5 text-gray-300" />
                      <span className="text-sm md:text-base text-white">Additional verified consents</span>
                    </div>
                    <span className="text-lg md:text-xl font-bold text-white">+{additionalLeads}</span>
                  </div>

                  <div className="flex items-center justify-between p-3 md:p-4 rounded-lg bg-white/5 border border-white/10">
                    <div className="flex items-center gap-3">
                      <DollarSign className="w-4 h-4 md:w-5 md:h-5 text-gray-300" />
                      <span className="text-sm md:text-base text-white">Value unlocked</span>
                    </div>
                    <span className="text-lg md:text-xl font-bold text-white">
                      €{additionalRevenue.toLocaleString()}
                    </span>
                  </div>

                  <div className="flex items-center justify-between p-3 md:p-4 rounded-lg bg-white/5 border border-white/10">
                    <div className="flex items-center gap-3">
                      <TrendingUp className="w-4 h-4 md:w-5 md:h-5 text-gray-300" />
                      <span className="text-sm md:text-base text-white">Program lift</span>
                    </div>
                    <span className="text-lg md:text-xl font-bold text-white">+{revenueIncrease.toFixed(1)}%</span>
                  </div>

                  <div className="flex items-center justify-between p-3 md:p-4 rounded-lg bg-white/5 border border-white/10">
                    <div className="flex items-center gap-3">
                      <Clock className="w-4 h-4 md:w-5 md:h-5 text-gray-300" />
                      <span className="text-sm md:text-base text-white">Request turnaround</span>
                    </div>
                    <span className="text-lg md:text-xl font-bold text-white">{improvements.response}% faster</span>
                  </div>
                </div>

                {/* Annual Projection */}
                <div className="mt-6 md:mt-8 p-4 md:p-6 rounded-lg bg-white/5 border border-white/10">
                  <div className="text-center">
                    <div className="text-xs md:text-sm text-gray-300 mb-2">Projected annual value secured</div>
                    <div className="text-2xl md:text-3xl lg:text-4xl font-bold text-white mb-2">
                      €{(additionalRevenue * 12).toLocaleString()}
                    </div>
                    <div className="text-xs md:text-sm text-gray-400">
                      Based on your current metrics and wallet benchmarks
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* CTA */}
        <div
          className={`text-center mt-12 md:mt-16 transition-all duration-700 delay-600 ${isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
        >
          <p className="text-sm text-gray-400 mt-4">* Estimates use open-source benchmarks; plug in real metrics for precise planning.</p>
        </div>
      </div>
    </section>
  )
}
