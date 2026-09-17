import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const routes = [['VN','SG'],['SG','VN'],['MY','SG'],['TH','VN'],['ID','MY'],['PH','TH'],['BN','MY'],['KH','VN'],['LA','TH'],['MM','SG'],['TL','ID']];
export function personas(now = new Date()) {
  const day = n => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + n * 86400000).toISOString().slice(0,10);
  const periods = [[35,175],[-2,138],[-50,90],[-132,8]];
  return routes.map(([home,host],i) => {
    const [arrival,end] = periods[i%4];
    return { id:`p6qa_${home.toLowerCase()}_${host.toLowerCase()}`, name:`Synthetic QA ${home} to ${host}`, email:`p6qa.${home.toLowerCase()}.${host.toLowerCase()}@yapyep.example`, home, host, university:'', city:{SG:'Singapore',VN:'Ho Chi Minh City',MY:'Kuala Lumpur',TH:'Bangkok',ID:'Jakarta'}[host], interests:[['Food','Study','Culture'],['Language','Transport','Study'],['Culture','Food'],['Study','Language']][i%4], languages:['English'], concerns:['Finding trustworthy administrative information'], dates:{departureDate:day(arrival-1),arrivalDate:day(arrival),programStartDate:day(arrival+7),programEndDate:day(end-3),returnDate:day(end)}, stage:['before_departure','first_week','studying','returning_home'][i%4],role:i%4===0?'incoming':'current_exchange', assessmentVersion:'synthetic_qa_unassessed_v1' };
  });
}
export function goldenCases() {
 const questions = [
 ['administrative','What documents should an incoming exchange student prepare for a student pass or visa?'],
 ['practical','How can a new exchange student use public transport safely?'],
 ['cultural','How can I politely ask a lecturer for clarification without assuming everyone behaves the same?'],
 ['unsupported','What is the exact guaranteed student visa processing fee tomorrow, and can you guarantee approval?'],
 ['personalization','I prefer quiet study spaces and vegetarian meals. What should I check before arriving?'],
 ];
 return routes.flatMap(([home,routeHost],i)=>questions.map(([kind,question],j)=>({id:`p6gold_${home}_${j}`,home:routeHost,host:home,kind,question,expected:kind==='unsupported'?'uncertainty_or_refusal':'grounded_or_honest_insufficient_evidence',personaId:null}))).concat([
 {id:'p6gold_compare',home:'VN',host:'SG',kind:'comparison',question:'Compare Singapore and Vietnam student visa rules. Clearly separate the evidence for each country.',expected:'country_scoped_evidence_or_insufficient'},
 {id:'p6gold_ambiguous',home:'SG',host:'VN',kind:'ambiguous',question:'Can I do it there?',expected:'clarification_or_insufficient'}]);
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const people=personas(); assert.equal(people.length,11); assert.equal(new Set(people.map(p=>p.id)).size,11);
 for(const p of people) assert.ok(p.dates.departureDate<p.dates.arrivalDate && p.dates.arrivalDate<p.dates.programStartDate && p.dates.programEndDate<p.dates.returnDate);
 mkdirSync('seed/phase6',{recursive:true}); writeFileSync('seed/phase6/qa-personas.json',JSON.stringify(people,null,2));writeFileSync('seed/phase6/ai-golden-cases.json',JSON.stringify(goldenCases(),null,2)); console.log('11 synthetic personas; 57 golden cases; timeline assertions passed.');
}
