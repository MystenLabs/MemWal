import { Check, CheckCheck } from "lucide-react"

interface ChatMessageProps {
  text: string
  time: string
  isUser?: boolean
  isAI?: boolean
  hasCheck?: boolean
  hasDoubleCheck?: boolean
  highlight?: boolean
}

export function ChatMessage({
  text,
  time,
  isUser = false,
  isAI = false,
  hasCheck = false,
  hasDoubleCheck = false,
  highlight = false,
}: ChatMessageProps) {
  const alignment = isUser ? "justify-end" : "justify-start"
  const bgColor = isUser ? "bg-[#DCF8C6]" : "bg-white"
  const borderClass = highlight ? "border-2 border-green-200" : ""

  return (
    <div className={`flex ${alignment}`}>
      <div className={`${bgColor} ${borderClass} rounded-lg px-3 py-2 max-w-[75%] shadow-sm`}>
        <p className="text-sm text-slate-800">{text}</p>
        <div className={`flex items-center ${isUser ? "justify-end" : "justify-start"} gap-1 mt-1`}>
          {isAI ? (
            <span className="text-xs text-green-600 font-semibold">Cliste • {time}</span>
          ) : (
            <>
              <span className="text-xs text-slate-500">{time}</span>
              {hasCheck && <Check className="w-3.5 h-3.5 text-slate-400" />}
              {hasDoubleCheck && <CheckCheck className="w-3.5 h-3.5 text-blue-500" />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
