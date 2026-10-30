// @effect-diagnostics nodeBuiltinImport:off -- This desktop boundary runs the external account-switch CLI with Electron's Node runtime.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const Provider = Schema.Literals(["claude", "codex"]);
type Provider = typeof Provider.Type;
const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
});
const ProviderFailure = Schema.Struct({ error: Schema.String });
const ProviderAccounts = Schema.Union([
  Schema.Struct({
    activeId: Schema.NullOr(Schema.String),
    current: Schema.Struct({
      loggedIn: Schema.Boolean,
      email: Schema.optional(Schema.String),
      plan: Schema.optional(Schema.String),
    }),
    profiles: Schema.Array(Profile),
  }),
  ProviderFailure,
]);
const AccountsList = Schema.Struct({
  ok: Schema.Literal(true),
  claude: ProviderAccounts,
  codex: ProviderAccounts,
});
const accountsEqual = Schema.toEquivalence(Schema.NullOr(AccountsList));
const UsageWindow = Schema.Struct({
  kind: Schema.Literals(["session", "weekly"]),
  leftPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(Schema.String),
});
const decodeUsageWindow = Schema.decodeUnknownOption(UsageWindow);
const decodeUsageOk = Schema.decodeUnknownOption(
  Schema.Struct({
    status: Schema.Literal("ok"),
    fetchedAt: Schema.String,
    windows: Schema.Array(Schema.Unknown),
  }),
);
const isUsageExpired = Schema.is(
  Schema.Struct({ status: Schema.Literal("expired"), fetchedAt: Schema.String }),
);
const ProviderUsage = Schema.Union([ProviderFailure, Schema.Record(Schema.String, Schema.Unknown)]);
const AccountsUsage = Schema.Struct({
  ok: Schema.Literal(true),
  claude: ProviderUsage,
  codex: ProviderUsage,
});

function usageLabel(usage: unknown): string {
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Account usage labels require this separator.
  if (isUsageExpired(usage)) return " — login expired";
  const ok = decodeUsageOk(usage);
  if (Option.isNone(ok)) return "";
  const windows = ok.value.windows.flatMap((window) => {
    const decoded = decodeUsageWindow(window);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  if (windows.length === 0) return "";
  const label = windows
    .map((window) => `${window.kind === "session" ? "5h" : "wk"} ${window.leftPercent}%`)
    .join(" · ");
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Account usage labels require this separator.
  return ` — ${label} left`;
}

const UsageLabels = Schema.Struct({
  claude: Schema.Record(Schema.String, Schema.String),
  codex: Schema.Record(Schema.String, Schema.String),
});
const usageEqual = Schema.toEquivalence(UsageLabels);
function usageLabels(usage: typeof AccountsUsage.Type | null): typeof UsageLabels.Type {
  const labels = (provider: typeof ProviderUsage.Type) =>
    "error" in provider
      ? {}
      : Object.fromEntries(
          Object.entries(provider).flatMap(([id, value]) => {
            const label = usageLabel(value);
            return label ? [[id, label]] : [];
          }),
        );
  return usage === null
    ? { claude: {}, codex: {} }
    : { claude: labels(usage.claude), codex: labels(usage.codex) };
}
const SwitchResult = Schema.Struct({
  ok: Schema.Literal(true),
  provider: Provider,
  profile: Profile,
  alreadyActive: Schema.Boolean,
});
const SaveResult = Schema.Struct({
  ok: Schema.Literal(true),
  provider: Provider,
  profile: Profile,
  updated: Schema.Boolean,
});
const CliFailure = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });
const responses = {
  list: AccountsList,
  switch: SwitchResult,
  save: SaveResult,
  usage: AccountsUsage,
};
type Command = keyof typeof responses;
type Response<C extends Command> = (typeof responses)[C]["Type"];
type CliOutput = { stdout: string; exitCode: number };
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFailure = Schema.decodeUnknownOption(CliFailure);
const decodeResponses: {
  [C in Command]: (input: unknown) => Effect.Effect<Response<C>, Schema.SchemaError>;
} = {
  list: Schema.decodeUnknownEffect(AccountsList),
  switch: Schema.decodeUnknownEffect(SwitchResult),
  save: Schema.decodeUnknownEffect(SaveResult),
  usage: Schema.decodeUnknownEffect(AccountsUsage),
};

