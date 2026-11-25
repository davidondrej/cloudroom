# DeepAPI CLI for AI agents (Windows PowerShell 5.1+ and PowerShell 7).
#   deepapi search [--max N] [--json] "query" ["query" ...]   web searches
#   deepapi scrape [--max-chars N] [--json] URL [URL ...]     page reads
#   deepapi research [--mode raw|clean] [--max-cost USD] [--json] "question"
#   deepapi pdf [--max-pages N] [--max-chars N] [--json] URL
#   deepapi reddit [--max N] [--subreddit SUB] [--json] "query"
#   deepapi github [--type repositories|code|issues|pulls] [--max N] [--json] "query"
#   deepapi twitter [--sort latest|top] [--max N] [--json] "query"
#   deepapi youtube [--max N] [--json] "query" | transcript [--json] URL
#   deepapi balance [--json]                                  remaining credit balance
#   deepapi requests [REQUEST_ID] [--json]                    list or recover a request
#   deepapi help [ENDPOINT_OR_SLUG]                           CLI help or live schema
#   deepapi call [--no-poll] METHOD /v1/path ['{"json":"body"}'] raw JSON
# Auto-polls async endpoints and writes request IDs to stderr while waiting.
# Exit 0 when every item succeeded, 1 otherwise, 2 on usage errors.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$CliVersion = 3
$PollLimitSecs = 600
$script:WantJson = $false

$EnvFile = Join-Path $HOME ".deepapi\env.ps1"
if ([string]::IsNullOrWhiteSpace($env:DEEPAPI_API_KEY) -and (Test-Path -LiteralPath $EnvFile)) {
  . $EnvFile
}
$BaseUrl = if ([string]::IsNullOrWhiteSpace($env:DEEPAPI_API_BASE_URL)) { "https://deepapi.co" } else { $env:DEEPAPI_API_BASE_URL.TrimEnd("/") }
$VersionFile = Join-Path $HOME ".agents\skills\deepapi\VERSION.txt"
$SkillVersion = if (Test-Path -LiteralPath $VersionFile) { ([System.IO.File]::ReadAllLines($VersionFile) | Select-Object -First 1).Trim() } else { "" }

function Show-Help {
  $Lines = [System.IO.File]::ReadAllLines($PSCommandPath) | Select-Object -Skip 1 -First 14
  foreach ($Line in $Lines) { Write-Output ($Line -replace '^# ?', '') }
}

function Fail-Usage([string]$Message = "") {
  if ($Message) { [Console]::Error.WriteLine("deepapi: $Message") }
  else {
    $Lines = [System.IO.File]::ReadAllLines($PSCommandPath) | Select-Object -Skip 1 -First 14
    foreach ($Line in $Lines) { [Console]::Error.WriteLine(($Line -replace '^# ?', '')) }
  }
  exit 2
}

function Assert-Client {
  if ([string]::IsNullOrWhiteSpace($env:DEEPAPI_API_KEY)) {
    if (-not [string]::IsNullOrWhiteSpace($env:ROOM_THREAD_ID) -or -not [string]::IsNullOrWhiteSpace($env:ROOM_PROJECT_ID)) {
      Fail-Usage "DEEPAPI_API_KEY is missing (DeepAPI is off in Cloudroom Settings -> General; use your built-in tools)"
    }
    Fail-Usage "DEEPAPI_API_KEY is missing. Run the setup prompt from https://deepapi.co/docs"
  }
}

function Assert-Path([string]$Path) {
  if ($Path -notmatch '^/v1($|/|\?)' -or $Path -match '\s') {
    Fail-Usage "path must start with /v1: $Path"
  }
}

