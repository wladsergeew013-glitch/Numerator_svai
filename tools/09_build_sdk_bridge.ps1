param(
    [string]$NanoCadSDK = 'D:\repo\SDK\Nanocad\26.0.7714.4962.8915',
    [string]$ModelStudioSDK = 'D:\repo\SDK\MS\7680\Model Studio',
    [string]$AtlmfcDir = ''
)
$ErrorActionPreference = 'Stop'
if (!$PSBoundParameters.ContainsKey('NanoCadSDK') -and $env:PILE_NUMBERING_SDK26_DIR) { $NanoCadSDK = $env:PILE_NUMBERING_SDK26_DIR }
if (!$PSBoundParameters.ContainsKey('ModelStudioSDK') -and $env:PILE_NUMBERING_MS_SDK_DIR) { $ModelStudioSDK = $env:PILE_NUMBERING_MS_SDK_DIR }
if (!$PSBoundParameters.ContainsKey('AtlmfcDir') -and $env:PILE_NUMBERING_ATLMFC_DIR) { $AtlmfcDir = $env:PILE_NUMBERING_ATLMFC_DIR }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'Visual Studio C++ build tools are required.' }
$msbuild = Join-Path $installation 'MSBuild\Current\Bin\MSBuild.exe'
foreach ($required in @((Join-Path $NanoCadSDK 'lib-x64\nrxdbgate.lib'), (Join-Path $ModelStudioSDK 'API\ModelStudioAPI\UnitsCS\CSParametricInterfaces.h'))) {
    if (!(Test-Path -LiteralPath $required)) { throw "SDK file is missing: $required" }
}
$buildArguments = @('/m', '/p:Configuration=Release', '/p:Platform=x64', "/p:NanoCadSDK=$NanoCadSDK", "/p:ModelStudioSDK=$ModelStudioSDK", '/verbosity:minimal', '/nologo')
if ($AtlmfcDir) {
    $buildArguments += "/p:AtlmfcDir=$AtlmfcDir"
}
& $msbuild (Join-Path $PSScriptRoot '..\cad_bridge\SdkBridge.vcxproj') @buildArguments
if ($LASTEXITCODE -ne 0) { throw 'nanoCAD SDK bridge build failed.' }
$module = Join-Path $PSScriptRoot '..\cad_bridge\bin\nanoCAD26\PileNumbering.Sdk26.nrx'
$evidence = [ordered]@{
    protocol = 1
    nanoCadSdkVersion = (Get-Item -LiteralPath (Join-Path $NanoCadSDK 'include-x64\hostdbmgd.dll')).VersionInfo.FileVersion
    modelStudioSdkVersion = (Get-Item -LiteralPath (Join-Path $ModelStudioSDK 'Source\bin\VS16\Release NCAD26\x64\UnitsCS.nrx')).VersionInfo.FileVersion
    sha256 = (Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash
}
$evidence | ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path $module -Parent) 'build-info.json') -Encoding UTF8
