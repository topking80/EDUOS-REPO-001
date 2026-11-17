import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canPerform } from "../src/policy.js";
const root = new URL("../", import.meta.url);
test("clubs and sports permissions are role-bounded", () => {
 const actor = role => ({ role, districtId: "district", userId: "user" });
 assert.equal(canPerform(actor("principal"), "activities", "manage"), true);
 assert.equal(canPerform(actor("superintendent"), "activities", "manage"), true);
 assert.equal(canPerform(actor("teacher"), "activities", "manage"), true);
 assert.equal(canPerform(actor("teacher"), "activities", "read"), true);
 assert.equal(canPerform(actor("pupil"), "activities", "join"), true);
 assert.equal(canPerform(actor("parent"), "activities", "read"), true);
 assert.equal(canPerform(actor("pupil"), "activities", "manage"), false);
 assert.equal(canPerform(actor("teacher"), "ticketing", "configure"), false);
 assert.equal(canPerform(actor("principal"), "ticketing", "configure"), true);
 assert.equal(canPerform(actor("teacher"), "streaming", "schedule"), false);
 assert.equal(canPerform(actor("principal"), "streaming", "schedule"), true);
});
test("migration establishes forced district RLS and protected ticket codes", async () => {
 const sql = await readFile(new URL("db/051_clubs_sports_multimedia.sql", root), "utf8");
 for (const name of ["school_activities","activity_staff","activity_memberships","school_events","event_ticket_types","event_ticket_orders","event_tickets","event_streams","activity_media_assets"]) assert.ok(sql.includes(name), "missing "+name);
 const sports = await readFile(new URL("db/052_sports_rosters_results.sql", root), "utf8");
 assert.match(sports, /activity_roster_entries/);
 assert.match(sports, /activity_event_results/);
 assert.match(sports, /FORCE ROW LEVEL SECURITY/);
 assert.match(sql, /FORCE ROW LEVEL SECURITY/);
 assert.match(sql, /app\.district_id/);
 assert.match(sql, /ticket_code_hash/);
});
test("paid checkout and livestream playback remain fail-closed", async () => {
 const routes = await readFile(new URL("src/clubs-sports-routes.js", root), "utf8");
 assert.match(routes, /paid_ticketing_not_configured/);
 assert.match(routes, /playbackEnabled:false/);
 assert.match(routes, /ticket_code_hash|ticketCode/);
 assert.match(routes, /event_checkin_staff_required/);
 assert.match(routes, /student_activity_membership_required/);
 assert.match(routes, /event_not_completed/);
 assert.match(routes, /published_result_requires_school_lead/);
 assert.match(routes, /jersey_number_already_in_use/);
 assert.match(routes, /recording_allowed,created_by\)[\s\S]*false/);
 assert.doesNotMatch(routes, /cardNumber|cvv|payment_secret/i);
});

test("media consent is participant-specific and publication fails closed", async () => {
 const sql = await readFile(new URL("db/053_activity_media_guardian_consent.sql", root), "utf8");
 assert.match(sql, /activity_media_participants/);
 assert.match(sql, /activity_media_consents/);
 assert.match(sql, /FOREIGN KEY\(district_id,student_id\)/);
 assert.match(sql, /FORCE ROW LEVEL SECURITY/);
 const routes = await readFile(new URL("src/clubs-sports-routes.js", root), "utf8");
 assert.match(routes, /active_guardian_link_required/);
 assert.match(routes, /guardianDecision\.denials/);
 assert.match(routes, /asset\.school_id!==activity\.school_id/);
 assert.match(routes, /media_participant_not_registered/);
 assert.match(routes, /all_guardian_consents_required/);
 assert.match(routes, /publicationEnabled:false/);
 assert.match(routes, /private_storage_and_publication_adapter_not_configured/);
 assert.doesNotMatch(routes, /publicUrl|signedUrl/);
});

