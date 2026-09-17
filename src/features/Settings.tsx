import Mascot from "../components/mascot";
import YepGuide from "../components/yep-guide";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScreenHeader, Scroll } from "../components/shell";
import { Card, Button, Badge, Avatar, Notice, Chip, EmptyState, Toast } from "../components/ui";
import { Icon } from "../components/icons";
import { COUNTRIES, COUNTRY_LIST, type CountryCode } from "../data/countries";
import { useJourney, type ForcedState } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { useAccount } from "../context/AccountContext";
import { friendlyAuthError, requestEmailUpgradeCode, completeEmailUpgrade, startGoogleUpgrade } from "../lib/appwrite/auth";
import { avatarPreviewUrl, deleteAvatar, uploadAvatar } from "../lib/appwrite/avatar";
import {
  clearLensHistory,
  deleteMyData,
  exportMyData,
  loadPrivateProfile,
  loadSocialProfile,
  savePrivateProfile,
  saveSocialProfile,
  STUDENT_ROLES,
  type SocialProfile,
  type StudentRole,
} from "../lib/appwrite/profiles";
import { blockUser, listBlockedUsers, unblockUser, type BlockedUser } from "../lib/appwrite/blocks";
import { COOKIE_CATEGORY_COPY, COOKIE_INVENTORY, readCookieConsent, writeCookieConsent } from "../lib/cookies";
import { LANGUAGES, loadPreferences, savePreferences, type AppPreferences, type RetentionPolicy } from "../lib/preferences";

const APP_VERSION = "1.0.0";
const SUPPORT_EMAIL = "support@yapyep.app";

const STATES: { key: ForcedState; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "loading", label: "Loading" },
  { key: "empty", label: "Empty" },
  { key: "error", label: "Error" },
  { key: "offline", label: "Offline" },
  { key: "permission", label: "Permission" },
  { key: "lowconf", label: "Low confidence" },
  { key: "stale", label: "Stale data" },
];

/* ------------------------------- primitives -------------------------------- */

