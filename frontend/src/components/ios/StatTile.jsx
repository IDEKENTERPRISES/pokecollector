import { createElement, isValidElement } from 'react'
import Link from './TransitionLink'
import clsx from 'clsx'
import EnergyIcon from './EnergyIcon'
import { TYPE_COLOURS, typeKeyFor } from './pokemon'

function Sparkline({ values, colour }) {
  const points = (values ?? []).filter(v => Number.isFinite(Number(v))).map(Number)
  if (points.length < 2) return null
  const min = Math.min(...points)
  const span = Math.max(...points) - min || 1
  const step = 100 / (points.length - 1)
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(22 - ((v - min) / span) * 20).toFixed(1)}`).join(' ')
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="mt-1 h-6 w-full" aria-hidden="true" focusable="false">
      <path d={path} fill="none" stroke={colour} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity="0.85" />
    </svg>
  )
}

/**
 * Home and Profile stat tile: radius 22, the type gradient at 150°, a soft shadow in the type's
 * solid at 55 %, a big rounded number, a label with an icon and the energy symbol as a large faint
 * watermark. A link when `to` is set, else a plain block. `sparkline` is an array of numbers.
 *
 * icon: a lucide component or element shown beside the label.
 */
export default function StatTile({ type, icon, label, value, detail, to, sparkline, className = '', children }) {
  const key = typeKeyFor(type) ?? 'colorless'
  const { text } = TYPE_COLOURS[key]
  const iconNode = icon ? (isValidElement(icon) ? icon : createElement(icon, { size: 15, strokeWidth: 2.25, 'aria-hidden': true })) : null

  const classes = clsx(
    'no-callout relative block overflow-hidden rounded-[22px] p-3.5 text-left',
    to && 'ios-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint',
    className,
  )
  const style = {
    color: text,
    background: `linear-gradient(150deg, var(--type-${key}-top), var(--type-${key}-bottom))`,
    boxShadow: `0 8px 20px color-mix(in srgb, var(--type-${key}) 55%, transparent)`,
    containerType: 'inline-size',
  }
  // The value shrinks to the tile's width (container query units) instead of truncating: about
  // 0.62 em per character, never below 14 px nor above the 30 px tile number.
  const valueStyle = typeof value === 'string' || typeof value === 'number'
    ? { fontSize: `clamp(14px, calc(100cqw / ${Math.max(String(value).length, 1) * 0.62}), 30px)`, lineHeight: 1.15 }
    : undefined

  const body = (
    <>
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-3 -right-3 opacity-20">
        <EnergyIcon type={key} size={84} />
      </span>
      <span className="relative flex items-center gap-1.5 text-footnote font-semibold opacity-90">
        {iconNode}
        <span className="break-words">{label}</span>
      </span>
      <span className="relative mt-1 block whitespace-nowrap text-tile-number font-display tabular-nums" style={valueStyle}>{value}</span>
      {detail && <span className="relative block break-words text-caption-1 opacity-90">{detail}</span>}
      {sparkline && <span className="relative block"><Sparkline values={sparkline} colour={text} /></span>}
      {children}
    </>
  )

  if (to) return <Link to={to} className={classes} style={style}>{body}</Link>
  return <div className={classes} style={style}>{body}</div>
}