function Invoke-Raw([string]$Method, [string]$Path, [string]$Body, [string]$Accept) {
  Assert-Path $Path
  $Headers = @{
    Authorization = "Bearer $($env:DEEPAPI_API_KEY)"
    Accept = $Accept
    "X-DeepAPI-Client" = "cli/$CliVersion"
  }
  if ($SkillVersion) { $Headers["X-DeepAPI-Skill-Version"] = $SkillVersion }
  $Params = @{
    Uri = "$BaseUrl$Path"
    Method = $Method
    Headers = $Headers
    TimeoutSec = 300
    UseBasicParsing = $true
  }
  if ($Method -ne "GET" -and $Method -ne "DELETE") {
    $Headers["Idempotency-Key"] = "cli-$([guid]::NewGuid())"
    $Params["ContentType"] = "application/json"
    $Params["Body"] = if ([string]::IsNullOrEmpty($Body)) { "{}" } else { $Body }
  } elseif (-not [string]::IsNullOrEmpty($Body)) {
    $Params["ContentType"] = "application/json"
    $Params["Body"] = $Body
  }
  # PowerShell 7 disposes the error body before the catch below can read it.
  if ($PSVersionTable.PSVersion.Major -ge 7) { $Params["SkipHttpErrorCheck"] = $true }
  try {
    $Res = Invoke-WebRequest @Params
    return @{ Status = [int]$Res.StatusCode; Content = [string]$Res.Content; Ok = $true }
  } catch {
    $Resp = $_.Exception.Response
    if ($null -ne $Resp) {
      $Code = [int]$Resp.StatusCode
      $Reader = New-Object System.IO.StreamReader($Resp.GetResponseStream())
      $Text = $Reader.ReadToEnd()
      $Reader.Dispose()
      return @{ Status = $Code; Content = $Text; Ok = $false }
    }
    return @{ Status = 0; Content = "[deepapi] status=failed code=network_error`nerror: could not reach $BaseUrl ($($_.Exception.Message))"; Ok = $false }
  }
}

function Parse-HeaderVal([string]$Key, [string]$Line) {
  $Match = [regex]::Match(" $Line ", " $([regex]::Escape($Key))=([^ ]+)")
  if ($Match.Success) { return $Match.Groups[1].Value }
  return ""
}

function Run-JsonCall([bool]$AutoPoll, [string]$Method, [string]$Path, [string]$Body) {
  Assert-Client
  $Started = [DateTime]::UtcNow
  $Announced = $false
  $CurMethod = $Method.ToUpperInvariant()
  $CurPath = $Path
  $CurBody = $Body
  while ($true) {
    $Res = Invoke-Raw $CurMethod $CurPath $CurBody "application/json"
    if ($AutoPoll -and $Res.Status -ge 200 -and $Res.Status -lt 300) {
      try {
        $Parsed = $Res.Content | ConvertFrom-Json
        if ($null -ne $Parsed.next -and $Parsed.next.method -eq "GET" -and $Parsed.next.path -like "/v1/requests/*") {
          if (-not $Announced -and $Parsed.requestId) {
            [Console]::Error.WriteLine("[deepapi] running request=$($Parsed.requestId)")
            $Announced = $true
          }
          if (([DateTime]::UtcNow - $Started).TotalSeconds -ge $PollLimitSecs) { break }
          $After = if ($Parsed.next.afterSecs) { [Math]::Min(30, [int]$Parsed.next.afterSecs) } else { 5 }
          Start-Sleep -Seconds $After
          $CurMethod = "GET"
          $CurPath = [string]$Parsed.next.path
          $CurBody = ""
          continue
        }
      } catch {}
    }
    break
  }
  Write-Output $Res.Content
  if ($Res.Status -lt 100 -or $Res.Status -ge 400) { $script:ExitCode = 1 }
}

function Run-Request([string]$Method, [string]$Path, [string]$Body = "") {
  if ($script:WantJson) { Run-JsonCall $true $Method $Path $Body; return }
  Assert-Client
  $Started = [DateTime]::UtcNow
  $Announced = $false
  $Res = Invoke-Raw $Method $Path $Body "text/plain"
  while ($true) {
    $FirstLine = ($Res.Content -split "`r?`n")[0]
    if ($FirstLine -notmatch '^\[deepapi\] status=(running|succeeded) .*poll=') { break }
    if (-not $Announced) {
      $ReqId = Parse-HeaderVal "request" $FirstLine
      if ($ReqId) { [Console]::Error.WriteLine("[deepapi] running request=$ReqId") }
      $Announced = $true
    }
    if (([DateTime]::UtcNow - $Started).TotalSeconds -ge $PollLimitSecs) {
      Write-Output "$($Res.Content)`nnote: not finished after ${PollLimitSecs}s; poll the link above to continue"
      $script:ExitCode = 1; return
    }
    $PollPath = Parse-HeaderVal "poll" $FirstLine
    $AfterRaw = Parse-HeaderVal "after" $FirstLine
    $After = 5
    if ([int]::TryParse($AfterRaw, [ref]$After)) { $After = [Math]::Min(30, [Math]::Max(1, $After)) }
    Start-Sleep -Seconds $After
    $Res = Invoke-Raw "GET" $PollPath "" "text/plain"
  }
  Write-Output $Res.Content
  $FinalHeader = ($Res.Content -split "`r?`n")[0]
  if ($FinalHeader -notmatch '^\[deepapi\] status=(succeeded|dry_run)\b') { $script:ExitCode = 1 }
}