function Row({ label, hint, value, onClick, tone = "default" }: { label: string; hint?: string; value?: string; onClick?: () => void; tone?: "default" | "danger" }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3.5 text-left last:border-b-0 active:bg-canvas"
    >
      <span className="min-w-0">
        <span className={`block text-[14px] font-medium ${tone === "danger" ? "text-error" : "text-ink"}`}>{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{hint}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {value && <span className="text-[12px] font-semibold text-muted">{value}</span>}
        {onClick && <Icon name="chevron" size={16} />}
      </span>
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wide text-muted">{title}</h2>
      <div className="overflow-hidden rounded-[12px] border border-line bg-surface">{children}</div>
    </section>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full border transition ${checked ? "border-ink bg-ink" : "border-line bg-canvas"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface transition-all ${checked ? "left-6" : "left-0.5"}`} />
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}

const inputClass = "w-full rounded-[12px] border border-line bg-surface px-3.5 py-3 text-[15px] text-ink outline-none focus:border-primary";

/* ------------------------- account upgrade (shared) ------------------------ */

/**
 * "Save your YapYep journey" — shown once the Passport exists. Appwrite cannot
 * let an anonymous user sign back in, so this is the moment to attach a real
 * identity (Google OAuth or Email OTP) and keep the data.
 */
export function SaveJourneyCard({ onSaved, compact = false }: { onSaved?: () => void; compact?: boolean }) {
  const { account, refresh } = useAccount();
  const [step, setStep] = useState<"offer" | "email" | "code" | "done">("offer");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState<{ userId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!account) return null;

  async function google() {
    setError("");
    setBusy(true);
    try {
      await startGoogleUpgrade();
    } catch (cause) {
      setError(friendlyAuthError(cause));
      setBusy(false);
    }
  }

  async function sendCode() {
    setError("");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    try {
      const next = await requestEmailUpgradeCode(account!.userId, email);
      setTicket({ userId: next.userId });
      setStep("code");
    } catch (cause) {
      setError(friendlyAuthError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError("");
    setBusy(true);
    try {
      await completeEmailUpgrade(ticket?.userId ?? account!.userId, code);
      await refresh();
      setStep("done");
      setNotice("Journey saved to your account.");
      onSaved?.();
    } catch (cause) {
      setError(friendlyAuthError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (step === "done")
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-white"><Icon name="check" size={13} /></span>
          <p className="text-[14px] font-bold text-ink">Journey saved</p>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          You can sign back in on any device with {account.email ?? email}. Your Passport, practice history and progress follow you.
        </p>
      </Card>
    );

  return (
    <Card className={compact ? "p-4" : "p-4"}>
      <div className="flex items-center gap-2">{step === "offer" && <Mascot size={48} />}<p className="text-[15px] font-bold text-ink">Save your YapYep journey</p></div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">
        You are using YapYep as a guest. A guest session cannot be restored if you change device or clear your browser, so your Passport and progress would be lost.
      </p>

      {error && <p role="alert" className="mt-3 rounded-[10px] border border-error/30 bg-error-soft px-3 py-2 text-[12px] leading-relaxed text-error">{error}</p>}
      {notice && <p className="mt-3 rounded-[10px] border border-success/30 bg-success-soft px-3 py-2 text-[12px] text-success">{notice}</p>}

      {step === "offer" && (
        <div className="mt-4 space-y-2">
          <Button full size="lg" onClick={google} disabled={busy}>
            <Icon name="connect" size={17} /> Continue with Google
          </Button>
          <Button full size="lg" variant="outline" onClick={() => setStep("email")} disabled={busy}>
            <Icon name="chat" size={17} /> Continue with Email
          </Button>
        </div>
      )}

      {step === "email" && (
        <div className="mt-4">
          <Field label="Email address" hint="We send a 6-digit code. No password to remember.">
            <input className={inputClass} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@university.edu" />
          </Field>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep("offer")} disabled={busy}>Back</Button>
            <Button full onClick={sendCode} disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
          </div>
        </div>
      )}

      {step === "code" && (
        <div className="mt-4">
          <Field label={`Code sent to ${email}`} hint="The code expires in 15 minutes.">
            <input
              className={`${inputClass} text-center font-mono text-[22px] tracking-[0.4em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { setStep("email"); setCode(""); }} disabled={busy}>Change email</Button>
            <Button full onClick={verify} disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Confirm"}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------ settings root ------------------------------ */

export function Settings({ onBack }: { onBack: () => void }) {
  const nav = useNav();
  const { journey } = useJourney();
  const { account, isGuest, isRegistered, signOut } = useAccount();
  const [prefs, setPrefs] = useState<AppPreferences | null>(null);
  const [social, setSocial] = useState<SocialProfile | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    void (async () => {
      setPrefs(await loadPreferences());
      if (account) setSocial(await loadSocialProfile(account.userId));
    })();
  }, [account]);

  const language = LANGUAGES.find((l) => l.code === prefs?.language)?.label ?? "English";

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Settings" onBack={onBack} />
      <Scroll tourScreen="help" className="px-5 py-4">
        <YepGuide screen="help" title="Need a hand?">Open Yep’s guide on a screen whenever you need it. Short tours explain the controls; you stay in charge of every action.</YepGuide>
        {isGuest && (
          <div className="mb-5">
            <SaveJourneyCard compact />
          </div>
        )}

        <Group title="Account">
          <Row label="Edit profile" hint="Photo, name, study details and discoverability" onClick={() => nav.push("editProfile")} />
          <Row
            label="Email & linked accounts"
            hint={isGuest ? "Add an email so you can sign back in" : "Manage how you sign in"}
            value={isRegistered ? account?.email ?? "Linked" : "Guest"}
            onClick={() => nav.push("account")}
          />
          <Row
            label="Sign out"
            hint="Ends this session on this device"
            value={signingOut ? "Signing out…" : undefined}
            onClick={async () => {
              setSigningOut(true);
              await signOut();
              // Guest-first product: a fresh anonymous session starts at onboarding.
              window.location.assign("/");
            }}
          />
          <Row label="Delete account" tone="danger" hint="Removes your YapYep data" onClick={() => nav.push("privacyData")} />
        </Group>

        <Group title="Preferences">
          <Row label="Language" value={language} onClick={() => nav.push("preferences")} />
          <Row label="Theme" value={prefs?.theme === "system" ? "Match device" : "Light"} onClick={() => nav.push("preferences")} />
          <Row label="Notifications" value={prefs?.notifications.practiceReminders ? "On" : "Off"} onClick={() => nav.push("preferences")} />
          <Row label="Host-country defaults" value={COUNTRIES[journey.host].name} onClick={() => nav.push("preferences")} />
        </Group>

        <Group title="Privacy">
          <Row
            label="Discoverable profile"
            hint="Let other students find you in Connect"
            value={social?.discoverable ? "On" : "Off"}
            onClick={() => nav.push("editProfile")}
          />
          <Row label="Lens history" value={prefs?.lensHistory ? "Kept" : "Off"} onClick={() => nav.push("privacyData")} />
          <Row label="Screenshot retention" value={retentionLabel(prefs?.retention.screenshots)} onClick={() => nav.push("privacyData")} />
          <Row label="Voice retention" value={retentionLabel(prefs?.retention.voice)} onClick={() => nav.push("privacyData")} />
          <Row label="Download my data" onClick={() => nav.push("privacyData")} />
          <Row label="Delete AI history" onClick={() => nav.push("privacyData")} />
        </Group>

        <Group title="Safety">
          <Row label="Blocked users" onClick={() => nav.push("blockedUsers")} />
          <Row label="Reported content" hint="Reporting opens with Connect in this build" onClick={() => nav.push("legal", { doc: "community" })} />
        </Group>

        <Group title="Legal">
          <Row label="Privacy Policy" onClick={() => nav.push("legal", { doc: "privacy" })} />
          <Row label="Cookies" onClick={() => nav.push("legal", { doc: "cookies" })} />
          <Row label="Terms of Use" onClick={() => nav.push("legal", { doc: "terms" })} />
          <Row label="Community Guidelines" onClick={() => nav.push("legal", { doc: "community" })} />
          <Row label="AI & Culture Disclaimer" onClick={() => nav.push("legal", { doc: "ai" })} />
        </Group>

        <Group title="Support">
          <Row label="Send feedback" onClick={() => openMail("YapYep feedback", "")} />
          <Row label="Report a bug" onClick={() => openMail("YapYep bug report", `App version ${APP_VERSION}`)} />
          <Row label="About YapYep" onClick={() => nav.push("about")} />
          <Row label="Version" value={APP_VERSION} />
        </Group>

        {import.meta.env.DEV && <DevStateMatrix />}
      </Scroll>
    </div>
  );
}

