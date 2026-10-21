import { artSize, pixelPaths } from './art'

const cache = new WeakMap()

/** One pixel-art map as a crisp SVG, one art pixel per viewBox unit. Sized by CSS. */
export default function PixelArt({ art, className, style }) {
  if (!cache.has(art)) cache.set(art, { paths: pixelPaths(art), ...artSize(art) })
  const { paths, width, height } = cache.get(art)
  return (
    <svg
      className={className}
      style={style}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map(({ key, fill, d }) => <path key={key} fill={fill} d={d} />)}
    </svg>
  )
}
