// MEDIA-01: Signature Version 4 against AWS's published S3 examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signS3, EMPTY_SHA256 } from "../src/s3-storage.js";

const creds = { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", date: new Date("2013-05-24T00:00:00Z") };
test("presigned GET matches the AWS documentation example", () => {
  const r = signS3({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", presign: 86400, ...creds });
  assert.equal(r.signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});
test("header-signed GET with a Range header matches the AWS documentation example", () => {
  const r = signS3({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" }, payloadHash: EMPTY_SHA256, ...creds });
  assert.equal(r.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.match(r.headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8/);
});
