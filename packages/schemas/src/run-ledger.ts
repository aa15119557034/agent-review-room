import { z } from "zod";
import { RunId, Sha256Hex } from "./common";
import { RemoteRunLedgerId } from "./remote-protocol";

/** Node-local append-only storage, never sent over HTTP. No prompts or credentials. */
export const RunLedgerIdentity = z.object({ version: z.literal(1), ledgerId: RemoteRunLedgerId, nonce: Sha256Hex }).strict();
export type RunLedgerIdentity = z.infer<typeof RunLedgerIdentity>;
export const RunLedgerHeader = z.object({ version: z.literal(1), ledgerId: RemoteRunLedgerId, identityHash: Sha256Hex }).strict();
export const RunLedgerRecord = z.object({
  ledgerId: RemoteRunLedgerId, seq: z.number().int().positive(), previousHash: Sha256Hex,
  runId: RunId, requestHash: Sha256Hex.nullable(),
  transition: z.enum(["admitted", "fenced", "never_spawned", "closed_process"]),
}).strict().refine((record) => (record.transition === "fenced") === (record.requestHash === null), "only an unknown cancellation has no request identity");
export type RunLedgerRecord = z.infer<typeof RunLedgerRecord>;
export const RunLedgerCommit = z.object({ ledgerId: RemoteRunLedgerId, seq: z.number().int().positive(), recordHash: Sha256Hex }).strict();