/** Dev-only UI state matrix (Today, Passport, Lens, Explore, Connect). */
function DevStateMatrix() {
  const { forced, setForced } = useJourney();
  return (
    <Group title="Developer">
      <div className="p-4">
        <p className="text-[13px] font-bold text-ink">Force UI state</p>
        <p className="mt-0.5 text-[12px] text-muted">Dev builds only — lets you demo loading, empty, error, offline and stale variants.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {STATES.map((s) => (
            <button key={s.key} onClick={() => setForced(s.key)} className={`min-h-[36px] rounded-full border px-3 py-1.5 text-[12px] font-semibold ${forced === s.key ? "border-ink bg-ink text-white" : "border-line bg-surface text-muted"}`}>{s.label}</button>
          ))}
        </div>
      </div>
    </Group>
  );
}

function retentionLabel(policy: RetentionPolicy | undefined): string {
  if (policy === "7d") return "7 days";
  if (policy === "keep") return "Keep";
  return "Delete after use";
}

function openMail(subject: string, body: string) {
  window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* ------------------------------- edit profile ------------------------------ */

const INTEREST_OPTIONS = ["AI", "Coffee", "Football", "Photography", "K-pop", "Startups", "Film", "Fashion", "Food", "Travel", "Gaming", "Music"];
const LANGUAGE_OPTIONS = ["English", "Vietnamese", "Thai", "Bahasa Indonesia", "Malay", "Filipino", "Mandarin", "Tamil", "Khmer", "Lao", "Burmese"];

export function EditProfile({ onBack }: { onBack: () => void }) {
  const { account } = useAccount();
  const { journey, setCustom } = useJourney();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [home, setHome] = useState<CountryCode>(journey.home);
  const [host, setHost] = useState<CountryCode>(journey.host);
  const [city, setCity] = useState("");
  const [university, setUniversity] = useState("");
  const [major, setMajor] = useState("");
  const [bio, setBio] = useState("");
  const [role, setRole] = useState<StudentRole>("incoming");
  const [interests, setInterests] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [discoverable, setDiscoverable] = useState(false);
  const [localHelper, setLocalHelper] = useState(false);
  const [avatarFileId, setAvatarFileId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!account) return;
      const [priv, social] = await Promise.all([loadPrivateProfile(account.userId), loadSocialProfile(account.userId)]);
      setDisplayName(priv?.displayName || social?.displayName || journey.name);
      setHome((priv?.home || journey.home) as CountryCode);
      setHost((priv?.host || journey.host) as CountryCode);
      setCity(priv?.city || journey.city);
      setUniversity(priv?.university || journey.university);
      setInterests(priv?.interests?.length ? priv.interests : journey.interests);
      setMajor(social?.major ?? "");
      setBio(social?.bio ?? "");
      setRole(social?.role ?? "incoming");
      setLanguages(social?.languages?.length ? social.languages : journey.languages.map((l) => l.name));
      setDiscoverable(social?.discoverable ?? false);
      setLocalHelper(social?.localHelper ?? false);
      setAvatarFileId(social?.avatarFileId ?? null);
      setLoading(false);
    })();
  }, [account, journey]);

  const avatarUrl = useMemo(() => avatarPreviewUrl(avatarFileId, 160), [avatarFileId]);

  const toggle = (list: string[], set: (next: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  async function onPickFile(file: File | null) {
    if (!file || !account) return;
    setError("");
    setUploading(true);
    const previous = avatarFileId;
    const result = await uploadAvatar(account.userId, file);
    setUploading(false);
    if (!result.ok || !result.fileId) {
      setError(result.message ?? "Upload failed.");
      return;
    }
    setAvatarFileId(result.fileId);
    if (previous && previous !== result.fileId) await deleteAvatar(previous);
    setToast("Photo updated");
    setTimeout(() => setToast(""), 1600);
  }

  async function save() {
    if (!account) return;
    if (!displayName.trim()) {
      setError("Add a display name so other students know who they are talking to.");
      return;
    }
    if (home === host) {
      setError("Your home and host country cannot be the same in an exchange journey.");
      return;
    }
    setError("");
    setSaving(true);
    const privateOk = await savePrivateProfile(account.userId, {
      displayName: displayName.trim(),
      home,
      host,
      city,
      university,
      languages,
      interests,
      goals: [],
      concerns: journey.concerns ?? [],
      exchangeStage: role === "local" ? "settled" : "studying",
    });
    const socialOk = await saveSocialProfile(account.userId, {
      displayName: displayName.trim(),
      avatarFileId,
      role,
      currentCountry: role === "local" ? home : host,
      city,
      university,
      major,
      bio,
      languages,
      interests,
      discoverable,
      localHelper: localHelper || role === "local",
    });
    // Keep the in-app journey (Today, Passport, PairDNA) consistent with the edit.
      setCustom({
      name: displayName.trim(),
      home,
      host,
      city,
      university,
      languages: languages.map((name) => journey.languages.find((l) => l.name === name) ?? { name, level: "B1" }),
      interests,
    });
    setSaving(false);
    if (!privateOk || !socialOk) {
      setError("We saved what we could, but the connection dropped. Please try again.");
      return;
    }
    setToast("Profile saved");
    setTimeout(() => setToast(""), 1600);
  }

  if (loading)
    return (
      <div className="flex h-full flex-col bg-canvas">
        <ScreenHeader title="Edit profile" onBack={onBack} />
        <div className="p-5"><Card className="p-4"><p className="text-[13px] text-muted">Loading your profile…</p></Card></div>
      </div>
    );

  return (
    <div className="flex h-full flex-col bg-canvas">
      {toast && <Toast text={toast} />}
      <ScreenHeader title="Edit profile" onBack={onBack} right={<Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>} />
      <Scroll className="px-5 py-4">
        {error && <p role="alert" className="mb-4 rounded-[10px] border border-error/30 bg-error-soft px-3 py-2 text-[12px] leading-relaxed text-error">{error}</p>}

        <Card className="mb-4 flex items-center gap-4 p-4">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-16 w-16 rounded-full border border-line object-cover" />
          ) : (
            <Avatar initials={(displayName || "Y").slice(0, 1).toUpperCase()} color={journey.avatarColor} size={64} />
          )}
          <div className="flex-1">
            <p className="text-[14px] font-bold text-ink">Profile photo</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">JPG, PNG or WebP. Resized to 512px before upload. Shown to students only when you are discoverable.</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? "Uploading…" : avatarFileId ? "Replace" : "Upload"}
              </Button>
              {avatarFileId && (
                <Button size="sm" variant="ghost" onClick={async () => { await deleteAvatar(avatarFileId); setAvatarFileId(null); }}>Remove</Button>
              )}
            </div>
          </div>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)} />
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-muted">Private — only you</p>
          <Field label="Display name"><input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Home country">
              <select className={inputClass} value={home} onChange={(e) => setHome(e.target.value as CountryCode)}>
                {COUNTRY_LIST.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Host country">
              <select className={inputClass} value={host} onChange={(e) => setHost(e.target.value as CountryCode)}>
                {COUNTRY_LIST.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </Field>
          </div>

          <Field label="City"><input className={inputClass} value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Singapore" /></Field>
          <Field label="University"><input className={inputClass} value={university} onChange={(e) => setUniversity(e.target.value)} placeholder="e.g. National University of Singapore" /></Field>

          <p className="mb-1 text-[13px] font-medium text-ink">Languages</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {LANGUAGE_OPTIONS.map((l) => (
              <Chip key={l} tone="primary" active={languages.includes(l)} onClick={() => toggle(languages, setLanguages, l)}>{l}</Chip>
            ))}
          </div>

          <p className="mb-1 text-[13px] font-medium text-ink">Interests</p>
          <div className="flex flex-wrap gap-2">
            {INTEREST_OPTIONS.map((i) => (
              <Chip key={i} tone="primary" active={interests.includes(i)} onClick={() => toggle(interests, setInterests, i)}>{i}</Chip>
            ))}
          </div>
        </Card>

        <Card className="mt-4 p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-muted">Social — opt-in, visible to students when discoverable</p>

          <Field label="Student role">
            <div className="space-y-2">
              {STUDENT_ROLES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setRole(r.value)}
                  className={`flex w-full items-start gap-2.5 rounded-[12px] border px-3.5 py-3 text-left ${role === r.value ? "border-ink bg-canvas" : "border-line bg-surface"}`}
                >
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${role === r.value ? "border-ink bg-ink text-white" : "border-line"}`}>
                    {role === r.value && <Icon name="check" size={12} />}
                  </span>
                  <span>
                    <span className="block text-[14px] font-medium text-ink">{r.label}</span>
                    <span className="mt-0.5 block text-[11px] text-muted">{r.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Major"><input className={inputClass} value={major} onChange={(e) => setMajor(e.target.value)} placeholder="e.g. Computer Science" /></Field>
          <Field label="Short bio" hint="One or two lines about what you are looking for.">
            <textarea className={`${inputClass} h-24 resize-none`} maxLength={280} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Exchange student in Singapore, happy to share notes about settling in." />
          </Field>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <span>
              <span className="block text-[14px] font-medium text-ink">Discoverable profile</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">Off means you never appear in Connect. Your journey data stays private either way.</span>
            </span>
            <Switch checked={discoverable} onChange={setDiscoverable} label="Discoverable profile" />
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
            <span>
              <span className="block text-[14px] font-medium text-ink">Available as a local helper</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">Lets incoming students ask you about everyday life here.</span>
            </span>
            <Switch checked={localHelper} onChange={setLocalHelper} label="Available as a local helper" />
          </div>
        </Card>

        <div className="mt-4"><Button size="lg" full onClick={save} disabled={saving}>{saving ? "Saving…" : "Save profile"}</Button></div>
      </Scroll>
    </div>
  );
}

/* ---------------------------- email / linked account ----------------------- */

export function AccountSettings({ onBack }: { onBack: () => void }) {
  const { account, isGuest, isRegistered, refresh, signOut } = useAccount();
  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Email & accounts" onBack={onBack} />
      <Scroll className="px-5 py-4">
        {isGuest ? (
          <SaveJourneyCard onSaved={() => void refresh()} />
        ) : (
          <Card className="p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Signed in as</p>
            <p className="mt-1 text-[16px] font-bold text-ink">{account?.email ?? account?.name ?? "YapYep student"}</p>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-muted">Sign-in methods</span>
                <span className="flex flex-wrap gap-1.5">
                  {(account?.providers.length ? account.providers : ["email"]).map((p) => (
                    <Badge key={p} tone="muted">{p === "email" ? "Email OTP" : p}</Badge>
                  ))}
                </span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-muted">Account ID</span>
                <span className="font-mono text-[12px] text-ink">{account?.userId}</span>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              To add Google sign-in to this account, sign out and use Continue with Google with the same email address — Appwrite links it to this account instead of creating a new one.
            </p>
          </Card>
        )}

        {isRegistered && (
          <div className="mt-4 space-y-2">
            <Button variant="outline" full onClick={() => void refresh()}>Refresh account status</Button>
            <Button variant="danger" full onClick={async () => { await signOut(); onBack(); }}>Sign out</Button>
          </div>
        )}
      </Scroll>
    </div>
  );
}

/* ------------------------------ preferences -------------------------------- */

export function PreferencesScreen({ onBack }: { onBack: () => void }) {
  const { journey } = useJourney();
  const [prefs, setPrefs] = useState<AppPreferences | null>(null);

  useEffect(() => { void (async () => setPrefs(await loadPreferences()))(); }, []);

  const update = async (patch: Partial<AppPreferences>) => setPrefs(await savePreferences(patch));

  if (!prefs) return <div className="flex h-full flex-col bg-canvas"><ScreenHeader title="Preferences" onBack={onBack} /><div className="p-5"><Card className="p-4"><p className="text-[13px] text-muted">Loading preferences…</p></Card></div></div>;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Preferences" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <Group title="Language">
          <div className="p-4">
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((l) => (
                <Chip key={l.code} tone="primary" active={prefs.language === l.code} onClick={() => void update({ language: l.code })}>{l.label}</Chip>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted">Interface copy ships in English today; your choice is stored and applied as translations land.</p>
          </div>
        </Group>

        <Group title="AI language profile">
          <div className="border-b border-line p-4">
            <p className="text-[14px] font-medium text-ink">I understand explanations in</p>
            <p className="mt-0.5 text-[11px] text-muted">Coaching, meanings and feedback are written in this language.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {LANGUAGES.map((entry) => (
                <Chip key={entry.code} tone="primary" active={prefs.aiLanguage.explanationLanguage === entry.code} onClick={() => void update({ aiLanguage: { ...prefs.aiLanguage, explanationLanguage: entry.code } })}>
                  {entry.label}
                </Chip>
              ))}
            </div>
          </div>

          <div className="border-b border-line p-4">
            <p className="text-[14px] font-medium text-ink">When speaking to local people, use</p>
            <p className="mt-0.5 text-[11px] text-muted">Suggested from your host country — not from your nationality. Override it freely.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {LANGUAGES.map((entry) => (
                <Chip
                  key={entry.code}
                  tone="primary"
                  active={prefs.aiLanguage.preferredLocalLanguages[0] === entry.code}
                  onClick={() => void update({ aiLanguage: { ...prefs.aiLanguage, preferredLocalLanguages: [entry.code, ...prefs.aiLanguage.preferredLocalLanguages.filter((code) => code !== entry.code)] } })}
                >
                  {entry.label}
                </Chip>
              ))}
            </div>
          </div>

          <div className="border-b border-line p-4">
            <p className="text-[14px] font-medium text-ink">My level in that language</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["beginner", "intermediate", "advanced"] as const).map((entry) => (
                <Chip key={entry} tone="primary" active={prefs.aiLanguage.level === entry} onClick={() => void update({ aiLanguage: { ...prefs.aiLanguage, level: entry } })}>
                  {entry[0].toUpperCase() + entry.slice(1)}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted">Beginner shows a bilingual subtitle and hints. Advanced shows the local language first.</p>
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5">
            <span>
              <span className="block text-[14px] font-medium text-ink">Translate what they say</span>
              <span className="mt-0.5 block text-[11px] text-muted">Show the meaning in your language automatically</span>
            </span>
            <Switch checked={prefs.aiLanguage.autoTranslateIncoming} onChange={(v) => void update({ aiLanguage: { ...prefs.aiLanguage, autoTranslateIncoming: v } })} label="Translate what they say" />
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5">
            <span>
              <span className="block text-[14px] font-medium text-ink">Speak my reply aloud</span>
              <span className="mt-0.5 block text-[11px] text-muted">Uses the AI voice, then your device voice, then text only</span>
            </span>
            <Switch
              checked={prefs.aiLanguage.autoSpeak !== "never"}
              onChange={(v) => void update({ aiLanguage: { ...prefs.aiLanguage, autoSpeak: v ? "ask" : "never" } })}
              label="Speak my reply aloud"
            />
          </div>
        </Group>

        <Group title="Theme">
          <Row label="Light" hint="YapYep ships a single restrained light theme" value={prefs.theme === "light" ? "Active" : undefined} onClick={() => void update({ theme: "light" })} />
          <Row label="Match device" hint="Applies when dark tokens ship" value={prefs.theme === "system" ? "Active" : undefined} onClick={() => void update({ theme: "system" })} />
        </Group>

        <Group title="Notifications">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5">
            <span>
              <span className="block text-[14px] font-medium text-ink">Practice reminders</span>
              <span className="mt-0.5 block text-[11px] text-muted">A nudge when your daily practice is ready</span>
            </span>
            <Switch checked={prefs.notifications.practiceReminders} onChange={(v) => void update({ notifications: { ...prefs.notifications, practiceReminders: v } })} label="Practice reminders" />
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5">
            <span>
              <span className="block text-[14px] font-medium text-ink">Journey updates</span>
              <span className="mt-0.5 block text-[11px] text-muted">Passport tasks and stage changes</span>
            </span>
            <Switch checked={prefs.notifications.journeyUpdates} onChange={(v) => void update({ notifications: { ...prefs.notifications, journeyUpdates: v } })} label="Journey updates" />
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span>
              <span className="block text-[14px] font-medium text-ink">Community replies</span>
              <span className="mt-0.5 block text-[11px] text-muted">When a local student answers your question</span>
            </span>
            <Switch checked={prefs.notifications.communityReplies} onChange={(v) => void update({ notifications: { ...prefs.notifications, communityReplies: v } })} label="Community replies" />
          </div>
        </Group>

        <Group title="Host-country defaults">
          <Row label="Default host country" value={`${COUNTRIES[journey.host].flag} ${COUNTRIES[journey.host].name}`} hint="Used to pre-select content before your journey loads" />
          <Row label="Default content language" value={LANGUAGES.find((l) => l.code === prefs.language)?.label ?? "English"} />
        </Group>
      </Scroll>
    </div>
  );
}

/* ------------------------------ privacy & data ----------------------------- */

const RETENTION_OPTIONS: { value: RetentionPolicy; label: string }[] = [
  { value: "immediate", label: "Delete after use" },
  { value: "7d", label: "Keep 7 days" },
  { value: "keep", label: "Keep" },
];

export function PrivacyData({ onBack }: { onBack: () => void }) {
  const { account, refresh } = useAccount();
  const nav = useNav();
  const [prefs, setPrefs] = useState<AppPreferences | null>(null);
  const [social, setSocial] = useState<SocialProfile | null>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void (async () => {
      setPrefs(await loadPreferences());
      if (account) setSocial(await loadSocialProfile(account.userId));
    })();
  }, [account]);

  const flash = useCallback((text: string) => { setToast(text); setTimeout(() => setToast(""), 2000); }, []);

  async function download() {
    if (!account) return;
    setBusy("download");
    const data = await exportMyData(account.userId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `yapyep-data-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setBusy("");
    flash("Export downloaded");
  }

  async function deleteHistory() {
    if (!account) return;
    setBusy("history");
    const count = await clearLensHistory(account.userId);
    setBusy("");
    flash(count ? `${count} Lens ${count === 1 ? "entry" : "entries"} deleted` : "No Lens history to delete");
  }

  async function deleteAccount() {
    if (!account) return;
    setBusy("delete");
    const result = await deleteMyData(account.userId);
    await refresh();
    setBusy("");
    flash(`Deleted ${result.deleted} records. Signing out…`);
    setTimeout(() => window.location.assign("/"), 1200);
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      {toast && <Toast text={toast} />}
      <ScreenHeader title="Privacy & data" onBack={onBack} />
      <Scroll className="px-5 py-4">
        {!prefs ? (
          <Card className="p-4"><p className="text-[13px] text-muted">Loading privacy settings…</p></Card>
        ) : (
          <>
            <Group title="Visibility">
              <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                <span>
                  <span className="block text-[14px] font-medium text-ink">Discoverable profile</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">When off, Connect never shows you and your journey stays private.</span>
                </span>
                <Switch
                  checked={Boolean(social?.discoverable)}
                  label="Discoverable profile"
                  onChange={async (v) => {
                    if (!account || !social) return;
                    const next = { ...social, discoverable: v };
                    setSocial(next);
                    await saveSocialProfile(account.userId, next);
                  }}
                />
              </div>
              <Row label="Edit profile details" onClick={() => nav.push("editProfile")} />
            </Group>

            <Group title="AI history">
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5">
                <span>
                  <span className="block text-[14px] font-medium text-ink">Keep Lens history</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">Lets YapYep personalise guidance. Turn off to stop storing new interpretations.</span>
                </span>
                <Switch checked={prefs.lensHistory} label="Keep Lens history" onChange={async (v) => setPrefs(await savePreferences({ lensHistory: v }))} />
              </div>
              <Row label="Delete AI history" hint={busy === "history" ? "Deleting…" : "Removes stored Lens interpretations"} onClick={() => void deleteHistory()} />
            </Group>

            <Group title="Retention">
              <div className="px-4 py-3.5">
                <p className="text-[14px] font-medium text-ink">Screenshots & photos</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {RETENTION_OPTIONS.map((o) => (
                    <Chip key={o.value} tone="primary" active={prefs.retention.screenshots === o.value} onClick={async () => setPrefs(await savePreferences({ retention: { ...prefs.retention, screenshots: o.value } }))}>{o.label}</Chip>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted">YapLens reads your screenshot, returns the interpretation, and deletes the original unless you change this.</p>
              </div>
              <div className="border-t border-line px-4 py-3.5">
                <p className="text-[14px] font-medium text-ink">Voice recordings</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {RETENTION_OPTIONS.map((o) => (
                    <Chip key={o.value} tone="primary" active={prefs.retention.voice === o.value} onClick={async () => setPrefs(await savePreferences({ retention: { ...prefs.retention, voice: o.value } }))}>{o.label}</Chip>
                  ))}
                </div>
              </div>
            </Group>

            <Group title="Your data">
              <Row label="Download my data" hint={busy === "download" ? "Preparing…" : "JSON export of everything YapYep stores about you"} onClick={() => void download()} />
              <Row label="Privacy Policy" onClick={() => nav.push("legal", { doc: "privacy" })} />
              <Row label="Cookies" onClick={() => nav.push("legal", { doc: "cookies" })} />
            </Group>

            <Group title="Delete account">
              <div className="px-4 py-3.5">
                <p className="text-[13px] leading-relaxed text-muted">
                  This deletes your journey, MyDNA, Passport progress, practice history, profile, avatar and saved insights from YapYep, then signs you out. It cannot be undone.
                </p>
                {!confirmDelete ? (
                  <div className="mt-3"><Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete my account</Button></div>
                ) : (
                  <div className="mt-3 space-y-2">
                    <Notice tone="error" icon="alert" title="This cannot be undone" body="Your Passport progress and practice history will be removed permanently." />
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setConfirmDelete(false)}>Keep my account</Button>
                      <Button variant="danger" onClick={() => void deleteAccount()} disabled={busy === "delete"}>{busy === "delete" ? "Deleting…" : "Yes, delete everything"}</Button>
                    </div>
                  </div>
                )}
              </div>
            </Group>
          </>
        )}
      </Scroll>
    </div>
  );
}

/* ------------------------------- blocked users ----------------------------- */

export function BlockedUsers({ onBack }: { onBack: () => void }) {
  const { account } = useAccount();
  const [rows, setRows] = useState<BlockedUser[] | null>(null);
  const [manualId, setManualId] = useState("");

  const load = useCallback(async () => {
    if (!account) return;
    setRows(await listBlockedUsers(account.userId));
  }, [account]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Blocked users" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <p className="mb-4 text-[12px] leading-relaxed text-muted">
          Blocked students cannot message you or see your profile. Blocking is private — nobody is told.
        </p>

        {rows === null && <Card className="p-4"><p className="text-[13px] text-muted">Loading…</p></Card>}

        {rows && rows.length === 0 && (
          <EmptyState icon="connect" title="No blocked students" body="When you block someone in Connect, they will appear here so you can unblock them later." />
        )}

        {rows && rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.rowId} className="flex items-center gap-3 rounded-[12px] border border-line bg-surface px-4 py-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-muted"><Icon name="connect" size={16} /></span>
                <div className="flex-1">
                  <p className="text-[13px] font-semibold text-ink">{row.displayName}</p>
                  <p className="text-[11px] text-muted">Blocked {new Date(row.createdAt).toLocaleDateString()}</p>
                </div>
                <Button size="sm" variant="outline" onClick={async () => { await unblockUser(row.rowId); await load(); }}>Unblock</Button>
              </div>
            ))}
          </div>
        )}

        {account && (
          <Card className="mt-5 p-4">
            <p className="text-[13px] font-bold text-ink">Block by account ID</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">For moderation during the demo you can block a known student ID directly.</p>
            <div className="mt-3 flex gap-2">
              <input className={inputClass} value={manualId} onChange={(e) => setManualId(e.target.value)} placeholder="account id" />
              <Button
                disabled={!manualId.trim()}
                onClick={async () => { await blockUser(account.userId, manualId.trim(), "Student"); setManualId(""); await load(); }}
              >
                Block
              </Button>
            </div>
          </Card>
        )}
      </Scroll>
    </div>
  );
}

