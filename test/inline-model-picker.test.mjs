import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = platform() === "win32";

const INLINE_PICKER_CALLBACK_V093 =
  "Gz=Z9.useCallback(()=>{if(D0.length<=1)return;let HR=NR().getModelPolicy();if(!D0.some((T9)=>rM(T9,HR).allowed))return;S9((T9)=>!T9)},[D0])";
const INLINE_PICKER_VIEW_V093 =
  "eC?pA.jsxDEV(OD0,{availableModels:D0,currentModel:yT().isSpecMode()&&yT().hasSpecModeModel()?iT||XE:XE,onSelect:dI,onCancel:()=>S9(!1)},void 0,!1,void 0,this):Nz";
const FULL_SELECTOR_VIEW_V093 =
  'S0?pA.jsxDEV(XvD,{currentModel:yT().getModel(),currentReasoningEffort:yT().getReasoningEffort(),onSelect:async(HR)=>{let RA=1},onCancel:()=>{e0(!1),IL(!1),UE.current?.closeSuggestions?.(),UE.current?.setInput?.("")}},void 0,!1,void 0,this):UI';

const INLINE_PICKER_CALLBACK_V098 =
  "rw=X9.useCallback(()=>{if(vJ.length<=1)return;let qR=MR().getModelPolicy();if(!vJ.some((aA)=>ZF(aA,qR).allowed))return;XT((aA)=>!aA)},[vJ])";
const INLINE_PICKER_VIEW_V098 =
  "GT?B9.jsxDEV(VpL,{availableModels:vJ,currentModel:xT().isSpecMode()&&xT().hasSpecModeModel()?ck||LN:LN,onSelect:i3,onCancel:()=>XT(!1)},void 0,!1,void 0,this):Xu";
const FULL_SELECTOR_VIEW_V098 =
  'R8?B9.jsxDEV(CDH,{currentModel:xT().getModel(),currentReasoningEffort:xT().getReasoningEffort(),onSelect:async(qR)=>{let aA=1},onCancel:()=>{QT(!1),WB(!1),w7.current?.closeSuggestions?.(),w7.current?.setInput?.("")}},void 0,!1,void 0,this):v9';

const INLINE_PICKER_CALLBACK_V099 =
  "eE=M9.useCallback(()=>{if(xh.length<=1)return;let qR=wR().getModelPolicy();if(!xh.some((B9)=>kF(B9,qR).allowed))return;ET((B9)=>!B9)},[xh])";
const INLINE_PICKER_VIEW_V099 =
  "_8?A9.jsxDEV(LmL,{availableModels:xh,currentModel:xT().isSpecMode()&&xT().hasSpecModeModel()?hM||s3:s3,onSelect:NM,onCancel:()=>ET(!1)},void 0,!1,void 0,this):rk";
const FULL_SELECTOR_VIEW_V099 =
  'n0?A9.jsxDEV(ILH,{currentModel:xT().getModel(),currentReasoningEffort:xT().getReasoningEffort(),onSelect:async(qR)=>{let IA=1},onCancel:()=>{FL(!1),v9(!1),O4.current?.closeSuggestions?.(),O4.current?.setInput?.("")}},void 0,!1,void 0,this):Q0';

async function runCliDryRunWithInlinePicker(binaryMarker, version) {
  const dir = await mkdtemp(join(tmpdir(), "droid-patch-inline-picker-"));
  const fakeDroidPath = join(dir, IS_WINDOWS ? "droid.cmd" : "droid");
  const cliPath = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  const script = IS_WINDOWS
    ? `@echo off
if "%~1"=="--version" (
  echo ${version}
  exit /b 0
)
echo noop
rem ${binaryMarker}
`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '${version}\\n'
  exit 0
fi
printf 'noop\\n'
# ${binaryMarker}
`;

  await writeFile(fakeDroidPath, script, "utf8");
  if (!IS_WINDOWS) {
    await chmod(fakeDroidPath, 0o755);
  }

  return execFileAsync(
    process.execPath,
    [cliPath, "--is-custom", "-p", fakeDroidPath, "--dry-run", "droid-test"],
    { cwd: join(fileURLToPath(new URL("..", import.meta.url))) },
  );
}

void test("inline model picker patch still applies for 0.93.0", async () => {
  const { stdout } = await runCliDryRunWithInlinePicker(
    `${INLINE_PICKER_CALLBACK_V093}\n${INLINE_PICKER_VIEW_V093}\n${FULL_SELECTOR_VIEW_V093}\nisCustom:!0`,
    "0.93.0",
  );

  assert.match(stdout, /\[\*\] Checking patch: inlineModelPickerUsesFullSelector/);
  assert.match(stdout, /inlineModelPickerUsesFullSelector: 1 occurrences will be patched/);
});

void test("inline model picker semantic patch applies for 0.98.0", async () => {
  const { stdout } = await runCliDryRunWithInlinePicker(
    `${INLINE_PICKER_CALLBACK_V098}\n${INLINE_PICKER_VIEW_V098}\n${FULL_SELECTOR_VIEW_V098}\nisCustom:!0`,
    "0.98.0",
  );

  assert.match(stdout, /\[\*\] Checking patch: inlineModelPickerUsesFullSelector/);
  assert.match(stdout, /inlineModelPickerUsesFullSelector: 1 occurrences will be patched/);
});

void test("inline model picker semantic patch applies for 0.99.0", async () => {
  const { stdout } = await runCliDryRunWithInlinePicker(
    `${INLINE_PICKER_CALLBACK_V099}\n${INLINE_PICKER_VIEW_V099}\n${FULL_SELECTOR_VIEW_V099}\nisCustom:!0`,
    "0.99.0",
  );

  assert.match(stdout, /\[\*\] Checking patch: inlineModelPickerUsesFullSelector/);
  assert.match(stdout, /inlineModelPickerUsesFullSelector: 1 occurrences will be patched/);
});

void test("inline model picker patch stays hidden when full selector context is missing", async () => {
  const { stdout } = await runCliDryRunWithInlinePicker(
    `${INLINE_PICKER_CALLBACK_V099}\n${INLINE_PICKER_VIEW_V099}\nisCustom:!0`,
    "0.99.0",
  );

  assert.doesNotMatch(stdout, /inlineModelPickerUsesFullSelector/);
  assert.match(stdout, /\[\*\] Checking patch: isCustom/);
});