export class DesktopAccountsMenuError extends Schema.TaggedError<DesktopAccountsMenuError>()(
  "DesktopAccountsMenuError",
  { message: Schema.String },
) {}

const accountError = (message: string) => new DesktopAccountsMenuError({ message });

export const decodeCliOutput = Effect.fn("desktop.accounts.decode")(function* <C extends Command>(
  command: C,
  stdout: string,
  exitCode = 0,
) {
  const json = yield* decodeJson(stdout).pipe(
    Effect.mapError(() => accountError("Account switch CLI returned invalid JSON.")),
  );
  const failure = decodeFailure(json);
  if (Option.isSome(failure)) {
    return yield* accountError(failure.value.error);
  }
  if (exitCode !== 0) {
    return yield* accountError(`Account switch CLI exited with code ${exitCode}.`);
  }
  return yield* decodeResponses[command](json).pipe(
    Effect.mapError(() =>
      accountError(`Account switch CLI returned an invalid ${command} response.`),
    ),
  );
});

function profileLabel(profile: typeof Profile.Type) {
  return profile.plan ? `${profile.name} (${profile.plan})` : profile.name;
}

type AccountAction =
  | { readonly command: "switch"; readonly provider: Provider; readonly id: string }
  | { readonly command: "save"; readonly provider: Provider };

export function buildAccountsMenu(
  list: typeof AccountsList.Type | null,
  onAction: (action: AccountAction) => void,
  usage: typeof AccountsUsage.Type | null = null,
): Electron.MenuItemConstructorOptions | undefined {
  if (list === null) return undefined;
  const labels = usageLabels(usage);
  return {
    label: "Accounts",
    submenu: (["claude", "codex"] as const).map((provider) => {
      const accounts = list[provider];
      return {
        label: provider === "claude" ? "Claude" : "Codex",
        submenu:
          "error" in accounts
            ? [{ label: accounts.error, enabled: false }]
            : [
                ...accounts.profiles.map((profile) => ({
                  label: `${profileLabel(profile)}${labels[provider][profile.id] ?? ""}`,
                  type: "checkbox" as const,
                  checked: profile.id === accounts.activeId,
                  click: () => onAction({ command: "switch", provider, id: profile.id }),
                })),
                { type: "separator" as const },
                {
                  label: "Save Current Login",
                  enabled: accounts.current.loggedIn && accounts.activeId === null,
                  click: () => onAction({ command: "save", provider }),
                },
              ],
      };
    }),
  };
}

