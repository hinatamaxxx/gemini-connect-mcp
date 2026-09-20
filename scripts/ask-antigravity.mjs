import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rmdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'agy/bin/agy.exe') : 'agy';
const safeEnv = { ...process.env };
for (const name of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL','GOOGLE_APPLICATION_CREDENTIALS']) delete safeEnv[name];
export function normalizeOrigin(value) {
  const url = new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Configure the HTTPS origin of your own MCP, without path or credentials.');
  return url.origin;
}
function configuredContextUrl() {
  const origin = process.env.GEMINI_MCP_ORIGIN || JSON.parse(readFileSync(join(homedir(),'.gemini-connect/config.json'),'utf8')).origin;
  return normalizeOrigin(origin)+'/cli-context';
}
export function validateTicket(ticket) {
  const contextUrl = configuredContextUrl();
  if(ticket?.url!==contextUrl||typeof ticket.token!=='string'||ticket.token.length>4096||!ticket.token)throw new Error('A valid Cloudflare CLI context ticket is required.');
  return contextUrl;
}
export async function downloadContext(ticket, fetcher=fetch) {
  const contextUrl = validateTicket(ticket);
  const response=await fetcher(contextUrl,{headers:{Authorization:'Bearer '+ticket.token},redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('CLI context ticket expired or unavailable. Obtain a new CLI ticket; no generation was sent.');
  const raw=await response.text();
  if(raw.length>100000)throw new Error('CLI context exceeds limit.');
  const context=JSON.parse(raw);
  if(typeof context.system_instruction!=='string'||!context.system_instruction||context.system_instruction.length>70000||typeof context.research!=='boolean'||!Array.isArray(context.warnings))throw new Error('Invalid CLI context.');
  return context;
}
export function cliCandidates(output) {
  const entries = [...output.matchAll(/^\s*(gemini-(\d+(?:\.\d+)+)-(flash|pro)-(low|medium|high))\s/gm)];
  entries.sort((a,b)=>{const x=a[2].split('.').map(Number),y=b[2].split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(y[i]??0)-(x[i]??0);if(d)return d;}return 0;});
  const candidates={};
  for(const [profile,family,effort] of [['thorough','flash','high']]) {
    const found=entries.find(m=>m[3]===family&&m[4]===effort);
    if(found)candidates[profile]={model:found[1],effort};
  }
  return candidates;
}
export function latestFlash(output) {
  const model=cliCandidates(output).thorough?.model;
  if(!model)throw new Error('Latest Flash High could not be identified. No fallback was used.');
  return model;
}
async function run(args, cwd, input, timeout=30000) {
  return new Promise((resolve,reject) => {
    const child=spawn(cli,args,{cwd,env:safeEnv,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='',size=0;
    const timer=setTimeout(()=>{child.kill();reject(new Error('Antigravity timed out; no retry or API fallback.'));},timeout);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Antigravity CLI could not be started.'));});
    child.stdout.on('data',b=>{size+=b.length;if(size>8_000_000){child.kill();reject(new Error('CLI output exceeded limit.'));}else out+=b;});
    child.stderr.on('data',b=>{if(err.length<8192)err+=b;});
    child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error(/auth|sign.in|login/i.test(err)?'Antigravity login required. Run agy interactively.':'Antigravity failed. Inspect the CLI locally; no retry or API fallback.'));}else resolve(out);});
    child.stdin.on('error',()=>{});
    child.stdin.end(input??'');
  });
}
export async function ask(input, checkOnly=false) {
  if (!checkOnly && (typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>100000)) throw new Error('prompt must contain 1–100000 characters.');
  if(!checkOnly)validateTicket(input.cli_context);
  try {
    const settings=JSON.parse(await readFile(join(homedir(),'.gemini/antigravity-cli/settings.json'),'utf8'));
    if(settings.modelProvider)throw new Error('Use Google account authentication in Antigravity, not an API provider.');
  } catch(e) { if(e.code!=='ENOENT')throw e; }
  const cwd=await mkdtemp(join(tmpdir(),'gemini-connect-'));
  try {
    // No cached latest-version result: check Google's official release on every invocation.
    const releaseResponse=await fetch('https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'gemini-connect'},signal:AbortSignal.timeout(10000)});
    if(!releaseResponse.ok)throw new Error('Latest CLI version could not be verified. No request was sent.');
    const release=await releaseResponse.json();
    const latest=String(release.tag_name??'').replace(/^v/,'');
    const installed=(await run(['changelog'],cwd)).match(/^\s*(\d+\.\d+\.\d+):/m)?.[1];
    if(!installed||!/^\d+\.\d+\.\d+$/.test(latest))throw new Error('CLI version could not be identified.');
    if(installed!==latest)throw new Error(`Antigravity update required: installed ${installed}, latest ${latest}. Run agy update, then retry. No model request was sent.`);
    const candidates=cliCandidates(await run(['models'],cwd));
    const info={backend:'antigravity-cli',cli_version:installed,latest_version:latest};
    if(checkOnly)return {...info,cli_models:Object.values(candidates).map(c=>c.model)};
    const context=await downloadContext(input.cli_context);
    const selected=candidates.thorough;
    if(!selected||selected.model!==context.model||selected.effort!==context.effort)throw new Error('Prepared model is no longer available as latest. Obtain a new CLI ticket; no generation was sent.');
    const {model,effort}=selected;
    const prompt=context.system_instruction+'\n\n回答は本文として返し、ファイルの閲覧・編集・コマンド実行・MCP呼び出し・エージェント起動はしないでください。'+(context.research?'公開Web調査が必要です。参照できなければその旨を明示し、出典を捏造しないでください。':'')+'\n\n依頼:\n'+input.prompt;
    const stream=await run(['--input-format','stream-json','--output-format','stream-json','--disable-slash-commands','--mode','plan','--effort',effort,'--model',model,'--print-timeout','5m','--log-file',devNull],cwd,JSON.stringify({event:'user',message:{content:prompt}})+'\n',320000);
    const events=stream.trim().split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
    const init=events.find(e=>e.event==='init');
    if(init?.init?.model!==model)throw new Error('CLI model could not be verified; inspect locally.');
    const result=events.findLast(e=>e.event==='result')?.result;
    if(result?.status!=='SUCCESS'||typeof result.response!=='string'||!result.response.trim())throw new Error('Antigravity did not return a successful response. No retry or API fallback.');
    return {...info,model,effort,status:result.status,text:result.response,usage:result.usage??null,writing_rules:context.writing_rules,warnings:[...context.warnings,'CLI may retain conversations under its own storage policy. CLI internal retries are managed by Antigravity; this wrapper does not retry.']};
  } finally { try{await rmdir(cwd);}catch{/* Leave only this run directory if CLI created files; never recursively delete CLI artifacts. */} }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const check=process.argv[2]==='--check';const input=check?{}:JSON.parse(await readFile(process.argv[2],'utf8'));console.log(JSON.stringify(await ask(input,check)));}
  catch(e){console.log(JSON.stringify({isError:true,backend:'antigravity-cli',message:e.message?.startsWith("Antigravity update required:")?e.message:"CLI check, context retrieval or generation failed. No retry or API fallback. Run --check to inspect version status.",api_fallback:false}));process.exitCode=1;}
}
