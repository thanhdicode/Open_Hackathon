import type { CountryCode } from "./countries";
import type { DnaScores } from "./dna";
import type { JourneyDates } from "../lib/journey/dates";

export interface TodayTask {
  id: string;
  title: string;
  meta: string;
  phase: string;
  done?: boolean;
}

export interface Journey {
  id: string;
  name: string;
  age?: number;
  avatarColor: string;
  initials: string;
  home: CountryCode;
  host: CountryCode;
  city: string;
  university: string;
  major: string;
  /**
   * Display strings for the same two dates. The shape is `1 Aug 2026` —
   * day-first, no comma — which is exactly what `journeyDateLabel()` produces
   * for a custom journey. Seed stories and user-created journeys therefore read
   * identically; a divergence here is a rendering bug, not a style choice.
   */
  arrival: string;
  departure: string;
  /**
   * The canonical timeline. `arrival` and `departure` above are the display
   * strings for the same two dates; this is the machine-readable pair the stage
   * is derived from, plus the programme dates the Greenbook and Today use.
   *
   * Stage is deliberately NOT a field here. It is computed from these dates
   * (`deriveStage`), because a stored stage goes stale the moment a day passes.
   */
  dates: JourneyDates;
  dayCount: number;
  totalDays: number;
  languages: { name: string; level: string }[];
  interests: string[];
  concerns: string[];
  myDna: DnaScores;
  myDnaAssessed?: boolean;
  readiness: number;
  weekProgress: number;
  primaryTask: TodayTask;
  practiceMission: { title: string; reason: string };
  reminder: { title: string; when: string };
  cultureTip: { title: string; body: string };
  deep?: boolean;
}

