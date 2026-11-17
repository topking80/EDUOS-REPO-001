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
 const mediaRegistry = await readFile(new URL("db/054_private_media_object_registry.sql", root), "utf8");
 assert.match(mediaRegistry, /private_media_objects/);
 assert.match(mediaRegistry, /FORCE ROW LEVEL SECURITY/);
 assert.match(mediaRegistry, /storage_key/);
 const grants = await readFile(new URL("db/runtime_grants.template.sql", root), "utf8");
 assert.match(grants, /SELECT, INSERT, UPDATE ON private_media_objects/);
 const scoped = await readFile(new URL("db/055_clubs_sports_composite_scope_constraints.sql", root), "utf8");
 const schoolRls = await readFile(new URL("db/056_clubs_sports_school_scope_rls.sql", root), "utf8");
 assert.match(schoolRls, /app\.school_id/);
 assert.match(schoolRls, /superintendent/);
 assert.match(schoolRls, /private_media_objects/);
 for (const fk of ["activity_staff_activity_school_fk","event_ticket_orders_type_school_fk","event_tickets_order_school_fk","media_participants_asset_school_fk","media_consents_asset_school_fk","activity_roster_student_school_fk","media_participant_student_school_fk","media_consent_student_school_fk","private_media_object_asset_school_fk","media_consent_registered_participant_fk"]) assert.match(scoped,new RegExp(fk));
});
test("paid checkout and livestream playback remain fail-closed", async () => {
 const routes = await readFile(new URL("src/clubs-sports-routes.js", root), "utf8");
 assert.match(routes, /paid_ticketing_not_configured/);
 assert.match(routes, /playbackEnabled:false/);
 assert.match(routes, /stream_schedule_access_forbidden/);
 assert.match(routes, /district_stream_audience_required/);
 assert.match(routes, /stream_ticket_holder_required/);
 assert.match(routes, /ticket_code_hash|ticketCode/);
 assert.match(routes, /idempotency_key_reused/);
 assert.match(routes, /idempotency_key_payload_mismatch/);
 assert.match(routes, /rotate_codes/);
 assert.match(routes, /previous unredeemed codes invalidated/);
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
 assert.match(routes, /approved_consent_required_for_withdrawal/);
 assert.match(routes, /withdraw_media_consent/);
 assert.match(routes, /status='withdrawn'/);
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

test("private media pipeline uses a durable registry and gates tenant-scoped delivery", async () => {
 const calls=[], objects=new Map();
 const actor={userId:"principal",role:"principal",districtId:"district-id",schoolId:"school-id"};
 const storage={
  async createPrivateUpload(v){calls.push(v);return {uploadUrl:"https://upload.example.invalid/one-use",storageKey:"private/district/object",expiresAt:new Date(Date.now()+30000).toISOString()};},
  async headPrivateObject(v){
   if(v.storageKey==="private/district/object-clean")return {byteSize:90,mimeType:"image/png",checksum:"sha256:def"};
   assert.equal(v.storageKey,"private/district/object");return {byteSize:100,mimeType:"image/png",checksum:"sha256:abc"};
  },
  async createPrivateReadUrl(v){assert.equal(v.expiresInSeconds,60);assert.equal(v.storageKey,"private/district/object-clean");return {url:"https://read.example.invalid/short",expiresAt:new Date(Date.now()+30000).toISOString()};}
 };
 const scanner={async scanPrivateObject(v){assert.ok(["private/district/object","private/district/object-clean"].includes(v.storageKey));return {verdict:"clean"};}};
 const processor={async processImage(v){return {storageKey:v.storageKey+"-clean",mimeType:"image/png",byteSize:90,metadataStripped:true,reencoded:true,checksum:"sha256:def"};}};
 const registry={
  async createPrivateObject(v){objects.set(v.assetId,{...v,scanStatus:"pending",processingStatus:"pending"});},
  async getPrivateObject(v){const record=objects.get(v.assetId);if(!record||record.districtId!==v.districtId||record.schoolId!==v.schoolId)throw Object.assign(new Error("media_reference_not_found"),{code:"media_reference_not_found"});return record;},
  async updatePrivateObject(v){const record=objects.get(v.assetId);Object.assign(record,Object.fromEntries(Object.entries(v).filter(([k])=>!["actor","assetId","districtId","schoolId"].includes(k))));}
 };
 let deliveryState={consentStatus:"pending",moderationStatus:"approved",participantCount:1,approvedParticipantCount:0,deniedParticipantCount:0};
 const authorization={async withAuthorizedMediaDelivery({issueReadUrl}){
  if(deliveryState.consentStatus!=="approved"||deliveryState.moderationStatus!=="approved"||
     deliveryState.participantCount<1||deliveryState.approvedParticipantCount!==deliveryState.participantCount||
     deliveryState.deniedParticipantCount!==0) throw Object.assign(new Error("media_not_approved"),{code:"media_not_approved",status:403});
  return issueReadUrl();
 }};
 const pipeline=(await import("../src/media-pipeline.js")).createMediaPipeline({
  storage,scanner,processor,authorization,registry,
  allowedUploadHosts:["upload.example.invalid"],allowedReadHosts:["read.example.invalid"]
 });
 const intent=await pipeline.beginUpload({actor,districtId:"district-id",schoolId:"school-id",input:{kind:"image",mimeType:"image/png",byteSize:100}});
 assert.ok(intent.assetId);
 const rejectedHost=(await import("../src/media-pipeline.js")).createMediaPipeline({
  storage,scanner,processor,authorization,registry,
  allowedUploadHosts:["other.example.invalid"],allowedReadHosts:["read.example.invalid"]
 });
 await assert.rejects(()=>rejectedHost.beginUpload({actor,districtId:"district-id",schoolId:"school-id",input:{kind:"image",mimeType:"image/png",byteSize:100}}),
  e=>e.code==="invalid_private_storage_response");
 assert.equal(calls[0].assetId,intent.assetId);
 assert.equal(Object.hasOwn(calls[0],"storageKey"),false);
 assert.equal(Object.hasOwn(intent,"storageKey"),false);
 await assert.rejects(()=>pipeline.createReadUrl({actor,assetId:intent.assetId,districtId:"other-district",schoolId:"school-id"}),e=>e.code==="media_tenant_scope_required");
 await assert.rejects(()=>pipeline.createReadUrl({actor,assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"}),e=>e.code==="media_not_security_processed");
 const processed=await pipeline.verifyUploadedObject({actor,assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"});
 assert.equal(processed.processingStatus,"processed");
 assert.equal(Object.hasOwn(processed,"storageKey"),false);
 await assert.rejects(()=>pipeline.createReadUrl({actor,assetId:intent.assetId,districtId:"district-id",schoolId:"school-id",consentStatus:"approved",moderationStatus:"approved"}),e=>e.code==="media_not_approved");
 deliveryState={consentStatus:"approved",moderationStatus:"approved",participantCount:2,approvedParticipantCount:1,deniedParticipantCount:0};
 await assert.rejects(()=>pipeline.createReadUrl({actor,assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"}),e=>e.code==="media_not_approved");
 deliveryState={consentStatus:"approved",moderationStatus:"approved",participantCount:2,approvedParticipantCount:2,deniedParticipantCount:0};
 const url=await pipeline.createReadUrl({actor,assetId:intent.assetId,districtId:"district-id",schoolId:"school-id"});
 assert.match(url.url,/read\.example/);
 assert.equal(Object.hasOwn(url,"storageKey"),false);
});

test("PostgreSQL media delivery authorization locks asset, participants and guardian decisions", async () => {
 const {createPostgresMediaAuthorization}=await import("../src/media-delivery-authorization.js");
 let denied=false, issued=0;
 const statements=[];
 const authorization=createPostgresMediaAuthorization({withTenantTransaction:async(actor,fn)=>{
  assert.equal(actor.districtId,"district-id");
  return fn({query:async(sql,params)=>{
   statements.push(sql);
   if(sql.includes("FROM activity_media_assets"))return {rows:[{id:"asset",school_id:"school-id",activity_id:"activity",consent_status:"approved",moderation_status:"approved"}],rowCount:1};
   if(sql.includes("FROM activity_media_participants"))return {rows:[{student_id:"student-1",consent_status:"approved"},{student_id:"student-2",consent_status:"approved"}],rowCount:2};
   if(sql.includes("FROM activity_media_consents"))return {rows:[{status:denied&&params[3]==="student-2"?"denied":"approved"}],rowCount:1};
   throw new Error("unexpected query");
  }});
 }});
 const args={actor:{userId:"principal",role:"principal",districtId:"district-id",schoolId:"school-id"},assetId:"asset",districtId:"district-id",schoolId:"school-id",issueReadUrl:async()=>{issued++;return {url:"https://read.example.invalid/short"};}};
 const result=await authorization.withAuthorizedMediaDelivery(args);
 assert.match(result.url,/read/);
 assert.equal(issued,1);
 assert.ok(statements.every(sql=>/FOR UPDATE/i.test(sql)));
 denied=true;
 await assert.rejects(()=>authorization.withAuthorizedMediaDelivery(args),e=>e.code==="media_not_approved");
 assert.equal(issued,1);
});
