import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This test mocks the account menu's external CLI file check.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This test replaces subprocess execution without launching the CLI.
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });

import type * as Electron from "electron";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
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
  it.effect("adds only known usage windows and expired logins to profile labels", () =>
    Effect.gen(function* () {
      const fetchedAt = "2026-10-30T10:00:00Z";
      for (const [value, suffix] of [
        [
          {
            status: "ok",
            windows: [
              { kind: "session", leftPercent: 70 },
              { kind: "weekly", leftPercent: 88, resetsAt: fetchedAt },
            ],
          },
          " — 5h 70% · wk 88% left",
        ],
        [
          {
            status: "ok",
            windows: [{ kind: "weekly", leftPercent: 0 }],
          },
          " — wk 0% left",
        ],
        [
          {
            status: "ok",
            windows: [{ kind: "session", leftPercent: 100 }],
          },
          " — 5h 100% left",
        ],
        [{ status: "expired" }, " — login expired"],
        [{ status: "unavailable", message: "offline" }, ""],
        [{ status: "future" }, ""],
        [{ status: "ok", windows: [] }, ""],
        [
          {
            status: "ok",
            windows: [
              { kind: "monthly", leftPercent: 40 },
              { kind: "session", leftPercent: 23 },
            ],
          },
          " — 5h 23% left",
        ],
        [
          {
            status: "ok",
            windows: [
              { kind: "session", leftPercent: 101 },
              { kind: "weekly", leftPercent: -1 },
              { kind: "session", leftPercent: 1.5 },
            ],
          },
          "",
        ],
      ] as const) {
        const usage = yield* decodeCliOutput(
          "usage",
          JSON.stringify({
            ok: true,
            claude: { personal: { ...value, fetchedAt } },
            codex: { error: "offline" },
          }),
        );
        const claude = submenu(submenu(buildAccountsMenu(accounts, () => {}, usage))[0]);
        assert.equal(claude[0]?.label, `Personal (Max)${suffix}`);
        assert.equal(claude[0]?.type, "checkbox");
        assert.isTrue(claude[0]?.checked);
        assert.equal(claude[1]?.label, "Work");
      }
      const usage = yield* decodeCliOutput(
        "usage",
        JSON.stringify({
          ok: true,
          claude: { error: "offline" },
          codex: { personal: { status: "expired", fetchedAt } },
        }),
      );
      const list = { ...accounts, codex: accounts.claude };
      const providers = submenu(buildAccountsMenu(list, () => {}, usage));
      assert.equal(submenu(providers[0])[0]?.label, "Personal (Max)");
      assert.equal(submenu(providers[1])[0]?.label, "Personal (Max) — login expired");
    }),
  );

  it.effect("refreshes usage independently, coalesces requests and hides failures", () =>
    Effect.gen(function* () {
      using _exists = vi.spyOn(NodeFS, "existsSync").mockReturnValue(true);
      type UsageReply = (stdout: string, error?: NodeChildProcess.ExecFileException) => void;
      const pending = yield* Queue.make<UsageReply>();
      const rebuilt = yield* Queue.make<Electron.MenuItemConstructorOptions | undefined>();
      const mainWindow = {} as Electron.BrowserWindow;
      let focus = () => {};
      let list = accounts;
      let activeUsage = 0;
      let usageCalls = 0;
      using execute = vi
        .spyOn(NodeChildProcess, "execFile")
        .mockImplementation((_file, args, options, callback) => {
          const command = args?.[1];
          if (command === "usage") {
            assert.equal(options?.timeout, 20_000);
            activeUsage++;
            usageCalls++;
            assert.equal(activeUsage, 1);
            Queue.offerUnsafe(pending, (stdout, error) => {
              activeUsage--;
              callback?.(error ?? null, stdout, "");
            });
          } else if (command === "list") {
            callback?.(null, JSON.stringify(list), "");
          } else if (command === "switch") {
            list = { ...accounts, claude: { ...accounts.claude, activeId: "work" } };
            callback?.(
              null,
              JSON.stringify({
                ok: true,
                provider: "claude",
                profile: { id: "work", name: "Work" },
                alreadyActive: true,
              }),
              "",
            );
          } else {
            assert.fail(`Unexpected CLI command: ${command}`);
          }
          return new NodeChildProcess.ChildProcess();
        });
      const menu = yield* make;
      const rebuild = Effect.gen(function* () {
        yield* Queue.offer(rebuilt, yield* menu.template);
      });
      yield* menu.watch(rebuild).pipe(
        Effect.provideService(ElectronApp.ElectronApp, {
          ...ElectronApp.make,
          on: (_event, listener) =>
            Effect.sync(() => {
              focus = () => Reflect.apply(listener, undefined, [{}, mainWindow]);
            }),
        }),
        Effect.provideService(ElectronWindow.ElectronWindow, {
          create: () => Effect.die("unexpected create"),
          main: Effect.succeedSome(mainWindow),
          currentMainOrFirst: Effect.succeedNone,
          focusedMainOrFirst: Effect.succeedNone,
          setMain: () => Effect.void,
          clearMain: () => Effect.void,
          prepareReveal: () => Effect.succeed(false),
          reveal: () => Effect.void,
          sendAll: () => Effect.void,
          destroyAll: Effect.void,
          syncAllAppearance: () => Effect.void,
        }),
        Effect.provideService(ElectronDialog.ElectronDialog, {
          ...ElectronDialog.make,
          showErrorBox: () => Effect.die("usage must never open a dialog"),
        }),
        Effect.provideService(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected createMain"),
          ensureMain: Effect.die("unexpected ensureMain"),
          revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
          activate: Effect.void,
          createMainIfBackendReady: Effect.void,
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          prepareCaptureReveal: Effect.void,
          dispatchMenuAction: () => Effect.void,
          dispatchSnapShotEvent: () => Effect.void,
          zoomMain: () => Effect.void,
          runMainContentsCommand: () => Effect.void,
          syncAppearance: Effect.void,
        }),
      );
      const initial = yield* menu.template;
      assert.equal(submenu(submenu(initial)[0])[0]?.label, "Personal (Max)");
      const first = yield* Queue.take(pending);
      submenu(submenu(initial)[0])[1]?.click?.(
        {} as Electron.MenuItem,
        undefined,
        {} as Electron.KeyboardEvent,
      );
      const switched = yield* Queue.take(rebuilt);
      assert.isTrue(submenu(submenu(switched)[0])[1]?.checked);
      assert.equal(activeUsage, 1);
      // The focus refresh and switch must request one follow-up, even while usage is pending.
      focus();
      yield* TestClock.adjust("2 seconds");
      assert.equal(usageCalls, 1);
      const usage = {
        ok: true,
        claude: {
          personal: {
            status: "ok",
            fetchedAt: "2026-10-30T10:00:00Z",
            windows: [{ kind: "session", leftPercent: 70 }],
          },
        },
        codex: {},
      };
      first(JSON.stringify(usage));
      const updated = yield* Queue.take(rebuilt);
      assert.equal(submenu(submenu(updated)[0])[0]?.label, "Personal (Max) — 5h 70% left");
      const second = yield* Queue.take(pending);
      assert.equal(usageCalls, 2);
      second(
        JSON.stringify({
          ...usage,
          claude: {
            personal: { ...usage.claude.personal, fetchedAt: "2026-10-30T10:01:00Z" },
          },
        }),
      );
      focus();
      yield* TestClock.adjust("2 seconds");
      const third = yield* Queue.take(pending);
      assert.equal(yield* Queue.size(rebuilt), 0);
      third("", { killed: true } as NodeChildProcess.ExecFileException);
      const failed = yield* Queue.take(rebuilt);
      assert.equal(submenu(submenu(failed)[0])[0]?.label, "Personal (Max)");
      assert.equal(execute.mock.calls.filter((call) => call[1]?.[1] === "usage").length, 3);
    }).pipe(Effect.scoped, Effect.provide(layerEnvironment)),
  );

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
      for (const command of ["list", "switch", "save", "usage"] as const) {
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
        ["usage", "not JSON", 0, "invalid JSON"],
        ["usage", '{"ok":true,"claude":{}}', 0, "invalid usage response"],
        ["usage", '{"ok":true,"claude":{},"codex":{}}', 1, "exited with code 1"],
      ] as const) {
        const error = yield* decodeCliOutput(command, stdout, exitCode).pipe(Effect.flip);
        assert.include(error.message, message);
      }
    }),
  );
});
