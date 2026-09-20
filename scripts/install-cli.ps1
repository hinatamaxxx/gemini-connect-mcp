param([Parameter(Mandatory=$true)][string]$Origin)
$ErrorActionPreference = 'Stop'
$uri = [Uri]$Origin
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw 'Use your MCP HTTPS origin, without /mcp or query.' }
$target = Join-Path $env:USERPROFILE '.gemini-connect'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ask-antigravity.mjs') -Destination (Join-Path $target 'ask-antigravity.mjs') -Force
$json = @{origin=$uri.GetLeftPart([UriPartial]::Authority)} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $target 'config.json'), $json, [Text.UTF8Encoding]::new($false))
Write-Host "Installed CLI script: $target"
