# Full health check for dota2tileague.com. Run it any time, especially after a
# deploy or during an event:
#
#   powershell -ExecutionPolicy Bypass -File tools\qa.ps1
#
# Exits 0 when everything passes, 1 when anything fails, so it can gate a
# deploy or be scheduled. Database checks are skipped (not failed) when the
# Supabase helper isn't present, so the script is useful on any machine.
#
# Written after an opening night where four separate surfaces each showed a
# different wrong score and nobody noticed until a user did.

$ErrorActionPreference = "Continue"
$SITE = "https://dota2tileague.com"
$FN   = "https://hqpynfzatnmwvlxdfhsw.supabase.co/functions/v1"
$SB   = "$env:LOCALAPPDATA\Temp\claude\C--Users-Azog-Downloads-magazin-lite-app-3\28395710-c5d3-454c-a92f-befa695d361b\scratchpad\sbsql.ps1"

$script:pass = 0; $script:fail = 0; $script:skip = 0
function Ok($n,$d=""){ $script:pass++; Write-Host ("  PASS  {0}{1}" -f $n,$(if($d){"  $d"}else{""})) -ForegroundColor Green }
function No($n,$d=""){ $script:fail++; Write-Host ("  FAIL  {0}{1}" -f $n,$(if($d){"  $d"}else{""})) -ForegroundColor Red }
function Sk($n,$d=""){ $script:skip++; Write-Host ("  skip  {0}{1}" -f $n,$(if($d){"  $d"}else{""})) -ForegroundColor DarkGray }
function Chk($n,$cond,$d=""){ if($cond){ Ok $n $d } else { No $n $d } }
function Head($t){ Write-Host "`n== $t ==" -ForegroundColor Cyan }

# ---------------------------------------------------------------- pages ----
Head "Pages reachable"
foreach($p in @("/","/data.json","/app","/manifest.webmanifest","/sw.js",
                "/.well-known/assetlinks.json","/icons/icon-192.png")){
  try{ $r=Invoke-WebRequest "$SITE$p" -UseBasicParsing -TimeoutSec 40
       Chk "$p" ($r.StatusCode -eq 200) "HTTP $($r.StatusCode)" }
  catch{ No "$p" "unreachable" }
}
try{
  $page=(Invoke-WebRequest "$SITE/app" -UseBasicParsing).Content
  $apk=[regex]::Match($page,'/downloads/([^"]+\.apk)').Value
  if($apk){ $r=Invoke-WebRequest "$SITE$apk" -UseBasicParsing -Method Head
            Chk "APK download" ($r.StatusCode -eq 200) "$apk" }
  else { No "APK download" "no .apk link on /app" }
}catch{ No "APK download" $_.Exception.Message }

# ----------------------------------------------------------------- data ----
Head "Published data"
try{
  $d=(Invoke-WebRequest "$SITE/data.json?cb=$(Get-Random)" -UseBasicParsing).Content | ConvertFrom-Json
  $age=[math]::Round(([DateTime]::UtcNow - [DateTime]::Parse($d.meta.lastUpdated).ToUniversalTime()).TotalMinutes,0)
  Chk "data.json is fresh" ($age -lt 90) "$age min old"
  Chk "prize pool above base" ($d.prizePool.total -gt $d.meta.basePrizePool) ("{0:N0} vs base {1:N0}" -f $d.prizePool.total,$d.meta.basePrizePool)
  Chk "prize note not stale" (-not ($d.prizePool.note -match 'grows with .*Compendium')) ""
  $amts=@($d.prizePool.distribution | Where-Object { $_.amount -ne $null })
  Chk "every placement has an amount" ($amts.Count -eq $d.prizePool.distribution.Count) "$($amts.Count)/$($d.prizePool.distribution.Count)"
  $span={ param($p) if($p -match '^(\d+)\s*-\s*(\d+)$'){ [int]$Matches[2]-[int]$Matches[1]+1 } else { 1 } }
  $paid=0; foreach($e in $d.prizePool.distribution){ $paid += $e.amount * (& $span $e.place) }
  Chk "payout matches the pool" ([math]::Abs($paid-$d.prizePool.total) -lt $d.prizePool.total*0.03) ("paid {0:N0} vs {1:N0}" -f $paid,$d.prizePool.total)
  Chk "teams present" ($d.teams.Count -ge 8) "$($d.teams.Count) teams"
}catch{ No "data.json parse" $_.Exception.Message }

