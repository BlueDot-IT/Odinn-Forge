export const HOSTILE_NODE_ENVIRONMENT_VARIABLES = [
  "NODE_CHANNEL_FD",
  "NODE_COMPILE_CACHE",
  "NODE_COMPILE_CACHE_PORTABLE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REDIRECT_WARNINGS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_UNIQUE_ID",
  "NODE_V8_COVERAGE",
  "OPENSSL_CONF",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE"
] as const;

// Windows PowerShell 5.1 hosts the desktop CLR. These variables can select a
// profiler, startup hook, alternate runtime, JIT, GC, or assembly search root
// before any PowerShell command (including Get-FileHash) runs. Keep this list
// explicit so generated batch files can clear the hooks before starting .NET.
export const HOSTILE_WINDOWS_DOTNET_ENVIRONMENT_VARIABLES = [
  "COMPlus_AltJit",
  "COMPlus_AltJitName",
  "COMPlus_ApplicationMigrationRuntimeActivationConfigPath",
  "COMPlus_EnableProfiling",
  "COMPlus_GCName",
  "COMPlus_GCPath",
  "COMPlus_InstallRoot",
  "COMPlus_JitName",
  "COMPlus_OnlyUseLatestCLR",
  "COMPlus_Profiler",
  "COMPlus_ProfilerPath",
  "COMPlus_ProfilerPath_32",
  "COMPlus_ProfilerPath_64",
  "COMPlus_Version",
  "CORECLR_ENABLE_PROFILING",
  "CORECLR_PROFILER",
  "CORECLR_PROFILER_PATH",
  "CORECLR_PROFILER_PATH_32",
  "CORECLR_PROFILER_PATH_64",
  "COR_ENABLE_PROFILING",
  "COR_PROFILER",
  "COR_PROFILER_PATH",
  "COR_PROFILER_PATH_32",
  "COR_PROFILER_PATH_64",
  "DEVPATH",
  "DOTNET_ADDITIONAL_DEPS",
  "DOTNET_AltJit",
  "DOTNET_AltJitName",
  "DOTNET_GCName",
  "DOTNET_GCPath",
  "DOTNET_HOST_PATH",
  "DOTNET_JitName",
  "DOTNET_MULTILEVEL_LOOKUP",
  "DOTNET_ROOT",
  "DOTNET_ROOT_X64",
  "DOTNET_ROOT_X86",
  "DOTNET_ROLL_FORWARD",
  "DOTNET_ROLL_FORWARD_TO_PRERELEASE",
  "DOTNET_RUNTIME_ID",
  "DOTNET_SHARED_STORE",
  "DOTNET_STARTUP_HOOKS"
] as const;

export const HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES = [
  ...HOSTILE_NODE_ENVIRONMENT_VARIABLES,
  ...HOSTILE_WINDOWS_DOTNET_ENVIRONMENT_VARIABLES
] as const;

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("standalone launcher runtime digest is invalid");
}

function unixDigestCommand(target: "linux-x64" | "darwin-x64"): string {
  return target === "linux-x64"
    ? 'ACTUAL=$(/usr/bin/sha256sum -- "$NODE"); ACTUAL=${ACTUAL%% *}'
    : 'ACTUAL=$(/usr/bin/shasum -a 256 -- "$NODE"); ACTUAL=${ACTUAL%% *}';
}

const WINDOWS_POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_PHYSICAL_PATH_ASSERTION = "function Assert-OdinnPhysicalPath([string]$PathValue){$full=[IO.Path]::GetFullPath($PathValue);$root=[IO.Path]::GetPathRoot($full);$cursor=$root;foreach($part in ($full.Substring($root.Length) -split '[\\\\/]')){if(!$part){continue};$cursor=[IO.Path]::Combine($cursor,$part);$item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Odinn path contains a reparse point'}}}";

export function standaloneUnixLauncher(entry: string, target: "linux-x64" | "darwin-x64", executableSha256: string): string {
  assertDigest(executableSha256);
  return `set -eu
[ "\${ODINN_NATIVE_BOUNDARY-}" = "1" ] || { echo "Ódinn native runtime boundary was bypassed" >&2; exit 126; }
unset ODINN_NATIVE_BOUNDARY
unset ${HOSTILE_NODE_ENVIRONMENT_VARIABLES.join(" ")}
SCRIPT=$0
BIN_DIR=\${SCRIPT%/*}
[ "$BIN_DIR" != "$SCRIPT" ] || { echo "Ódinn launcher path is invalid" >&2; exit 126; }
ROOT=$(CDPATH= cd -- "$BIN_DIR/.." && pwd -P)
NODE="$ROOT/runtime/node"
[ ! -L "$ROOT/runtime" ] && [ ! -L "$NODE" ] && [ -f "$NODE" ] && [ -x "$NODE" ] || { echo "Ódinn embedded runtime is missing, linked, or not executable" >&2; exit 126; }
${unixDigestCommand(target)}
[ "$ACTUAL" = "${executableSha256}" ] || { echo "Ódinn embedded runtime digest mismatch" >&2; exit 126; }
exec "$NODE" "$ROOT/${entry}" "$@"
`;
}

