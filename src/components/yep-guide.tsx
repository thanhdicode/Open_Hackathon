import { useEffect, useRef, useState } from "react"
import { driver, type Driver } from "driver.js"
import "driver.js/dist/driver.css"
import Mascot, { type MascotPose } from "./mascot"
import {
  COUNTRY_OUTFITS,
  readGuideDismissed,
  writeGuideDismissed,
  TOURS,
  visibleTourSteps,
  type GuideScreen,
} from "../lib/yep-guidance"
import type { CountryCode } from "../data/countries"
import { useNav } from "../context/NavContext"
import { useAccount } from "../context/AccountContext"
import { account as accountApi } from "../lib/appwrite/client"

let activeTour: Driver | null = null

export default function YepGuide({
  screen,
  title,
  children,
  pose = "wave",
  country,
  compact = true,
  autoStart = false,
}: {
  screen: GuideScreen
  title: string
  children: string
  pose?: MascotPose
  country?: CountryCode
  compact?: boolean
  autoStart?: boolean
}) {
  const nav = useNav()
  const { account: identity, loading } = useAccount()
  const scope = `${identity?.userId ?? "guest"}.${screen}`
  const remoteComplete = screen === "today" && identity?.prefs.yapyepProductTourV1 === true
  const card = useRef<HTMLDivElement>(null)
  const tour = useRef<Driver | null>(null)
  const restoreFocus = useRef(true)
  const [dismissed, setDismissed] = useState(() => readGuideDismissed(scope) || remoteComplete)
  const autoHandled = useRef(false)
  useEffect(() => setDismissed(readGuideDismissed(scope) || remoteComplete), [scope, remoteComplete])
  useEffect(() => {
    if (!autoStart || autoHandled.current || loading || !identity || dismissed || remoteComplete || nav.stack.length) return
    const frame = requestAnimationFrame(() => { autoHandled.current = true; start() })
    return () => cancelAnimationFrame(frame)
  }, [autoStart, loading, identity?.userId, dismissed, remoteComplete, nav.stack])
  function persistDismissal() {
    writeGuideDismissed(scope)
    if (screen === "today" && identity?.kind === "registered") void accountApi.get().then((user) => accountApi.updatePrefs({ prefs: { ...user.prefs, yapyepProductTourV1: true } })).catch(() => {})
  }
  const [notice, setNotice] = useState("")
  // Observe stack changes because overlays leave the underlying tab mounted.
  useEffect(
    () => () => {
      restoreFocus.current = false
      tour.current?.destroy()
    },
    [nav.tab, nav.stack, screen],
  )

  function start() {
    activeTour?.destroy()
    restoreFocus.current = true
    const root = card.current?.closest("[data-tour-screen]")
    if (!root || document.querySelector('[role="dialog"]')) return
    ;(document.activeElement as HTMLElement | null)?.blur()
    const steps = visibleTourSteps(root, TOURS[screen])
    if (!steps.length) {
      setNotice("This guide is available when the screen is ready.")
      return
    }
    const returnFocus =
      card.current?.querySelector<HTMLButtonElement>("[data-yep-replay]")
    const viewport = window.visualViewport
    let frame = 0
    let observer: MutationObserver
    function boundPopover() {
      const popover = document.querySelector<HTMLElement>(".yep-tour")
      if (!popover) return
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      const style = getComputedStyle(popover)
      const safeTop = parseFloat(style.getPropertyValue("--yep-safe-top")) || 0
      const safeBottom =
        parseFloat(style.getPropertyValue("--yep-safe-bottom")) || 0
      popover.style.maxWidth = `${Math.max(160, width - 24)}px`
      popover.style.maxHeight = `${Math.max(100, height - 24 - safeTop - safeBottom)}px`
      const rect = popover.getBoundingClientRect()
      popover.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - rect.width - 12))}px`
      popover.style.top = `${Math.max(top + 12 + safeTop, Math.min(rect.top, top + height - rect.height - 12 - safeBottom))}px`
      popover.style.right = "auto"
      popover.style.bottom = "auto"
    }
    function scheduleBounds() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(boundPopover)
    }
    function closeForKeyboard() {
      if (viewport && viewport.height < window.innerHeight * 0.72)
        tour.current?.destroy()
      else scheduleBounds()
    }
    const instance = driver({
      steps,
      animate: false,
      smoothScroll: false,
      allowClose: true,
      overlayOpacity: 0.42,
      disableActiveInteraction: true,
      showProgress: true,
      stagePadding: 5,
      stageRadius: 12,
      popoverOffset: 12,
      popoverClass: "yep-tour",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Got it",
      progressText: "{{current}} / {{total}}",
      onPopoverRender: (popover) => {
        popover.wrapper.setAttribute("aria-label", "Yep’s screen guide")
        popover.wrapper.setAttribute("aria-modal", "true")
        popover.closeButton.setAttribute("aria-label", "Close guide")
        const image = document.createElement("img")
        image.src = `${import.meta.env.BASE_URL}brand/yep-mascot-v1.png`
        image.alt = ""
        image.width = 44
        image.height = 44
        image.className = "yep-tour-mascot"
        popover.title.prepend(image)
        scheduleBounds()
      },
      onHighlighted: scheduleBounds,
      onDestroyed: () => {
        cancelAnimationFrame(frame)
        observer?.disconnect()
        window.removeEventListener("resize", scheduleBounds)
        document.removeEventListener("scroll", scheduleBounds, true)
        viewport?.removeEventListener("resize", closeForKeyboard)
        viewport?.removeEventListener("scroll", scheduleBounds)
        if (activeTour === instance) activeTour = null
        if (tour.current === instance) tour.current = null
        persistDismissal()
        setDismissed(true)
        if (restoreFocus.current && returnFocus?.isConnected)
          requestAnimationFrame(() => {
            if (restoreFocus.current && returnFocus.isConnected)
              returnFocus.focus({ preventScroll: true })
          })
      },
    })
    tour.current = instance
    activeTour = instance
    observer = new MutationObserver(() => {
      const target = instance.getActiveElement()
      const hidden =
        target &&
        (!target.isConnected ||
          !target.getBoundingClientRect().width ||
          (target.checkVisibility &&
            !target.checkVisibility({ checkVisibilityCSS: true })))
      if (
        !root.isConnected ||
        hidden ||
        document.querySelector('[role="dialog"]:not(.driver-popover)')
      )
        instance.destroy()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "class", "style", "aria-hidden"],
    })
    window.addEventListener("resize", scheduleBounds)
    document.addEventListener("scroll", scheduleBounds, true)
    viewport?.addEventListener("resize", closeForKeyboard)
    viewport?.addEventListener("scroll", scheduleBounds)
    instance.drive()
  }

  return (
    <div
      ref={card}
      data-yep-guide={screen}
      className={`my-3 ${
        dismissed || compact
          ? ""
          : "rounded-[12px] border border-line bg-surface p-3"
      }`}
    >
      {!dismissed && !compact && (
        <div className="flex items-start gap-2.5">
          <Mascot pose={pose} country={country} size={country ? 88 : 64} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold text-ink">{title}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              {children}
            </p>
            {country && (
              <a
                href={COUNTRY_OUTFITS[country].source}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex min-h-[44px] items-center text-[11px] text-primary underline"
              >
                {COUNTRY_OUTFITS[country].label} · Heritage reference
              </a>
            )}
          </div>
        </div>
      )}
      <div
        className={`flex flex-wrap items-center gap-x-3 ${
          dismissed || compact ? "" : "mt-1"
        }`}
      >
        <button
          type="button"
          data-yep="intro"
          data-yep-replay
          onClick={start}
          className="inline-flex min-h-[44px] items-center gap-1.5 text-[12px] font-semibold text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {(dismissed || compact) && (
            <Mascot country={country} size={country ? 48 : 32} />
          )}{" "}
          {dismissed || compact ? "Yep’s guide" : "Show me"}
          <span className="sr-only">: {title}</span>
        </button>
        {!dismissed && !compact && (
          <button
            type="button"
            aria-label={`Dismiss ${title} guide card`}
            onClick={() => {
              persistDismissal()
              setDismissed(true)
            }}
            className="min-h-[44px] px-2 text-[12px] text-muted"
          >
            Dismiss
          </button>
        )}
      </div>
    {country && (dismissed || compact) && (
        <a
          href={COUNTRY_OUTFITS[country].source}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-[44px] items-center text-[11px] text-primary underline"
        >
          {COUNTRY_OUTFITS[country].label} · Heritage illustration
        </a>
      )}
      {notice && (
        <p role="status" className="text-[12px] text-muted">
          {notice}
        </p>
      )}
    </div>
  )
}
