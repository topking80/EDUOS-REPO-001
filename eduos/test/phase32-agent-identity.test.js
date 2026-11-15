import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
const html=(readFileSync(new URL('../public/index.html',import.meta.url),'utf8')+readFileSync(new URL('../public/legacy-app.js',import.meta.url),'utf8'));
const root=new URL('../public/assets/',import.meta.url);
test('four named agent identity SVGs are included and accessible',()=>{
 const agents=[['christie','Christie AI'],['helios','Helios'],['vulcan','Vulcan'],['aurora','Aurora']];
 for(const [key,name] of agents){const file=new URL(`eduos-agent-${key}.svg`,root);assert.ok(existsSync(file),`missing ${key} identity`);assert.ok(statSync(file).size>500);const svg=readFileSync(file,'utf8');assert.match(svg,new RegExp(`<title[^>]*>${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));assert.match(svg,/prefers-reduced-motion:reduce/);assert.match(svg,/<desc/);}
});
test('AI Agents workspace renders role-matched artwork beside each agent identity',()=>{
 assert.match(html,/function agentArtwork\(i,compact=false\)/);
 assert.match(html,/function agents\(\)[\s\S]*?agentArtwork\(i\)/);
 assert.match(html,/function command\(\)[\s\S]*?agentArtwork\(i,true\)/);
});
test('artwork remains explicitly a local simulation and does not imply connected AI',()=>{
 assert.match(html,/No external AI inference or live system integrations are active/);
 assert.match(html,/Agents are role labels and deterministic demonstrations/);
 assert.match(html,/No external AI inference, live telemetry, or system changes occurred/);
});
