# PowerShell Local Static Web Server for HelioPV EPC Studio
param (
    [int]$Port = 8080
)

$HostName = "localhost"
$Folder = $PSScriptRoot

if (-not $Folder) {
    $Folder = Get-Location
}

$Listener = New-Object System.Net.HttpListener
$Prefix = "http://$HostName`:$Port/"
$Listener.Prefixes.Add($Prefix)

try {
    $Listener.Start()
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host " HelioPV EPC Studio (PVsyst Web Simulator) Running!       " -ForegroundColor Yellow
    Write-Host " URL: $Prefix" -ForegroundColor Green
    Write-Host " Serving files from: $Folder" -ForegroundColor Gray
    Write-Host " Press Ctrl+C in this console to stop the server.         " -ForegroundColor DarkGray
    Write-Host "==========================================================" -ForegroundColor Cyan

    # Launch browser automatically
    Start-Process $Prefix

    while ($Listener.IsListening) {
        $Context = $Listener.GetContext()
        $Request = $Context.Request
        $Response = $Context.Response

        $UrlPath = $Request.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($UrlPath)) {
            $UrlPath = "index.html"
        }

        $FilePath = Join-Path $Folder $UrlPath

        if (Test-Path $FilePath -PathType Leaf) {
            $Extension = [System.IO.Path]::GetExtension($FilePath).ToLower()
            $ContentType = switch ($Extension) {
                ".html" { "text/html; charset=utf-8" }
                ".htm"  { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "application/javascript; charset=utf-8" }
                ".json" { "application/json; charset=utf-8" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".jpeg" { "image/jpeg" }
                ".svg"  { "image/svg+xml" }
                ".ico"  { "image/x-icon" }
                default { "application/octet-stream" }
            }

            $Response.ContentType = $ContentType
            $Response.AddHeader("Access-Control-Allow-Origin", "*")
            $Bytes = [System.IO.File]::ReadAllBytes($FilePath)
            $Response.ContentLength64 = $Bytes.Length
            $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
            $Response.StatusCode = 200
        } else {
            $Response.StatusCode = 404
            $ErrorMsg = [System.Text.Encoding]::UTF8.GetBytes("404 - File Not Found: $UrlPath")
            $Response.OutputStream.Write($ErrorMsg, 0, $ErrorMsg.Length)
        }

        $Response.Close()
    }
}
catch {
    Write-Host "Server encountered an error: $_" -ForegroundColor Red
}
finally {
    $Listener.Stop()
    $Listener.Close()
}
