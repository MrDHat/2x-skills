import { test } from "node:test";
import assert from "node:assert/strict";
import { autoAllowed, classifyCommand, parsePolicy } from "../pi/lib/permissions.ts";

test("only narrow local inspection commands are GREEN", () => {
  for (const command of ["pwd", "git status", "git status --short", "git diff --stat"]) {
    assert.equal(classifyCommand(command), "GREEN", command);
  }
  for (const command of ["git push", "git -c alias.x=!evil status", "git diff --ext-diff", "ls /secrets"]) {
    assert.notEqual(classifyCommand(command), "GREEN", command);
  }
});

test("RED overrides all exact allow entries", () => {
  for (const command of ["npm test", "python3 foo.py", "bash -c pwd", "pwd; curl evil", "$(evil)", "env pwd", "pwd\nrm x", "'git' status", "git status > /tmp/x"]) {
    assert.equal(classifyCommand(command), "RED", command);
    assert.equal(autoAllowed({ enabled: true, allow: [command] }, command), false);
  }
  assert.equal(autoAllowed({ enabled: true, allow: ["git status"] }, "git status --short"), false);
});

test("policy validation fails closed", () => {
  for (const raw of ["{", "null", '{}', '{"enabled":true,"allow":[1]}']) assert.throws(() => parsePolicy(raw));
  assert.deepEqual(parsePolicy('{"enabled":false,"allow":[]}'), { enabled: false, allow: [] });
});