function Parse-PosInt([string]$Flag, [string]$Val) {
  $Num = 0
  if (-not [int]::TryParse($Val, [ref]$Num) -or $Num -lt 1) { Fail-Usage "$Flag needs a whole number of 1 or more" }
  return $Num
}

if ($args.Count -eq 0) { Fail-Usage }
$Command = [string]$args[0]
$Rest = @($args | Select-Object -Skip 1)

if ($Command -eq "-h" -or $Command -eq "--help") { Show-Help; exit 0 }

$ExitCode = 0
switch ($Command) {
  "help" {
    $Topic = ""
    foreach ($Arg in $Rest) {
      if ($Arg -eq "--json") { $script:WantJson = $true }
      elseif ($Arg -eq "-h" -or $Arg -eq "--help") { Show-Help; exit 0 }
      elseif ($Arg -like "-*") { Fail-Usage "unknown option: $Arg" }
      else { $Topic = $Arg }
    }
    if (-not $Topic) { Show-Help; exit 0 }
    if ($Topic -eq "all" -or $Topic -eq "endpoints") { Run-Request "GET" "/v1/capabilities" }
    else { Run-Request "GET" "/v1/capabilities?capability=$([Uri]::EscapeDataString($Topic))" }
  }
  "search" {
    $MaxVal = $null; $Items = New-Object "System.Collections.Generic.List[string]"
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--max") { if ($i + 1 -ge $Rest.Count) { Fail-Usage "--max needs a number" }; $MaxVal = Parse-PosInt "--max" $Rest[++$i] }
      elseif ($a -like "--max=*") { $MaxVal = Parse-PosInt "--max" $a.Substring(6) }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { [void]$Items.Add($a) }
    }
    if ($Items.Count -eq 0) { Fail-Usage }
    foreach ($Item in $Items) {
      if (-not $script:WantJson) { Write-Output "=== search: $Item ===" }
      $Payload = @{ query = $Item }
      if ($null -ne $MaxVal) { $Payload["maxResults"] = $MaxVal }
      Run-Request "POST" "/v1/search/web" ($Payload | ConvertTo-Json -Compress)
    }
  }
  "scrape" {
    $MaxChars = $null; $Items = New-Object "System.Collections.Generic.List[string]"
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--max-chars") { if ($i + 1 -ge $Rest.Count) { Fail-Usage "--max-chars needs a number" }; $MaxChars = Parse-PosInt "--max-chars" $Rest[++$i] }
      elseif ($a -like "--max-chars=*") { $MaxChars = Parse-PosInt "--max-chars" $a.Substring(12) }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { [void]$Items.Add($a) }
    }
    if ($Items.Count -eq 0) { Fail-Usage }
    foreach ($Item in $Items) {
      if (-not $script:WantJson) { Write-Output "=== scrape: $Item ===" }
      $Payload = @{ urls = @($Item); contentFormat = "markdown" }
      if ($null -ne $MaxChars) { $Payload["maxChars"] = $MaxChars }
      Run-Request "POST" "/v1/scrape/website" ($Payload | ConvertTo-Json -Compress)
    }
  }
  "research" {
    $Mode = $null; $MaxCost = $null; $Query = ""
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--mode") { $Mode = $Rest[++$i] }
      elseif ($a -like "--mode=*") { $Mode = $a.Substring(7) }
      elseif ($a -eq "--max-cost") { $MaxCost = $Rest[++$i] }
      elseif ($a -like "--max-cost=*") { $MaxCost = $a.Substring(11) }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { $Query = $a }
    }
    if (-not $Query) { Fail-Usage }
    $Payload = @{ query = $Query }
    if ($Mode) { $Payload["mode"] = $Mode }
    if ($MaxCost) { $Payload["maxCostUsd"] = $MaxCost }
    Run-Request "POST" "/v1/research/deep" ($Payload | ConvertTo-Json -Compress)
  }
  "pdf" {
    $MaxPages = $null; $MaxChars = $null; $Url = ""
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--max-pages") { $MaxPages = Parse-PosInt "--max-pages" $Rest[++$i] }
      elseif ($a -eq "--max-chars") { $MaxChars = Parse-PosInt "--max-chars" $Rest[++$i] }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { $Url = $a }
    }
    if (-not $Url) { Fail-Usage }
    $Payload = @{ url = $Url }
    if ($null -ne $MaxPages) { $Payload["maxPages"] = $MaxPages }
    if ($null -ne $MaxChars) { $Payload["maxChars"] = $MaxChars }
    Run-Request "POST" "/v1/scrape/pdf" ($Payload | ConvertTo-Json -Compress)
  }
  "reddit" {
    $MaxItems = $null; $Sub = $null; $Query = ""
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--max") { $MaxItems = Parse-PosInt "--max" $Rest[++$i] }
      elseif ($a -eq "--subreddit") { $Sub = $Rest[++$i] }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { $Query = $a }
    }
    if (-not $Query) { Fail-Usage }
    $Payload = @{ query = $Query }
    if ($Sub) { $Payload["subreddit"] = $Sub }
    if ($null -ne $MaxItems) { $Payload["maxItems"] = $MaxItems }
    Run-Request "POST" "/v1/scrape/reddit/search" ($Payload | ConvertTo-Json -Compress)
  }
  "github" {
    $GType = "repositories"; $MaxItems = $null; $Query = ""
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--type") { $GType = $Rest[++$i] }
      elseif ($a -eq "--max") { $MaxItems = Parse-PosInt "--max" $Rest[++$i] }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { $Query = $a }
    }
    if (-not $Query) { Fail-Usage }
    $Payload = @{ type = $GType; query = $Query }
    if ($null -ne $MaxItems) { $Payload["maxItems"] = $MaxItems }
    Run-Request "POST" "/v1/scrape/github/search" ($Payload | ConvertTo-Json -Compress)
  }
  "twitter" {
    $Sort = $null; $MaxItems = $null; $Query = ""
    for ($i = 0; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--sort") { $Sort = $Rest[++$i] }
      elseif ($a -eq "--max") { $MaxItems = Parse-PosInt "--max" $Rest[++$i] }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { $Query = $a }
    }
    if (-not $Query) { Fail-Usage }
    $Payload = @{ query = $Query }
    if ($Sort) { $Payload["sort"] = $Sort }
    if ($null -ne $MaxItems) { $Payload["maxItems"] = $MaxItems }
    Run-Request "POST" "/v1/scrape/twitter/search" ($Payload | ConvertTo-Json -Compress)
  }
  "youtube" {
    $Sub = "search"; $Start = 0; $MaxItems = $null; $Target = ""
    if ($Rest.Count -gt 0 -and $Rest[0] -eq "transcript") { $Sub = "transcript"; $Start = 1 }
    for ($i = $Start; $i -lt $Rest.Count; $i++) {
      $a = $Rest[$i]
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -eq "--max") { $MaxItems = Parse-PosInt "--max" $Rest[++$i] }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { $Target = $a }
    }
    if (-not $Target) { Fail-Usage }
    if ($Sub -eq "transcript") {
      Run-Request "POST" "/v1/scrape/youtube/transcript" (@{ url = $Target } | ConvertTo-Json -Compress)
    } else {
      $Payload = @{ query = $Target }
      if ($null -ne $MaxItems) { $Payload["maxItems"] = $MaxItems }
      Run-Request "POST" "/v1/scrape/youtube/search" ($Payload | ConvertTo-Json -Compress)
    }
  }
  "balance" {
    foreach ($a in $Rest) {
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      else { Fail-Usage "unknown option: $a" }
    }
    Run-Request "GET" "/v1/balance"
  }
  "requests" {
    $ReqId = ""
    foreach ($a in $Rest) {
      if ($a -eq "-h" -or $a -eq "--help") { Show-Help; exit 0 }
      elseif ($a -eq "--json") { $script:WantJson = $true }
      elseif ($a -like "-*") { Fail-Usage "unknown option: $a" }
      else { $ReqId = $a }
    }
    if ($ReqId) { Run-Request "GET" "/v1/requests/$([Uri]::EscapeDataString($ReqId))" }
    else { Run-Request "GET" "/v1/requests" }
  }
  "call" {
    $AutoPoll = $true; $Idx = 0
    while ($Idx -lt $Rest.Count -and $Rest[$Idx] -like "-*") {
      if ($Rest[$Idx] -eq "-h" -or $Rest[$Idx] -eq "--help") { Show-Help; exit 0 }
      elseif ($Rest[$Idx] -eq "--no-poll") { $AutoPoll = $false; $Idx++ }
      else { Fail-Usage "unknown option: $($Rest[$Idx])" }
    }
    $CallArgs = @($Rest[$Idx..($Rest.Count - 1)])
    if ($CallArgs.Count -lt 2 -or $CallArgs.Count -gt 3) { Fail-Usage }
    $CallBody = if ($CallArgs.Count -eq 3) { [string]$CallArgs[2] } else { "" }
    Run-JsonCall $AutoPoll ([string]$CallArgs[0]) ([string]$CallArgs[1]) $CallBody
  }
  default { Fail-Usage }
}
exit $ExitCode
