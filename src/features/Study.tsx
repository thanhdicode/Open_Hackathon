import { useState } from "react";
import { ScreenHeader, Scroll } from "../components/shell";
import { Card, Button, Notice } from "../components/ui";
import { Icon } from "../components/icons";
import { STUDY_MODES, STUDY_SAMPLES } from "../data/study";
import YepGuide from "../components/yep-guide";

export default function Study({ onBack }: { onBack: () => void }) {
  const [modeId, setModeId] = useState<string | null>(null);
  const mode = STUDY_MODES.find((m) => m.id === modeId);

  if (mode) {
    const sample = STUDY_SAMPLES[mode.id];
    return (
      <div className="flex h-full flex-col bg-canvas">
        <ScreenHeader title={mode.title} onBack={() => setModeId(null)} />
        <Scroll className="px-5 py-4">
          <Card className="p-4">
            <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Your input</p>
            <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{sample.input}</p>
          </Card>

          <div className="my-4 flex items-center gap-2 text-[12px] font-semibold text-primary">
            <span className="h-px flex-1 bg-line" /> YapYep explains <span className="h-px flex-1 bg-line" />
          </div>

          <div className="space-y-3">
            {sample.output.map((o) => (
              <Card key={o.label} className="p-4">
                <p className="text-[12px] font-bold uppercase tracking-wide text-primary">{o.label}</p>
                {o.body && <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{o.body}</p>}
                {o.items && (
                  <ul className="mt-2 space-y-1.5">
                    {o.items.map((it) => (
                      <li key={it} className="flex items-start gap-2 text-[13px] text-ink"><span className="text-muted">◆</span> {it}</li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </div>

          <div className="mt-5"><Button variant="soft" full onClick={() => setModeId(null)}>Try another mode</Button></div>
        </Scroll>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Study Copilot" onBack={onBack} />
      <Scroll tourScreen="study" className="px-5 py-4">
        <YepGuide screen="study" title="Explore study examples" pose="think">These are demo examples of how YapYep explains academic material. Choose a mode to see a sample input and explanation.</YepGuide>
        <Notice tone="primary" icon="info" title="Academic support, not answer-cheating" body="YapYep helps you understand lectures, slides and communication — so you can do the work with confidence." />
        <div data-yep="modes" className="mt-4 space-y-3">
          {STUDY_MODES.map((m) => (
            <Card key={m.id} className="flex items-center gap-3 p-4" onClick={() => setModeId(m.id)}>
              <div className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-canvas text-[20px]">{m.icon}</div>
              <div className="flex-1">
                <p className="text-[15px] font-bold text-ink">{m.title}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted">{m.desc}</p>
              </div>
              <Icon name="chevron" size={18} />
            </Card>
          ))}
        </div>
      </Scroll>
    </div>
  );
}
