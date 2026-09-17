import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { JourneyProvider, useJourney, makeCustomJourney } from "./context/JourneyContext";
import { AccountProvider } from "./context/AccountContext";
import { NavProvider, useNav } from "./context/NavContext";
import { AppShell, TopHeader, BottomNavigation, type TabKey } from "./components/shell";
import { Notice } from "./components/ui";
import Onboarding from "./features/Onboarding";
import MyDnaAssessment from "./features/MyDnaAssessment";
import Today from "./features/Today";
import { PassportHome, PassportSection, PassportCardDetail } from "./features/Passport";
import BankFlow from "./features/BankFlow";
import Study from "./features/Study";
import { AddExperience } from "./features/explore/AddExperience";
import { Greenbook, ChapterBrowse, EntryDetail, AskGreenbookScreen, Phrases, StudentReality } from "./features/greenbook";
import type { GreenbookPracticeContext } from "./features/YapSim";
import { Profile, Compass } from "./features/Profile";
import { Settings, EditProfile, AccountSettings, PreferencesScreen, PrivacyData, BlockedUsers, LegalDoc, About } from "./features/Settings";
import { ensureAnonymousSession } from "./lib/appwrite/session";
import { loadJourney, saveJourney } from "./lib/appwrite/journeyPersistence";
import PwaControls from "./components/pwa-controls";
import { fetchTaskProgress } from "./lib/appwrite/taskProgress";
import { journeyById } from "./data/journeys";
import type { PassportCard } from "./data/passports";
import type { ExploreCategory, Place } from "./lib/phase5/contract";
import { useCurrentUserId } from "./lib/phase5/use-user";

const Lens = lazy(() => import("./features/Lens"));
const YapSim = lazy(() => import("./features/YapSim"));
const Explore = lazy(() => import("./features/Explore").then((module) => ({ default: module.Explore })));
const ConnectHome = lazy(() => import("./features/Connect").then((module) => ({ default: module.ConnectHome })));
const CommunityPostScreen = lazy(() => import("./features/community/CommunityPostScreen").then((module) => ({ default: module.CommunityPostScreen })));

function ViewLoading({ onBack }: { onBack?: () => void }) {
  return <div role="status" className="flex h-full flex-col gap-3 p-5"><p className="text-[14px] font-semibold text-muted">Opening your workspace…</p>{onBack && <button onClick={onBack} className="min-h-[44px] self-start text-[13px] font-semibold text-primary">Back</button>}<div className="yy-skeleton h-24 rounded-[12px]" /></div>;
}

export default function App() {
  return (
    <JourneyProvider>
      <AccountProvider>
        <NavProvider>
          <AppShell>
            <Root />
          </AppShell>
        </NavProvider>
      </AccountProvider>
    </JourneyProvider>
  );
}

function Root() {
  const [onboarded, setOnboarded] = useState(false);
  const [authNotice, setAuthNotice] = useState<{ tone: "primary" | "warning"; title: string; body: string } | null>(null);
  const restored = useRef(false);
  const { setJourneyId, hydrate } = useJourney();
  const nav = useNav();

  useEffect(() => {
    // OAuth returns to /?auth=google or /?auth_error=google — surface the result
    // and strip the parameters so a refresh does not repeat the message.
    const params = new URLSearchParams(window.location.search);
    const success = params.get("auth");
    const failure = params.get("auth_error");
    if (success === "google") {
      setAuthNotice({ tone: "primary", title: "Signed in with Google", body: "Your journey, Passport and progress are saved to this account." });
    } else if (failure === "google") {
      setAuthNotice({ tone: "warning", title: "Google sign-in did not finish", body: "Nothing was lost — try again or continue with Email instead." });
    }
    if (success || failure) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void (async () => {
      const session = await ensureAnonymousSession();
      if (!session.ok) return;
      const journey = await loadJourney(session.user.$id, journeyById("minh"));
      if (!journey) return;
      const tasks = await fetchTaskProgress(session.user.$id);
      hydrate(session.user.$id, journey, tasks);
      setOnboarded(true);
    })();
  }, [hydrate]);

  return <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1">{!onboarded ? (
      <Onboarding
        onStart={async () => {
          const result = await ensureAnonymousSession();
          return result.ok ? { ok: true } : { ok: false, message: result.message };
        }}
        onComplete={async ({ home, host, city, university, dates, myDna }) => {
          const session = await ensureAnonymousSession();
          if (!session.ok) throw new Error("Could not save journey");
          const next = { ...journeyById("minh"), ...makeCustomJourney(home, host, myDna, dates), city, university };
          if (!await saveJourney(session.user.$id, next)) throw new Error("Could not save journey");
          hydrate(session.user.$id, next, {});
          setOnboarded(true);
        }}
      />
    ) : <Main onReonboard={() => { setJourneyId("minh"); nav.reset(); setOnboarded(false); }} authNotice={authNotice} onDismissAuthNotice={() => setAuthNotice(null)} />}</div><PwaControls eligible={onboarded} /></div>;
}

