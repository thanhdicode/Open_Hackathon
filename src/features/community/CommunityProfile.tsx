import { useEffect, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Avatar, Badge, BottomSheet, Button, Card, EmptyState, Notice, Toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { COUNTRIES } from "../../data/countries";
import { campusFor } from "../../data/campuses";
import { blockUser } from "../../lib/appwrite/blocks";
import { reportContent, toggleFollow, loadFollowing } from "../../lib/appwrite/social";
import { scoreProfile } from "../../lib/phase5/matching";
import { REPORT_REASONS, ROLE_LABELS, type SocialProfile } from "../../lib/phase5/contract";
import type { ViewerContext } from "../../lib/phase5/matching";
import { languageName } from "../../lib/phase5/matching";

/**
 * A student's community profile.
 *
 * THE PRIVACY RULE THIS SCREEN EXISTS TO HOLD
 *
 * There is no live location here, and there is no field for one. The most
 * specific thing shown is the city, and it is shown as text — "Currently in
 * Depok" — never as a coordinate. Bump can show friends' live positions because
 * its entire product and safety model is built around friend location; YapYep's
 * thesis is community adaptation, and shipping a tracker to prove it would be
 * solving a different problem badly.
 *
 * The shared map is a list of places the student chose to contribute, not a
 * trace of where they have been.
 */

export interface CommunityProfileProps {
  profile: SocialProfile;
  viewer: ViewerContext;
  onBack: () => void;
  onOpenSharedMap: (profile: SocialProfile) => void;
  onBlocked: (userId: string) => void;
}

export function CommunityProfile({ profile, viewer, onBack, onOpenSharedMap, onBlocked }: CommunityProfileProps) {
  const [following, setFollowing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!viewer.userId) return;
    let cancelled = false;
    void loadFollowing(viewer.userId).then((set) => {
      if (!cancelled) setFollowing(set.has(profile.userId));
    });
    return () => {
      cancelled = true;
    };
  }, [viewer.userId, profile.userId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const campus = campusFor(profile.universityId);
  const { reasons } = scoreProfile(profile, viewer);
  const homeFlag = profile.homeCountry ? COUNTRIES[profile.homeCountry as keyof typeof COUNTRIES]?.flag : "";
  const hostFlag = profile.hostCountry ? COUNTRIES[profile.hostCountry as keyof typeof COUNTRIES]?.flag : "";

  async function follow() {
    if (!viewer.userId) return;
    const result = await toggleFollow(viewer.userId, profile.userId, following);
    if (!result.ok) {
      setToast(result.message);
      return;
    }
    setFollowing(result.value);
    setToast(result.value ? `Following ${profile.displayName}` : "Unfollowed");
  }

  async function doBlock() {
    if (!viewer.userId) return;
    const ok = await blockUser(viewer.userId, profile.userId, profile.displayName);
    setMenuOpen(false);
    if (!ok) {
      setToast("Could not block this student.");
      return;
    }
    setBlocked(true);
    onBlocked(profile.userId);
  }

  async function doReport(reason: string) {
    if (!viewer.userId) return;
    const result = await reportContent({ reporterId: viewer.userId, targetType: "profile", targetId: profile.userId, reason });
    setReportOpen(false);
    setToast(result.ok ? "Report sent for review" : result.message);
  }

  if (blocked) {
    return (
      <div className="flex h-full flex-col bg-canvas">
        <ScreenHeader title={profile.displayName} onBack={onBack} />
        <div className="flex flex-1 items-center justify-center px-8">
          <EmptyState icon="check" title="Student blocked" body="Their posts, places and profile are hidden from you." />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader
        title={profile.displayName}
        onBack={onBack}
        right={
          <button onClick={() => setMenuOpen(true)} aria-label="Profile options" className="flex h-11 w-11 items-center justify-center text-muted">
            <Icon name="more" size={18} />
          </button>
        }
      />

      <Scroll className="px-5 py-4">
        <div className="flex flex-col items-center text-center">
          <Avatar initials={profile.initials} color={profile.color} size={76} />
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            <h2 className="text-[20px] font-bold text-ink">{profile.displayName}</h2>
            {profile.isDemoSeed && <Badge tone="muted">Demo fixture</Badge>}
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {homeFlag} {profile.homeCountry} → {hostFlag} {profile.hostCountry}
          </p>
          <p className="text-[13px] text-muted">
            {campus?.universityName ?? profile.universityId}
            {profile.major ? ` · ${profile.major}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-1.5">
            <Badge tone="primary">{ROLE_LABELS[profile.role]}</Badge>
            {profile.localHelper && <Badge tone="success">Local student</Badge>}
          </div>
        </div>

        {profile.isDemoSeed && (
          <div className="mt-4">
            <Notice
              tone="warning"
              icon="info"
              title="This is a demo profile"
              body="YapYep seeded this account to show what the community looks like. It is not a real exchange student and is not marked as verified."
            />
          </div>
        )}

        {profile.bio && <p className="mt-4 text-[14px] leading-relaxed text-ink">{profile.bio}</p>}

        {/* ------------------------ presence, not position ------------------------ */}
        <Card className="mt-4 p-4">
          <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Presence</p>
          <p className="mt-2 flex items-center gap-2 text-[13px] text-ink">
            <Icon name="pin" size={15} /> Currently in {profile.city || "—"}
          </p>
          <p className="mt-1.5 flex items-start gap-2 text-[12px] text-muted">
            <Icon name="info" size={13} />
            YapYep does not show live locations. This is the city on their profile, not a position.
          </p>
        </Card>

        {/* --------------------------- matching reasons --------------------------- */}
        {reasons.length > 0 && (
          <Card className="mt-4 p-4">
            <p className="text-[13px] font-bold text-ink">Why you might connect</p>
            <div className="mt-2 space-y-2">
              {reasons.map((reason) => (
                <div key={reason.label} className="flex items-start gap-2">
                  <span className="mt-0.5 text-success">
                    <Icon name="check" size={14} />
                  </span>
                  <div>
                    <p className="text-[13px] font-medium text-ink">{reason.label}</p>
                    <p className="text-[11px] text-muted">{reason.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ------------------------------- activity ------------------------------- */}
        <Card className="mt-4 p-4">
          <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Community activity</p>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            <Stat label="Posts" value={profile.counts.posts} />
            <Stat label="Tips" value={profile.counts.tips} />
            <Stat label="Places" value={profile.counts.placesShared} />
            <Stat label="Questions" value={profile.counts.helpfulAnswers} />
          </div>
        </Card>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {profile.interests.map((interest) => (
            <Badge key={interest} tone="muted">
              {interest}
            </Badge>
          ))}
          {profile.languages.map((language) => (
            <Badge key={language} tone="muted">
              <Icon name="globe" size={11} /> {languageName(language)}
            </Badge>
          ))}
        </div>

        <div className="mt-5 flex gap-2">
          <Button variant={following ? "outline" : "primary"} full onClick={() => void follow()} disabled={!viewer.userId}>
            {following ? "Following" : "Follow"}
          </Button>
          <Button variant="outline" full onClick={() => onOpenSharedMap(profile)}>
            <Icon name="map" size={16} /> Shared map
          </Button>
        </div>
      </Scroll>

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Options">
        <div className="space-y-2">
          <Button variant="outline" full onClick={() => { setMenuOpen(false); onOpenSharedMap(profile); }}>
            <Icon name="map" size={16} /> View shared places
          </Button>
          <Button variant="outline" full onClick={() => { setMenuOpen(false); setReportOpen(true); }}>
            <Icon name="flag" size={16} /> Report this student
          </Button>
          <Button variant="danger" full onClick={() => void doBlock()}>
            <Icon name="close" size={16} /> Block {profile.displayName}
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet open={reportOpen} onClose={() => setReportOpen(false)} title="Why are you reporting this?">
        <div className="space-y-2">
          {REPORT_REASONS.map((reason) => (
            <Button key={reason.key} variant="outline" full onClick={() => void doReport(reason.key)}>
              {reason.label}
            </Button>
          ))}
        </div>
      </BottomSheet>

      {toast && <Toast text={toast} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[18px] font-extrabold text-ink">{value}</p>
      <p className="text-[10px] font-semibold text-muted">{label}</p>
    </div>
  );
}
