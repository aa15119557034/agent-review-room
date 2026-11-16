import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { RemoteRunFenceAccess } from "@room/core";
import { ulid, WorldBudgetStore } from "@room/db";
import type { RemoteRunProof } from "@room/schemas";
import { WorldRunFenceBarrier, WorldRunNotStoppedError } from "../src/main/world-run-fence";
import { resolveWorldFence } from "../src/main/world-node";

function fixture(t: TestContext) {
  const parent = fs.realpathSync.native(tmpdir()), root = fs.mkdtempSync(join(parent, "world-fence-desktop-")), path = join(root, "usage.sqlite");
  const budget = new WorldBudgetStore(path);
  t.after(() => { budget.close(); assert.equal(dirname(resolve(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { runId: "run_" + ulid(), agent: "deepseek", limit: 3, binding: {
    worldId: "world_" + ulid(), generation: { session: "wses_" + ulid(), runSeq: 1 }, nodeId: "original-node", baseUrl: "http://127.0.0.1:7420",
    profileId: "deleted-world-profile", ledgerId: "rled_" + ulid(), worldProfile: { sourceChatProfileId: "deleted-chat", recipeVersion: "deepseek-http-v1" }, model: { model: "deepseek-flash", effort: "high" },
  } };
  budget.reserveBound(input);
  return { budget, path, input };
}

test("restart reconciliation cancels missing Run on original binding and persists only positive proof", async t => {
  const h = fixture(t); h.budget.close(); const reopened = new WorldBudgetStore(h.path);
  let cancelled = false, resolved = 0;
  const access: RemoteRunFenceAccess = { ledgerId: h.input.binding.ledgerId,
    cancel: async (id, _reason, signal) => { assert.equal(id,h.input.runId); assert.equal(signal?.aborted,false); cancelled=true; },
    proof: async id => ({runId:id,ledgerId:h.input.binding.ledgerId,status:cancelled?'fenced_never_started':'missing'}),
  };
  const barrier = new WorldRunFenceBarrier({ budget: reopened, resolve: original => { resolved++; assert.deepEqual(original,h.input.binding); return access; } });
  try {
    await Promise.all([barrier.reconcile(),barrier.reconcile()]);
    assert.equal(resolved,1);assert.equal(cancelled,true);assert.deepEqual(reopened.pending(),[]);assert.equal(reopened.get('deepseek',3).used,1);
  } finally { reopened.close(); }
});

test("completed event/list absence are irrelevant; accepted cancellation with unconfirmed proof keeps blocking", async t => {
  const h = fixture(t);let cancels=0;
  const barrier = new WorldRunFenceBarrier({ budget:h.budget,timeoutMs:30,resolve:()=>({ledgerId:h.input.binding.ledgerId,
    cancel:async()=>{cancels++;},proof:async id=>({runId:id,ledgerId:h.input.binding.ledgerId,status:'unconfirmed'})}) });
  await assert.rejects(barrier.reconcile(),WorldRunNotStoppedError);
  assert.equal(cancels,1);assert.equal(h.budget.pending().length,1);
});

test("wrong proof, missing original credential and failed cancel never clear durable state", async t => {
  for(const variant of ['run','ledger','credential','cancel'] as const) await t.test(variant,async t=>{
    const h=fixture(t);const barrier=new WorldRunFenceBarrier({budget:h.budget,resolve:()=>variant==='credential'?null:{ledgerId:h.input.binding.ledgerId,
      cancel:async()=>{throw new Error('cancel failed');},proof:async id=>({runId:variant==='run'?'run_'+ulid():id,ledgerId:variant==='ledger'?'rled_'+ulid():h.input.binding.ledgerId,status:variant==='cancel'?'missing':'closed_process'} as RemoteRunProof)}});
    await assert.rejects(barrier.reconcile(),WorldRunNotStoppedError);assert.equal(h.budget.pending().length,1);
  });
});

test("positive original proof works after profile deletion without health or session", async t => {
  const h=fixture(t);const barrier=new WorldRunFenceBarrier({budget:h.budget,resolve:()=>({ledgerId:h.input.binding.ledgerId,
    cancel:async()=>{throw new Error('already stopped must not cancel');},proof:async id=>({runId:id,ledgerId:h.input.binding.ledgerId,status:'closed_process'})})});
  await barrier.reconcile();assert.deepEqual(h.budget.pending(),[]);
});

test("main resolves proof access from saved node and address even if resident/profile disappeared", t => {
  const h=fixture(t),reads:string[]=[];
  const settings={getNode:(id:string)=>{reads.push(id);return {baseUrl:h.input.binding.baseUrl,token:'fake-original-token'.repeat(3)};}};
  const access=resolveWorldFence({settings},h.input.binding);
  assert.equal(access?.ledgerId,h.input.binding.ledgerId);assert.deepEqual(reads,['original-node']);
  assert.equal(resolveWorldFence({settings:{getNode:()=>({baseUrl:'http://127.0.0.1:9999',token:'fake-new-token'.repeat(3)})}},h.input.binding),null);
  assert.equal(resolveWorldFence({settings:{getNode:()=>null}},h.input.binding),null);
});
