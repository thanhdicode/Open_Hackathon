import { useState } from "react";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { ScreenHeader, Scroll } from "../components/shell";
import { Card, Button, SourceBadge, FreshnessBadge, ProgressBar, Notice } from "../components/ui";
import { Icon } from "../components/icons";
import { COUNTRIES } from "../data/countries";

export default function BankFlow({ onBack }: { onBack: () => void }) {
  const { journey, toggleTask } = useJourney();
  const nav = useNav();
  const host = COUNTRIES[journey.host];
  const isSG = journey.host === "SG";

  const reqs = isSG
    ? ["Passport", "Student's Pass", "Proof of NUS enrolment", "Local address (hall/dorm)"]
    : ["Passport", "Student visa/pass", "Proof of enrolment", "Local address"];

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const done = reqs.filter((r) => checked[r]).length;
  const pct = Math.round((done / reqs.length) * 100);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Open a bank account" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold text-muted"><Icon name="passport" size={14} /> Money & Banking · {host.name}</div>
        <p className="text-[14px] leading-relaxed text-ink">
          {isSG ? "DBS/POSB, OCBC and UOB offer student accounts with no minimum balance." : `Local banks in ${host.name} offer student accounts.`} Gather these documents first.
        </p>

        <Card className="mt-4 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[13px] font-bold text-ink">Document checklist</p>
            <span className="text-[12px] font-bold text-primary">{done}/{reqs.length}</span>
          </div>
          <div className="mb-3"><ProgressBar value={pct} tone={pct === 100 ? "success" : "primary"} /></div>
          <div className="space-y-2">
            {reqs.map((r) => {
              const on = checked[r];
              return (
                <button key={r} onClick={() => setChecked((c) => ({ ...c, [r]: !c[r] }))} className="flex w-full items-center gap-3 rounded-[14px] border border-line bg-surface px-3.5 py-3 text-left active:scale-[.99]">
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full border ${on ? "border-success bg-success text-white" : "border-line"}`}>{on && <Icon name="check" size={14} />}</span>
                  <span className={`text-[14px] font-medium ${on ? "text-muted line-through" : "text-ink"}`}>{r}</span>
                </button>
              );
            })}
          </div>
        </Card>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SourceBadge source={isSG ? "mas.gov.sg" : "central bank portal"} />
          <FreshnessBadge reviewed="Sep 2026" status="verified" />
        </div>

        <Card className="mt-4 flex items-center gap-3 p-4" onClick={() => nav.push("placeCategory", { category: "banks" })}>
          <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-primary-soft text-primary"><Icon name="pin" size={18} /></div>
          <div className="flex-1">
            <p className="text-[14px] font-semibold text-ink">Find the nearest bank</p>
            <p className="text-[12px] text-muted">See student-friendly branches on Explore</p>
          </div>
          <Icon name="chevron" size={18} />
        </Card>

        {pct === 100 && <div className="mt-4"><Notice tone="primary" icon="check" title="You're ready!" body="You have every document. Book an appointment or open in-app, then mark this task complete." /></div>}

        <div className="mt-6">
          <Button size="lg" full disabled={pct !== 100} onClick={() => { toggleTask(journey.id === "custom" ? `${journey.home}-${journey.host}-bank-documents` : journey.primaryTask.id); onBack(); }}>
            Mark task complete
          </Button>
        </div>
      </Scroll>
    </div>
  );
}