/* ---------------------------------- legal --------------------------------- */

const LEGAL: Record<string, { title: string; body: { heading: string; text: string }[] }> = {
  privacy: {
    title: "Privacy Policy",
    body: [
      { heading: "What we store", text: "Your journey (home and host country, city, university, dates), your MyDNA assessment answers, Passport progress, practice sessions and, if you opt in, a social profile with a display name, photo and bio." },
      { heading: "Who can see it", text: "Journey, MyDNA and progress rows are readable only by your own account. Your social profile is readable by signed-in students only while Discoverable is on. We never expose your private student profile to Connect." },
      { heading: "Media", text: "Lens screenshots and voice clips are processed to produce your interpretation and deleted by default. Avatars are stored in a separate, file-level-secured bucket that only you can modify or delete." },
      { heading: "Your controls", text: "Settings → Privacy & data lets you export everything as JSON, delete your AI history, or delete your account and all associated rows and files." },
      { heading: "Contact", text: `Questions or requests: ${SUPPORT_EMAIL}.` },
    ],
  },
  cookies: {
    title: "Cookies",
    body: [
      { heading: "Our approach", text: "YapYep sets one strictly-necessary cookie: your Appwrite session. Strictly-necessary cookies that deliver the service you asked for are exempt from consent, so we do not interrupt you with a banner while nothing optional exists." },
      { heading: "Optional categories", text: "Analytics is off and no analytics script is loaded. Marketing cookies are not used at all. If optional analytics is ever enabled, YapYep asks first and loads the script only after you allow it." },
    ],
  },
  terms: {
    title: "Terms of Use",
    body: [
      { heading: "Using YapYep", text: "YapYep supports student adaptation and communication. It is guidance, not legal, immigration, medical or financial advice. Always confirm administrative requirements with the official source shown on the card." },
      { heading: "Your account", text: "Keep your access secure and provide accurate information. You are responsible for what you send through Lens, YapSim and Connect." },
      { heading: "Acceptable use", text: "No harassment, hate speech, impersonation, scraping other students, or using YapYep to complete academic work dishonestly." },
      { heading: "Availability", text: "YapYep is a prototype build provided as-is during the hackathon period; features may change or be unavailable." },
    ],
  },
  community: {
    title: "Community Guidelines",
    body: [
      { heading: "Be a good local", text: "Share context and lived experience, not stereotypes. Say when something depends on campus, city or individual." },
      { heading: "No nationality verdicts", text: "Describe tendencies and situations. Do not tell people how someone of a nationality will behave." },
      { heading: "Keep it useful", text: "Answer the question asked, mark outdated information, and add sources when you can." },
      { heading: "Safety", text: "Block and report tools exist for a reason. Use them, and never share another student's private details." },
    ],
  },
  ai: {
    title: "AI & Culture Disclaimer",
    body: [
      { heading: "AI is contextual, not authoritative", text: "YapLens and YapSim generate probable interpretations using context. They can be wrong. Cultural guidance is always probabilistic and never a claim about a nationality." },
      { heading: "Check what matters", text: "Administrative facts (visas, banking, enrolment) come with an authority tier, source and freshness. Anything marked unverified must be confirmed with the official source." },
      { heading: "How to read confidence", text: "Low confidence results are labelled and can be routed to Ask a Local. Individual variation is expected — treat every interpretation as a starting point for a real conversation." },
    ],
  },
};

