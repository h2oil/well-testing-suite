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

  Running it again keeps the settings of the existing bridge-config.json: new -Allow targets
  are ADDED to its allow list, and its port / listen address / write setting / origins stay
  unless you give -Port / -Listen / -AllowWrites / -ReadOnly. -Reset starts from a new, empty
  configuration (the old file is kept as bridge-config.json.bak).

  Allow list of an older installer: a bridge-config.json written before v1.2.1 has no
  "allowMode". Its allow list is replaced by any device (the default since v1.2) unless you
  give -Allow targets (added to it) or -KeepAllow (kept as it is); a note says so.

  Run it from PowerShell (Start menu > type PowerShell) in the folder that holds it:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1 -Allow "192.168.1.10:502"
  "-ExecutionPolicy Bypass" applies to this one run only; it changes no system setting.

.PARAMETER Allow
  host:port targets the bridge may connect to, comma separated: IPv4 (192.168.1.10:502),
  IPv4 subnet (10.0.0.0/24:502), host name (plc-1.local:502) or IPv6 in brackets
  ([fd00::10]:502); port 1-65535 or * (any port). Added to the targets already configured.
.PARAMETER Port
  WebSocket port of the bridge (default 8502; the app's bridge URL is ws://127.0.0.1:<port>).
.PARAMETER Listen
  Interface to listen on (default 127.0.0.1 = this computer only).
.PARAMETER AllowAny
  Allow any device IP / port (same as -Allow "*:*"). This is also what you get when no -Allow
  target is given at all (the default since bridge v1.2.0). Replaces an existing list.
.PARAMETER KeepAllow
  Keep the allow list of an existing bridge-config.json written by an older installer (without
  it, that list is replaced by any device).
.PARAMETER AllowWrites
  Forward Modbus write requests (FC 05/06/15/16). Read-only otherwise.
.PARAMETER ReadOnly
  Refuse Modbus write requests again (the default for a new install).
.PARAMETER Origin
  Also accept pages from these origins, comma separated: https://my.site, http://host:port, or
  null for a saved file:// copy of the app (any web site can send "null", so only on a PC that
  is not used for general web browsing).
.PARAMETER AutoStart
  Start the bridge automatically at logon.
.PARAMETER NoStart
  Install only; do not start the bridge now (with -AutoStart it starts at the next logon).
.PARAMETER Reset
  Ignore the existing bridge-config.json and write a new one.
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
    [switch]$AllowAny,
    [switch]$KeepAllow,
    [switch]$AllowWrites,
    [switch]$ReadOnly,
    [string[]]$Origin = @(),
    [switch]$AutoStart,
    [switch]$NoStart,
    [switch]$Reset,
    [switch]$Uninstall,
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'

