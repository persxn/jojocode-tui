<#
  Checks install.ps1 without a Windows machine.

      pwsh -NoProfile -File install/test-install-ps1.ps1

  What this can and cannot prove. It parses the script, runs PSScriptAnalyzer
  (when installed) for errors, and executes the installer's own functions under
  the strictest error settings PowerShell 7 has - so the helper that stops pip's
  stderr killing the install is exercised for real. It does NOT run winget, a
  Windows venv or Windows PowerShell 5.1; the first real Windows install is
  still the test that matters. Linux pwsh: ~/.local/opt/pwsh/pwsh.
#>
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'install.ps1'
$fail = 0
function Check($name, $ok) { if ($ok) { "ok   $name" } else { "FAIL $name"; $script:fail++ } }

$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$tokens, [ref]$errors)
Check 'parses with no errors' ($errors.Count -eq 0)
$bytes = [IO.File]::ReadAllBytes($target)
Check 'is plain ASCII (5.1 reads BOM-less files as ANSI)' (-not ($bytes | Where-Object { $_ -gt 127 }))

if (Get-Module -ListAvailable PSScriptAnalyzer) {
  $bad = Invoke-ScriptAnalyzer -Path $target -Severity Error
  Check "PSScriptAnalyzer: no errors ($(@($bad).Count))" (@($bad).Count -eq 0)
  $auto = Invoke-ScriptAnalyzer -Path $target -IncludeRule PSAvoidAssignmentToAutomaticVariable
  Check 'no assignment to automatic variables' (@($auto).Count -eq 0)
} else {
  'skip PSScriptAnalyzer not installed (Install-Module PSScriptAnalyzer -Scope CurrentUser)'
}

# Load the installer's functions without running its body.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
foreach ($f in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($f.Extent.Text))
}

$sh = if ($IsWindows) { 'cmd' } else { 'sh' }
$warn = if ($IsWindows) { @('/c', 'echo out & echo WARNING: new pip 1>&2 & exit /b 0') } else { @('-c', 'echo out; echo "WARNING: new pip" >&2; exit 0') }
$bad3 = if ($IsWindows) { @('/c', 'echo nope 1>&2 & exit /b 3') } else { @('-c', 'echo nope >&2; exit 3') }

$r = Invoke-Native $sh $warn
Check 'stderr + exit 0: no throw, stdout kept' ($r.Code -eq 0 -and "$($r.Out)".Trim() -eq 'out')
$r = Invoke-Native $sh $bad3
Check 'non-zero exit is returned, not thrown' ($r.Code -eq 3)
$r = Invoke-Native 'definitely-not-a-program' @()
Check 'missing program is -1, not a throw' ($r.Code -eq -1)
Check 'caller error preference restored' ($ErrorActionPreference -eq 'Stop')
$py = Find-Python
Check "Find-Python finds a Python >= 3.9 ($($py.Exe))" ($null -ne $py)

if ($fail) { "$fail check(s) failed"; exit 1 } else { 'all checks passed' }
