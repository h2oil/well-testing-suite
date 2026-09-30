<#
.SYNOPSIS
  Installs the WTS Modbus bridge (WebSocket <-> Modbus TCP) for the current Windows user.
  No administrator rights are needed for the bridge itself.

.DESCRIPTION
  1. Checks for Node.js 18 or newer. If it is missing it offers to install the LTS version
     with "winget install OpenJS.NodeJS.LTS" - only after you confirm (or with -Yes).
     Nothing else is downloaded.
  2. Copies modbus-bridge.js, fake-slave.js and README.md to
     "%LOCALAPPDATA%\WTS Modbus Bridge", writes bridge-config.json and start-bridge.cmd,
     and adds a Start-menu shortcut "WTS Modbus Bridge".
  3. -AutoStart also starts the bridge at every logon (a user-level Scheduled Task, or a
     Startup-folder shortcut when Task Scheduler refuses).
  4. Starts the bridge, checks http://127.0.0.1:<port>/health and prints the next steps.

  Run it from PowerShell (Start menu > type PowerShell) in the folder that holds it:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -Allow "192.168.1.10:502"
  "-ExecutionPolicy Bypass" applies to this one run only; it changes no system setting.

.PARAMETER Allow
  host:port targets the bridge may connect to, comma separated: IPv4 (192.168.1.10:502),
  IPv4 subnet (10.0.0.0/24:502) or host name (plc-1.local:502); port 1-65535 or * (any port).
