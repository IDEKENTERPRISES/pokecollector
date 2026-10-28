import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { FlipHorizontal, Smartphone } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useTilt } from '../../hooks/useTilt'
import { CardArtworkFrame } from '../UnifiedCard'
import { resolveFoilPattern } from './foilRules'
import './holo.css'

/**
 * The card sheet's artwork as a holo card: drag (or hover) to tilt, glare that follows the light,
 * a foil pattern, a flip to the card back and an opt-in "Tilt with your phone".
 *
 * Children is a render function receiving { stage, controls, foil } so the sheet can place the
 * artwork and the buttons in different spots. `foil` is the resolved pattern (see foilRules.js).
 */
export default function HoloViewer({
  card,
  variant,
  printingDetails,
  foilPattern,
  overlay,
  children,
  variantEffectSource,
  ...frameProps
}) {
  const { t } = useSettings()
  const foil = resolveFoilPattern({ card, variant, printingDetails, foilPattern })
  const { ref, bind, reduced, motion } = useTilt()
  const [flipped, setFlipped] = useState(false)
  const [flipping, setFlipping] = useState(false)
  const flipTimer = useRef(null)

  useEffect(() => () => clearTimeout(flipTimer.current), [])
  useEffect(() => { setFlipped(false) }, [card?.id])

  const flip = () => {
    setFlipped(value => !value)
    if (reduced) return
    setFlipping(true)
    clearTimeout(flipTimer.current)
    flipTimer.current = setTimeout(() => setFlipping(false), 650)
  }

  const stage = (
    <div
      ref={ref}
      className={clsx('holo', flipping && 'is-flipping')}
      data-testid="holo-stage"
      data-foil={foil.pattern || 'none'}
      data-foil-source={foil.source}
      data-supertype={String(card?.supertype || '').toLowerCase()}
      data-flipped={flipped ? 'true' : 'false'}
      {...bind}
      onClickCapture={(event) => {
        bind.onClickCapture(event)
        if (event.defaultPrevented || event.target.closest?.('button')) return
        // While the card is tilting, the press and release can land on different layers, so the
        // browser reports the click on a common ancestor. Treat it as a tap on the artwork.
        ref.current?.querySelector('.unified-card-primary-action')?.click()
      }}
    >
      <div className="holo__rotator">
        <div
          className="holo__front"
          style={flipped ? { pointerEvents: 'none' } : undefined}
          aria-hidden={flipped ? 'true' : undefined}
          inert={flipped ? '' : undefined}
        >
          <CardArtworkFrame
            card={card}
            variantEffectSource={foil.pattern ? null : variantEffectSource}
            overlay={(
              <>
                {overlay}
                {foil.pattern && (
                  <>
                    <span className="holo-shine" aria-hidden="true" />
                    <span className="holo-glare" aria-hidden="true" />
                  </>
                )}
              </>
            )}
            {...frameProps}
          />
        </div>
        <div className="holo__back" aria-hidden={flipped ? undefined : 'true'}>
          <img src="/cardback.jpg" alt={flipped ? t('holo.cardBack') : ''} draggable={false} />
        </div>
      </div>
    </div>
  )

  const controls = (
    <div className="holo-controls">
      <button type="button" className="holo-button" onClick={flip} aria-pressed={flipped} data-testid="holo-flip">
        <FlipHorizontal size={16} aria-hidden />
        {flipped ? t('holo.showFront') : t('holo.flip')}
      </button>
      {motion.supported && (
        <button
          type="button"
          className="holo-button"
          onClick={motion.toggle}
          aria-pressed={motion.active}
          data-testid="holo-motion"
        >
          <Smartphone size={16} aria-hidden />
          {t('holo.tiltWithPhone')}
        </button>
      )}
    </div>
  )

  return children({ stage, controls, foil })
}
