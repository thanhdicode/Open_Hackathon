import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const report=JSON.parse(readFileSync('docs/evidence/phase6/ai-golden.json','utf8'));
assert.equal(report.results.length,57,'Review requires the completed 57-case report');
// These findings were identified by reading every answer/action/preparation/warning block against its packet.
const findings={
 p6gold_ID_0:{status:'fail',violations:['Conflates initial E30B student visa with ITK visitor-permit extension.','Calls ITK a limited stay permit and assigns upload to a university portal absent from evidence.','High confidence despite missing initial-visa documents.'],factIds:['f77466cd6668938ab8dc43dcc7bd368d','589038e0932482d29fc0a4e5d6ad3aeb']},
 p6gold_ID_1:{status:'fail',violations:['Applies Universitas Indonesia campus yellow-bus and pickup arrangements to an unspecified student campus.'],sourceIds:['id-ui-post-arrival','id-ui-living']},
 p6gold_TL_4:{status:'fail',violations:['Does not answer quiet-study/vegetarian preferences or explicitly mark those details unverified.','Changes before-2000 notes not accepted into post-2000 notes required, excluding year 2000 without evidence.'],factIds:['b105225f7fc02dd7c8cfa368482ffa67']},
 p6gold_VN_0:{status:'needs_scope_review',violations:['Uses generic eVisa-status lookup as an action for a student-document question. Student documents remain explicitly unverified.']},
 p6gold_VN_3:{status:'needs_scope_review',violations:['Generic eVisa-status lookup is not a verified student visa application procedure; fee and approval are correctly not guaranteed.']},
};
const reviewed=report.results.map(record=>{
 let review=findings[record.id];
 if(!review) {
  if(!record.answer)review={status:record.kind==='ambiguous'?'harness_classification_issue':'honest_no_evidence',notes:record.kind==='ambiguous'?'Old harness classified before frontend clarification; targeted latest-pipeline rerun required.':'No topic evidence; no model call; deterministic refusal recorded. This remains a coverage failure.'};
  else if(record.kind==='cultural')review={status:'honest_refusal',notes:'All answer/action/preparation/warning blocks inspected: no lecturer-specific communication norm was inferred from unrelated country or visitor evidence.'};
  else if(record.kind==='unsupported')review={status:'bounded_answer',notes:'No future fee or approval guarantee asserted. Quoted available fee, where present, is separated from tomorrow-specific/total processing cost and eligibility.'};
  else if(record.kind==='comparison')review={status:'bounded_answer',notes:'Singapore evidence and unavailable Vietnam student-visa rules are separated. Partial comparison only.'};
  else if(record.kind==='personalization')review={status:'bounded_answer',notes:'Preference availability explicitly unverified where missing; source-supported preparation and direct confirmation suggested. Saved-profile context is not proven by this explicitly typed preference question.'};
  else review={status:'bounded_answer',notes:'Answer, actions, preparations and warnings inspected against recorded packet claims/actions. Source scope and uncertainty are retained; this review is not a guarantee that every upstream extraction is correct.'};
 }
 return {id:record.id,kind:record.kind,country:record.host,confidence:record.answer?.confidence??null,reviewedBlocks:['answer','whatToDo','whatToPrepare','whatToSay','warnings'],...review};
});
writeFileSync('docs/evidence/phase6/ai-semantic-review.json',JSON.stringify({at:new Date().toISOString(),scope:'Manual reading of all generated answer blocks against recorded packet claims and actions; primary-source rechecking performed for identified VN/ID scope defects only.',gate:'BLOCKED',reason:'Three semantic failures and two student-purpose scope concerns require latest-pipeline targeted rerun; coverage gaps remain explicit.',results:reviewed},null,2));
console.log('57 per-case semantic review records written; broad acceptance gate BLOCKED.');