# @@WTS-PRESET-BEGIN@@ (the app's "Generate installer for my devices" fills in this block)
$PresetAllow = ''
$PresetPort = 0
$PresetListen = ''
$PresetAllowWrites = $null
$PresetAutoStart = $false
$PresetOrigins = ''
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
$ConfigComment = 'WTS Modbus bridge settings. allow = the host:port targets the bridge may connect to (*:* = any device; allowMode any or list). Running the installer again keeps these settings and adds new -Allow targets (-AllowAny = any device, -Reset starts over). Restart the bridge after editing.'

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
    if ($h.StartsWith('[') -and $h.EndsWith(']')) {
        # IPv6 in brackets: hex digits, colons and dots only (no zone id), 2+ colons
        $a = $h.Substring(1, $h.Length - 2)
        if ($a -cnotmatch '\A[0-9A-Fa-f:.]{2,45}\z') { return $false }
        return (($a.Split(':').Length - 1) -ge 2)
    }
    if ($h.Contains('/')) {
        $parts = $h.Split('/')
        if ($parts.Length -ne 2) { return $false }
        if (-not (Test-IPv4 ($parts[0]))) { return $false }
        if ($parts[1] -cnotmatch '\A[0-9]{1,2}\z') { return $false }
        return ([int]$parts[1] -le 32)
    }
    if ($h -cmatch '\A[0-9.]+\z') { return (Test-IPv4 $h) }
    if ($h -cnotmatch '\A[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?\z') { return $false }
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
    if ($t.Substring(0, $i) -ceq '*') { $p = $t.Substring($i + 1); return ($p -eq '*' -or (Test-PortText $p)) }
    if (-not (Test-HostName ($t.Substring(0, $i)))) { return $false }
    $p = $t.Substring($i + 1)
    return ($p -eq '*' -or (Test-PortText $p))
}
function Test-Listen([string]$a) { return ($a -ceq 'localhost' -or (Test-IPv4 $a)) }
function Get-NormalListen([string]$a) {
    # "localhost" may resolve to ::1 only (Node >= 17 keeps the resolver order) - the app uses 127.0.0.1
    if ($a -ceq 'localhost') { return '127.0.0.1' }
    return $a
}
function Test-Origin([string]$o) {
    # null | file:// | http(s)://host[:port]
    if ($o -ceq 'null' -or $o -ceq 'file://') { return $true }
    if ($o.Length -gt 300) { return $false }
    if (-not ($o -cmatch '\Ahttps?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:([0-9]{1,5}))?\z')) { return $false }
    if ($Matches[3]) { return (Test-PortText $Matches[3]) }
    return $true
}
function Get-NormalTarget([string]$t) {
    # a valid target: lower case, port without leading zeros
    $t = $t.ToLowerInvariant()
    $i = $t.LastIndexOf(':')
    $p = $t.Substring($i + 1)
    if ($p -ne '*') { $p = [string]([int]$p) }
    return ($t.Substring(0, $i) + ':' + $p)
}
function Get-SpecForm([string]$t) {
    # the bridge's own spelling of an allow entry (as /health lists it)
    $t = $t.Trim()
    $i = $t.LastIndexOf(':')
    if ($i -le 0) { return $t.ToLowerInvariant() }
    $h = $t.Substring(0, $i).Trim('[', ']').ToLowerInvariant()
    $p = $t.Substring($i + 1)
    $n = 0
    if ($p -ne '*' -and [int]::TryParse($p, [ref]$n)) { $p = [string]$n }
    if ($h.Contains(':')) { $h = '[' + $h + ']' }
    return ($h + ':' + $p)
}

