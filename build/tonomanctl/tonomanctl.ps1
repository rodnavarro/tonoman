# tonomanctl — run a Tonoman agent on your own computer, managed from Tonoman Cloud. PowerShell flavour.
#
#   tonomanctl enrol <token> [-Api URL] [-Temporal ADDR] [-Release TAG] [-NoUp]
#   tonomanctl up | down | status | logs | update <TAG> | uninstall
#
# The same pod and containers as tonomanctl.sh, with podman on Windows (podman machine). Checks first
# and changes nothing on a machine that cannot run the agent; never updates on its own. The pool's
# credential lives in ~\.tonoman\pool.env, readable by you alone.
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Command = "",
  [Parameter(Position = 1)] [string] $Arg = "",
  [string] $Api = $(if ($env:TONOMAN_API_URL) { $env:TONOMAN_API_URL } else { "https://api.tonoman.com" }),
  [string] $Temporal = "",
  [string] $Release = $(if ($env:TONOMAN_RELEASE) { $env:TONOMAN_RELEASE } else { "latest" }),
  [switch] $NoUp
)
$ErrorActionPreference = "Stop"
$TonomanHome = if ($env:TONOMAN_HOME) { $env:TONOMAN_HOME } else { Join-Path $HOME ".tonoman" }
$PoolEnv = Join-Path $TonomanHome "pool.env"
$Pod = "tonoman"
$ImageRepo = if ($env:TONOMAN_IMAGE_REPO) { $env:TONOMAN_IMAGE_REPO } else { "ghcr.io/rodnavarro/tonoman" }
$Podman = if ($env:PODMAN) { $env:PODMAN } else { "podman" }

function Fail($msg) { Write-Error "tonomanctl: $msg"; exit 1 }
function Check {
  if (-not (Get-Command $Podman -ErrorAction SilentlyContinue)) { Fail "podman is not installed. Get it from https://podman.io/docs/installation, then run this again." }
  & $Podman info *> $null
  if ($LASTEXITCODE -ne 0) { Fail "podman is installed but not running: 'podman machine init' then 'podman machine start', then run this again." }
}
function Random-Token { -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }
function Read-PoolEnv {
  $h = @{}
  Get-Content $PoolEnv | Where-Object { $_ -and -not $_.StartsWith("#") } | ForEach-Object { $k, $v = $_ -split "=", 2; $h[$k] = $v }
  $h
}

function Enrol {
  if (-not $Arg) { Fail "usage: tonomanctl enrol <token> [-Api URL] [-Temporal ADDR] [-Release TAG] [-NoUp]" }
  Check
  if (Test-Path $PoolEnv) { Fail "this computer is already enrolled ($PoolEnv). 'tonomanctl uninstall' first to enrol again." }
  Write-Host "Enrolling with $Api …"
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$Api/v1/pool/enrol" -ContentType "application/json" -Body (@{ token = $Arg; version = $Release } | ConvertTo-Json)
  } catch {
    $code = $null; try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
    if ($code -eq 404) { Fail "that enrolment is not open: it was used, it expired, or it never existed. Mint a new command in the Hub." }
    Fail "the platform did not answer (http $code). Is $Api reachable from this computer?"
  }
  if (-not $r.credential) { Fail "the platform answered without a credential; nothing was saved." }
  $tempo = if ($Temporal) { $Temporal } else { $r.temporal.address }
  if (-not $tempo) { Fail "no Temporal address: pass -Temporal HOST:PORT." }
  New-Item -ItemType Directory -Force $TonomanHome | Out-Null
  @(
    "# Written by tonomanctl enrol. This is your computer's credential to Tonoman Cloud: keep it to yourself.",
    "TONOMANCLOUD_API_URL=$Api",
    "TONOMANCLOUD_API_TOKEN=$($r.credential)",
    "TEMPORAL_ADDRESS=$tempo",
    "TEMPORAL_NAMESPACE=$($r.pool.temporalNamespace)",
    "TEMPORAL_TASK_QUEUE=$($r.pool.taskQueue)",
    "AGENT_RUNTIME_TOKEN=$(Random-Token)",
    "TONOMAN_WAKE_TOKEN=$(Random-Token)",
    "TONOMAN_RELEASE=$Release"
  ) | Set-Content -Path $PoolEnv -Encoding ascii
  # Readable by you alone.
  icacls $PoolEnv /inheritance:r /grant:r "$($env:USERNAME):(R,W)" *> $null
  Write-Host "Enrolled. Credential saved to $PoolEnv (only you can read it)."
  if (-not $NoUp) { Up }
}

