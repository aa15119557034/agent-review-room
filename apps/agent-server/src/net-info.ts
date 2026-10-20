import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/**
 * 本机的局域网 IPv4 地址，用来告诉用户在主控端填什么。
 *
 * 排除：回环、链路本地（169.254/16）、以及 198.18.0.0/15——这是 Clash / Surge 等代理软件
 * TUN 模式虚拟网卡常用的地址段，另一台电脑连不到它，打印出来只会让人填错。
 * 私有网段（192.168 / 10 / 172.16–31）排在前面。
 */
export function lanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.") || isProxyTunRange(a.address)) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out.sort((x, y) => Number(isPrivate(y)) - Number(isPrivate(x)));
}

function octets(ip: string): number[] {
  return ip.split(".").map(Number);
}

/** 198.18.0.0/15（RFC 2544 基准测试段，被代理软件拿来做虚拟网卡） */
function isProxyTunRange(ip: string): boolean {
  const [a, b] = octets(ip);
  return a === 198 && (b === 18 || b === 19);
}

function isPrivate(ip: string): boolean {
  const [a, b = -1] = octets(ip);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
