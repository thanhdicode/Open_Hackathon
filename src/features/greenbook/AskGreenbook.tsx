/**
 * Ask this Greenbook.
 *
 * Two things this screen must get right, both of them trust properties rather
 * than UI properties:
 *
 * 1. The progress states are REAL. Each one is appended after an await that
 *    actually completed, so the screen cannot claim to be "reading official
 *    sources" when it is not. There is no timer in this file.
 *
 * 2. The no-LLM mode is shown, not hidden. When every provider fails, the answer
 *    is assembled from verified facts and the screen says so plainly. A student
 *    reading a field manual is entitled to know whether a sentence was written by
 *    a model or copied from a government page.
 */
import { useCallback, useRef, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Badge, Button, Card } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AiThinking, Section, SourceRow, formatDate } from "../../components/greenbook/bits";
import { useJourney } from "../../context/JourneyContext";
import { COUNTRIES, type CountryCode } from "../../data/countries";
import { UNVERIFIED_ANSWER, askGreenbook, retrieveEvidence, type GreenbookAnswer } from "../../lib/greenbook";

const SUGGESTIONS: Record<string, string[]> = {
  MY: ["What do I need for my Student Pass?", "How do I open a bank account?", "How do I get from the airport to campus?"],
  SG: ["What does my Student's Pass require?", "How do I pay for transport?", "What should I do in my first week?"],
  ID: ["What do I need for my stay permit?", "How do I pay for things?", "What should I know before I arrive?"],
};

export function AskGreenbookScreen({ onBack, countryCode, chapter }: { onBack: () => void; countryCode: string; chapter: string | null }) {
  const { journey } = useJourney();
  const [question, setQuestion] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [answer, setAnswer] = useState<GreenbookAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const askedRef = useRef(false);

  const host = countryCode as CountryCode;
  const suggestions = SUGGESTIONS[host] ?? ["What should I know first?", "What do I need to prepare?", "What should I avoid?"];

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setAnswer(null);
      askedRef.current = true;

      const query = {
        homeCountry: journey.home,
        hostCountry: countryCode,
        chapter,
        city: journey.city || null,
        university: journey.university || null,
        journeyStage: null,
        language: "en",
        languageLevel: null,
        question: trimmed,
      };

      try {
        // Real phase 1 — retrieval actually happens here.
        setSteps(["Retrieving evidence from the verified corpus"]);
        const packet = await retrieveEvidence(query);
        setSteps((current) => [
          ...current,
          packet.facts.length
            ? `Found ${packet.facts.length} verified point${packet.facts.length === 1 ? "" : "s"} from ${packet.sources.length} official source${packet.sources.length === 1 ? "" : "s"}`
            : "No verified point covers this yet",
          "Checking freshness and building the answer",
        ]);

        // Real phase 2 — generation, or the no-LLM assembly.
        const result = await askGreenbook(query);
        setSteps((current) => [...current, result.mode === "grounded" ? "Answer ready" : "Answer built from verified facts (no model available)"]);
        setAnswer(result);
      } catch {
        // askGreenbook is designed not to throw, but a UI must never depend on
        // that. This is the last line of defence against a white screen.
        setAnswer({
          answer: UNVERIFIED_ANSWER,
          whatToDo: [],
          whatToPrepare: [],
          whatToSay: [],
          warnings: ["Something went wrong while retrieving. Nothing was invented to fill the gap."],
          confidence: "low",
          sources: [],
          lastChecked: null,
          mode: "no_llm",
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, chapter, countryCode, journey.city, journey.home, journey.university],
  );

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Ask this Greenbook" onBack={onBack} />
      <Scroll className="px-4 pb-8 pt-4">
        <Card className="mb-4 p-3.5">
          <p className="text-[13px] leading-relaxed text-muted">
            Answers are built only from verified facts for <span className="font-semibold text-ink">{COUNTRIES[host]?.name ?? countryCode}</span>. If nothing
            authoritative covers your question, the Greenbook says so instead of guessing.
          </p>
        </Card>

        <div className="mb-3 flex items-end gap-2">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask(question);
              }
            }}
            rows={2}
            placeholder={`Ask about ${COUNTRIES[host]?.name ?? countryCode}…`}
            className="min-h-[52px] flex-1 resize-none rounded-[12px] border border-line bg-surface px-3.5 py-3 text-[14px] text-ink outline-none placeholder:text-muted focus:border-primary"
          />
          <Button onClick={() => void ask(question)} disabled={busy || !question.trim()}>
            {busy ? "…" : "Ask"}
          </Button>
        </div>

        {!askedRef.current && (
          <div className="mb-5 flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => {
                  setQuestion(suggestion);
                  void ask(suggestion);
                }}
                className="min-h-[44px] rounded-full border border-line bg-surface px-3.5 text-[12px] font-medium text-ink"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {steps.length > 0 && (
          <Card className="mb-4 p-3.5">
            <AiThinking steps={steps} />
          </Card>
        )}

        {answer && <AnswerCard answer={answer} />}
      </Scroll>
    </div>
  );
}

