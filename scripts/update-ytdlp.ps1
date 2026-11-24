<#
.SYNOPSIS
Rebuilds MediaVault's api and worker Docker images with --no-cache to install the latest yt-dlp release.
#>
[CmdletBinding()]
param(
    [switch]$Prod
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeArgs = @('compose', '-f', 'docker-compose.yml')
if ($Prod) {
    $composeArgs += @('-f', 'docker-compose.prod.yml')
}

function Invoke-DockerCompose {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$SubArgs,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    & docker @composeArgs @SubArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)."
    }
}

Push-Location $repoRoot
try {
    Write-Host "Checking current yt-dlp version in api container..."
    $previousPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $currentVersion = & docker @composeArgs exec -T api yt-dlp --version 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($currentVersion)) {
            Write-Host "Current api yt-dlp version: $($currentVersion.Trim())"
        } else {
            Write-Host "Current api container not running; skipping pre-update version check."
        }
    } catch {
        Write-Host "Current api container not available; skipping pre-update version check."
    } finally {
        $ErrorActionPreference = $previousPref
    }

    Write-Host "Rebuilding api and worker images (--no-cache)..."
    Invoke-DockerCompose -SubArgs @('build', '--no-cache', 'api', 'worker') -FailureMessage 'Failed to rebuild api and worker images'

    Write-Host "Recreating and restarting api and worker containers..."
    Invoke-DockerCompose -SubArgs @('up', '-d', '--force-recreate', 'api', 'worker') -FailureMessage 'Failed to recreate api and worker containers'

    Write-Host "Verifying updated yt-dlp versions..."
    $apiVersion = (& docker @composeArgs exec -T api yt-dlp --version).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($apiVersion)) {
        throw "Failed to read updated yt-dlp version from api container."
    }

    $workerVersion = (& docker @composeArgs exec -T worker yt-dlp --version).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($workerVersion)) {
        throw "Failed to read updated yt-dlp version from worker container."
    }

    Write-Host "Updated yt-dlp versions -> api: $apiVersion | worker: $workerVersion"
} finally {
    Pop-Location
}
