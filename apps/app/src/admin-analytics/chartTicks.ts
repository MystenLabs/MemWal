/** Labels only. The caller still plots every bucket. */
export function visibleTickIndexes(count: number, width: number, minGap = 72): number[] {
  if (count <= 0) return []
  if (count === 1 || width < minGap * 2) return [0, count - 1].filter((index, position, all) => all.indexOf(index) === position)
  const maxLabels = Math.max(2, Math.floor(width / minGap))
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index)
  const step = Math.ceil((count - 1) / (maxLabels - 1))
  const indexes: number[] = []
  for (let index = 0; index < count; index += step) indexes.push(index)
  const last = count - 1
  if (indexes[indexes.length - 1] !== last) {
    if (last - indexes[indexes.length - 1] < step) indexes[indexes.length - 1] = last
    else indexes.push(last)
  }
  return indexes
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function shortDate(value: string): string {
  const hour = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (hour) return `${hour[4]}:${hour[5]}`
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return value.length > 8 ? value.slice(0, 8) : value
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`
}

export function bucketInterval(label: string): string {
  const hour = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(label)
  if (hour) {
    const start = Number(hour[4])
    const end = String((start + 1) % 24).padStart(2, '0')
    return `${Number(hour[3])} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(hour[2]) - 1]}, ${hour[4]}:${hour[5]}–${end}:${hour[5]}`
  }
  return shortDate(label)
}

