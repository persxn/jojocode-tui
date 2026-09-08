<#
  install.ps1 - set up everything needed to run `jojo` on Windows.

      irm https://ai.jojocode.in/install.ps1 | iex

  Turnkey: installs Python if missing (winget), installs the TUI into a private
  venv (pulls in windows-curses), adds a `jojo` shim to your PATH, installs
  Ollama (winget), and pulls a model that fits this machine. No admin rights;
  winget handles the package installs.

  Env overrides:
    $env:JOJO_TUI_SOURCE     pip target (default: PyPI, then the git repo)
    $env:JOJO_ENDPOINT       helper-script host (default https://ai.jojocode.in)
    $env:JOJO_NO_OLLAMA=1    install the TUI only; skip Ollama + model
    $env:JOJO_MODEL=<tag>    pull this model instead of the auto-recommended one
#>
$ErrorActionPreference = 'Stop'

$Endpoint = if ($env:JOJO_ENDPOINT) { $env:JOJO_ENDPOINT } else { 'https://ai.jojocode.in' }
$Prefix   = Join-Path $env:LOCALAPPDATA 'jojocode-ai'
$Venv     = Join-Path $Prefix 'venv'
$BinDir   = Join-Path $Prefix 'bin'
$RepoPip  = 'jojocode-ai-tui @ git+https://github.com/persxn/jojocode-tui.git#subdirectory=tui'

function Step($m) { Write-Host "`n> $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Error "install: $m"; exit 1 }

function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Resolve a Python >= 3.9 launcher, searching PATH then the usual winget/Store paths.
function Find-Python {
  foreach ($cand in @('py -3', 'python3', 'python')) {
    $exe, $rest = $cand.Split(' ', 2)
    if (Have $exe) {
      try {
        $v = & $exe $rest -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>$null
        if ($v -and [version]$v -ge [version]'3.9') { return $cand }
      } catch { }
    }
  }
  foreach ($p in @(
      "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
      "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
      "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
      "$env:ProgramFiles\Python313\python.exe",
      "$env:ProgramFiles\Python312\python.exe")) {
    if (Test-Path $p) { return "`"$p`"" }
  }
  return $null
}

# --- 1. Python ---------------------------------------------------------
Step 'Python'
$py = Find-Python
if (-not $py) {
  if (-not (Have winget)) {
    Die "need Python >= 3.9 and winget is not available.`n  Install Python from https://www.python.org/downloads/ and re-run."
  }
  Write-Host '  not found - installing via winget'
  winget install --id Python.Python.3.12 -e --silent --accept-source-agreements --accept-package-agreements --scope user
  # winget does not refresh this process's PATH; re-resolve from disk.
  $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')
  $py = Find-Python
}
if (-not $py) { Die 'Python installed but could not be located - open a new terminal and re-run.' }
$pyExe, $pyRest = $py.Split(' ', 2)
Write-Host "  $py  ($(& $pyExe $pyRest --version 2>&1))"

# --- 2. venv + the TUI ---------------------------------------------
Step 'The TUI'
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) {
  & $pyExe $pyRest -m venv $Venv
}
$vpy = Join-Path $Venv 'Scripts\python.exe'
& $vpy -m pip install --quiet --upgrade pip | Out-Null
$src = if ($env:JOJO_TUI_SOURCE) { $env:JOJO_TUI_SOURCE } else { 'jojocode-ai-tui' }
$ok = $true
try { & $vpy -m pip install --quiet $src } catch { $ok = $false }
if (-not $ok) {
  Write-Host '  installing from the git repo'
  & $vpy -m pip install --quiet $RepoPip
}
Write-Host "  $(& (Join-Path $Venv 'Scripts\jojo.exe') --version 2>&1)"

# --- 3. shim + PATH ----------------------------------------------
Step 'Launcher'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
"@echo off`r`n`"$Venv\Scripts\jojo.exe`" %*" | Set-Content -Encoding ascii (Join-Path $BinDir 'jojo.cmd')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
  $env:Path += ";$BinDir"
  Write-Host "  added $BinDir to your user PATH (open a new terminal to pick it up)"
}

# --- 4. Ollama + a model ---------------------------------------
if ($env:JOJO_NO_OLLAMA -eq '1') {
  Step 'Skipping Ollama (JOJO_NO_OLLAMA=1)'
} else {
  Step 'Ollama'
  if (Have ollama) {
    Write-Host "  already installed"
  } elseif (Have winget) {
    winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')
  } else {
    Warn 'winget not found - install Ollama from https://ollama.com/download/windows'
  }
  if (Have ollama) {
    # make sure the server is up
    if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) {
      Start-Process -WindowStyle Hidden ollama -ArgumentList 'serve'
      Start-Sleep -Seconds 3
    }
    Step 'Model'
    $rec = Join-Path $env:TEMP 'jojo-recommend-model.py'
    Invoke-WebRequest -UseBasicParsing "$Endpoint/recommend-model.py" -OutFile $rec
    if ($env:JOJO_MODEL) { & $vpy $rec --model $env:JOJO_MODEL --pull --yes }
    else { & $vpy $rec --pull --yes }
  }
}

Write-Host @"

[ready]  Start it in any project directory:

    jojo
    jojo --model gpt-oss:20b
    jojo --remote https://ai.jojocode.in --login

  Update:  & "$vpy" -m pip install -U jojocode-ai-tui
  Remove:  Remove-Item -Recurse -Force "$Prefix"   (and drop $BinDir from PATH)
"@ -ForegroundColor Green
