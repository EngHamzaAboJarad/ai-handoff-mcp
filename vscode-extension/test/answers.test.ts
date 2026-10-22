// What @handoff answers, checked without VS Code against real storage and a real Git repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { HandoffStore, emptyFields } from "../../src/storage.js";
import { getGitSnapshot } from "../../src/git.js";
import { briefFor, checkFor, statusFor, systemPromptFor } from "../src/answers.js";
import { initRepo, tempProject } from "../../test/helpers.js";

async function project() {
  const { project: dir, dataDir } = await tempProject();
  await initRepo(dir);
  return { dir, store: new HandoffStore(dataDir) };
}

test("/resume shows the same brief the session-start hook injects, and says when there is none", async () => {
  const { dir, store } = await project();
  const empty = await briefFor(dir, store);
  assert.equal(empty.hasCheckpoint, false);
  assert.match(empty.brief, /No checkpoint exists for this project yet/);

  await store.write(dir, () => ({ ...emptyFields(), task: "Add login", currentStep: "Form", nextSteps: ["Validation", "Tests"] }), {
    agent: "claude",
    message: "saved",
    git: await getGitSnapshot(dir)
  });
  await fs.writeFile(path.join(dir, "login.ts"), "export const login = 1;\n");
  const { brief, hasCheckpoint } = await briefFor(dir, store);
  assert.equal(hasCheckpoint, true);
  assert.match(brief, /## Task\nAdd login/);
  assert.match(brief, /## Next steps \(in order\)\n1\. Validation/);
  assert.match(brief, /login\.ts/, "work after the checkpoint is shown");
});

test("/resume follows the project's token profile, like the hooks", async () => {
  const { dir, store } = await project();
  await fs.writeFile(path.join(dir, ".ai-handoff.json"), JSON.stringify({ tokens: { profile: "minimal" } }));
  const { brief } = await briefFor(dir, store);
  assert.match(brief, /call log_progress with the task/);
  assert.doesNotMatch(brief, /save_handoff/, "minimal has no save_handoff");
});

test("/status: task, where it stopped, next step and the guards' counters", async () => {
  const { dir, store } = await project();
  assert.match(await statusFor(dir, store), /No checkpoint for this folder yet/);
  await store.write(dir, () => ({ ...emptyFields(), task: "Add login", currentStep: "Form", nextSteps: ["Validation", "Tests"] }), {
    agent: "copilot",
    message: "saved"
  });
  await store.bumpStats(dir, { loopDenied: 2, loopStopped: 1, checkpoints: 1 });
  const status = await statusFor(dir, store);
  assert.match(status, /\*\*Task:\*\* Add login/);
  assert.match(status, /\*\*Next:\*\* Validation \(\+1 more\)/);
  assert.match(status, /by copilot · in_progress/);
  assert.match(status, /Loop guard: calls denied \/ agents stopped \| 2 \/ 1/);
});

test("/check uses the prompt gate itself, in both languages", () => {
  assert.match(checkFor("fix it"), /stopped this prompt before it reached the model/);
  assert.match(checkFor("صلحها"), /قوة البرومبت: 10\/100/);
  assert.match(checkFor("add a logout button to settings"), /Prompt strength 60\/100 \(weak\)[\s\S]*would go through, but/);
  assert.match(checkFor("In src/login.ts, validateEmail() accepts 'a@b'. It should reject it."), /\(good\)[\s\S]*It would go through\./);
  assert.match(checkFor("yes"), /never stopped/);
  assert.match(checkFor("   "), /Write the prompt after `\/check`/);
});

test("free questions get the brief as context and are told not to guess", () => {
  const prompt = systemPromptFor("## Task\nAdd login");
  assert.match(prompt, /## Task\nAdd login$/);
  assert.match(prompt, /say so instead of guessing/);
  assert.match(prompt, /Answer in the user's language/);
});
