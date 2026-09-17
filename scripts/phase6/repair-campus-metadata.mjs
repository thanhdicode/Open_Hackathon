import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { parse } from 'yaml';
import { Client,TablesDB,Query } from 'node-appwrite';
const registry=parse(readFileSync('config/source-registry.yaml','utf8'));
const campuses=JSON.parse(readFileSync('config/phase5-campuses.json','utf8')).campuses;
const domains=[['ui.ac.id','ui'],['nus.edu.sg','nus'],['um.edu.my','um'],['fpt.edu.vn','fpt'],['chula.ac.th','chula'],['ubd.edu.bn','Universiti Brunei Darussalam'],['upd.edu.ph','University of the Philippines Diliman']];
const displayScopes={ 'Universiti Brunei Darussalam':'BN','University of the Philippines Diliman':'PH' };
const client=new Client().setEndpoint(process.env.VITE_APPWRITE_ENDPOINT).setProject(process.env.VITE_APPWRITE_PROJECT_ID).setKey(process.env.APPWRITE_API_KEY),tables=new TablesDB(client),databaseId=process.env.VITE_APPWRITE_DATABASE_ID;
async function all(tableId){const rows=[];for(let offset=0;;offset+=100){const r=await tables.listRows({databaseId,tableId,queries:[Query.limit(100),Query.offset(offset)]});rows.push(...r.rows);if(r.rows.length<100)return rows;}}
const [sources,facts]=await Promise.all([all('knowledge_sources'),all('knowledge_facts')]);
const report={at:new Date().toISOString(),sources:[],facts:[],unmapped:[],mismatches:[]};
const normal=url=>new URL(url).href.replace(/\/$/,'');
for(const registered of registry.sources.filter(s=>s.source_type==='university'&&s.status==='verified_official')) {
 const host=new URL(registered.url).hostname;
 const matched=domains.find(([domain])=>host===domain||host.endsWith(`.${domain}`));
 if(!matched){report.unmapped.push({sourceId:registered.id,url:registered.url,agency:registered.agency,reason:'No existing canonical campus id; no id invented.'});continue;}
 const campus=campuses.find(c=>c.university_id===matched[1])??(displayScopes[matched[1]]?{university_id:matched[1],university_name:matched[1],country_code:displayScopes[matched[1]]}:null);assert.ok(campus);assert.equal(campus.country_code,registered.country);
 if(displayScopes[matched[1]])assert.ok(registered.agency.startsWith(campus.university_name),'Publisher display scope must match verified institution name');
 const source=sources.find(s=>s.source_id===registered.id);
 if(!source)continue;
 if(normal(source.url)!==normal(registered.url)||source.country_code!==registered.country){report.mismatches.push({sourceId:registered.id,reason:'Stored source URL/country differs from registry; not changed.'});continue;}
 if(source.university_id&&source.university_id!==campus.university_id){report.mismatches.push({sourceId:registered.id,reason:'Existing nonempty campus differs; not overwritten.'});continue;}
 await tables.updateRow({databaseId,tableId:'knowledge_sources',rowId:source.$id,data:{university_id:campus.university_id}});
 const checked=await tables.getRow({databaseId,tableId:'knowledge_sources',rowId:source.$id});assert.equal(checked.university_id,campus.university_id);assert.deepEqual(checked.$permissions,source.$permissions);
 report.sources.push({sourceId:source.source_id,url:source.url,universityId:campus.university_id,universityName:campus.university_name,before:source.university_id??null,readBackVerified:true});
 for(const fact of facts.filter(f=>f.source_id===source.source_id)) {
  if(fact.university_id&&fact.university_id!==campus.university_id){report.mismatches.push({factId:fact.fact_id,reason:'Existing nonempty campus differs; not overwritten.'});continue;}
  await tables.updateRow({databaseId,tableId:'knowledge_facts',rowId:fact.$id,data:{university_id:campus.university_id}});
  const stored=await tables.getRow({databaseId,tableId:'knowledge_facts',rowId:fact.$id});assert.equal(stored.university_id,campus.university_id);assert.equal(stored.claim,fact.claim);assert.equal(stored.verification_status,fact.verification_status);assert.deepEqual(stored.$permissions,fact.$permissions);
  report.facts.push({factId:fact.fact_id,sourceId:fact.source_id,universityId:campus.university_id,before:fact.university_id??null,readBackVerified:true});
 }
}
const path='docs/evidence/phase6/campus-metadata-repair.json';if(existsSync(path))writeFileSync(path.replace('.json',`-${Date.now()}.json`),readFileSync(path));writeFileSync(path,JSON.stringify(report,null,2));console.log(`University scope checked: ${report.sources.length} sources / ${report.facts.length} facts. ${report.unmapped.length} publishers left unmapped; no new campus ids invented.`);