export const JOURNEYS: Journey[] = [
  {
    id: "minh",
    name: "Minh",
    age: 20,
    avatarColor: "#3157D5",
    initials: "M",
    home: "VN",
    host: "SG",
    city: "Singapore",
    university: "National University of Singapore",
    major: "Computer Science",
    arrival: "12 Aug 2026",
    departure: "20 Dec 2026",
    dates: { departureDate: "2026-08-09", arrivalDate: "2026-08-12", programStartDate: "2026-08-17", programEndDate: "2026-12-11", returnDate: "2026-12-20" },
    dayCount: 34,
    totalDays: 130,
    languages: [
      { name: "Vietnamese", level: "Native" },
      { name: "English", level: "B1–B2" },
    ],
    interests: ["AI", "Coffee", "Football", "Photography"],
    concerns: ["Speaking up in class", "Group project friction", "Understanding local English"],
    myDna: { directness: 42, formality: 76, hierarchy: 74, conflict: 37, relationship: 68, time: 61, participation: 48, uncertainty: 55 },
    readiness: 82,
    weekProgress: 60,
    primaryTask: { id: "t-bank", title: "Open a student bank account", meta: "Money & Banking · needs 3 documents", phase: "First Week" },
    practiceMission: { title: "Introduce a disagreement politely in a group project", reason: "Your conflict-openness is lower than most NUS group settings expect" },
    reminder: { title: "CS2103 group sync", when: "Tomorrow · 10:00" },
    cultureTip: { title: "\"Can\" means yes", body: "In Singapore, \"can lah\" is a friendly confirmation — not dismissive. It usually means \"sure, no problem\"." },
    deep: true,
  },
  {
    id: "dewi",
    name: "Dewi",
    age: 21,
    avatarColor: "#169B62",
    initials: "D",
    home: "ID",
    host: "TH",
    city: "Bangkok",
    university: "Chulalongkorn University",
    major: "International Business",
    arrival: "5 Aug 2026",
    departure: "15 Dec 2026",
    dates: { departureDate: "2026-08-02", arrivalDate: "2026-08-05", programStartDate: "2026-08-10", programEndDate: "2026-12-04", returnDate: "2026-12-15" },
    dayCount: 41,
    totalDays: 132,
    languages: [
      { name: "Bahasa Indonesia", level: "Native" },
      { name: "English", level: "B2" },
      { name: "Thai", level: "A1" },
    ],
    interests: ["Street food", "K-pop", "Marketing", "Muay Thai"],
    concerns: ["Thai language basics", "Classroom etiquette", "Kreng jai culture"],
    myDna: { directness: 40, formality: 64, hierarchy: 60, conflict: 44, relationship: 78, time: 48, participation: 62, uncertainty: 58 },
    readiness: 74,
    weekProgress: 45,
    primaryTask: { id: "t-sim", title: "Get an AIS student SIM", meta: "SIM & Connectivity · passport required", phase: "First Week" },
    practiceMission: { title: "Order lunch using 5 Thai phrases", reason: "Building spoken Thai confidence is your biggest gap" },
    reminder: { title: "Faculty welcome session", when: "Fri · 14:00" },
    cultureTip: { title: "Mind the wai", body: "Return a wai to elders and staff, but you don't need to wai children or service workers who wai you first." },
  },
  {
    id: "kevin",
    name: "Kevin",
    age: 22,
    avatarColor: "#F59E0B",
    initials: "K",
    home: "TH",
    host: "PH",
    city: "Manila",
    university: "Ateneo de Manila University",
    major: "Communication",
    arrival: "1 Aug 2026",
    departure: "10 Dec 2026",
    dates: { departureDate: "2026-07-29", arrivalDate: "2026-08-01", programStartDate: "2026-08-05", programEndDate: "2026-11-27", returnDate: "2026-12-10" },
    dayCount: 45,
    totalDays: 131,
    languages: [
      { name: "Thai", level: "Native" },
      { name: "English", level: "B1" },
    ],
    interests: ["Film", "Basketball", "Podcasts", "Coffee"],
    concerns: ["Fast spoken English", "Being expressive enough", "Taglish slang"],
    myDna: { directness: 38, formality: 68, hierarchy: 74, conflict: 30, relationship: 72, time: 52, participation: 40, uncertainty: 48 },
    readiness: 68,
    weekProgress: 70,
    primaryTask: { id: "t-org", title: "Join a student org fair", meta: "Student Life · this week", phase: "First Week" },
    practiceMission: { title: "Keep up in a fast, casual English group chat", reason: "Following rapid Taglish discussion is your top concern" },
    reminder: { title: "Comm 101 presentation", when: "Wed · 09:00" },
    cultureTip: { title: "Po and opo", body: "Adding \"po\" to sentences shows respect to elders and professors — a small word that goes a long way here." },
  },
  {
    id: "aisyah",
    name: "Aisyah",
    age: 20,
    avatarColor: "#E5484D",
    initials: "A",
    home: "MY",
    host: "VN",
    city: "Ho Chi Minh City",
    university: "Vietnam National University",
    major: "Economics",
    arrival: "18 Aug 2026",
    departure: "22 Dec 2026",
    dates: { departureDate: "2026-08-15", arrivalDate: "2026-08-18", programStartDate: "2026-08-24", programEndDate: "2026-12-11", returnDate: "2026-12-22" },
    dayCount: 28,
    totalDays: 126,
    languages: [
      { name: "Malay", level: "Native" },
      { name: "English", level: "B2" },
      { name: "Vietnamese", level: "A1" },
    ],
    interests: ["Cafés", "Fashion", "Economics", "Travel"],
    concerns: ["Vietnamese pronouns", "Halal food", "Academic hierarchy"],
    myDna: { directness: 55, formality: 58, hierarchy: 60, conflict: 50, relationship: 66, time: 62, participation: 66, uncertainty: 60 },
    readiness: 71,
    weekProgress: 40,
    primaryTask: { id: "t-halal", title: "Map halal food near campus", meta: "Explore · Student Food", phase: "First Week" },
    practiceMission: { title: "Address a lecturer with the right pronoun (thầy/cô)", reason: "Vietnamese address forms encode respect you'll use daily" },
    reminder: { title: "Residence registration", when: "Mon · 11:00" },
    cultureTip: { title: "Coffee is connection", body: "In Vietnam, \"đi cà phê\" (going for coffee) is the main way friendships and study groups form." },
  },
  {
    id: "wei",
    name: "Wei",
    age: 21,
    avatarColor: "#7A5AF8",
    initials: "W",
    home: "SG",
    host: "VN",
    city: "Ha Noi",
    university: "Foreign Trade University",
    major: "Business Analytics",
    arrival: "20 Aug 2026",
    departure: "24 Dec 2026",
    dates: { departureDate: "2026-08-17", arrivalDate: "2026-08-20", programStartDate: "2026-08-24", programEndDate: "2026-12-11", returnDate: "2026-12-24" },
    dayCount: 26,
    totalDays: 126,
    languages: [
      { name: "English", level: "Native" },
      { name: "Mandarin", level: "B2" },
      { name: "Vietnamese", level: "A1" },
    ],
    interests: ["Startups", "Street photography", "Coffee", "Running"],
    concerns: ["Indirect communication", "Slower pace", "Reading the room"],
    myDna: { directness: 72, formality: 50, hierarchy: 46, conflict: 62, relationship: 48, time: 80, participation: 74, uncertainty: 60 },
    readiness: 69,
    weekProgress: 35,
    primaryTask: { id: "t-momo", title: "Set up a MoMo e-wallet", meta: "Systems · payments", phase: "First Week" },
    practiceMission: { title: "Soften a direct request so it doesn't feel abrupt", reason: "Ha Noi settings often read very direct asks as blunt" },
    reminder: { title: "Team project kickoff", when: "Thu · 15:00" },
    cultureTip: { title: "Slow down the ask", body: "A little warmth before the request (\"how are you?\" first) makes messages land much better here." },
  },
];

export function journeyById(id: string): Journey {
  return JOURNEYS.find((j) => j.id === id) ?? JOURNEYS[0];
}
