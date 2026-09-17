import type { DriveStep } from "driver.js"
import type { CountryCode } from "../data/countries"

type TourEntry = {
  selector: string
  title: string
  description: string
}
const step = (
  anchor: string,
  title: string,
  description: string,
): TourEntry => ({ selector: `[data-yep="${anchor}"]`, title, description })
export const TOURS = {
  today: [
    step(
      "intro",
      "Meet Yep",
      "Today gives you a next step. Passport holds country guidance; Lens helps interpret a moment; Explore finds places; Connect introduces real students.",
    ),
    step(
      "focus",
      "One useful task",
      "Open the guide and check requirements before marking a task done. Your progress belongs to your own journey.",
    ),
    step(
      "practice",
      "Rehearse before you go",
      "Start an AI roleplay to practise a real situation. You can retry after feedback.",
    ),
  ],
  passport: [
    step(
      "intro",
      "Your destination guide",
      "This Passport follows your home-to-host journey. Yep’s outfit is heritage-inspired art, not a rule about how people dress.",
    ),
    step(
      "sections",
      "Check the source",
      "Open a section, then a guidance card. Check its verification status, review date and official source before relying on requirements.",
    ),
  ],
  lens: [
    step(
      "intro",
      "Understand a moment",
      "Choose text, a photo, camera or voice. AI suggests likely meaning and next steps; it can be uncertain.",
    ),
    step(
      "input",
      "You control what is shared",
      "Paste a message or use the visible capture/upload controls. Leave out private details you do not need to interpret. Camera and microphone require permission.",
    ),
    step(
      "modes",
      "More ways to communicate",
      "Conversation translates and coaches turn by turn. You confirm before a suggested reply is spoken. You can practise a situation in YapSim.",
    ),
  ],
  conversation: [
    step(
      "intro",
      "Translate, then decide",
      "Listen to the other person, read the translation and coaching, then choose your response. Yep is your guide, not the other speaker.",
    ),
    step(
      "controls",
      "Keep control of your voice",
      "Hold to record or type. Review your reply before choosing Speak to them. Nothing is sent just by opening this guide.",
    ),
  ],
  sim: [
    step(
      "intro",
      "A safe place to practise",
      "AI plays a conversation partner. Yep helps you learn; the partner’s words are roleplay, not official advice.",
    ),
    step(
      "situation",
      "Choose the situation",
      "Pick where the conversation happens. An optional goal makes practice more specific.",
    ),
    step(
      "start",
      "Start when ready",
      "Use Start roleplay yourself. Read hints and translations during practice, then review feedback and try again.",
    ),
  ],
  study: [
    step(
      "intro",
      "Explore study examples",
      "This prototype shows sample inputs and explanations. It does not upload your lectures or run live Study AI here.",
    ),
    step(
      "modes",
      "Choose an example",
      "Open a mode to see its sample input and output. Lens and YapSim are available for live interpretation and practice.",
    ),
  ],
  greenbook: [
    step(
      "intro",
      "A sourced field manual",
      "Your Greenbook follows your destination and journey. Sparse coverage is shown honestly; an illustration is not verification.",
    ),
    step(
      "browse",
      "Read or ask",
      "Browse the chapters or ask a specific question. Check the answer’s linked sources and freshness; missing verified guidance is not filled with guesses.",
    ),
  ],
  ask: [
    step(
      "intro",
      "Ask with a source in mind",
      "Greenbook answers from verified country facts. If sources do not cover your question, it says so. Yep’s guidance does not certify an answer.",
    ),
    step(
      "question",
      "Keep it specific",
      "Ask one practical question. Avoid sharing account numbers, identity documents or other private details.",
    ),
    step(
      "ask",
      "Read the evidence",
      "Press Ask when ready, then check the sources below the answer. Opening this tour never submits a question.",
    ),
  ],
  explore: [
    step(
      "intro",
      "Find a useful place",
      "Choose a category and scope, then select a map pin or a list entry. You can use Explore without sharing your location.",
    ),
    step(
      "list",
      "Map and list work together",
      "Select a place to open details and save it. Check its information before going. Location is optional and requested only when you choose it.",
    ),
  ],
  connect: [
    step(
      "intro",
      "Meet real students",
      "Community shares student experiences. People helps you find relevant students; Yep is not a student account.",
    ),
    step(
      "feed",
      "Choose what you see",
      "Browse the feed, save useful posts or open a place. Be thoughtful about what personal information you share; report or block unsafe behaviour.",
    ),
  ],
  help: [
    step(
      "intro",
      "Yep is here to help",
      "Find Show me on Today, Passport, Lens, Explore and Connect, and in practice or Greenbook. Each tour stays within its own screen.",
    ),
    step(
      "intro",
      "Your pace, your choice",
      "You can close any tour and replay it later. Guides never record, send a message or change your answers. Dismiss hides the expanded card on this browser.",
    ),
  ],
} satisfies Record<string, TourEntry[]>
export type GuideScreen = keyof typeof TOURS

