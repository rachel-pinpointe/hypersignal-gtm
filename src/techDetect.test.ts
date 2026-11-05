// Technology detection — the ambiguity guard.
//
// The dictionary is ~29k names from TheirStack + webappanalyzer, and many products are named after
// ordinary English words. Run against JOB PROSE (webappanalyzer was built for website markup) that
// made the most-detected "technologies" on the live 24,945-job table almost all English: Lift 4687,
// Qualified 4399, Make 3656, JOIN 3561 ("join our team"), Basic 3469, Here 3191 — with Python (2261)
// and Azure (1456), the answers a user actually wants, ranked below "Here" and "JUST".
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { rebuildTechIndex, detectTechIds, detectedTechNames } from "./techDetect.ts";

// A miniature dictionary: names that are also English words, and names that are not.
// `canonical` is NOT NULL UNIQUE — omitting it makes every INSERT fail, and with OR IGNORE that
// failure is silent, leaving an EMPTY dictionary. The first draft of this file did exactly that, and
// the two "an ambiguous name alone is not a technology" cases below passed anyway: detectTechIds
// returns nothing when the index is empty, so they were asserting nothing. Any test whose expected
// value is "empty" has to be paired with one that proves the machinery is switched on.
const seed = db.prepare("INSERT OR IGNORE INTO technologies (name, canonical, aliases) VALUES (?, ?, ?)");
for (const name of ["Lift", "Spring", "Java", "Kubernetes", "Spring Boot"]) seed.run(name, name.toLowerCase(), null);
rebuildTechIndex();
assert.ok(detectTechIds("Kubernetes").size > 0, "guard: the test dictionary must actually be loaded");

const names = (text: string) => [...detectedTechNames(text)].sort();

test("an ambiguous name alone is not a technology", () => {
  // The exact shape that produced 4,687 false Lift detections: a warehouse posting.
  assert.deepEqual(names("Warehouse Associate. Must be able to lift up to 50 lbs repeatedly."), []);
  assert.deepEqual(names("Join our team and make an impact this spring."), []);
});

test("an ambiguous name IS a technology when a real one sits beside it", () => {
  assert.deepEqual(names("Requirements: Java, Spring, Kubernetes."), ["java", "kubernetes", "spring"]);
});

test("proximity, not mere presence — document-level corroboration was measured and was not enough", () => {
  // With 29k dictionary entries virtually every job matches something unambiguous somewhere, so a
  // document-level test let "Spring" attach to a Primo Brands WAREHOUSE posting. Only nearness works.
  const far = "Warehouse Associate. Must be able to lift up to 50 lbs. " + "word ".repeat(40)
    + "Our engineering team uses Kubernetes.";
  assert.equal(names(far).includes("lift"), false, "lift is 40+ words from the only real technology");
  assert.equal(names(far).includes("kubernetes"), true, "the real technology is still detected");
});

test("unambiguous technologies never need corroboration", () => {
  assert.deepEqual(names("We run Kubernetes."), ["kubernetes"]);
  assert.deepEqual(names("Backend is Java."), ["java"]);
});

test("a distinctive ALIAS of an ambiguous product counts as a hard match", () => {
  // Ambiguity is judged per NAME, not per technology: "spring boot" is unambiguous even though
  // "spring" is not, so it stands on its own with nothing else in the text.
  assert.equal(names("Built with Spring Boot.").includes("spring boot"), true);
});

test("detectTechIds returns ids that map back to the names", () => {
  assert.equal(detectTechIds("We run Kubernetes.").size, 1);
  assert.equal(detectTechIds("").size, 0);
});
