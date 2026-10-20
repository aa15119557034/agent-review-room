import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, it } from "node:test";
import { lanAddresses } from "../src/net-info";

const v4 = (address: string, internal = false) =>
  ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }) as NetworkInterfaceInfo;

describe("lanAddresses", () => {
  it("drops loopback, link-local and the 198.18/15 proxy TUN range, private first", () => {
    const got = lanAddresses({
      Clash: [v4("198.18.0.1"), v4("198.19.255.1")],
      lo: [v4("127.0.0.1", true)],
      apipa: [v4("169.254.3.4")],
      public: [v4("203.0.113.5")],
      wifi: [v4("192.168.190.10"), { ...v4("fe80::1"), family: "IPv6" } as NetworkInterfaceInfo],
    });
    assert.deepEqual(got, ["192.168.190.10", "203.0.113.5"]);
  });

  it("keeps 198.17 and 198.20 (outside the /15)", () => {
    assert.deepEqual(lanAddresses({ a: [v4("198.17.0.1"), v4("198.20.0.1")] }), ["198.17.0.1", "198.20.0.1"]);
  });
});
