/** Deterministic safety gates. These establish provenance, not model truth. */
const knownStatuses = new Set(['official_verified', 'university_verified', 'community_verified', 'stale']);
const get = (row, camel, snake) => row?.[camel] ?? row?.[snake];
function failure(code, message) { return { ok:false, code, message }; }

export function requiresClarification(question) {
  const words=String(question).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').trim().split(/\s+/).filter(Boolean);
  const vague=new Set(['can','could','i','we','you','do','it','this','that','there','here','is','allowed','possible','được','không','có','em','anh','tôi','mình','nó','đó','ở','làm','ấy']);
  // Anaphoric questions without an identified activity/location cannot be resolved from nationality.
  return words.length===0 || (words.length<=9 && words.every(word=>vague.has(word)));
}

export function preflightGreenbook(input) {
 if(requiresClarification(input.question)) return {kind:'clarification', answer:'Could you specify which activity or rule you mean, and where you plan to do it?'};
 if(!input.evidence?.length) return {kind:'insufficient_evidence',answer:'This could not be verified from a current authoritative source.'};
 return null;
}

/** Caller must fetch canonical rows server-side; client supplied claims are never their own proof. */
export function validateGroundingPacket(input, { trustedFacts, trustedSources } = {}) {
 if(!Array.isArray(trustedFacts)||!Array.isArray(trustedSources)) return failure('UNTRUSTED_EVIDENCE','Canonical server-side evidence is required.');
 const facts=new Map(trustedFacts.map(f=>[get(f,'factId','fact_id'),f]));
 const sources=new Map(trustedSources.map(s=>[get(s,'sourceId','source_id'),s]));
 const allowed=new Set(input.sources.map(s=>s.sourceId));
 for(const source of input.sources) {
  const canonical=sources.get(source.sourceId);
  if(!canonical || canonical.url!==source.url || canonical.title!==source.title || get(canonical,'authorityLevel','authority_level')!==source.authority) return failure('SOURCE_MISMATCH','A source does not match the canonical registry.');
  try {if(new URL(source.url).protocol!=='https:')return failure('SOURCE_PROTOCOL','Authoritative source URLs must use HTTPS.');}catch{return failure('SOURCE_PROTOCOL','Source URL is invalid.');}
 }
 for(const fact of input.evidence) {
  const canonical=facts.get(fact.factId);
  if(!canonical || get(canonical,'countryCode','country_code')!==input.hostCountry || get(canonical,'sourceId','source_id')!==fact.sourceId || canonical.claim!==fact.claim || !allowed.has(fact.sourceId)) return failure('FACT_MISMATCH','A claim does not match canonical evidence for this country.');
  if(!knownStatuses.has(fact.status) || get(canonical,'verificationStatus','verification_status')!==fact.status || get(canonical,'authorityLevel','authority_level')!==fact.authority || get(canonical,'checkedAt','checked_at')!==fact.checkedAt) return failure('TRUST_MISMATCH','Evidence trust metadata does not match canonical evidence.');
  if((canonical.chapter??canonical.category)!==fact.chapter)return failure('FACT_SCOPE_MISMATCH','Evidence chapter differs from its canonical scope.');
  const canonicalAction=get(canonical,'action','actionable_advice')??null;
  if(canonicalAction!==(fact.action??null))return failure('ACTION_MISMATCH','Advice differs from canonical evidence.');
 }
 return {ok:true};
}

export function validateGroundedAnswer(input, answer) {
 const sources=new Set(input.sources.map(s=>s.sourceId)),facts=new Set(input.evidence.map(f=>f.factId));
 if(answer.citedSourceIds.some(id=>!sources.has(id)))return failure('UNKNOWN_CITATION','Answer references a source outside the evidence packet.');
 if(!answer.citedSourceIds.length && answer.confidence!=='low')return failure('UNCITED_ANSWER','An answer without evidence citations must remain uncertain.');
 if((answer.citedFactIds??[]).some(id=>!facts.has(id)))return failure('UNKNOWN_FACT','Answer references a fact outside the evidence packet.');
 if(requiresClarification(input.question))return failure('AMBIGUOUS_REQUEST','An ambiguous request requires clarification before a model answer.');
 const text=[answer.answer,...(answer.whatToDo??[]),...(answer.whatToPrepare??[])].join(' ');
 const sentences=text.split(/[.!?\n]+/);
 if(sentences.some(sentence=>/your current location (?:in|is)|you(?:'re| are) (?:currently|now) (?:in|located in|residing in)|since you are in/i.test(sentence)&&!/\bnot\b|\bunknown\b|\bcannot\b|couldn't|could not|if you(?:'re| are) (?:currently|now) in|if your current location is/i.test(sentence)))return failure('UNSUPPORTED_CURRENT_LOCATION','Home and host countries do not prove a current physical location.');
 if(sentences.some(sentence=>/guaranteed approval|approval is guaranteed|you will be approved|you (?:are eligible|qualify) for (?:a |the )?(?:student |study )?(?:visa|pass)/i.test(sentence)&&!/\bcannot\b|can't|\bnot\b|no guarantee|could not|not verified/i.test(sentence)))return failure('UNSUPPORTED_PERSONAL_OUTCOME','Published general rules cannot guarantee an individual immigration outcome.');
 const studentVisaQuestion=/student|exchange|study/i.test(input.question)&&/visa|pass|immigra/i.test(input.question);
 const personalEligibility=/you (?:are eligible|qualify|can (?:apply|enter|study))|students can apply|guaranteed approval/i.test(text);
 const specificEvidence=input.evidence.some(f=>/student(?:['’]s)?\s+(?:visa|pass)|study\s+visa|higher.education\s+visa|\bE30B\b|\b9F\b/i.test(f.claim)&&['A','B'].includes(f.authority)&&['official_verified','university_verified'].includes(f.status));
 if(studentVisaQuestion&&personalEligibility&&!specificEvidence)return failure('UNSUPPORTED_STUDENT_ELIGIBILITY','Generic immigration evidence does not establish student eligibility.');
 return {ok:true,semanticReviewRequired:true};
}
