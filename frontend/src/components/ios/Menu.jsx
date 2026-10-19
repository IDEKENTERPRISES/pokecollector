import { cloneElement, createElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, MoreHorizontal } from 'lucide-react'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'

const MENU_WIDTH = 260
const GAP = 8
const EDGE = 8

/** Where the popover goes: below the trigger, flipped above when it does not fit. Pure. */
export function placeMenu({ rect, width, height, viewportWidth, viewportHeight, align = 'end' }) {
  let left = align === 'start' ? rect.left : rect.right - width
  left = Math.max(EDGE, Math.min(left, viewportWidth - width - EDGE))
  let top = rect.bottom + GAP
  if (top + height > viewportHeight - EDGE && rect.top - GAP - height >= EDGE) {
    top = rect.top - GAP - height
  }
  top = Math.max(EDGE, Math.min(top, viewportHeight - height - EDGE))
  return { left, top }
}

/**
 * iOS menu (design doc §6.8): a glass popover anchored to its trigger. Rows are 44 px with the
 * label on the left and the icon on the right, sections are separated by a gap, destructive items
 * are red and the selected option of a choice gets a checkmark.
 *
 * `trigger` is a React element (it receives the click, ref and aria props) or omitted for a
 * default "more" icon button named by `label`. `sections` is an array of arrays of
 * { id, label, icon, onSelect, checked, destructive, disabled }; an item with `checked` defined is
 * a menuitemradio. Arrow keys, Home/End, Enter/Space, Escape (focus returns to the trigger).
 * `container` defaults to document.body (§6.1).
 */
export default function Menu({ label, trigger, sections = [], align = 'end', container }) {
  const { t } = useSettings()
  const menuId = useId()
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    setPosition(null)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // Measure after the menu is in the DOM, then place it. Re-place on resize or scroll.
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const triggerEl = triggerRef.current
      const menuEl = menuRef.current
      if (!triggerEl || !menuEl) return
      setPosition(placeMenu({
        rect: triggerEl.getBoundingClientRect(),
        width: menuEl.offsetWidth,
        height: menuEl.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        align,
      }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align])

  // Focus the first enabled item once placed; close on an outside press.
  useEffect(() => {
    if (!open) return undefined
    const first = menuRef.current?.querySelector('[role^="menuitem"]:not([disabled])')
    first?.focus()
    const onPointerDown = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, close])

  const handleMenuKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      close(false)
      return
    }
    const items = [...menuRef.current.querySelectorAll('[role^="menuitem"]:not([disabled])')]
    if (!items.length) return
    const index = items.indexOf(document.activeElement)
    let next = null
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next === null) return
    event.preventDefault()
    items[next].focus()
  }

  const toggle = () => (open ? close() : setOpen(true))

  const triggerProps = {
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: toggle,
  }
  const triggerNode = isValidElement(trigger)
    ? cloneElement(trigger, {
      ...triggerProps,
      ref: triggerRef,
      onClick: (event) => {
        trigger.props.onClick?.(event)
        toggle()
      },
    })
    : createElement(
      'button',
      {
        type: 'button',
        ref: triggerRef,
        'aria-label': label ?? t('ios.more'),
        className: 'glass inline-flex h-11 w-11 items-center justify-center rounded-full text-text-primary ios-press',
        ...triggerProps,
      },
      createElement(MoreHorizontal, { size: 20, 'aria-hidden': true }),
    )

  const visibleSections = sections.filter(section => section?.length)

  return (
    <>
      {triggerNode}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          className={clsx('ios-menu-in fixed w-[260px] max-w-[calc(100vw-16px)]', !position && 'invisible')}
          style={{
            zIndex: 'var(--z-menu)',
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            minWidth: 220,
            maxWidth: MENU_WIDTH + 20,
            transformOrigin: align === 'start' ? 'top left' : 'top right',
          }}
        >
          <div className="glass overflow-hidden rounded-[14px]">
            {visibleSections.map((section, sectionIndex) => (
              <div
                key={sectionIndex}
                role="group"
                className={clsx(sectionIndex > 0 && 'border-t-[8px] border-black/30')}
              >
                {section.map((item, itemIndex) => (
                  <button
                    key={item.id ?? item.label}
                    type="button"
                    role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                    aria-checked={item.checked === undefined ? undefined : Boolean(item.checked)}
                    disabled={item.disabled}
                    tabIndex={-1}
                    onClick={() => {
                      close()
                      item.onSelect?.()
                    }}
                    className={clsx(
                      'flex min-h-[44px] w-full items-center justify-between gap-3 px-4 text-left text-body',
                      'ios-press outline-none focus-visible:bg-fill-tertiary disabled:opacity-40',
                      itemIndex > 0 && 'border-t-[0.5px] border-border',
                      item.destructive ? 'text-red' : 'text-text-primary',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.checked
                      ? <Check size={18} strokeWidth={2.5} className="flex-shrink-0 text-tint" aria-hidden="true" />
                      : item.icon && (isValidElement(item.icon)
                        ? item.icon
                        : createElement(item.icon, { size: 18, className: 'flex-shrink-0', 'aria-hidden': true }))}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>,
        container ?? document.body,
      )}
    </>
  )
}