const runCli = Effect.fn("desktop.accounts.runCli")(function* <C extends Command>(
  path: string,
  command: C,
  args: readonly string[] = [],
) {
  // switch may wait on the lock and then restart Codex's daemon (up to ~10 s).
  const timeout = command === "list" ? 10_000 : 20_000;
  const result = yield* Effect.callback<CliOutput, DesktopAccountsMenuError>((resume) => {
    const child = NodeChildProcess.execFile(
      process.execPath,
      [path, command, ...args, "--json"],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error && (typeof error.code !== "number" || error.killed)) {
          const message = error.killed
            ? `Account switch CLI timed out after ${timeout / 1_000} seconds.`
            : `Could not run account switch CLI: ${error.message}`;
          resume(Effect.fail(accountError(message)));
        } else {
          resume(
            Effect.succeed({ stdout, exitCode: typeof error?.code === "number" ? error.code : 0 }),
          );
        }
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });
  return yield* decodeCliOutput(command, result.stdout, result.exitCode);
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path =
    process.env.T3CODE_ACCOUNT_SWITCH_CLI ??
    environment.path.join(environment.homeDirectory, ".config/claude-switch/cli.mjs");
  const enabled = environment.platform === "darwin" && NodeFS.existsSync(path);
  const mutex = yield* Semaphore.make(1);
  let cached: typeof AccountsList.Type | null = null;
  let initialized = false;
  let cachedUsage: typeof AccountsUsage.Type | null = null;
  let requestUsage = () => {};

  const refresh = Effect.fn("desktop.accounts.refresh")(function* () {
    const next = NodeFS.existsSync(path)
      ? yield* runCli(path, "list").pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ok: true as const,
              claude: { error: error.message },
              codex: { error: error.message },
            }),
          ),
        )
      : null;
    const changed = !accountsEqual(next, cached);
    cached = next;
    initialized = true;
    return changed;
  });

  const watch = Effect.fn("desktop.accounts.watch")(function* (rebuild: Effect.Effect<void>) {
    if (!enabled) return;
    const app = yield* ElectronApp.ElectronApp;
    const windows = yield* ElectronWindow.ElectronWindow;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const runFork = yield* FiberSet.makeRuntime<never, void, never>();
    let pendingRefresh: Fiber.Fiber<void> | undefined;
    const run = (effect: Effect.Effect<void>) =>
      runFork(
        effect.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Accounts menu action failed", cause)),
        ),
      );

    let usageRunning = false;
    let usageRequested = false;
    requestUsage = () => {
      usageRequested = true;
      if (usageRunning) return;
      usageRunning = true;
      run(
        Effect.gen(function* () {
          do {
            usageRequested = false;
            const next = yield* runCli(path, "usage").pipe(
              Effect.catchCause(() => Effect.succeed(null)),
            );
            const changed = !usageEqual(usageLabels(cachedUsage), usageLabels(next));
            cachedUsage = next;
            if (changed) yield* rebuild;
          } while (usageRequested);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              usageRunning = false;
            }),
          ),
        ),
      );
    };

    const apply = Effect.fn("desktop.accounts.applyAction")(function* (action: AccountAction) {
      if (action.command === "switch") {
        const result = yield* runCli(path, "switch", [action.provider, action.id]);
        if (!result.alreadyActive) {
          yield* Effect.sync(() => {
            if (Electron.Notification.isSupported()) {
              new Electron.Notification({
                title: environment.displayName,
                body: `${result.provider === "claude" ? "Claude" : "Codex"}: now ${profileLabel(result.profile)}`,
              }).show();
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not show account notification", cause),
            ),
          );
        }
        yield* desktopWindow.dispatchMenuAction("accounts-switched", { reveal: false });
      } else {
        yield* runCli(path, "save", [action.provider]);
      }
    });

    onAction = (action) =>
      run(
        apply(action).pipe(
          Effect.catch((error) => dialog.showErrorBox("Accounts", error.message)),
          Effect.andThen(refresh()),
          Effect.andThen(rebuild),
          mutex.withPermits(1),
          Effect.tap(() => Effect.sync(requestUsage)),
        ),
      );

    const handleFocus = (_event: Electron.Event, window: Electron.BrowserWindow) => {
      run(
        Effect.gen(function* () {
          const main = yield* windows.main;
          if (Option.isNone(main) || main.value !== window) return;
          if (pendingRefresh) yield* Fiber.interrupt(pendingRefresh);
          pendingRefresh = run(
            Effect.sleep(2_000).pipe(
              Effect.andThen(
                mutex.withPermits(1)(
                  Effect.gen(function* () {
                    if (yield* refresh()) yield* rebuild;
                  }),
                ),
              ),
              Effect.tap(() => Effect.sync(requestUsage)),
            ),
          );
        }),
      );
    };
    yield* app.on("browser-window-focus", handleFocus);
  });

  let onAction: (action: AccountAction) => void = () => {};
  const template = Effect.gen(function* () {
    if (!enabled) return undefined;
    if (!initialized) {
      yield* mutex.withPermits(1)(refresh());
      requestUsage();
    }
    return buildAccountsMenu(cached, (action) => onAction(action), cachedUsage);
  });
  return { template, watch };
});
