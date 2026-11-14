import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { assertReleaseMetadataAligned } from "./helpers/release.js";

function htmlFiles(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
    const p=join(dir,e.name);
    return e.isDirectory()?htmlFiles(p):(p.endsWith(".html")?[p]:[]);
  });
}
test("all literal local HTML href/src references resolve",()=>{
  const files=htmlFiles("public"),missing=[];
  for(const file of files){
    const source=readFileSync(file,"utf8");
    for(const ref of source.matchAll(/(?:src|href)=["']([^"']+)["']/g)){
      const value=ref[1].trim();
      if(!value||/^(#|https?:|mailto:|tel:|data:|javascript:)/i.test(value)||value.includes("${"))continue;
      const path=value.split(/[?#]/,1)[0];
      if(!path)continue;
      const target=path.startsWith("/")?join("public",path.slice(1)):join(dirname(file),path);
      if(!existsSync(target))missing.push(`${file} -> ${value}`);
    }
  }
  assert.deepEqual(missing,[]);
});
test("release version is consistent across app and package metadata",()=>{
  assertReleaseMetadataAligned();
});

test("Vision Studio journey controls exist and all six steps are reachable",()=>{
 const vision=readFileSync("public/eduos-vision.html","utf8");
 const script=readFileSync("public/eduos-vision.js","utf8");
 for(const label of ["Learner","Teacher","Family","Principal","Superintendent","Platform"]) assert.match(vision,new RegExp(label));
 for(const id of ["journeyPrev","journeyNext","journeyReset","journeyProgress"]) assert.match(vision,new RegExp(`id="${id}"`));
 assert.match(script,/stops\.forEach/);
});