function Main({ onReonboard, authNotice, onDismissAuthNotice }: { onReonboard: () => void; authNotice: { tone: "primary" | "warning"; title: string; body: string } | null; onDismissAuthNotice: () => void }) {
  const nav = useNav();
  const top = nav.stack[nav.stack.length - 1];

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Tab content */}
      <div className="flex min-h-0 flex-1 flex-col">
        <TopHeader onAvatar={() => nav.push("profile")} onCompass={() => nav.push("compass")} />
        {authNotice && (
          <div className="px-5 pt-3">
            <Notice tone={authNotice.tone} icon="info" title={authNotice.title} body={authNotice.body} />
            <button onClick={onDismissAuthNotice} className="mt-1.5 min-h-[44px] text-[12px] font-semibold text-muted">Dismiss</button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<ViewLoading />}><TabView tab={nav.tab} /></Suspense>
        </div>
      </div>

      <BottomNavigation active={nav.tab} onChange={(t: TabKey) => nav.setTab(t)} />

      {/* Overlay stack — scoped to the workspace column so rail stays usable */}
      {top && (
        <div className="absolute inset-0 z-40 bg-canvas">
          <Suspense fallback={<ViewLoading onBack={() => nav.pop()} />}><Overlay frame={top} onReonboard={onReonboard} /></Suspense>
        </div>
      )}
    </div>
  );
}

function TabView({ tab }: { tab: TabKey }) {
  switch (tab) {
    case "today":
      return <Today />;
    case "passport":
      return <PassportHome />;
    case "lens":
      return <Lens />;
    case "explore":
      return <Explore />;
    case "connect":
      return <ConnectHome />;
  }
}

function Overlay({ frame, onReonboard }: { frame: { screen: string; params?: Record<string, unknown> }; onReonboard: () => void }) {
  const nav = useNav();
  const p = frame.params ?? {};
  const back = () => nav.pop();

  switch (frame.screen) {
    case "passportSection":
      return <PassportSection sectionId={p.sectionId as string} onBack={back} />;
    case "passportCard":
      return <PassportCardDetail card={p.card as PassportCard} onBack={back} />;
    case "bankFlow":
      return <BankFlow onBack={back} />;
    case "sim":
      return <YapSim onBack={back} fromLens={p.fromLens as boolean} incident={p.incident as string | undefined} greenbook={p.greenbook as GreenbookPracticeContext | undefined} />;
    case "study":
      return <Study onBack={back} />;
    /* ------------------------- Living Greenbook (Phase 4) ------------------------- */
    case "greenbook":
      return <Greenbook onBack={back} />;
    case "greenbookBrowse":
      return <ChapterBrowse countryCode={p.countryCode as string} onBack={back} />;
    case "greenbookEntry":
      return <EntryDetail entryId={p.entryId as string} onBack={back} />;
    case "greenbookAsk":
      return <AskGreenbookScreen countryCode={p.countryCode as string} chapter={(p.chapter as string | null) ?? null} onBack={back} />;
    case "greenbookPhrases":
      return <Phrases countryCode={p.countryCode as string} chapter={(p.chapter as string | null) ?? null} onBack={back} />;
    case "greenbookReality":
      return <StudentReality countryCode={p.countryCode as string} onBack={back} />;
    /* ---------------------------- Explore (Phase 5) ---------------------------- */
    case "addExperience": {
      const place = p.place as Place;
      return <AddExperienceScreen place={place} onBack={back} />;
    }
    case "placeCategory":
      return (
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
            <button onClick={back} className="text-[15px] font-semibold text-primary">← Back</button>
          </div>
          <Explore initialCategory={p.category as ExploreCategory} />
        </div>
      );
    /* ------------------------- Community (Phase 5.1) ------------------------- */
    case "communityPost":
      return <CommunityPostScreen postId={p.postId as string} onBack={back} />;
    case "profile":
      return <Profile onBack={back} />;
    case "dnaAssessment":
      return <MyDnaAssessment onBack={back} />;
    case "settings":
      return <Settings onBack={back} />;
    case "editProfile":
      return <EditProfile onBack={back} />;
    case "account":
      return <AccountSettings onBack={back} />;
    case "preferences":
      return <PreferencesScreen onBack={back} />;
    case "privacyData":
      return <PrivacyData onBack={back} />;
    case "blockedUsers":
      return <BlockedUsers onBack={back} />;
    case "legal":
      return <LegalDoc doc={(p.doc as string) ?? "privacy"} onBack={back} />;
    case "about":
      return <About onBack={back} />;
    case "compass":
      return <Compass onBack={back} onReonboard={onReonboard} />;
    default:
      return null;
  }
}

/**
 * Wrapper that supplies the session and the active journey to the Add Experience
 * form, so the form itself stays a pure component that can be rendered with
 * fixtures in a test.
 */
function AddExperienceScreen({ place, onBack }: { place: Place; onBack: () => void }) {
  const nav = useNav();
  const { journey } = useJourney();
  const { userId } = useCurrentUserId();
  const [notice, setNotice] = useState<string | null>(null);

  if (!userId) {
    return (
      <div className="flex h-full flex-col bg-canvas">
        <div className="flex flex-1 items-center justify-center px-8 text-center">
          <p className="text-[14px] text-muted">Your session is still starting. Try again in a moment.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <AddExperience
        place={place}
        userId={userId}
        countryCode={journey.host}
        universityId={journey.university}
        onBack={onBack}
        onSaved={() => {
          setNotice("Experience shared");
          nav.pop();
        }}
      />
      {notice && <span className="sr-only">{notice}</span>}
    </>
  );
}
