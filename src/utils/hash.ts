import { createHash } from "node:crypto";

export function rendezvousScore(routingKey: string, accountKey: string): bigint {
  const digest = createHash("sha256")
    .update(routingKey)
    .update("\0")
    .update(accountKey)
    .digest("hex");
  return BigInt(`0x${digest.slice(0, 16)}`);
}