$NewAllow = New-Object 'System.Collections.Generic.List[string]'
$NewOrigins = New-Object 'System.Collections.Generic.List[string]'
$AllowList = New-Object 'System.Collections.Generic.List[string]'
function Add-Allow([string[]]$items) {
    foreach ($raw in $items) {
        if ($null -eq $raw) { continue }
        foreach ($item in ($raw -split '[,\s]+')) {
            if ($item -eq '') { continue }
            if (-not (Test-Target $item)) {
                throw ("Invalid -Allow entry '" + $item + "' (use ip:port, ip/bits:port, hostname:port or [ipv6]:port; port 1-65535 or *).")
            }
            $item = Get-NormalTarget $item
            if (-not $script:NewAllow.Contains($item)) { $script:NewAllow.Add($item) }
        }
    }
}
function Add-Origin([string[]]$items) {
    foreach ($raw in $items) {
        if ($null -eq $raw) { continue }
        foreach ($item in ($raw -split '[,\s]+')) {
            if ($item -eq '') { continue }
            if (-not (Test-Origin $item)) {
                throw ("Invalid -Origin '" + $item + "' (use https://host[:port], http://host[:port], null or file://).")
            }
            if (-not $script:NewOrigins.Contains($item)) { $script:NewOrigins.Add($item) }
        }
    }
}
function ConvertTo-JsonText([string]$s) {
    # a JSON string literal (ASCII only)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        $code = [int]$ch
        if ($code -eq 34) { [void]$sb.Append('\"') }
        elseif ($code -eq 92) { [void]$sb.Append('\\') }
        elseif ($code -lt 32 -or $code -gt 126) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
        else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
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
function Test-PortInUse([string]$hostName, [int]$port) {
    # anything (a bridge or another program) listening on the port?
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect($hostName, $port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $client.EndConnect($ar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}
function Test-HealthMatches($h, [int]$port, [bool]$writes) {
    # is the bridge that answered the one just configured?
    if ([int]$h.port -ne $port) { return $false }
    if ([bool]$h.readOnly -eq $writes) { return $false }
    $got = @(@($h.allow) | Where-Object { $null -ne $_ } | ForEach-Object { ([string]$_).ToLowerInvariant() } | Sort-Object)
    $want = @($script:AllowList | ForEach-Object { Get-SpecForm $_ } | Sort-Object)
    return (($got -join ',') -eq ($want -join ','))
}
function Get-HealthText($h) {
    if ($h.readOnly) { $m = 'read-only' } else { $m = 'writes ALLOWED' }
    $allowed = @($h.allow) -join ', '
    if (-not $allowed) { $allowed = '(none)' }
    return ('v' + $h.version + ', ' + $m + ', port ' + $h.port + '; allowed targets: ' + $allowed)
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
    # node.exe processes started from the install folder (an earlier install or auto-start), and
    # the console windows running start-bridge.cmd (older auto-start tasks left a "cmd /K" prompt
    # open there, which keeps the install folder in use)
    $stopped = 0
    $killed = 0
    $procs = @()
    try { $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" -ErrorAction Stop) } catch { $procs = @() }
    foreach ($p in $procs) {
        if ($null -eq $p -or -not $p.CommandLine -or $p.ProcessId -eq $PID) { continue }
        if ($p.Name -ieq 'node.exe') { $ours = ($p.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
        else { $ours = ($p.CommandLine.IndexOf($StartCmd, [StringComparison]::OrdinalIgnoreCase) -ge 0) }
        if ($ours) {
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                $killed++
                if ($p.Name -ieq 'node.exe') { $stopped++ }
            } catch { }
        }
    }
    if ($killed -gt 0) { Start-Sleep -Milliseconds 500 }
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
        # "start" runs a .cmd file with "cmd /K": that window would stay open at a prompt after the
        # bridge ends, keeping the install folder in use. A minimised "cmd /c call" closes with it.
        $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c start "' + $AppName + '" /min "' + $env:ComSpec + '" /c call "' + $StartCmd + '"') -WorkingDirectory $InstallDir
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
            if (Test-Path -LiteralPath $path) {
                try { Remove-Item -LiteralPath $path -Force -ErrorAction Stop; $removed++ }
                catch { Warn ('could not remove ' + $path + ' (' + $_.Exception.Message + ')') }
            }
        }
        if (@(Get-ChildItem -LiteralPath $InstallDir -Force).Length -eq 0) {
            try {
                Remove-Item -LiteralPath $InstallDir -Force -ErrorAction Stop
                Say ('Removed ' + $InstallDir + ' (' + $removed + ' files)')
            } catch {
                Warn ('removed ' + $removed + ' files, but not the empty folder ' + $InstallDir + ' (' + $_.Exception.Message + '). A window may still use it: close the "' + $AppName + '" window, then delete the folder.')
            }
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
function Read-OldConfig {
    # the bridge-config.json of an earlier install: its settings are the defaults of this run
    $r = @{ Have = $false; Allow = @(); Mode = ''; Port = 0; Listen = ''; Writes = $null; Origins = @(); AnyOrigin = $false; Verbose = $false }
    if ($Reset -or -not (Test-Path -LiteralPath $ConfigPath)) { return $r }
    try { $c = [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json } catch { $c = $null }
    if ($null -eq $c -or $c -is [array] -or $c -is [string] -or $c -is [ValueType]) {
        Warn ($ConfigPath + ' could not be read (not valid JSON?) - writing a new one (the old file is kept as bridge-config.json.bak).')
        return $r
    }
    $r.Have = $true
    foreach ($a in @($c.allow)) {
        if (-not ($a -is [string])) { continue }
        $t = $a.Trim()
        if (Test-Target $t) { $t = Get-NormalTarget $t }
        elseif ($t -cnotmatch '\A[\[\]A-Za-z0-9._:/*-]+\z') { Warn ("left out '" + $t + "' from the existing allow list (not a host:port target)"); continue }
        if ($r.Allow -notcontains $t) { $r.Allow += $t }
    }
    if ($null -ne $c.port -and ([string]$c.port) -cmatch '\A[0-9]{1,5}\z' -and (Test-PortText ([string]$c.port))) { $r.Port = [int]$c.port }
    if ($c.listen -is [string]) {
        if (Test-Listen $c.listen.Trim()) { $r.Listen = Get-NormalListen $c.listen.Trim() }
        else { Warn ("the existing listen address '" + $c.listen + "' is not an IPv4 address or localhost - not kept") }
    }
    if ($c.allowWrites -is [bool]) { $r.Writes = [bool]$c.allowWrites }
    # "allowMode" is written by v1.2.1+ installers; without it the allow list is an older installer's
    if (($c.allowMode -is [string]) -and ($c.allowMode -ceq 'any' -or $c.allowMode -ceq 'list')) { $r.Mode = $c.allowMode }
    foreach ($o in @($c.origins)) { if ($o -is [string] -and $o.Trim()) { $r.Origins += $o.Trim() } }
    $r.AnyOrigin = (($c.anyOrigin -is [bool]) -and $c.anyOrigin)
    $r.Verbose = (($c.verbose -is [bool]) -and $c.verbose)
    return $r
}
function Write-Config([int]$port, [string]$listen, [bool]$writes, [string[]]$origins, [bool]$anyOrigin, [bool]$verbose) {
    # origins, anyOrigin and verbose come from the old file (plus -Origin); values JSON-escaped
    $allowJson = (@($AllowList | ForEach-Object { ConvertTo-JsonText $_ })) -join ', '
    $originsJson = (@($origins | Where-Object { $_ } | ForEach-Object { ConvertTo-JsonText $_ })) -join ', '
    if ($writes) { $w = 'true' } else { $w = 'false' }
    if ($anyOrigin) { $any = 'true' } else { $any = 'false' }
    if ($verbose) { $verb = 'true' } else { $verb = 'false' }
    if ($AllowList.Contains('*:*')) { $mode = 'any' } else { $mode = 'list' }
    $json = "{`n" +
        "  ""_comment"": " + (ConvertTo-JsonText $ConfigComment) + ",`n" +
        "  ""allow"": [" + $allowJson + "],`n" +
        "  ""allowMode"": " + (ConvertTo-JsonText $mode) + ",`n" +
        "  ""port"": " + $port + ",`n" +
        "  ""listen"": " + (ConvertTo-JsonText $listen) + ",`n" +
        "  ""origins"": [" + $originsJson + "],`n" +
        "  ""anyOrigin"": " + $any + ",`n" +
        "  ""allowWrites"": " + $w + ",`n" +
        "  ""verbose"": " + $verb + "`n" +
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
    Say ('Allow list:    powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'install-windows.ps1') + '" -Allow <ip>:<port>   (only listed devices; adds to the list)  or  -AllowAny')
    Say ('Uninstall:     powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'install-windows.ps1') + '" -Uninstall')
}

function Invoke-Install {
    Add-Allow @($PresetAllow)
    Add-Allow $Allow
    if ($AllowAny) { Add-Allow @('*:*') }
    Add-Origin @($PresetOrigins)
    Add-Origin $Origin
    if ($AllowWrites -and $ReadOnly) { throw 'Use either -AllowWrites or -ReadOnly, not both.' }
    if ($Port -ne 0 -and ($Port -lt 1 -or $Port -gt 65535)) { throw ('Invalid -Port ' + $Port + ' (1-65535).') }
    if ($PresetPort -ne 0 -and ($PresetPort -lt 1 -or $PresetPort -gt 65535)) { throw ('Invalid preset port ' + $PresetPort + ' (1-65535).') }
    if ($Listen -and -not (Test-Listen $Listen)) { throw ("Invalid -Listen '" + $Listen + "' (an IPv4 address or localhost).") }
    if ($PresetListen -and -not (Test-Listen $PresetListen)) { throw ("Invalid preset listen address '" + $PresetListen + "'.") }

    $node = Initialize-Node
    # The existing bridge-config.json supplies the defaults, so running the installer again (for one
    # more device, or -AllowWrites) never drops the other targets or changes the port.
    $old = Read-OldConfig
    # The allow list: -AllowAny (or '*:*') = any device; -Allow targets are added to the old list
    # (an "any" list starts empty); -KeepAllow or a file with "allowMode" (v1.2.1+) keeps the old
    # list; the list of an older installer (no "allowMode") is replaced by any device.
    $oldAny = ((@($old.Allow).Count -eq 0) -or (@($old.Allow) -contains '*:*'))
    $migrated = ''
    if ($NewAllow.Contains('*:*')) { $script:AllowList.Add('*:*') }
    elseif ($NewAllow.Count -gt 0) {
        $base = @()
        if (-not $oldAny) { $base = @($old.Allow) }
        foreach ($e in ($base + @($NewAllow))) { if ($e -and -not $script:AllowList.Contains($e)) { $script:AllowList.Add($e) } }
    }
    elseif ($oldAny) { }
    elseif ($KeepAllow -or $old.Mode) {
        foreach ($e in @($old.Allow)) { if ($e -and -not $script:AllowList.Contains($e)) { $script:AllowList.Add($e) } }
    }
    else { $migrated = (@($old.Allow) -join ', ') }
    $origins = @()
    foreach ($o in (@($old.Origins) + @($NewOrigins))) { if ($o -and ($origins -notcontains $o)) { $origins += $o } }
    $port = 8502
    if ($Port -gt 0) { $port = $Port } elseif ($PresetPort -gt 0) { $port = $PresetPort } elseif ($old.Port -gt 0) { $port = $old.Port }
    $listen = '127.0.0.1'
    if ($Listen) { $listen = $Listen } elseif ($PresetListen) { $listen = $PresetListen } elseif ($old.Listen) { $listen = $old.Listen }
    $listen = Get-NormalListen $listen
    $writes = $false
    if ($ReadOnly) { $writes = $false }
    elseif ($AllowWrites) { $writes = $true }
    elseif ($null -ne $PresetAllowWrites) { $writes = [bool]$PresetAllowWrites }
    elseif ($null -ne $old.Writes) { $writes = [bool]$old.Writes }
    $auto = [bool]($AutoStart -or $PresetAutoStart)
    $healthHost = $listen
    if ($healthHost -eq '0.0.0.0') { $healthHost = '127.0.0.1' }

    if ($migrated) {
        Say ('Keeping the settings of the existing ' + $ConfigPath + ' (port, listen address, writes, origins).')
        Say ('Allow-list ' + $migrated + ' replaced by any device (default since 1.2). Use -KeepAllow to keep it.')
    } elseif ($old.Have -and $oldAny) {
        Say ('Keeping the settings of the existing ' + $ConfigPath + ' (any device; -Allow <ip>:<port> restricts it, -Reset starts a new file).')
    } elseif ($old.Have) {
        Say ('Keeping the settings of the existing ' + $ConfigPath + ' (' + @($old.Allow).Count + ' target(s); new targets are added - -Reset starts a new list).')
    }
    if ($AllowList.Count -eq 0) {
        $script:AllowList.Add('*:*')
        Say 'No -Allow targets given: the bridge will allow any device IP / port (default). Give -Allow <ip>:<port> to restrict it.'
    }
    # Before anything is written: stop the bridges of an earlier install, then the port must be free
    # (otherwise the new bridge could not start, and the settings on disk would not match the bridge
    # that answers).
    if (-not $NoStart) {
        $n = Stop-OurBridges
        if ($n -gt 0) { Say ('Stopped ' + $n + ' bridge process(es) from an earlier install') }
        $other = Get-Health $healthHost $port
        if ($other) {
            throw ('another WTS Modbus bridge already answers on http://' + $healthHost + ':' + $port + ' (' + (Get-HealthText $other) + ') - it was not started by this install (a bridge started by hand?). Close its window, or install with -Port <other>. Nothing was changed.')
        }
        if (Test-PortInUse $healthHost $port) {
            throw ('another program already uses port ' + $port + ' on ' + $healthHost + '. Stop it, or install with -Port <other> (and use that port in the device bridge URL). Nothing was changed.')
        }
    }
    Install-Files
    Write-Config $port $listen $writes $origins $old.AnyOrigin $old.Verbose
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
    if ($auto) { $style = 'Minimized' } else { $style = 'Normal' }
    Start-Process -FilePath $StartCmd -WorkingDirectory $InstallDir -WindowStyle $style
    $h = Wait-Health $healthHost $port 15
    if ($h) {
        if (-not (Test-HealthMatches $h $port $writes)) {
            throw ('the bridge answering on port ' + $port + ' is not the one just installed (' + (Get-HealthText $h) + '). Another bridge may be running: close it and run the installer again.')
        }
        Say ''
        Good ('OK: the WTS Modbus bridge is running - ' + (Get-HealthText $h))
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