export function standaloneWindowsLauncher(entry: string, executableSha256: string): string {
  assertDigest(executableSha256);
  const clears = HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES.map((name) => `set "${name}="`).join("\r\n");
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${clears}\r\nset "ROOT=%~dp0.."\r\nset "RUNTIME_DIR=%ROOT%\\runtime"\r\nset "NODE=%RUNTIME_DIR%\\node.exe"\r\nset "ODINN_EXPECTED_RUNTIME_SHA256=${executableSha256}"\r\nset "ODINN_POWERSHELL=${WINDOWS_POWERSHELL}"\r\nif not exist "%ODINN_POWERSHELL%" (echo Trusted PowerShell is unavailable 1>&2 & exit /b 126)\r\n"%ODINN_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${WINDOWS_PHYSICAL_PATH_ASSERTION};Assert-OdinnPhysicalPath $env:ROOT;Assert-OdinnPhysicalPath $env:RUNTIME_DIR;Assert-OdinnPhysicalPath $env:NODE;$i=Get-Item -LiteralPath $env:NODE -Force -ErrorAction Stop;if($i.PSIsContainer){exit 126};if((Get-FileHash -LiteralPath $env:NODE -Algorithm SHA256).Hash.ToLowerInvariant() -ne $env:ODINN_EXPECTED_RUNTIME_SHA256){exit 126}"\r\nif errorlevel 1 (echo Odinn embedded runtime identity check failed 1>&2 & exit /b 126)\r\n"%NODE%" "%ROOT%\\${entry.replaceAll("/", "\\")}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

export function standaloneWindowsInstaller(entry: string, executableSha256: string): string {
  assertDigest(executableSha256);
  const clears = HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES.map((name) => `set "${name}="`).join("\r\n");
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${clears}\r\nset "ROOT=%~dp0.."\r\nset "RUNTIME_DIR=%ROOT%\\runtime"\r\nset "NODE=%RUNTIME_DIR%\\node.exe"\r\nset "ODINN_EXPECTED_RUNTIME_SHA256=${executableSha256}"\r\nset "ODINN_POWERSHELL=${WINDOWS_POWERSHELL}"\r\nif not exist "%ODINN_POWERSHELL%" (echo Trusted PowerShell is unavailable 1>&2 & exit /b 126)\r\n"%ODINN_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${WINDOWS_PHYSICAL_PATH_ASSERTION};Assert-OdinnPhysicalPath $env:ROOT;Assert-OdinnPhysicalPath $env:RUNTIME_DIR;Assert-OdinnPhysicalPath $env:NODE;$i=Get-Item -LiteralPath $env:NODE -Force -ErrorAction Stop;if($i.PSIsContainer){exit 126};if((Get-FileHash -LiteralPath $env:NODE -Algorithm SHA256).Hash.ToLowerInvariant() -ne $env:ODINN_EXPECTED_RUNTIME_SHA256){exit 126}"\r\nif errorlevel 1 (echo Odinn embedded runtime identity check failed 1>&2 & exit /b 126)\r\n"%NODE%" "%ROOT%\\${entry.replaceAll("/", "\\")}" install --source "%ROOT%" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

export function standalonePowerShellInstaller(entry: string, executableSha256: string): string {
  assertDigest(executableSha256);
  const clears = HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES.map((name) => `$env:${name} = $null`).join("\r\n");
  return `param([string]$Prefix = "$HOME/.local/share/odinn")\r\n$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)\r\n${clears}\r\n$RuntimeDirectory = Join-Path $Root "runtime"\r\n$Node = Join-Path $RuntimeDirectory "node.exe"\r\n${WINDOWS_PHYSICAL_PATH_ASSERTION}\r\nAssert-OdinnPhysicalPath $Root\r\nAssert-OdinnPhysicalPath $RuntimeDirectory\r\nAssert-OdinnPhysicalPath $Node\r\n$Runtime = Get-Item -LiteralPath $Node -Force\r\nif ($Runtime.PSIsContainer -or (Get-FileHash -LiteralPath $Node -Algorithm SHA256).Hash.ToLowerInvariant() -ne "${executableSha256}") { throw "Odinn embedded runtime identity check failed" }\r\n& $Node "$Root\\${entry.replaceAll("/", "\\")}" install --source "$Root" --prefix "$Prefix" @args\r\nexit $LASTEXITCODE\r\n`;
}
