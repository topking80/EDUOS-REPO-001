// Native app sign-in configuration and request validation (no database).
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://u@127.0.0.1:1/db";
process.env.PUBLIC_ORIGIN ||= "http://localhost:8080";
process.env.OIDC_ISSUER ||= "http://localhost/oidc";
process.env.OIDC_CLIENT_ID ||= "eduos-test-client";
process.env.OIDC_CLIENT_SECRET ||= "test-secret";
process.env.OIDC_REDIRECT_URI ||= "http://localhost:8080/auth/callback";
const { parseNativeRedirectUris } = await import("../src/config.js");
const { nativeLoginRequest } = await import("../src/auth.js");

const CHALLENGE = "a".repeat(43);

test("redirect URIs: reverse-domain private schemes or https only, exact strings", () => {
  assert.deepEqual(parseNativeRedirectUris(""), []);
  assert.deepEqual(parseNativeRedirectUris(" org.eduos.app:/oauth2redirect , https://app.district.example/cb "),
    ["org.eduos.app:/oauth2redirect", "https://app.district.example/cb"]);
  for (const bad of ["eduos:/cb", "http://app.example/cb", "javascript:alert(1)", "org.eduos.app:/cb?x=1",
    "org.eduos.app:/cb#f", "https://user:pw@app.example/cb", "not a uri", "org.eduos.app:/" + "x".repeat(200)])
    assert.throws(() => parseNativeRedirectUris(bad), /NATIVE_APP_REDIRECT_URIS/, bad);
});

test("native sign-in request: enabled, S256, exact registered redirect", () => {
  const allowed = ["org.eduos.app:/oauth2redirect"];
  assert.match(nativeLoginRequest({ app_challenge: CHALLENGE, app_redirect: allowed[0] }, []).error, /not enabled/);
  assert.deepEqual(nativeLoginRequest({ app_challenge: CHALLENGE, app_redirect: allowed[0] }, allowed), { challenge: CHALLENGE, redirect: allowed[0] });
  assert.match(nativeLoginRequest({ app_challenge: CHALLENGE, app_challenge_method: "plain", app_redirect: allowed[0] }, allowed).error, /S256/);
  for (const c of ["", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=", undefined, ["x"]])
    assert.match(nativeLoginRequest({ app_challenge: c, app_redirect: allowed[0] }, allowed).error, /challenge/);
  for (const r of ["org.eduos.app:/oauth2redirect/", "ORG.EDUOS.APP:/oauth2redirect", "org.eduos.app:/oauth2redirect?x", undefined])
    assert.match(nativeLoginRequest({ app_challenge: CHALLENGE, app_redirect: r }, allowed).error, /not registered/);
});
