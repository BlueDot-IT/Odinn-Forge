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
// before the reviewed trust-boundary script runs. Keep this list explicit so
// generated batch files can clear the hooks before starting .NET.
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

// PowerShell command discovery can auto-load a same-named attacker module from
// PSModulePath even with -NoProfile. Clear it in cmd.exe before PowerShell
// starts; clearing it from inside the child is too late for startup/module
// initializers. Trust-boundary operations below also use direct .NET APIs and
// therefore do not depend on module or function resolution.
export const HOSTILE_WINDOWS_POWERSHELL_ENVIRONMENT_VARIABLES = [
  "PSModulePath"
] as const;

export const HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES = [
  ...HOSTILE_NODE_ENVIRONMENT_VARIABLES,
  ...HOSTILE_WINDOWS_DOTNET_ENVIRONMENT_VARIABLES,
  ...HOSTILE_WINDOWS_POWERSHELL_ENVIRONMENT_VARIABLES
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
export const WINDOWS_PHYSICAL_PATH_ASSERTION = "function Assert-OdinnPhysicalPath([string]$PathValue){$full=[System.IO.Path]::GetFullPath($PathValue);$root=[System.IO.Path]::GetPathRoot($full);if([string]::IsNullOrEmpty($root)){throw 'Odinn path has no physical root'};$cursor=$root;foreach($part in ($full.Substring($root.Length) -split '[\\\\/]')){if(!$part){continue};$cursor=[System.IO.Path]::Combine($cursor,$part);$attributes=[System.IO.File]::GetAttributes($cursor);if(($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Odinn path contains a reparse point'}}}";
export const WINDOWS_SHA256_ASSERTION = "function Get-OdinnSha256([string]$PathValue){$stream=[System.IO.File]::Open($PathValue,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);try{$algorithm=[System.Security.Cryptography.SHA256]::Create();if($null -eq $algorithm){throw 'Odinn SHA-256 implementation is unavailable'};try{[byte[]]$digest=$algorithm.ComputeHash($stream)}finally{$algorithm.Dispose()}}finally{$stream.Dispose()};if($digest.Length -ne 32){throw 'Odinn SHA-256 result length is invalid'};$hex=[System.BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant();if($hex.Length -ne 64 -or $hex -cnotmatch '^[a-f0-9]{64}$'){throw 'Odinn SHA-256 result is invalid'};return $hex}";
export const WINDOWS_RUNTIME_TRUST_ASSERTIONS = `${WINDOWS_PHYSICAL_PATH_ASSERTION};${WINDOWS_SHA256_ASSERTION}`;

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
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${clears}\r\nset "ROOT=%~dp0.."\r\nset "RUNTIME_DIR=%ROOT%\\runtime"\r\nset "NODE=%RUNTIME_DIR%\\node.exe"\r\nset "ODINN_EXPECTED_RUNTIME_SHA256=${executableSha256}"\r\nset "ODINN_POWERSHELL=${WINDOWS_POWERSHELL}"\r\nif not exist "%ODINN_POWERSHELL%" (echo Trusted PowerShell is unavailable 1>&2 & exit /b 126)\r\n"%ODINN_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${WINDOWS_RUNTIME_TRUST_ASSERTIONS};Assert-OdinnPhysicalPath $env:ROOT;Assert-OdinnPhysicalPath $env:RUNTIME_DIR;Assert-OdinnPhysicalPath $env:NODE;$attributes=[System.IO.File]::GetAttributes($env:NODE);if(($attributes -band [System.IO.FileAttributes]::Directory) -ne 0){exit 126};if((Get-OdinnSha256 $env:NODE) -cne $env:ODINN_EXPECTED_RUNTIME_SHA256){exit 126}"\r\nif errorlevel 1 (echo Odinn embedded runtime identity check failed 1>&2 & exit /b 126)\r\n"%NODE%" "%ROOT%\\${entry.replaceAll("/", "\\")}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

export function standaloneWindowsInstaller(entry: string, executableSha256: string): string {
  assertDigest(executableSha256);
  const clears = HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES.map((name) => `set "${name}="`).join("\r\n");
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${clears}\r\nset "ROOT=%~dp0.."\r\nset "RUNTIME_DIR=%ROOT%\\runtime"\r\nset "NODE=%RUNTIME_DIR%\\node.exe"\r\nset "ODINN_EXPECTED_RUNTIME_SHA256=${executableSha256}"\r\nset "ODINN_POWERSHELL=${WINDOWS_POWERSHELL}"\r\nif not exist "%ODINN_POWERSHELL%" (echo Trusted PowerShell is unavailable 1>&2 & exit /b 126)\r\n"%ODINN_POWERSHELL%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${WINDOWS_RUNTIME_TRUST_ASSERTIONS};Assert-OdinnPhysicalPath $env:ROOT;Assert-OdinnPhysicalPath $env:RUNTIME_DIR;Assert-OdinnPhysicalPath $env:NODE;$attributes=[System.IO.File]::GetAttributes($env:NODE);if(($attributes -band [System.IO.FileAttributes]::Directory) -ne 0){exit 126};if((Get-OdinnSha256 $env:NODE) -cne $env:ODINN_EXPECTED_RUNTIME_SHA256){exit 126}"\r\nif errorlevel 1 (echo Odinn embedded runtime identity check failed 1>&2 & exit /b 126)\r\n"%NODE%" "%ROOT%\\${entry.replaceAll("/", "\\")}" install --source "%ROOT%" %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

export function standalonePowerShellInstaller(entry: string, executableSha256: string): string {
  assertDigest(executableSha256);
  const clears = HOSTILE_WINDOWS_RUNTIME_ENVIRONMENT_VARIABLES.map((name) => `$env:${name} = $null`).join("\r\n");
  return `param([string]$Prefix = "$HOME/.local/share/odinn")\r\n${clears}\r\n$Root = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($MyInvocation.MyCommand.Path))\r\n$RuntimeDirectory = [System.IO.Path]::Combine($Root, "runtime")\r\n$Node = [System.IO.Path]::Combine($RuntimeDirectory, "node.exe")\r\n${WINDOWS_RUNTIME_TRUST_ASSERTIONS}\r\nAssert-OdinnPhysicalPath $Root\r\nAssert-OdinnPhysicalPath $RuntimeDirectory\r\nAssert-OdinnPhysicalPath $Node\r\n$Attributes = [System.IO.File]::GetAttributes($Node)\r\nif (($Attributes -band [System.IO.FileAttributes]::Directory) -ne 0 -or (Get-OdinnSha256 $Node) -cne "${executableSha256}") { throw "Odinn embedded runtime identity check failed" }\r\n& $Node "$Root\\${entry.replaceAll("/", "\\")}" install --source "$Root" --prefix "$Prefix" @args\r\nexit $LASTEXITCODE\r\n`;
}
