$ErrorActionPreference = 'Stop'
$bucket = if ($env:GOOP_S3_BUCKET) { $env:GOOP_S3_BUCKET } else { 'mathscholar' }
$url = if ($env:GOOP_BACKEND_URL) { $env:GOOP_BACKEND_URL.Trim().TrimEnd('/') } else { '' }
if ($url -and -not $url.StartsWith('https://')) { throw 'GOOP_BACKEND_URL must start with https://' }
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'Install AWS CLI and configure credentials.' }
aws sts get-caller-identity | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'AWS credentials unavailable. Run aws configure or sign into AWS SSO.' }
$js = 'window.GOOP_BACKEND_URL = ' + (ConvertTo-Json -InputObject $url -Compress) + ';'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'site/goop-config.js'),$js)
aws s3 cp (Join-Path $PSScriptRoot 'site/index.html') "s3://$bucket/index.html" --content-type 'text/html; charset=utf-8' --cache-control 'no-cache'
if ($LASTEXITCODE -ne 0) { throw 'S3 HTML upload failed' }
aws s3 sync (Join-Path $PSScriptRoot 'site') "s3://$bucket/" --exclude 'index.html' --cache-control 'no-cache'
if ($LASTEXITCODE -ne 0) { throw 'S3 asset upload failed' }
Write-Host "Uploaded to https://$bucket.s3.us-east-2.amazonaws.com/index.html"
Write-Host 'Backend services require a separate Docker host with HTTPS.'
