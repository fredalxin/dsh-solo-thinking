param(
  [string]$Version = 'latest',
  [string]$Profile = 'web',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Repo = 'fredalxin/dsh-solo-thinking'
$Package = 'dsh-plugin-solo-thinking'
$SidebarPackage = 'dsh-better-sidebar'
$SidebarVersion = '^0.12.1'

function Get-ReleaseFile([string]$Uri, [string]$OutFile) {
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing $Uri -OutFile $OutFile
      return
    } catch {
      if ($Attempt -eq 3) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required by DSH'
}

if ($Version -eq 'latest') {
  $Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  $Tag = [string]$Release.tag_name
  if ([string]::IsNullOrWhiteSpace($Tag)) {
    throw 'Latest GitHub Release has no tag'
  }
} else {
  $Tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
}

$ReleaseVersion = $Tag.TrimStart('v')
$Asset = "$Package-$ReleaseVersion.tgz"
$Url = "https://github.com/$Repo/releases/download/$Tag/$Asset"
$ChecksumUrl = "$Url.sha256"

if (Get-Command dsh -ErrorAction SilentlyContinue) {
  $Executable = 'dsh'
  $BaseArgs = @()
} elseif (Get-Command npx -ErrorAction SilentlyContinue) {
  $Executable = 'npx'
  $BaseArgs = @('-y', '--package', '@deepseek-ai/dsh', 'dsh')
} else {
  throw 'dsh or npx is required; install DSH first'
}

Write-Host "[install] $Package $Tag into DSH profile $Profile" -ForegroundColor Green
Write-Host "[install] source: $Url" -ForegroundColor Green

$InstallArgs = $BaseArgs + @('plugin', '--profile', $Profile, 'add', $Url)
if ($DryRun) {
  Write-Host '[dry-run] prepare the profile for node-pty/protobufjs builds'
  Write-Host "[dry-run] install sidebar: $Executable $($BaseArgs + @('plugin', '--profile', $Profile, 'add', "$SidebarPackage@$SidebarVersion") -join ' ')"
  Write-Host "[dry-run] download $Url and $ChecksumUrl"
  Write-Host "[dry-run] verify SHA-256, then run: $Executable $($InstallArgs -join ' ')"
  exit 0
}

$DshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh' } else { Join-Path $HOME '.dsh' }
$ProfileDir = Join-Path $DshRoot "profiles\$Profile"
$WorkspaceFile = Join-Path $ProfileDir 'pnpm-workspace.yaml'
if (-not (Test-Path $WorkspaceFile)) {
  throw "DSH profile $Profile is not initialized; run dsh --profile $Profile once, then retry"
}

$WorkspaceText = Get-Content -Raw $WorkspaceFile
$WorkspaceText = [regex]::Replace($WorkspaceText, '(?m)^(\s*)(node-pty|protobufjs):.*$', '$1$2: true')
if ($WorkspaceText -notmatch '(?m)^\s*allowBuilds:\s*$') {
  $WorkspaceText += "`nallowBuilds:`n  node-pty: true`n  protobufjs: true`n"
} else {
  foreach ($BuildPackage in @('node-pty', 'protobufjs')) {
    if ($WorkspaceText -notmatch "(?m)^\s*$([regex]::Escape($BuildPackage)):\s*true\s*$") {
      $Rule = [regex]::new('(?m)^(\s*allowBuilds:\s*)$')
      $WorkspaceText = $Rule.Replace($WorkspaceText, "`$1`n  ${BuildPackage}: true", 1)
    }
  }
}
if ($WorkspaceText -notmatch '(?m)^\s*-\s+dsh-better-sidebar\s*$') {
  if ($WorkspaceText -match '(?m)^\s*minimumReleaseAgeExclude:\s*$') {
    $Rule = [regex]::new('(?m)^(\s*minimumReleaseAgeExclude:\s*)$')
    $WorkspaceText = $Rule.Replace($WorkspaceText, "`$1`n  - dsh-better-sidebar", 1)
  } else {
    $WorkspaceText += "`nminimumReleaseAgeExclude:`n  - dsh-better-sidebar`n"
  }
}
Set-Content -LiteralPath $WorkspaceFile -Value $WorkspaceText -NoNewline

$SidebarArgs = $BaseArgs + @('plugin', '--profile', $Profile, 'add', "$SidebarPackage@$SidebarVersion")
Write-Host "[install] mounting $SidebarPackage $SidebarVersion" -ForegroundColor Green
& $Executable @SidebarArgs
if ($LASTEXITCODE -ne 0) {
  throw "Better Sidebar installation failed with exit code $LASTEXITCODE"
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-solo-thinking-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir | Out-Null
$Tarball = Join-Path $TempDir $Asset
$ChecksumFile = "$Tarball.sha256"

try {
  Get-ReleaseFile $Url $Tarball
  Get-ReleaseFile $ChecksumUrl $ChecksumFile
  $Expected = ((Get-Content -Raw $ChecksumFile).Trim() -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Tarball).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) {
    throw "SHA-256 mismatch for $Asset"
  }

  $InstallArgs = $BaseArgs + @('plugin', '--profile', $Profile, 'add', $Tarball)
  & $Executable @InstallArgs
  if ($LASTEXITCODE -ne 0) {
    throw "DSH plugin installation failed with exit code $LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$DumpArgs = $BaseArgs + @('--profile', $Profile, '--dump-config')
$Config = (& $Executable @DumpArgs | Out-String)
if ($LASTEXITCODE -ne 0 -or $Config -notmatch "name:\s+$([regex]::Escape($Package))") {
  throw "$Package is not mounted in the composed profile"
}
if ($Config -notmatch "name:\s+$([regex]::Escape($SidebarPackage))") {
  throw "$SidebarPackage is not mounted in the composed profile"
}

Write-Host "[install] verified: $Package and $SidebarPackage are mounted" -ForegroundColor Green
Write-Host '[install] restart DSH, then hard-refresh the browser (Ctrl+Shift+R)' -ForegroundColor Green