test("private media pipeline validates types and fails closed without configured adapters", async () => {
 const { createMediaPipeline, validateMediaIntent, MediaPipelineError, MEDIA_LIMITS } = await import("../src/media-pipeline.js");
 assert.throws(() => validateMediaIntent({kind:"image",mimeType:"image/svg+xml",byteSize:100}), e => e instanceof MediaPipelineError && e.status===415);
 assert.throws(() => validateMediaIntent({kind:"video",mimeType:"video/mp4",byteSize:MEDIA_LIMITS.videoBytes+1}), e => e.status===413);
 const disabled=createMediaPipeline();
 assert.equal(disabled.enabled,false);
 await assert.rejects(() => disabled.beginUpload({districtId:"d",schoolId:"s",input:{kind:"image",mimeType:"image/png",byteSize:100}}), e => e.code==="private_media_pipeline_not_configured");
});

test("private media pipeline never exposes storage keys and gates tenant-scoped delivery", async () => {
 const calls=[];
 const storage={
  async createPrivateUpload(v){calls.push(v);return {uploadUrl:"https://upload.example.invalid/one-use",storageKey:"private/district/object",expiresAt:new Date(Date.now()+30000).toISOString()};},
  async headPrivateObject(v){assert.equal(v.storageKey,"private/district/object");return {byteSize:100,mimeType:"image/png",checksum:"sha256:abc"};},
  async createPrivateReadUrl(v){assert.equal(v.expiresInSeconds,60);assert.equal(v.storageKey,"private/district/object-clean");return {url:"https://read.example.invalid/short",expiresAt:new Date(Date.now()+30000).toISOString()};}
 };
 const scanner={async scanPrivateObject(v){assert.equal(v.storageKey,"private/district/object");return {verdict:"clean"};}};
 const processor={async processImage(v){return {storageKey:v.storageKey+"-clean",mimeType:"image/png",byteSize:90,metadataStripped:true,reencoded:true,checksum:"sha256:def"};}};
 let deliveryState={consentStatus:"pending",moderationStatus:"approved",participantCount:1,approvedParticipantCount:0,deniedParticipantCount:0};
 const authorization={async withAuthorizedMediaDelivery({issueReadUrl}){
  if(deliveryState.consentStatus!=="approved"||deliveryState.moderationStatus!=="approved"||
     deliveryState.participantCount<1||deliveryState.approvedParticipantCount!==deliveryState.participantCount||
     deliveryState.deniedParticipantCount!==0) throw Object.assign(new Error("media_not_approved"),{code:"media_not_approved",status:403});
  return issueReadUrl();
 }};
 const pipeline=(await import("../src/media-pipeline.js")).createMediaPipeline({storage,scanner,processor,authorization});
 const intent=await pipeline.beginUpload({districtId:"district-id",schoolId:"school-id",input:{kind:"image",mimeType:"image/png",byteSize:100}});
 assert.ok(intent.assetId);
 assert.equal(calls[0].assetId,intent.assetId);
 assert.equal(Object.hasOwn(calls[0],"storageKey"),false);
 assert.equal(Object.hasOwn(intent,"storageKey"),false);
 await assert.rejects(()=>pipeline.createReadUrl({assetId:intent.assetId,districtId:"other-district",schoolId:"school-id"}),e=>e.code==="media_reference_not_found");
 await assert.rejects(()=>pipeline.createReadUrl({assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"}),e=>e.code==="media_not_security_processed");
 const processed=await pipeline.verifyUploadedObject({assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"});
 assert.equal(processed.processingStatus,"processed");
 assert.equal(Object.hasOwn(processed,"storageKey"),false);
 await assert.rejects(()=>pipeline.createReadUrl({assetId:intent.assetId,districtId:"district-id",schoolId:"school-id",consentStatus:"approved",moderationStatus:"approved"}),e=>e.code==="media_not_approved");
 deliveryState={consentStatus:"approved",moderationStatus:"approved",participantCount:2,approvedParticipantCount:1,deniedParticipantCount:0};
 await assert.rejects(()=>pipeline.createReadUrl({assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"}),e=>e.code==="media_not_approved");
 deliveryState={consentStatus:"approved",moderationStatus:"approved",participantCount:2,approvedParticipantCount:2,deniedParticipantCount:0};
 const url=await pipeline.createReadUrl({assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"});
 assert.match(url.url,/read\\.example/);
 assert.equal(Object.hasOwn(url,"storageKey"),false);
});