function AnswerCard({ answer }: { answer: GreenbookAnswer }) {
  const isRefusal = answer.answer === UNVERIFIED_ANSWER && answer.sources.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {answer.mode === "grounded" ? (
            <Badge tone="primary">
              <Icon name="check" size={11} /> Grounded in retrieved sources
            </Badge>
          ) : (
            <Badge tone="warning">
              <Icon name="info" size={11} /> Built without a model
            </Badge>
          )}
          <Badge tone={answer.confidence === "high" ? "success" : answer.confidence === "medium" ? "warning" : "muted"}>
            Confidence {answer.confidence}
          </Badge>
          {answer.lastChecked && <span className="text-[11px] text-muted">Sources checked {formatDate(answer.lastChecked)}</span>}
        </div>

        <p className={`text-[14px] leading-relaxed ${isRefusal ? "font-semibold text-warning" : "text-ink"}`}>{answer.answer}</p>

        {answer.mode === "no_llm" && !isRefusal && (
          <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-muted">
            Every AI provider was unavailable, so this answer was assembled directly from verified facts and official sources — no text was generated.
          </p>
        )}
      </Card>

      {answer.whatToDo.length > 0 && (
        <Section title="Do this">
          <Card className="p-3.5">
            {answer.whatToDo.map((item) => (
              <div key={item} className="flex items-start gap-2.5 border-b border-line py-2.5 first:pt-0 last:border-0 last:pb-0">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-canvas text-muted">
                  <Icon name="check" size={12} />
                </span>
                <p className="text-[13px] leading-relaxed text-ink">{item}</p>
              </div>
            ))}
          </Card>
        </Section>
      )}

      {answer.whatToPrepare.length > 0 && (
        <Section title="Prepare">
          <Card className="p-3.5">
            {answer.whatToPrepare.map((item) => (
              <p key={item} className="border-b border-line py-2 text-[13px] leading-relaxed text-ink last:border-0 last:pb-0">
                {item}
              </p>
            ))}
          </Card>
        </Section>
      )}

      {answer.whatToSay.length > 0 && (
        <Section title="Say this">
          <Card className="p-3.5">
            {answer.whatToSay.map((item) => (
              <p key={item} className="border-b border-line py-2 text-[13px] leading-relaxed text-ink last:border-0 last:pb-0">
                {item}
              </p>
            ))}
          </Card>
        </Section>
      )}

      {answer.warnings.length > 0 && (
        <div className="rounded-[12px] border border-warning/30 bg-warning-soft px-3.5 py-3">
          {answer.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-2 text-[12px] leading-relaxed text-warning">
              <Icon name="alert" size={14} /> {warning}
            </p>
          ))}
        </div>
      )}

      {answer.sources.length > 0 && (
        <Section title={`Sources (${answer.sources.length})`}>
          <Card className="px-3.5 py-1">
            {answer.sources.map((source) => (
              <SourceRow key={source.sourceId} source={source} />
            ))}
          </Card>
        </Section>
      )}

      {isRefusal && (
        <Card className="p-3.5">
          <p className="text-[12px] leading-relaxed text-muted">
            The Greenbook only publishes guidance that traces to a registered official source with a last-checked date. Adding a plausible-sounding answer here
            would defeat the point of the manual.
          </p>
        </Card>
      )}
    </div>
  );
}

export default AskGreenbookScreen;
