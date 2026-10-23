import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentProfile,
  AppearanceSettings,
  ChatBackground,
  COMMANDS,
  ControlCommand,
  ControlQuery,
  DEFAULT_APPEARANCE,
  IMAGE_MAX_BYTES,
  ImageRef,
  QUERIES,
} from "../src/index";

const REF = "img_01JAAAAAAAAAAAAAAAAAAAAAAA";

describe("appearance (C-32)", () => {
  it("ImageRef is an opaque id, never a path or file name", () => {
    assert.ok(ImageRef.safeParse(REF).success);
    for (const bad of ["C:\\Users\\a.png", "../img.png", "img_01JAAAAAAAAAAAAAAAAAAAAAAA.png", "avatar.png", "file:///x"]) {
      assert.equal(ImageRef.safeParse(bad).success, false, bad);
    }
  });

  it("avatarRef on AgentProfile uses ImageRef", () => {
    assert.equal(AgentProfile.shape.avatarRef.safeParse(null).success, true);
    assert.equal(AgentProfile.shape.avatarRef.safeParse(REF).success, true);
    assert.equal(AgentProfile.shape.avatarRef.safeParse("/tmp/a.png").success, false);
  });

  it("chat background is a preset or an image ref", () => {
    assert.ok(ChatBackground.safeParse({ kind: "preset", id: "paper" }).success);
    assert.ok(ChatBackground.safeParse({ kind: "image", ref: REF }).success);
    assert.equal(ChatBackground.safeParse({ kind: "image", ref: "bg.jpg" }).success, false);
    assert.equal(ChatBackground.safeParse({ kind: "preset", id: "neon" }).success, false);
  });

  it("default appearance is valid and size limits are sane", () => {
    assert.ok(AppearanceSettings.safeParse(DEFAULT_APPEARANCE).success);
    assert.ok(IMAGE_MAX_BYTES.avatar < IMAGE_MAX_BYTES.background);
  });

  it("image.pick takes a purpose, never a path", () => {
    assert.ok(ControlCommand.safeParse({ type: "image.pick", purpose: "avatar" }).success);
    const withPath = COMMANDS["image.pick"].request.strict().safeParse({ type: "image.pick", purpose: "avatar", path: "C:\\x.png" });
    assert.equal(withPath.success, false);
    assert.ok(COMMANDS["image.pick"].response.safeParse(null).success);
    assert.ok(COMMANDS["image.pick"].response.safeParse({ ref: REF }).success);
  });

  it("appearance.update and appearance.get", () => {
    assert.ok(ControlCommand.safeParse({ type: "appearance.update", chatBackground: { kind: "preset", id: "night" } }).success);
    assert.ok(ControlCommand.safeParse({ type: "appearance.update", userAvatarRef: null }).success);
    assert.ok(ControlCommand.safeParse({ type: "agent.update", id: "claude", avatarRef: REF }).success);
    assert.ok(ControlQuery.safeParse({ type: "appearance.get" }).success);
    assert.equal(QUERIES["appearance.get"].scope, "read");
  });
});

describe("node.importLocalToken (C-39)", () => {
  it("takes only a node id: no path, no token", () => {
    assert.ok(ControlCommand.safeParse({ type: "node.importLocalToken", id: "controller-local" }).success);
    const strict = COMMANDS["node.importLocalToken"].request.strict();
    assert.equal(strict.safeParse({ type: "node.importLocalToken", id: "controller-local", path: "C:\\x" }).success, false);
    assert.equal(strict.safeParse({ type: "node.importLocalToken", id: "controller-local", token: "a".repeat(40) }).success, false);
    assert.equal(COMMANDS["node.importLocalToken"].scope, "admin");
  });

  it("response is NodeInfo (tokenConfigured only, never the token)", () => {
    const shape = Object.keys(COMMANDS["node.importLocalToken"].response.shape);
    assert.deepEqual(shape.sort(), ["baseUrl", "id", "label", "tokenConfigured"]);
  });
});