.PARAMETER Port
  WebSocket port of the bridge (default 8502; the app's bridge URL is ws://127.0.0.1:<port>).
.PARAMETER Listen
  Interface to listen on (default 127.0.0.1 = this computer only).
.PARAMETER AllowWrites
  Forward Modbus write requests (FC 05/06/15/16). Read-only otherwise.
.PARAMETER AutoStart
  Start the bridge automatically at logon.
.PARAMETER NoStart
  Install only; do not start the bridge now.
.PARAMETER Uninstall
  Stop the bridge and remove the auto-start entry, the shortcuts and the installed files.
.PARAMETER Yes
  Answer yes to the Node.js installation question.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -Allow "192.168.1.10:502,192.168.1.11:502" -AutoStart
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\WTS Modbus Bridge\install-windows.ps1" -Uninstall
#>
[CmdletBinding()]
param(
    [string[]]$Allow = @(),
    [int]$Port = 0,
    [string]$Listen = '',
    [switch]$AllowWrites,
    [switch]$AutoStart,
    [switch]$NoStart,
    [switch]$Uninstall,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'

# @@WTS-PRESET-BEGIN@@ (the app's "Generate installer for my devices" fills in this block)
$PresetAllow = ''
$PresetPort = 0
$PresetListen = ''
$PresetAllowWrites = $false
$PresetAutoStart = $false
# @@WTS-PRESET-END@@

# @@WTS-PAYLOAD-BEGIN@@ (a generated installer embeds the bridge files here)
$Embedded = @{}
$EmbeddedVersion = ''
# @@WTS-PAYLOAD-END@@

$AppName = 'WTS Modbus Bridge'
$TaskName = 'WTS Modbus Bridge'
$NodeMin = 18
$InstallDir = Join-Path $env:LOCALAPPDATA $AppName
$StartCmd = Join-Path $InstallDir 'start-bridge.cmd'
$ConfigPath = Join-Path $InstallDir 'bridge-config.json'
$InstalledFiles = @('modbus-bridge.js', 'fake-slave.js', 'README.md', 'bridge-config.json', 'bridge-config.json.bak',
    'start-bridge.cmd', 'install-windows.ps1', 'bridge.log')

function Say([string]$text) { Write-Host $text }
function Warn([string]$text) { Write-Host ('WARNING: ' + $text) -ForegroundColor Yellow }
function Good([string]$text) { Write-Host $text -ForegroundColor Green }

# ---- validation (no PowerShell / cmd metacharacters can get through) ---------
function Test-IPv4([string]$ip) {
    if (-not ($ip -cmatch '\A([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\z')) { return $false }
    for ($i = 1; $i -le 4; $i++) { if ([int]$Matches[$i] -gt 255) { return $false } }
    return $true
}
function Test-HostName([string]$h) {
    if ($h.Length -lt 1 -or $h.Length -gt 253) { return $false }
    if ($h.Contains('/')) {
        $parts = $h.Split('/')
        if ($parts.Length -ne 2) { return $false }
        if (-not (Test-IPv4 ($parts[0]))) { return $false }
        if ($parts[1] -cnotmatch '\A[0-9]{1,2}\z') { return $false }
        return ([int]$parts[1] -le 32)
    }
    if ($h -cmatch '\A[0-9.]+\z') { return (Test-IPv4 $h) }
    if ($h -cnotmatch '\A[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\z') { return $false }
    return (-not $h.Contains('..'))
}
function Test-PortText([string]$p) {
    if ($p -cnotmatch '\A[0-9]{1,5}\z') { return $false }
    $n = [int]$p
    return ($n -ge 1 -and $n -le 65535)
}
function Test-Target([string]$t) {
    $i = $t.LastIndexOf(':')
    if ($i -le 0) { return $false }
    if (-not (Test-HostName ($t.Substring(0, $i)))) { return $false }
    $p = $t.Substring($i + 1)
    return ($p -eq '*' -or (Test-PortText $p))
}
function Test-Listen([string]$a) { return ($a -ceq 'localhost' -or (Test-IPv4 $a)) }

$AllowList = New-Object 'System.Collections.Generic.List[string]'
function Add-Allow([string[]]$items) {
    foreach ($raw in $items) {
        if ($null -eq $raw) { continue }
        foreach ($item in ($raw -split '[,\s]+')) {
            if ($item -eq '') { continue }
            if (-not (Test-Target $item)) {
                throw ("Invalid -Allow entry '" + $item + "' (use ip:port, ip/bits:port or hostname:port; port 1-65535 or *).")
            }
            if (-not $script:AllowList.Contains($item)) { $script:AllowList.Add($item) }
        }
    }
}

# ---- helpers -------------------------------------------------------------------
function Confirm-Step([string]$question) {
    if ($Yes) { return $true }
    try { $answer = Read-Host ($question + ' [y/N]') } catch { return $false }
    return ($answer -match '\A\s*(y|yes)\s*\z')
}
function Invoke-Quiet([string]$exe, [string[]]$arguments) {
    # Windows PowerShell 5.1 turns native stderr into errors under 'Stop' - relax it here.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $exe @arguments 2>$null
        return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (@($out) -join "`n") }
    } catch {
        return [pscustomobject]@{ Code = 1; Out = '' }
    } finally {
        $ErrorActionPreference = $old
    }
}
function Find-Node {
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Path }
    $candidates = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    return $null
}
function Get-NodeMajor([string]$node) {
    if (-not $node) { return 0 }
    $r = Invoke-Quiet $node @('-p', "process.versions.node.split('.')[0]")
    $n = 0
    if ($r.Code -eq 0 -and [int]::TryParse(($r.Out.Trim()), [ref]$n)) { return $n }
    return 0
}
function Show-NodeHelp {
    Say ('Install Node.js ' + $NodeMin + ' or newer (the LTS version), then run this installer again:')
    Say '  - winget install OpenJS.NodeJS.LTS'
    Say '  - or the Windows installer (.msi) from https://nodejs.org'
}
function Initialize-Node {
    $node = Find-Node
    $major = Get-NodeMajor $node
    if ($major -ge $NodeMin) { return $node }
    if ($node) { $have = 'version ' + $major + ' at ' + $node } else { $have = 'not found' }
    Say ('Node.js ' + $NodeMin + ' or newer is needed to run the bridge (Node.js: ' + $have + ').')
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) { Show-NodeHelp; throw 'Node.js is missing.' }
    if (-not (Confirm-Step "Install Node.js LTS now with 'winget install OpenJS.NodeJS.LTS' (Windows may ask for permission)?")) {
        Show-NodeHelp; throw 'Node.js is missing.'
    }
    & $winget.Path install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host
    if ($LASTEXITCODE -ne 0) { Warn ('winget exited with code ' + $LASTEXITCODE) }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Find-Node
    $major = Get-NodeMajor $node
    if ($major -lt $NodeMin) {
        Say 'Node.js is still not available in this window. Open a new PowerShell window and run the installer again.'
        throw 'Node.js is missing.'
    }
    return $node
}
function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($path, $text, $enc)
}
function Get-Health([string]$hostName, [int]$port) {
    $resp = $null
    try {
        $req = [System.Net.WebRequest]::Create('http://' + $hostName + ':' + $port + '/health')
        $req.Timeout = 2000
        $req.ReadWriteTimeout = 2000
        $req.Proxy = $null
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $text = $reader.ReadToEnd()
        $reader.Close()
        return ($text | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        if ($resp) { $resp.Close() }
    }
}
function Wait-Health([string]$hostName, [int]$port, [int]$seconds) {
    for ($i = 0; $i -lt ($seconds * 4); $i++) {
        $h = Get-Health $hostName $port
        if ($h) { return $h }
        Start-Sleep -Milliseconds 250
    }
    return $null
}
function Stop-OurBridges {
    # node.exe processes started from the install folder (an earlier install or auto-start)
    $stopped = 0
    $procs = @()
    try { $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop) } catch { $procs = @() }
    foreach ($p in $procs) {
        if ($null -eq $p -or -not $p.CommandLine) { continue }
        if ($p.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $stopped++ } catch { }
        }
    }
    if ($stopped -gt 0) { Start-Sleep -Milliseconds 500 }
    return $stopped
}
function New-Shortcut([string]$lnk, [string]$target, [string]$workDir, [string]$description, [int]$windowStyle, [string]$icon) {
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = $target
    $s.WorkingDirectory = $workDir
    $s.Description = $description
    $s.WindowStyle = $windowStyle
    if ($icon) { $s.IconLocation = $icon + ',0' }
    $s.Save()
}
function Get-StartMenuLink { return (Join-Path ([Environment]::GetFolderPath('Programs')) ($AppName + '.lnk')) }
function Get-StartupLink { return (Join-Path ([Environment]::GetFolderPath('Startup')) ($AppName + '.lnk')) }
function Remove-AutoStart {
    try {
        $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($t) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Say ('Removed the scheduled task "' + $TaskName + '"') }
    } catch { }
    $startup = Get-StartupLink
    if (Test-Path -LiteralPath $startup) { Remove-Item -LiteralPath $startup -Force; Say ('Removed ' + $startup) }
}
function Register-AutoStart([string]$node) {
    $user = $env:USERNAME
    if ($env:USERDOMAIN) { $user = $env:USERDOMAIN + '\' + $env:USERNAME }
    try {
        $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c start "' + $AppName + '" /min "' + $StartCmd + '"') -WorkingDirectory $InstallDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
            -Description 'Starts the WTS Modbus bridge (WebSocket to Modbus TCP) at logon.' -Force -ErrorAction Stop | Out-Null
        $startup = Get-StartupLink
        if (Test-Path -LiteralPath $startup) { Remove-Item -LiteralPath $startup -Force }
        Say ('Auto-start: scheduled task "' + $TaskName + '" (at logon, this user, no admin rights)')
    } catch {
        New-Shortcut (Get-StartupLink) $StartCmd $InstallDir 'Starts the WTS Modbus bridge at logon' 7 $node
        Say ('Auto-start: Startup-folder shortcut ' + (Get-StartupLink) + ' (Task Scheduler said: ' + $_.Exception.Message + ')')
    }
}
function Test-AutoStartInstalled {
    try { if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { return $true } } catch { }
    return (Test-Path -LiteralPath (Get-StartupLink))
}
function Get-ConfiguredPort {
    try {
        $c = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        if ($c.port -ge 1 -and $c.port -le 65535) { return [int]$c.port }
    } catch { }
    if ($Port -ge 1 -and $Port -le 65535) { return $Port }
    return 8502
}
function Wait-IfStartedFromExplorer {
    # "Run with PowerShell" from Explorer closes the window at once - keep it open to read.
    try {
        $me = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $PID) -ErrorAction Stop
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $me.ParentProcessId) -ErrorAction Stop
        if ($parent -and $parent.Name -ieq 'explorer.exe') { Read-Host 'Press Enter to close this window' | Out-Null }
    } catch { }
}

