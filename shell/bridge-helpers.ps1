# Telegram Agent Bridge - PowerShell Helpers
# Source this in your $PROFILE: . path\to\bridge-helpers.ps1

$script:BRIDGE_PORT = if ($env:BRIDGE_PORT) { $env:BRIDGE_PORT } else { "3847" }

function Get-BridgeSession {
    if ($env:TELEGRAM_BRIDGE_SESSION) {
        return $env:TELEGRAM_BRIDGE_SESSION
    }
    Write-Warning "TELEGRAM_BRIDGE_SESSION not set"
    return $null
}

function Send-BridgeNotify {
    param(
        [string]$Type = "info",
        [Parameter(Mandatory)][string]$Message
    )
    $session = Get-BridgeSession
    if (-not $session) { return }

    $body = @{
        session = $session
        type = $Type
        message = $Message
    } | ConvertTo-Json

    try {
        Invoke-RestMethod -Uri "http://localhost:$script:BRIDGE_PORT/notify" `
            -Method Post -ContentType "application/json" -Body $body -ErrorAction Stop | Out-Null
    } catch {
        # Silently fail
    }
}

function Invoke-AndNotify {
    param([Parameter(Mandatory)][string]$Command)
    Invoke-Expression $Command
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        Send-BridgeNotify -Type "success" -Message "Command completed: $Command"
    } else {
        Send-BridgeNotify -Type "error" -Message "Command failed (exit $exitCode): $Command"
    }
}

# Aliases
Set-Alias -Name notify -Value Send-BridgeNotify
Set-Alias -Name cop -Value Invoke-AndNotify
