import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const html = await readFile(new URL("../www/index.html", import.meta.url), "utf8");
function section(from, until) {
  const start = html.indexOf(from), end = html.indexOf(until, start + 1);
  assert.ok(start >= 0 && end > start, from);
  return html.slice(start, end);
}
const logic = section("  function planText(", "  function openPlanEditor(");
const planView = section("    plan() {", "    workout() {");
const workoutView = section("    workout() {", "    progress() {");
const escape = html.match(/^  const esc = [^\r\n]+/m)[0];
const EX = Object.fromEntries(Array.from({ length: 25 }, (_, i) => ["exercise-" + i, { name: "Lift " + i, level: 2 }]));
const ctx = vm.createContext({
  EX, EXERCISES: Object.values(EX), S: { planId: "my:p12", equip: [], log: [] },
  Program: { lastSession: () => null }, Units: { mass: () => "kg" }, Thumbs: { img: () => "" },
  curPlan: () => ctx.plan, planMuscles: () => ({}), planAllowed: () => true, canDo: () => true,
  backBtn: () => "", levelBadge: () => "", ICON: { chev: "" },
});
vm.runInContext(logic + escape + "\nconst testViews = {" + planView + workoutView + "};", ctx);
const run = expr => vm.runInContext(expr, ctx);

test("shared plans keep known exercises, bounded sets, and plain-text rep prescriptions", () => {
  ctx.input = { n: { toString: "bad" }, i: [null, {}, ["constructor", 1], ["__proto__", 1],
    [["exercise-1"], 1], ["unknown", 3], ["exercise-1", "2", "8–10 each side"],
    ["exercise-2", { valueOf: "bad" }, { toString: "bad" }], ["exercise-3", 100000, 12]] };
  const plan = run("normPlan(input)");
  assert.equal(plan.name, "Shared plan");
  assert.deepEqual(JSON.parse(JSON.stringify(plan.items)), [
    ["exercise-1", 2, "8–10 each side"], ["exercise-2", 3, "10"], ["exercise-3", 10, "12"],
  ]);
  assert.equal(run("normPlan({i:[[ 'toString', 2 ]]})"), null);
});

test("restore preserves legitimate older custom plans and discards unsafe metadata", () => {
  ctx.input = { id: "p12", name: "Sam’s session", items: Object.keys(EX).map(id => [id, 3, "30 sec"]),
    trainer: "Coach", code: "ABC234", days: "2 days a week", mins: 55, level: 3, focus: "Grip", note: "Controlled reps" };
  const legacy = run("restoreMyPlan(input)");
  assert.equal(legacy.items.length, 25);
  for (const key of ["id", "name", "trainer", "code", "days", "mins", "level", "focus", "note"]) assert.equal(legacy[key], ctx.input[key]);
  for (const id of ["__proto__", "constructor", 'p1" onclick="alert(1)']) {
    ctx.input.id = id;
    assert.equal(run("restoreMyPlan(input)"), null);
  }
  ctx.input = { id: "assigned-12", name: "Day 1", items: [["exercise-0", 3, "10"]], mins: "<svg>", level: "<img>", added: [{}], auto: true };
  const fixed = run("restoreMyPlan(input)");
  assert.equal(typeof fixed.mins, "number");
  assert.equal(fixed.level, 2);
  assert.equal(fixed.added, undefined);
  assert.equal(fixed.auto, undefined);
});

test("actual plan and active workout screens render markup-shaped names and reps as text", () => {
  ctx.input = { n: "<img src=x>", i: [["exercise-0", 3, "<svg/onload=x>"]], no: "<script>x</script>" };
  ctx.plan = run("asMyPlan(normPlan(input))");
  ctx.S.workout = { plan: ctx.plan, items: ctx.plan.items, sets: [[]], i: 0 };
  for (const page of ["plan", "workout"]) {
    const view = run("testViews." + page + "()");
    assert.ok(view.includes("&lt;svg/onload=x&gt;"), page);
    assert.ok(view.includes("&lt;img src=x&gt;"), page);
    assert.doesNotMatch(view, /<svg\/onload|<img src=x>|<script>/);
  }
});
