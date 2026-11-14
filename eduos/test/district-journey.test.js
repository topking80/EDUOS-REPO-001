import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html=readFileSync("public/eduos-vision.html","utf8");
const css=readFileSync("public/eduos-vision.css","utf8");
const js=readFileSync("public/eduos-vision.js","utf8");
test("district journey presents all six existing role experiences",()=>{
 for(const label of ["Learner","Teacher","Family","Principal","Superintendent","Platform"]) assert.match(html,new RegExp(label));
 assert.match(html,/id="district-journey"/);
});
test("district journey is keyboard-operable and has explicit synthetic-data boundaries",()=>{
 assert.match(html,/aria-label="District journey stages"/);
 assert.match(html,/aria-live="polite"/);
 assert.match(html,/Synthetic scenario/);
 assert.match(js,/addEventListener\("click"/);
 assert.match(js,/authorized/);
});
test("district journey responds to reduced-motion preference",()=>{
 assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
 assert.match(css,/journeyOrbit/);
});
