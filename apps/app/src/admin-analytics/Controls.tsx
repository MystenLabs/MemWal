import { ChevronDown } from 'lucide-react'
import type { ReactNode, SelectHTMLAttributes } from 'react'

export function Chevron() {
  return <ChevronDown className="wa-chevron" size={14} strokeWidth={2} aria-hidden="true" />
}

export function SelectControl({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="wa-select-wrap">
      <select className="wa-select" aria-label={label} {...props}>{children}</select>
      <Chevron />
    </span>
  )
}
