import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client, Users, TablesDB, Permission, Role } from 'node-appwrite';
import { personas } from './personas.mjs';
const required=['VITE_APPWRITE_ENDPOINT','VITE_APPWRITE_PROJECT_ID','APPWRITE_API_KEY','VITE_APPWRITE_DATABASE_ID'];
for(const key of required) if(!process.env[key]) throw new Error(`Missing configuration: ${key}`);
const client=new Client().setEndpoint(process.env.VITE_APPWRITE_ENDPOINT).setProject(process.env.VITE_APPWRITE_PROJECT_ID).setKey(process.env.APPWRITE_API_KEY);
const users=new Users(client), tables=new TablesDB(client), databaseId=process.env.VITE_APPWRITE_DATABASE_ID;
const report={at:new Date().toISOString(),synthetic:true,users:[]};
for(const p of personas()) {
 try {await users.get({userId:p.id});} catch(e) {if(e.code!==404) throw e;await users.create({userId:p.id,email:p.email,password:randomBytes(32).toString('base64url'),name:p.name});}
 await users.updatePrefs({userId:p.id,prefs:{syntheticQA:true,seedOrigin:'phase6_qa',assessment:'unassessed',home:p.home,host:p.host,interests:p.interests,languages:p.languages}});
 const now=new Date().toISOString(), instant=d=>`${d}T00:00:00.000Z`, permissions=[Permission.read(Role.user(p.id)),Permission.update(Role.user(p.id)),Permission.delete(Role.user(p.id))];
 const rows={student_profiles:{user_id:p.id,display_name:p.name,home_country_code:p.home,host_country_code:p.host,host_city:p.city,university_id:p.university,languages:JSON.stringify(p.languages),interests:JSON.stringify(p.interests),goals:'[]',concerns:JSON.stringify(p.concerns),journey_dates:JSON.stringify(p.dates),exchange_start:instant(p.dates.arrivalDate),exchange_end:instant(p.dates.returnDate),exchange_stage:p.stage,journey_role:p.role,created_at:now,updated_at:now},my_dna_profiles:{user_id:p.id,explicitness:50,formality:50,hierarchy_sensitivity:50,conflict_openness:50,relationship_orientation:50,time_structure:50,participation_confidence:50,uncertainty_tolerance:50,assessment_version:p.assessmentVersion,updated_at:now},journeys:{journey_id:p.id,user_id:p.id,home_country_code:p.home,host_country_code:p.host,city:p.city,university_id:p.university,start_date:instant(p.dates.arrivalDate),end_date:instant(p.dates.returnDate),status:'active',is_current:1,updated_at:now}};
 for(const [tableId,data] of Object.entries(rows)) {try{await tables.getRow({databaseId,tableId,rowId:p.id}); await tables.updateRow({databaseId,tableId,rowId:p.id,data,permissions});}catch(e){if(e.code!==404)throw e;await tables.createRow({databaseId,tableId,rowId:p.id,data,permissions});}}
 for(const [tableId,data] of Object.entries(rows)) {
  const stored=await tables.getRow({databaseId,tableId,rowId:p.id});
  for(const [key,value] of Object.entries(data)) {
   if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) assert.equal(Date.parse(stored[key]),Date.parse(value),`Stored ${tableId}.${key} instant mismatch`);
   else assert.deepEqual(stored[key],value,`Stored ${tableId}.${key} mismatch`);
  }
  assert.ok(stored.$permissions.every(permission=>permission.includes(p.id)),`Non-owner access in ${tableId}`);
 }
 report.users.push({id:p.id,route:`${p.home}->${p.host}`,stage:p.stage,privateTables:Object.keys(rows),readBackVerified:true,ownerPermissionsVerified:true});
}
mkdirSync('docs/evidence/phase6',{recursive:true});writeFileSync('docs/evidence/phase6/qa-users.json',JSON.stringify(report,null,2));console.log(`Seeded ${report.users.length} synthetic private QA accounts. No public social rows created.`);
