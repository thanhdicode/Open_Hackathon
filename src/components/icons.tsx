export type IconName =
  | "today"
  | "passport"
  | "lens"
  | "explore"
  | "connect"
  | "back"
  | "close"
  | "chevron"
  | "check"
  | "text"
  | "image"
  | "camera"
  | "mic"
  | "chat"
  | "calendar"
  | "signal"
  | "practice"
  | "info"
  | "alert"
  | "star"
  | "pin"
  | "settings"
  | "globe"
  // Phase 5 — Connect + Explore
  | "heart"
  | "bookmark"
  | "plus"
  | "search"
  | "map"
  | "location"
  | "translate"
  | "send"
  | "more"
  | "flag"
  | "users"
  | "layers"
  // Phase 5.1 — community media
  | "play"
  | "video"
  | "trash";

/**
 * Monochrome line icons. Decorative emoji are not used as icons (ADR-003 §4).
 */
export function Icon({ name, size = 24, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  const sw = filled ? 0 : 1.9;
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: filled ? "currentColor" : "none",
    stroke: "currentColor",
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "today":
      return (
        <svg {...common}>
          <path d="M3 10.5 12 4l9 6.5" stroke="currentColor" fill="none" strokeWidth={1.9} />
          <path d="M5 9.5V20h14V9.5" fill={filled ? "currentColor" : "none"} />
        </svg>
      );
    case "passport":
      return (
        <svg {...common}>
          <rect x="5" y="3" width="14" height="18" rx="2.5" fill={filled ? "currentColor" : "none"} />
          <circle cx="12" cy="10" r="3" fill="none" stroke={filled ? "#fff" : "currentColor"} strokeWidth={1.7} />
          <path d="M9 16h6" stroke={filled ? "#fff" : "currentColor"} strokeWidth={1.7} />
        </svg>
      );
    case "lens":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" fill={filled ? "currentColor" : "none"} />
          <circle cx="11" cy="11" r="2.5" fill="none" stroke={filled ? "#fff" : "currentColor"} strokeWidth={1.7} />
          <path d="m17 17 4 4" strokeWidth={2} />
        </svg>
      );
    case "explore":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill={filled ? "currentColor" : "none"} />
          <path d="m15 9-2 5-4 1 2-5z" fill={filled ? "#fff" : "none"} stroke={filled ? "#fff" : "currentColor"} strokeWidth={1.6} />
        </svg>
      );
    case "connect":
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="3" fill={filled ? "currentColor" : "none"} />
          <circle cx="16.5" cy="11" r="2.4" fill={filled ? "currentColor" : "none"} />
          <path d="M3.5 19c.6-3 3-4.5 5.5-4.5S14 16 14.5 19M14 15.2c1.8-.3 4 .6 4.7 3" />
        </svg>
      );
    case "back":
      return (
        <svg {...common}>
          <path d="m15 5-7 7 7 7" strokeWidth={2.1} />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6 6 18" strokeWidth={2.1} />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" strokeWidth={2} />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m5 12 4.5 4.5L19 7" strokeWidth={2.2} />
        </svg>
      );
    case "text":
      return (
        <svg {...common}>
          <path d="M5 6.5V5h14v1.5M12 5v14M9 19h6" strokeWidth={1.9} />
        </svg>
      );
    case "image":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m5 17 4.5-4.5 3 3 2.5-2.5L19.5 17" />
        </svg>
      );
    case "camera":
      return (
        <svg {...common}>
          <path d="M4 8.5h2.6L8 6h8l1.4 2.5H20V19H4z" />
          <circle cx="12" cy="13" r="3.2" />
        </svg>
      );
    case "mic":
      return (
        <svg {...common}>
          <rect x="9.2" y="3" width="5.6" height="10" rx="2.8" />
          <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.5 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5z" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3.5" y="5.5" width="17" height="14" rx="2.5" />
          <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
        </svg>
      );
    case "signal":
      return (
        <svg {...common}>
          <path d="M5 15.5a10 10 0 0 1 14 0M8 18.5a6 6 0 0 1 8 0M12 21h.01" />
          <path d="M12 3v6M12 9 8.5 5.5M12 9l3.5-3.5" />
        </svg>
      );
    case "practice":
      return (
        <svg {...common}>
          <circle cx="9.5" cy="8" r="3" />
          <path d="M3.5 19.5c.5-3.2 3-5 6-5s5.5 1.8 6 5" />
          <path d="M17 6.5h3.5v5H17z" />
          <path d="M17 9h3.5" />
        </svg>
      );
    case "info":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5.5M12 7.8v.4" strokeWidth={2} />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <path d="M12 4.5 3.5 19.5h17z" />
          <path d="M12 10v4.5M12 17.2v.3" strokeWidth={2} />
        </svg>
      );
    case "star":
      return (
        <svg {...common}>
          <path d="m12 4.5 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10.2l5.4-.8z" fill={filled ? "currentColor" : "none"} />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="M12 21s6.5-5.6 6.5-10.2A6.5 6.5 0 0 0 5.5 10.8C5.5 15.4 12 21 12 21z" />
          <circle cx="12" cy="10.6" r="2.4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
        </svg>
      );
    case "globe":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z" />
        </svg>
      );
    /* ------------------------- Phase 5 — Connect + Explore ------------------------- */
    case "heart":
      return (
        <svg {...common}>
          <path
            d="M12 20s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"
            fill={filled ? "currentColor" : "none"}
          />
        </svg>
      );
    case "bookmark":
      return (
        <svg {...common}>
          <path d="M6.5 4.5h11v15l-5.5-3.8-5.5 3.8z" fill={filled ? "currentColor" : "none"} />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5.5v13M5.5 12h13" strokeWidth={2.1} />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.2" />
          <path d="m16 16 4.5 4.5" strokeWidth={2} />
        </svg>
      );
    case "map":
      return (
        <svg {...common}>
          <path d="M9 4.5 3.5 6.8V20L9 17.7l6 2.3 5.5-2.3V4.5L15 6.8z" />
          <path d="M9 4.5v13.2M15 6.8v13.2" />
        </svg>
      );
    case "location":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="2.6" fill={filled ? "currentColor" : "none"} />
          <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4" />
        </svg>
      );
    case "translate":
      return (
        <svg {...common}>
          <path d="M4 6h8M8 4.5v1.5M9.6 6c-.7 3.2-2.4 5.6-5.1 7.4" />
          <path d="M5.4 9.6c1.1 1.9 2.7 3.3 4.6 4.2" />
          <path d="m12.6 19.5 3.4-9 3.4 9M13.8 16.6h4.4" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M20 4 3.5 10.8l6.2 2.4M20 4l-6.4 16-3.9-6.8M20 4 9.7 13.2" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "flag":
      return (
        <svg {...common}>
          <path d="M6 21V4.5M6 5.2c3-1.4 6 1.4 9 0v7.6c-3 1.4-6-1.4-9 0z" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8.5" r="3.2" />
          <path d="M3 19.5c.6-3.4 3.2-5.3 6-5.3s5.4 1.9 6 5.3" />
          <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 14.8c2 .7 3.3 2.3 3.7 4.7" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common}>
          <path d="m12 3.5 8 4.2-8 4.2-8-4.2z" fill={filled ? "currentColor" : "none"} />
          <path d="m4 13 8 4.2 8-4.2" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill={filled ? "currentColor" : "none"} />
          <path d="M10.5 8.8v6.4l5.2-3.2z" fill={filled ? "#fff" : "currentColor"} stroke="none" />
        </svg>
      );
    case "video":
      return (
        <svg {...common}>
          <rect x="3" y="6" width="12.5" height="12" rx="2.5" fill={filled ? "currentColor" : "none"} />
          <path d="m16 12 5-3v6z" fill={filled ? "currentColor" : "none"} />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M5 7h14M10 7V5.5h4V7M7 7l.8 12h8.4L17 7" />
          <path d="M10.5 10.5v5M13.5 10.5v5" strokeWidth={1.6} />
        </svg>
      );
  }
}