# ---- uninstall -----------------------------------------------------------------
function Invoke-Uninstall {
    $p = Get-ConfiguredPort
    Remove-AutoStart
    $lnk = Get-StartMenuLink
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Say ('Removed ' + $lnk) }
    $n = Stop-OurBridges
    if ($n -gt 0) { Say ('Stopped ' + $n + ' running bridge process(es)') }
    if (Test-Path -LiteralPath $InstallDir) {
        $removed = 0
        foreach ($f in $InstalledFiles) {
            $path = Join-Path $InstallDir $f
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force; $removed++ }
        }
        if (@(Get-ChildItem -LiteralPath $InstallDir -Force).Length -eq 0) {
            Remove-Item -LiteralPath $InstallDir -Force
            Say ('Removed ' + $InstallDir + ' (' + $removed + ' files)')
        } else {
            Warn ($InstallDir + ' still contains other files - left in place')
        }
    } else {
        Say ('Nothing installed in ' + $InstallDir)
    }
    if (Get-Health '127.0.0.1' $p) { Warn ('a bridge still answers on port ' + $p + ' (started by hand?) - close its window.') }
    Good 'The WTS Modbus bridge is uninstalled.'
}

# ---- install -------------------------------------------------------------------
function Install-Files {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    if ($Embedded.Count -gt 0) {
        foreach ($name in @($Embedded.Keys)) {
            $entry = $Embedded[$name]
            $dest = Join-Path $InstallDir $name
            [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($entry.B64))
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash.ToLowerInvariant()
            if ($got -ne $entry.Sha256) { throw ($name + ': SHA-256 mismatch after unpacking (installer damaged?) - download it again from the app.') }
        }
        Say ('Unpacked bridge v' + $EmbeddedVersion + ' (SHA-256 verified)')
    } else {
        $src = $PSScriptRoot
        if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src 'modbus-bridge.js'))) {
            throw ('modbus-bridge.js was not found next to this installer (' + $src + '). Download the bridge package from the app''s Modbus page, unzip it and run install-windows.ps1 from that folder.')
        }
        foreach ($f in @('modbus-bridge.js', 'fake-slave.js', 'README.md')) {
            $from = Join-Path $src $f
            $to = Join-Path $InstallDir $f
            if ((Test-Path -LiteralPath $from) -and ($from -ne $to)) { Copy-Item -LiteralPath $from -Destination $to -Force }
        }
    }
    $self = $PSCommandPath
    $selfCopy = Join-Path $InstallDir 'install-windows.ps1'
    if ($self -and (Test-Path -LiteralPath $self) -and ($self -ne $selfCopy)) { Copy-Item -LiteralPath $self -Destination $selfCopy -Force }
    try { Get-ChildItem -LiteralPath $InstallDir -File | Unblock-File -ErrorAction SilentlyContinue } catch { }
}
function Write-Config([int]$port, [string]$listen, [bool]$writes) {
    $quoted = @()
    foreach ($e in $AllowList) { $quoted += ('"' + $e + '"') }
    $allowJson = $quoted -join ', '
    if ($writes) { $w = 'true' } else { $w = 'false' }
    $json = "{`n" +
        "  ""_comment"": ""WTS Modbus bridge settings. allow = the host:port targets the bridge may connect to. Restart the bridge after editing (or run the installer again)."",`n" +
        "  ""allow"": [" + $allowJson + "],`n" +
        "  ""port"": " + $port + ",`n" +
        "  ""listen"": """ + $listen + """,`n" +
        "  ""origins"": [],`n" +
        "  ""anyOrigin"": false,`n" +
        "  ""allowWrites"": " + $w + ",`n" +
        "  ""verbose"": false`n" +
        "}`n"
    if (Test-Path -LiteralPath $ConfigPath) {
        $old = [IO.File]::ReadAllText($ConfigPath)
        if ($old -ne $json) { Copy-Item -LiteralPath $ConfigPath -Destination ($ConfigPath + '.bak') -Force }
    }
    Write-Utf8NoBom $ConfigPath $json
}
function Write-StartCmd([string]$node) {
    $nodeForCmd = $node.Replace('%', '%%')
    $text = "@echo off`r`n" +
        "rem Starts the WTS Modbus bridge with bridge-config.json (written by install-windows.ps1).`r`n" +
        "rem Extra options are passed on, e.g.  start-bridge.cmd --verbose`r`n" +
        "chcp 65001 >nul`r`n" +
        "title " + $AppName + "`r`n" +
        """" + $nodeForCmd + """ ""%~dp0modbus-bridge.js"" --config ""%~dp0bridge-config.json"" %*`r`n" +
        "if errorlevel 1 pause`r`n"
    Write-Utf8NoBom $StartCmd $text
}
function Show-NextSteps([string]$hostName, [int]$port) {
    Say ''
    Say 'Next steps in the Well Testing Suite (Modbus Config page):'
    Say '  1. For each device choose transport "Modbus TCP via WebSocket bridge", enter the'
    Say ('     PLC''s IP address and port, and the bridge URL ws://' + $hostName + ':' + $port)
    Say '  2. Press "Check bridge" in the setup guide, then "Test" on the device row.'
    Say ''
    Say ('Installed in:  ' + $InstallDir)
    Say ('Settings:      ' + $ConfigPath + ' (restart the bridge after editing)')
    Say ('Start:         Start menu > ' + $AppName + '   (or "' + $StartCmd + '")')
    Say ('Uninstall:     powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'install-windows.ps1') + '" -Uninstall')
}

function Invoke-Install {
    Add-Allow @($PresetAllow)
    Add-Allow $Allow
    $port = $Port
    if ($port -eq 0) { if ($PresetPort -gt 0) { $port = $PresetPort } else { $port = 8502 } }
    if ($port -lt 1 -or $port -gt 65535) { throw ('Invalid -Port ' + $port + ' (1-65535).') }
    $listen = $Listen
    if (-not $listen) { if ($PresetListen) { $listen = $PresetListen } else { $listen = '127.0.0.1' } }
    if (-not (Test-Listen $listen)) { throw ("Invalid -Listen '" + $listen + "' (an IPv4 address or localhost).") }
    $writes = [bool]($AllowWrites -or $PresetAllowWrites)
    $auto = [bool]($AutoStart -or $PresetAutoStart)
    $healthHost = $listen
    if ($healthHost -eq '0.0.0.0' -or $healthHost -eq 'localhost') { $healthHost = '127.0.0.1' }

    $node = Initialize-Node
    if ($AllowList.Count -eq 0) {
        Warn 'no -Allow targets: the bridge will refuse every device until you add one (run the installer again with -Allow <ip>:<port>, or edit bridge-config.json).'
    }
    $n = Stop-OurBridges
    if ($n -gt 0) { Say ('Stopped ' + $n + ' bridge process(es) from an earlier install') }
    Install-Files
    Write-Config $port $listen $writes
    Write-StartCmd $node
    New-Shortcut (Get-StartMenuLink) $StartCmd $InstallDir 'WTS Modbus bridge (WebSocket to Modbus TCP) for the Well Testing Suite' 1 $node
    if ($writes) { $mode = 'writes ALLOWED' } else { $mode = 'read-only' }
    $targets = $AllowList -join ', '
    if (-not $targets) { $targets = '(none)' }
    Good ('Installed the WTS Modbus bridge in ' + $InstallDir)
    Say ('  allowed targets: ' + $targets + '   port: ' + $port + '   ' + $mode)
    Say ('  Start-menu shortcut: ' + (Get-StartMenuLink))
    if ($auto) { Register-AutoStart $node }
    elseif (Test-AutoStartInstalled) { Say 'Auto-start from an earlier install is still set up (it uses the new settings from the next logon).' }

    if ($NoStart) { Show-NextSteps $healthHost $port; return }
    if (Get-Health $healthHost $port) {
        Warn ('something already answers on port ' + $port + ' (another bridge?) - not starting a second one. Close it, or install with -Port <other>.')
        Show-NextSteps $healthHost $port
        return
    }
    if ($auto) { $style = 'Minimized' } else { $style = 'Normal' }
    Start-Process -FilePath $StartCmd -WorkingDirectory $InstallDir -WindowStyle $style
    $h = Wait-Health $healthHost $port 15
    if ($h) {
        if ($h.readOnly) { $m = 'read-only' } else { $m = 'writes ALLOWED' }
        $allowed = @($h.allow) -join ', '
        if (-not $allowed) { $allowed = '(none)' }
        Say ''
        Good ('OK: the WTS Modbus bridge v' + $h.version + ' is running (' + $m + ', port ' + $h.port + '; allowed targets: ' + $allowed + ')')
        Say ('    health check: http://' + $healthHost + ':' + $port + '/health')
        Say ('    It runs in its own window "' + $AppName + '" - leave that window open while you use the app.')
    } else {
        Warn ('the bridge did not answer on http://' + $healthHost + ':' + $port + '/health within 15 s - look at the "' + $AppName + '" window for the error.')
    }
    Show-NextSteps $healthHost $port
}

$exitCode = 0
try {
    if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    $exitCode = 1
} finally {
    Wait-IfStartedFromExplorer
}
exit $exitCode
