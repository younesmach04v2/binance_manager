/**
 * Chart theme. The categorical palette was validated with the dataviz
 * palette checker against the panel surface (#111827): lightness band, chroma
 * floor, colour-vision-deficiency separation, normal-vision floor and contrast
 * all pass. Hues are assigned in fixed order and never cycled; a 9th entity
 * folds into "Other".
 */
export const CATEGORICAL = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#7c6be0', '#e34948']
export const OTHER_COLOR = '#5b6577'
export const ACCENT = '#f0b90b'
export const GAIN = '#22c55e'
export const LOSS = '#ef4444'

export const chartTheme = {
  grid: '#1f2a3d',
  axis: '#8b98ad',
  tick: { fontSize: 11, fill: '#8b98ad' },
  tooltip: {
    backgroundColor: '#161f31',
    border: '1px solid #1f2a3d',
    borderRadius: 8,
    color: '#e6ebf3',
    fontSize: 12,
    padding: '6px 10px'
  },
  tooltipLabel: { color: '#8b98ad', marginBottom: 2 },
  cursor: { stroke: '#8b98ad', strokeWidth: 1, strokeDasharray: '3 3' }
}

/** Stable colour per entity: sort the full entity list once and index into the palette. */
export function colorFor(entity: string, allEntities: string[]): string {
  const idx = [...allEntities].sort().indexOf(entity)
  return idx >= 0 && idx < CATEGORICAL.length ? CATEGORICAL[idx] : OTHER_COLOR
}

export function compact(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  if (abs >= 1) return v.toFixed(0)
  return v.toFixed(2)
}
