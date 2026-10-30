import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This test mocks the account menu's external CLI file check.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This test replaces subprocess execution without launching the CLI.
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });

import type * as Electron from "electron";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { buildAccountsMenu, decodeCliOutput, make } from "./DesktopAccountsMenu.ts";

const accounts = {
  ok: true as const,
  claude: {
    activeId: "personal",
    current: { loggedIn: true },
    profiles: [
      { id: "personal", name: "Personal", email: "me@example.com", plan: "Max" },
      { id: "work", name: "Work" },
    ],
  },
  codex: { activeId: null, current: { loggedIn: true }, profiles: [] },
};

const layerEnvironment = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/missing-account-switch-cli",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
}).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));

function submenu(item: Electron.MenuItemConstructorOptions | undefined) {
  if (!Array.isArray(item?.submenu)) throw new Error("Expected a menu template array.");
  return item.submenu;
}

describe("DesktopAccountsMenu", () => {
  it.effect("decodes profiles into labelled checkboxes and an unsaved login into Save", () =>
    Effect.gen(function* () {
      const list = yield* decodeCliOutput("list", JSON.stringify(accounts));
      const actions: unknown[] = [];
      const menu = buildAccountsMenu(list, (action) => actions.push(action));
      assert.equal(menu?.label, "Accounts");
      const providers = submenu(menu);
      assert.deepEqual(
        providers.map((item) => item.label),
        ["Claude", "Codex"],
      );
      const claude = submenu(providers[0]);
      assert.deepEqual(
        claude.map(({ label, type, checked, enabled }) => ({ label, type, checked, enabled })),
        [
          { label: "Personal (Max)", type: "checkbox", checked: true, enabled: undefined },
          { label: "Work", type: "checkbox", checked: false, enabled: undefined },
          { label: undefined, type: "separator", checked: undefined, enabled: undefined },
          { label: "Save Current Login", type: undefined, checked: undefined, enabled: false },
        ],
      );
      const codex = submenu(providers[1]);
      assert.equal(codex.at(-1)?.label, "Save Current Login");
      assert.isTrue(codex.at(-1)?.enabled);
      claude[1]?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
      codex.at(-1)?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
      assert.deepEqual(actions, [
        { command: "switch", provider: "claude", id: "work" },
        { command: "save", provider: "codex" },
      ]);
    }),
  );

  it("disables Save for logged-out and already-saved logins", () => {
    for (const [loggedIn, activeId, enabled] of [
      [false, null, false],
      [false, "saved", false],
      [true, "saved", false],
      [true, null, true],
      [true, "", false],
    ] as const) {
      const menu = buildAccountsMenu(
        { ...accounts, codex: { activeId, current: { loggedIn }, profiles: [] } },
        () => {},
      );
      assert.equal(submenu(submenu(menu)[1]).at(-1)?.enabled, enabled);
    }
  });

  it.effect("shows provider errors without hiding the other provider", () =>
    Effect.gen(function* () {
      const list = yield* decodeCliOutput(
        "list",
        JSON.stringify({ ...accounts, claude: { error: "Keychain is locked" } }),
      );
      const providers = submenu(buildAccountsMenu(list, () => {}));
      assert.deepEqual(submenu(providers[0]), [{ label: "Keychain is locked", enabled: false }]);
      assert.isTrue(submenu(providers[1]).at(-1)?.enabled);
    }),
  );

  it.effect("omits the menu when the CLI file is missing", () =>
    Effect.gen(function* () {
      using _exists = vi.spyOn(NodeFS, "existsSync").mockReturnValue(false);
      const menu = yield* make;
      assert.isUndefined(yield* menu.template);
      assert.isUndefined(buildAccountsMenu(null, () => {}));
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("runs the CLI as Electron Node and renders readable failures", () =>
    Effect.gen(function* () {
      using _exists = vi.spyOn(NodeFS, "existsSync").mockReturnValue(true);
      for (const [error, stdout, message] of [
        [null, "not JSON", "Account switch CLI returned invalid JSON."],
        [{ code: 1 }, '{"ok":false,"error":"Keychain locked"}', "Keychain locked"],
        [{ killed: true }, "", "Account switch CLI timed out after 10 seconds."],
        [
          { code: "ENOENT", message: "missing runtime" },
          "",
          "Could not run account switch CLI: missing runtime",
        ],
      ] as const) {
        using execute = vi
          .spyOn(NodeChildProcess, "execFile")
          .mockImplementation((_file, _args, _options, callback) => {
            callback?.(error as NodeChildProcess.ExecFileException | null, stdout, "");
            return new NodeChildProcess.ChildProcess();
          });
        const menu = yield* make;
        const providers = submenu(yield* menu.template);
        for (const provider of providers) {
          assert.deepEqual(submenu(provider), [{ label: message, enabled: false }]);
        }
        const call = execute.mock.calls[0];
        assert.equal(call?.[0], process.execPath);
        assert.deepEqual(call?.[1], [
          process.env.T3CODE_ACCOUNT_SWITCH_CLI ??
            "/missing-account-switch-cli/.config/claude-switch/cli.mjs",
          "list",
          "--json",
        ]);
        assert.containsSubset(call?.[2], {
          timeout: 10_000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
      }
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("decodes switch/save responses and preserves CLI failure messages", () =>
    Effect.gen(function* () {
      const profile = { id: "work", name: "Work", plan: "Plus" };
      for (const alreadyActive of [true, false]) {
        const response = { ok: true, provider: "codex", profile, alreadyActive } as const;
        assert.deepEqual(yield* decodeCliOutput("switch", JSON.stringify(response)), response);
      }
      const saved = { ok: true, provider: "claude", profile, updated: false } as const;
      assert.deepEqual(yield* decodeCliOutput("save", JSON.stringify(saved)), saved);
      for (const command of ["list", "switch", "save"] as const) {
        for (const exitCode of [0, 1]) {
          const error = yield* decodeCliOutput(
            command,
            '{"ok":false,"error":"Login expired"}',
            exitCode,
          ).pipe(Effect.flip);
          assert.equal(error.message, "Login expired");
        }
      }
    }),
  );

  it.effect("rejects malformed JSON, invalid response shapes and unsuccessful exits", () =>
    Effect.gen(function* () {
      for (const [command, stdout, exitCode, message] of [
        ["list", "not JSON", 0, "invalid JSON"],
        ["list", "{}", 0, "invalid list response"],
        [
          "list",
          JSON.stringify({ ...accounts, codex: { activeId: null } }),
          0,
          "invalid list response",
        ],
        [
          "switch",
          JSON.stringify({ ok: true, provider: "claude", profile: { id: "x", name: "X" } }),
          0,
          "invalid switch response",
        ],
        [
          "save",
          JSON.stringify({
            ok: true,
            provider: "other",
            profile: { id: "x", name: "X" },
            updated: true,
          }),
          0,
          "invalid save response",
        ],
        ["list", JSON.stringify(accounts), 1, "exited with code 1"],
        ["list", '{"ok":true}\n{}', 0, "invalid JSON"],
      ] as const) {
        const error = yield* decodeCliOutput(command, stdout, exitCode).pipe(Effect.flip);
        assert.include(error.message, message);
      }
    }),
  );
});
