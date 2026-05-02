param(
  [Parameter(Mandatory = $true)]
  [string]$Task,

  [string[]]$ContextFiles = @(),

  [string]$Workspace = (Resolve-Path ".").Path,

  [string]$CodexPath = "",

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Resolve-CodexPath {
  param([string]$ExplicitPath)

  if ($ExplicitPath -and (Test-Path -LiteralPath $ExplicitPath)) {
    return (Resolve-Path -LiteralPath $ExplicitPath).Path
  }

  $command = Get-Command codex -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $antigravityCodex = Join-Path $env:USERPROFILE ".antigravity\extensions\openai.chatgpt-26.422.71525-win32-x64\bin\windows-x86_64\codex.exe"
  if (Test-Path -LiteralPath $antigravityCodex) {
    return $antigravityCodex
  }

  throw "Codex CLI was not found. Pass -CodexPath or add codex to PATH."
}

function Assert-SafeContextFile {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $normalized = $Path.Replace("/", "\").ToLowerInvariant()
  $name = [System.IO.Path]::GetFileName($normalized)

  if ($name -eq ".env" -or $normalized.EndsWith("\.env") -or $normalized.Contains("\.env.")) {
    throw "Refusing to pass secret-like context file: $Path"
  }

  if ($normalized.Contains("secret") -or $normalized.Contains("private_key") -or $normalized.Contains("apikey") -or $normalized.Contains("api_key")) {
    throw "Refusing to pass secret-like context file: $Path"
  }
}

$codex = Resolve-CodexPath -ExplicitPath $CodexPath
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$outDir = Join-Path $workspacePath ".agent\codex-requests"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$promptPath = Join-Path $outDir "codex-request-$timestamp.md"
$responsePath = Join-Path $outDir "codex-response-$timestamp.md"

$contextBlock = New-Object System.Collections.Generic.List[string]
foreach ($file in $ContextFiles) {
  Assert-SafeContextFile -Path $file
  $fullPath = Join-Path $workspacePath $file
  if (-not (Test-Path -LiteralPath $fullPath)) {
    $contextBlock.Add("## Missing context file: $file")
    continue
  }

  $content = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
  $contextBlock.Add("## Context: $file`n`n``````text`n$content`n``````")
}

$prompt = @"
You are Codex CLI working as the specialist agent in an Antigravity Orchestra workflow.

Repository root: $workspacePath

Task:
$Task

Rules:
- Do not read, print, or request `.env`.
- Keep live trading safety gates conservative.
- Do not claim guaranteed or stable profit.
- Prefer reproducible data, deterministic tests, and explicit risk controls.
- If code changes are needed, keep them scoped and run the narrowest useful verification.
- End with CODEX_ORCHESTRA_STATUS.

$($contextBlock -join "`n`n")
"@

Set-Content -LiteralPath $promptPath -Value $prompt -Encoding UTF8

if ($DryRun) {
  Write-Host "Dry run complete. Codex was not invoked."
  Write-Host "Codex path: $codex"
  Write-Host "Codex request: $promptPath"
  exit 0
}

$promptInput = Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8
$promptInput | & $codex exec --cd $workspacePath --sandbox workspace-write --output-last-message $responsePath -
$exitCode = $LASTEXITCODE

Write-Host "Codex request: $promptPath"
Write-Host "Codex response: $responsePath"
exit $exitCode
