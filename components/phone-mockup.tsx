import type { ReactNode } from "react"
import { MessageCircle } from "lucide-react"

interface PhoneMockupProps {
  headerTitle: string
  headerSubtitle: string
  headerIcon?: ReactNode
  headerBgColor?: string
  chatBgColor?: string
  children: ReactNode
}

export function PhoneMockup({
  headerTitle,
  headerSubtitle,
  headerIcon,
  headerBgColor = "bg-[#075E54]",
  chatBgColor = "bg-[#ECE5DD]",
  children,
}: PhoneMockupProps) {
  return (
    <div className="relative mx-auto w-[280px] sm:w-[320px] lg:w-[360px]">
      <div className="relative bg-slate-900 rounded-[2.5rem] sm:rounded-[3rem] p-2 sm:p-3 shadow-2xl border-4 sm:border-8 border-slate-900">
        {/* Phone Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 sm:w-40 h-6 sm:h-7 bg-slate-900 rounded-b-2xl z-10"></div>

        {/* Phone Screen */}
        <div className="bg-white rounded-[2rem] sm:rounded-[2.5rem] overflow-hidden relative">
          {/* Header */}
          <div className={`${headerBgColor} px-3 sm:px-4 py-3 sm:py-4 flex items-center gap-2 sm:gap-3`}>
            <div className="w-8 sm:w-10 h-8 sm:h-10 bg-slate-300 rounded-full flex items-center justify-center text-slate-600 font-bold text-xs sm:text-sm">
              JD
            </div>
            <div className="flex-1">
              <div className="text-white font-semibold text-sm sm:text-base">{headerTitle}</div>
              <div className="text-green-200 text-xs sm:text-sm">{headerSubtitle}</div>
            </div>
            {headerIcon || <MessageCircle className="w-5 sm:w-6 h-5 sm:h-6 text-white/80" />}
          </div>

          {/* Chat Area */}
          <div className={`${chatBgColor} p-3 sm:p-4 space-y-2 sm:space-y-2.5 h-[420px] sm:h-[500px]`}>{children}</div>
        </div>
      </div>
    </div>
  )
}
