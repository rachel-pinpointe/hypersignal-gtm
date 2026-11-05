// Keyword term-matching: prefix mode (default) vs exact/whole-word mode ("Exact matches only").
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordHit } from "./keywordMatch.ts";

test("prefix mode: 4+ char terms match a word start", () => {
  assert.ok(keywordHit("we use ReactJS here", "react"));      // prefix hit
  assert.ok(keywordHit("Kubernetes cluster", "kubernet"));
  assert.ok(keywordHit("JavaScript ninja", "java"));          // documented prefix behaviour
});

test("prefix mode: short terms are whole-word only", () => {
  assert.ok(keywordHit("AI Engineer", "ai"));
  assert.ok(!keywordHit("maintenance technician", "ai"));      // never mid-word
});

test("exact mode: whole word on both sides for every length", () => {
  assert.ok(keywordHit("we use React here", "react", true));
  assert.ok(!keywordHit("we use ReactJS here", "react", true)); // no longer a prefix hit
  assert.ok(!keywordHit("JavaScript ninja", "java", true));     // the case exact mode fixes
  assert.ok(keywordHit("a Java shop", "java", true));
});

test("punctuation terms keep no wrong boundary in either mode", () => {
  assert.ok(keywordHit("built in .NET", ".net"));
  assert.ok(keywordHit("built in .NET", ".net", true));
  assert.ok(keywordHit("strong C++ skills", "c++"));
  assert.ok(keywordHit("strong C++ skills", "c++", true));
});

test("empty term never hits", () => {
  assert.ok(!keywordHit("anything", ""));
  assert.ok(!keywordHit("anything", "", true));
});
