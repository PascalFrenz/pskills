#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $ProjectDirectory,
    [Parameter(Mandatory)][string[]] $SourceDirectory,
    [string] $Ruleset = (Join-Path $PSScriptRoot '../assets/java-quality-rules.xml'),
    [string] $FilePattern = '*.java',
    [string] $LanguageVersion
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
try {
    $project = (Resolve-Path -LiteralPath $ProjectDirectory).Path
    $command = Get-Command pmd -ErrorAction Stop
    $version = (& $command.Source --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '\bPMD 7\.') {
        throw "This skill requires PMD 7. Found: $version"
    }
    $files = @(
        foreach ($source in $SourceDirectory) {
            $path = if ([IO.Path]::IsPathRooted($source)) { $source } else { Join-Path $project $source }
            $resolved = (Resolve-Path -LiteralPath $path).Path
            if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw "Not a source directory: $resolved" }
            Get-ChildItem -LiteralPath $resolved -Recurse -File -Filter $FilePattern | ForEach-Object FullName
        }
    ) | Sort-Object -Unique
    if (-not $files) { throw 'No matching source files found. Check the source directories and file pattern.' }
    if ($files | Where-Object { $_ -match '[\r\n,]' }) { throw 'PMD file lists cannot safely represent paths containing commas or newlines.' }
    $output = Join-Path ([IO.Path]::GetTempPath()) ('example-driven-pmd-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $output | Out-Null
    $fileList = Join-Path $output 'sources.txt'
    $files | Set-Content -LiteralPath $fileList -Encoding utf8
    $rules = (Resolve-Path -LiteralPath $Ruleset).Path
    $arguments = @('check', '--file-list', $fileList, '--rulesets', $rules,
        '--format', 'json', '--no-cache', '--no-progress',
        '--show-suppressed', '--fail-on-error', '--fail-on-violation')
    if ($LanguageVersion) { $arguments += @('--use-version', $LanguageVersion) }
    [Console]::Error.WriteLine("PMD: $version")
    [Console]::Error.WriteLine("Sources: $($files.Count)")
    $report = (& $command.Source @arguments | Out-String)
    $result = $LASTEXITCODE
    Write-Output $report
    if ($result -notin @(0, 4)) { throw "PMD analysis failed (exit $result)." }
    $data = $report | ConvertFrom-Json
    if ($null -eq $data -or $data.files -isnot [array]) { throw 'Invalid PMD report.' }
    if (@($data.processingErrors).Count -gt 0 -or @($data.configurationErrors).Count -gt 0) {
        throw 'PMD report contains analysis errors.'
    }
    exit $result
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 2
}
