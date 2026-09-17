import { useState } from "react"
import type { CountryCode } from "../data/countries"
import { COUNTRY_OUTFITS } from "../lib/yep-guidance"

export type MascotPose = "wave" | "think" | "practice" | "celebrate" | "explore"
const CELLS = { think: 0, practice: 1, celebrate: 2, explore: 3 }
const base = `${import.meta.env.BASE_URL}brand/`

export default function Mascot({
  pose = "wave",
  country,
  size = 72,
  className = "",
  label,
}: {
  pose?: MascotPose
  country?: CountryCode
  size?: number
  className?: string
  label?: string
}) {
  const [failed, setFailed] = useState(false)
  if ((pose === "wave" && !country) || failed)
    return (
      <img
        src={`${base}yep-mascot-v1.png`}
        width={size}
        height={size}
        alt={label ?? ""}
        className={`shrink-0 object-contain ${className}`}
        draggable={false}
      />
    )
  const cell = country
    ? COUNTRY_OUTFITS[country].cell
    : CELLS[(pose as keyof typeof CELLS)]
  const cols = country ? 4 : 2
  const rows = country ? 3 : 2
  const src = `${base}${country ? "yep-heritage-v1.png" : "yep-states-v1.png"}`
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-mascot-country={country}
      data-mascot-pose={pose}
      className={`relative inline-block shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        backgroundImage: `url("${src}")`,
        backgroundSize: `${cols * 100}% ${rows * 100}%`,
        backgroundPosition: `${((cell % cols) * 100) / (cols - 1)}% ${(Math.floor(cell / cols) * 100) / (rows - 1)}%`,
      }}
    >
      <img
        src={src}
        alt=""
        className="hidden"
        onError={() => setFailed(true)}
      />
    </span>
  )
}
