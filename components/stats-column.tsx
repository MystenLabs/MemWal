interface Stat {
  value: string
  label: string
  gradient?: boolean
}

interface StatsColumnProps {
  stats: Stat[]
  isMobile?: boolean
}

export function StatsColumn({ stats, isMobile = false }: StatsColumnProps) {
  const textSize = isMobile ? "text-2xl sm:text-3xl" : "text-5xl"
  const valueSize = isMobile ? "text-xs sm:text-sm" : "text-lg"

  return (
    <div className="space-y-6">
      {stats.map((stat, index) => (
        <div key={index}>
          <div className="text-center space-y-2">
            <div
              className={`${textSize} ${stat.gradient ? "bg-gradient-to-r from-red-500 to-orange-500 bg-clip-text text-transparent" : "text-slate-900"} font-bold`}
            >
              {stat.value}
            </div>
            <p className={`${valueSize} text-slate-600`}>{stat.label}</p>
          </div>
          {index < stats.length - 1 && (
            <div className="h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent mt-6"></div>
          )}
        </div>
      ))}
    </div>
  )
}