function Up {
  Check
  if (-not (Test-Path $PoolEnv)) { Fail "not enrolled: run the command from the Hub first." }
  $e = Read-PoolEnv
  $rel = if ($e.TONOMAN_RELEASE) { $e.TONOMAN_RELEASE } else { "latest" }
  $image = "${ImageRepo}:$rel"
  Write-Host "Pulling $image …"
  & $Podman pull -q $image | Out-Null
  & $Podman pod exists $Pod *> $null
  if ($LASTEXITCODE -eq 0) { Write-Host "Stopping the previous pod …"; & $Podman pod rm -f $Pod | Out-Null }
  foreach ($v in "tonoman-claude", "tonoman-codex", "tonoman-homes", "tonoman-state") { & $Podman volume exists $v *> $null; if ($LASTEXITCODE -ne 0) { & $Podman volume create $v | Out-Null } }
  & $Podman pod create --name $Pod | Out-Null
  & $Podman run -d --pod $Pod --name tonoman-auth --init --restart=always `
    -e "AGENT_RUNTIME_TOKEN=$($e.AGENT_RUNTIME_TOKEN)" -e CLAUDE_CONFIG_ROOT=/root/.claude -e CODEX_HOME=/root/.codex -e TONOMAN_TURN_USERS=on `
    -v tonoman-claude:/root/.claude -v tonoman-codex:/root/.codex -v tonoman-homes:/srv/tonoman/homes `
    $image node /opt/tonoman/dist/cli.js runtime | Out-Null
  & $Podman run -d --pod $Pod --name tonoman-worker --init --restart=always `
    --env-file $PoolEnv `
    -e AGENT_RUNTIME_URL=http://127.0.0.1:8080 -e TONOMAN_STATE_ROOT=/root/.tonoman -e TONOMAN_TURN_USERS=on `
    -e CLAUDE_CONFIG_ROOT=/root/.claude -e CODEX_HOME=/root/.codex -e TONOMAN_WAKE_PORT=3980 -e "TONOMAN_VERSION=$rel" `
    -v tonoman-claude:/root/.claude -v tonoman-codex:/root/.codex -v tonoman-homes:/srv/tonoman/homes -v tonoman-state:/root/.tonoman `
    $image node /opt/tonoman/dist/cli.js worker | Out-Null
  Write-Host "Up. Your agent will show as online in the Hub within a minute. 'tonomanctl logs' follows it."
}

function Down { Check; & $Podman pod exists $Pod *> $null; if ($LASTEXITCODE -eq 0) { & $Podman pod rm -f $Pod | Out-Null; Write-Host "Down." } else { Write-Host "Not running." } }
function Status {
  Check
  & $Podman pod exists $Pod *> $null
  if ($LASTEXITCODE -ne 0) { Write-Host "Not running. 'tonomanctl up' starts it."; return }
  & $Podman ps --pod --filter "pod=$Pod" --format "{{.Names}}`t{{.Status}}"
  & $Podman logs --tail 5 tonoman-worker 2>&1 | Select-String -Pattern "worker: (tonoman|serving|heartbeat|this release)"
}
function Logs { Check; & $Podman logs -f --tail 100 tonoman-worker }
function Update {
  if (-not (Test-Path $PoolEnv)) { Fail "not enrolled." }
  if (-not $Arg) { Fail "usage: tonomanctl update <release> — the Hub names the release to move to; nothing updates on its own." }
  (Get-Content $PoolEnv) -replace "^TONOMAN_RELEASE=.*", "TONOMAN_RELEASE=$Arg" | Set-Content -Path $PoolEnv -Encoding ascii
  Up
}
function Uninstall {
  Check; Down
  foreach ($v in "tonoman-claude", "tonoman-codex", "tonoman-homes", "tonoman-state") { & $Podman volume rm -f $v *> $null }
  Remove-Item -Force -ErrorAction SilentlyContinue $PoolEnv
  Write-Host "Uninstalled: the logins and this computer's credential are gone from this machine. Revoke it in the Hub too, so the platform knows."
}

switch ($Command) {
  "enrol" { Enrol } "enroll" { Enrol }
  "up" { Up } "down" { Down } "status" { Status } "logs" { Logs } "update" { Update } "uninstall" { Uninstall }
  default { Get-Content $PSCommandPath | Select-Object -First 8 | ForEach-Object { $_ -replace "^# ?", "" }; exit 2 }
}