export function LegalDoc({ doc, onBack }: { doc: string; onBack: () => void }) {
  const content = LEGAL[doc] ?? LEGAL.privacy;
  const consent = readCookieConsent();
  const [analytics, setAnalytics] = useState(consent.analytics);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title={content.title} onBack={onBack} />
      <Scroll className="px-5 py-4">
        {content.body.map((section) => (
          <Card key={section.heading} className="mb-3 p-4">
            <p className="text-[14px] font-bold text-ink">{section.heading}</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{section.text}</p>
          </Card>
        ))}

        {doc === "cookies" && (
          <>
            <Card className="mb-3 p-4">
              <p className="text-[14px] font-bold text-ink">Cookie inventory</p>
              <div className="mt-3 space-y-3">
                {COOKIE_INVENTORY.map((cookie) => (
                  <div key={cookie.name} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12px] text-ink">{cookie.name}</span>
                      <Badge tone={cookie.essential ? "muted" : "warning"}>{COOKIE_CATEGORY_COPY[cookie.category].state}</Badge>
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted">{COOKIE_CATEGORY_COPY[cookie.category].title} · {cookie.provider} · {cookie.duration}</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted">{cookie.purpose}</p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <p className="text-[14px] font-bold text-ink">Your cookie preferences</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{COOKIE_CATEGORY_COPY.marketing.detail}</p>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
                <span>
                  <span className="block text-[13px] font-medium text-ink">Optional analytics</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                    {analytics ? "Allowed. Analytics may load on next visit." : "Not allowed. No analytics script is loaded."}
                  </span>
                </span>
                <Switch checked={analytics} label="Optional analytics" onChange={(v) => { writeCookieConsent({ analytics: v }); setAnalytics(v); }} />
              </div>
            </Card>
          </>
        )}
      </Scroll>
    </div>
  );
}

/* ---------------------------------- about --------------------------------- */

export function About({ onBack }: { onBack: () => void }) {
  const nav = useNav();
  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="About YapYep" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <Mascot size={96} className="mx-auto mb-3 block" label="Yep, the YapYep mascot" />
        <Card className="p-4">
          <p className="text-[18px] font-extrabold tracking-tight text-ink">YapYep</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            ASEAN Student Adaptation Network. Understand the moment, practise it, then live it — across all 11 ASEAN member states.
          </p>
          <p className="mt-3 font-mono text-[12px] text-muted">Version {APP_VERSION}</p>
        </Card>
        <div className="mt-4 space-y-2">
          <Button variant="outline" full onClick={() => nav.push("legal", { doc: "terms" })}>Terms of Use</Button>
          <Button variant="outline" full onClick={() => nav.push("legal", { doc: "privacy" })}>Privacy Policy</Button>
          <Button variant="outline" full onClick={() => openMail("YapYep feedback", "")}>Send feedback</Button>
        </div>
      </Scroll>
    </div>
  );
}
