param([string]$Prefix = "$HOME/.local/share/odinn")
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Installer = Join-Path $Root "dist/install/install.js"
if (-not (Test-Path -LiteralPath $Installer)) {
  $Installer = Join-Path $Root "scripts/install.ts"
}
& node $Installer install --source $Root --prefix $Prefix @args
exit $LASTEXITCODE
