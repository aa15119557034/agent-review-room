import { networkInterfaces } from "node:os";

/** 本机的局域网 IPv4 地址（排除回环和链路本地地址），用来告诉用户在主控端填什么 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
    }
  }
  return out;
}