export function visibleTourSteps(
  root: ParentNode,
  entries: TourEntry[],
): DriveStep[] {
  return entries.flatMap((entry) => {
    const element = root.querySelector(entry.selector)
    if (!element) return []
    const rect = element.getBoundingClientRect()
    if (
      !rect.width ||
      !rect.height ||
      (element.checkVisibility &&
        !element.checkVisibility({
          checkVisibilityCSS: true,
          checkOpacity: true,
        }))
    )
      return []
    return [
      {
        element,
        popover: {
          title: entry.title,
          description: entry.description,
          side: "bottom" as const,
          align: "center" as const,
        },
        disableActiveInteraction: true,
      },
    ]
  })
}

const guideKey = (screen: string) => `yapyep.yep.v1.${screen}`
export function readGuideDismissed(
  screen: string,
  storage?: Pick<Storage, "getItem">,
): boolean {
  try {
    return (storage ?? localStorage).getItem(guideKey(screen)) === "1"
  } catch {
    return false
  }
}
export function writeGuideDismissed(
  screen: string,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    ;(storage ?? localStorage).setItem(guideKey(screen), "1")
  } catch {
    /* Private browsing: keep the current screen usable. */
  }
}

const kebaya =
  "https://ich.unesco.org/en/RL/kebaya-knowledge-skills-traditions-and-practices-02090"
export const COUNTRY_OUTFITS: Record<CountryCode, {
  cell: number
  label: string
  source: string
}> = {
  BN: { cell: 0, label: "Kebaya-inspired", source: kebaya },
  KH: {
    cell: 1,
    label: "Krama and wrap-inspired",
    source:
      "https://www.unesco.org/en/articles/unesco-congratulates-cambodia-kramas-inscription",
  },
  ID: { cell: 2, label: "Kebaya-inspired", source: kebaya },
  LA: {
    cell: 3,
    label: "Woven skirt-inspired",
    source:
      "https://www.tourismlaos.org/welcome/authentic-culture/artisans-handicrafts/",
  },
  MY: { cell: 4, label: "Kebaya-inspired", source: kebaya },
  MM: {
    cell: 5,
    label: "Longyi-inspired",
    source: "https://www.moi.gov.mm/moi%3Aeng/news/3995",
  },
  PH: {
    cell: 6,
    label: "Barong-inspired",
    source:
      "https://www.nafa.edu.sg/docs/default-source/press-releases/2019/pina-seda-annex-1.pdf",
  },
  SG: {
    cell: 7,
    label: "Peranakan kebaya-inspired",
    source: "https://www.roots.gov.sg/ich-landing/ich/Kebaya",
  },
  TH: {
    cell: 8,
    label: "Ruean Ton-inspired",
    source:
      "https://www.tatnews.org/2025/08/chud-thai-a-timeless-invitation-to-dress-the-nation-in-heritage/",
  },
  TL: {
    cell: 9,
    label: "Tais-inspired",
    source: "https://www.unesco.org/archives/multimedia/document-5636",
  },
  VN: {
    cell: 10,
    label: "Ao dai-inspired",
    source: "https://vietnam.travel/node/1216",
  },
}
