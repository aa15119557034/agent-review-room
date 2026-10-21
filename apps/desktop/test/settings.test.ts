import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SettingsError, SettingsStore, type SafeStorageLike } from "../src/main/settings";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "room-settings-"));
  dirs.push(dir);
  return join(dir, "settings.json");
}
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

/** 用一个可预测的「加密」替身：base64 反转，足以验证「不以明文落盘」。 */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from("enc:" + plain.split("").reverse().join(""), "utf8"),
  decryptString: (enc) => {
    const text = enc.toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("bad cipher");
    return text.slice(4).split("").reverse().join("");
  },
};

const unavailableSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("should not be called");
  },
  decryptString: () => {
    throw new Error("should not be called");
  },
};

describe("SettingsStore", () => {
  it("returns null before anything is configured", () => {
    const store = new SettingsStore(tempFile(), fakeSafeStorage);
    assert.equal(store.get(), null);
    assert.equal(store.getToken(), null);
  });

  it("stores the token encrypted and only reports tokenConfigured", () => {
    const file = tempFile();
    const store = new SettingsStore(file, fakeSafeStorage);
    const token = "a".repeat(40);

    const result = store.updateReviewerNode({ baseUrl: "http://192.168.1.20:7420", profileId: "claude-review", token });
    assert.deepEqual(result, {
      baseUrl: "http://192.168.1.20:7420",
      profileId: "claude-review",
      tokenConfigured: true,
    });
    assert.equal(JSON.stringify(result).includes(token), false, "settings.get must never contain the token");

    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes(token), false, "token must not be written in plaintext");

    assert.equal(store.getToken(), token);
  });

  it("keeps the token when the address is unchanged, clears it when the address changes", () => {
    const store = new SettingsStore(tempFile(), fakeSafeStorage);
    store.updateReviewerNode({ baseUrl: "http://10.0.0.1:7420", profileId: "p1", token: "b".repeat(40) });

    // 地址没变、不传 Token：保留
    const same = store.updateReviewerNode({ baseUrl: "http://10.0.0.1:7420", profileId: "p2" });
    assert.equal(same.tokenConfigured, true);
    assert.equal(store.getToken(), "b".repeat(40));

    // 地址变了、不传 Token：旧 Token 不能跟着新地址走
    const moved = store.updateReviewerNode({ baseUrl: "http://10.0.0.2:7420", profileId: "p2" });
    assert.equal(moved.baseUrl, "http://10.0.0.2:7420");
    assert.equal(moved.tokenConfigured, false);
    assert.equal(store.getToken(), null);
  });

  it("refuses to store a token when encryption is unavailable", () => {
    const store = new SettingsStore(tempFile(), unavailableSafeStorage);
    assert.throws(
      () => store.updateReviewerNode({ baseUrl: "http://10.0.0.1:7420", profileId: "p1", token: "c".repeat(40) }),
      (error: unknown) => error instanceof SettingsError && error.code === "token_storage_unavailable",
    );
  });

  it("survives a corrupted settings file", () => {
    const file = tempFile();
    const store = new SettingsStore(file, fakeSafeStorage);
    store.updateReviewerNode({ baseUrl: "http://10.0.0.1:7420", profileId: "p1" });
    assert.equal(store.get()?.profileId, "p1");

    // 文件存在但内容被写坏：当作未配置，不阻止应用启动
    writeFileSync(file, "{not json");
    assert.equal(new SettingsStore(file, fakeSafeStorage).get(), null);
  });
});