# ------------------------------------------------------------- live feed ----
Head "Live feed"
try{
  $f=Invoke-RestMethod "$FN/live-matches" -TimeoutSec 90
  Ok "live-matches responds" "$($f.liveMatches.Count) live"
  foreach($m in $f.liveMatches){
    $nm="$($m.teamA.name) v $($m.teamB.name)"
    if($m.seriesA -eq $null -or $m.seriesB -eq $null){ No "series score present" $nm }
    elseif($m.seriesA -gt 5 -or $m.seriesB -gt 5){ No "series score looks like kills" "$nm $($m.seriesA)-$($m.seriesB)" }
    else { Ok "series score sane" "$nm $($m.seriesA)-$($m.seriesB)" }
  }
  Chk "top teams ranked" ($f.topTeams.Count -gt 0) "$($f.topTeams.Count) rated"

  # The series roll-up. Without it the page falls back to the Liquipedia
  # schedule, which lags by minutes, and a finished series keeps showing its
  # old score while still labelled live.
  Chk "tiLeagueId shipped" ($null -ne $f.tiLeagueId) "$($f.tiLeagueId)"
  Chk "tiSeries shipped" ($f.tiSeries.Count -gt 0) "$($f.tiSeries.Count) series"

  # A decided series must have left the live feed. This is the check that would
  # have caught BoomBoys v OG reading 1-0 "live" when it had finished 2-0.
  $stillLive=@()
  foreach($s in $f.tiSeries){
    if([math]::Max($s.sa,$s.sb) -lt 2){ continue }
    foreach($m in $f.liveMatches){
      $p1="$($m.teamA.name)|$($m.teamB.name)"; $p2="$($m.teamB.name)|$($m.teamA.name)"
      if($p1 -eq "$($s.a)|$($s.b)" -or $p2 -eq "$($s.a)|$($s.b)"){ $stillLive += "$($s.a) v $($s.b) $($s.sa)-$($s.sb)" }
    }
  }
  Chk "decided series are not still live" ($stillLive.Count -eq 0) (($stillLive -join ', '))
}catch{ No "live-matches" $_.Exception.Message }

# The page must not drop fields the feed adds. fetchLiveFeed used to rebuild the
# response by naming every key, so tiSeries was silently discarded on arrival
# and no server-side check could see it: the feed was correct, the page was not.
try{
  $page=(Invoke-WebRequest "$SITE/index.html?cb=$(Get-Random)" -UseBasicParsing).Content
  $fn=[regex]::Match($page,'async function fetchLiveFeed\([\s\S]{0,2000}?\n\}')
  Chk "page keeps unknown feed fields" ($fn.Success -and $fn.Value -match '\{\s*\.\.\.j') "spreads the response"
  Chk "page consumes tiSeries" ($page -match 'LIVE_FEED\.tiSeries|tiSeries') ""
}catch{ No "index.html fetch" $_.Exception.Message }

# --------------------------------------------------------------- backend ----
Head "Backend"
if(Test-Path $SB){
  function Q($sql){ (& $SB -Sql $sql) | ConvertFrom-Json }
  try{
    $jobs=Q "select jobname, active from cron.job order by jobname;"
    Chk "cron jobs active" (@($jobs | Where-Object { $_.active }).Count -ge 2) (($jobs.jobname) -join ', ')
    $runs=Q "select count(*) filter (where status='failed') as failed, count(*) as total from cron.job_run_details where start_time > now() - interval '2 hours';"
    Chk "no cron failures (2h)" ([int]$runs.failed -eq 0) "$($runs.failed) failed of $($runs.total)"
    $http=Q "select count(*) filter (where status_code<>200) as bad, count(*) as total from net._http_response;"
    Chk "cron HTTP calls OK" ([int]$http.bad -eq 0) "$($http.bad) non-200 of $($http.total)"
    $acl=Q "select proname, coalesce(array_to_string(proacl::text[],' '),'PUBLIC') as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('tournament_confirm','tournament_resolve_byes');"
    foreach($a in $acl){
      # A Postgres ACL entry is "grantee=privs/grantor". PUBLIC is the entry
      # with an EMPTY grantee — a bare "=X/postgres". Matching on "=X/" alone
      # also hits "postgres=X/postgres", which is fine and expected, so test
      # each entry's grantee rather than the string as a whole.
      $entries = @($a.acl -split '\s+' | Where-Object { $_ })
      $exposed = @($entries | Where-Object {
        $g = ($_ -split '=')[0]
        $g -eq '' -or $g -eq 'anon' -or $g -eq 'authenticated' -or $_ -eq 'PUBLIC'
      })
      Chk "$($a.proname) not publicly callable" ($exposed.Count -eq 0) $a.acl
    }
    $cfg=Q "select value #>> '{}' as v from app_config where key='ti_league_ids';"
    Chk "TI league id configured" ($cfg.v -and $cfg.v -ne '[]') $cfg.v
    $lg=Q "select count(*) as n from leagues;"
    $lb=Q "select count(*) as n from league_leaderboard((select id from leagues order by created_at desc limit 1));"
    Chk "leaderboard computes" ([int]$lb.n -ge 0) "$($lb.n) rows, $($lg.n) leagues"
  }catch{ No "backend queries" $_.Exception.Message }
}else{ Sk "backend checks" "sbsql.ps1 not found" }

# ---------------------------------------------------------------- result ----
Write-Host ""
Write-Host ("PASS {0}   FAIL {1}   skipped {2}" -f $script:pass,$script:fail,$script:skip) -ForegroundColor $(if($script:fail){"Red"}else{"Green"})
exit $(if($script:fail){1}else{0})
