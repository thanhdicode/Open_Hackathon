import { readFileSync } from 'node:fs';
import ts from 'typescript';
/** Execute the current frontend retrieval function; inject real published DB rows in place of browser transport. */
export function frontendRetriever(allFacts,sourcesById) {
 const campusModule={};
 const campusCode=ts.transpileModule(readFileSync('src/data/campuses.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 new Function('exports','require',campusCode)(campusModule,path=>{if(path.endsWith('phase5-campuses.json'))return JSON.parse(readFileSync('config/phase5-campuses.json','utf8'));throw new Error(`Unexpected campus resolver dependency: ${path}`);});
 const source=readFileSync('src/lib/greenbook/ask.ts','utf8').replaceAll('\r\n','\n');
 const start=source.indexOf('const STOPWORDS'),end=source.indexOf('/**\n * Shape the gateway');
 if(start<0||end<start)throw new Error('Frontend retrieval boundaries changed; update harness explicitly.');
 const code=ts.transpileModule(source.slice(start,end).replace('export async function retrieveEvidence','async function retrieveEvidence'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const published=new Set(['official_verified','university_verified','community_verified','stale']);
 const listFacts=async q=>allFacts.filter(f=>published.has(f.verificationStatus)&&f.countryCode===q.countryCode&&(!q.chapter||f.chapter===q.chapter)).sort((a,b)=>String(b.checkedAt).localeCompare(String(a.checkedAt))).slice(0,q.limit??200);
 const sourcesByIds=async ids=>ids.map(id=>sourcesById.get(id)).filter(Boolean);
 const listSources=async country=>[...sourcesById.values()].filter(s=>s.countryCode===country);
 return new Function('listFacts','sourcesByIds','listSources','campusFor',`${code};return retrieveEvidence;`)(listFacts,sourcesByIds,listSources,campusModule.campusFor);
}
