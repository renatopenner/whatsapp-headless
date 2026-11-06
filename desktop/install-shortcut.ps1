# Cria o atalho "Status do WhatsApp" na Area de Trabalho.
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vbs  = Join-Path $root 'desktop\status.vbs'
$icon = Join-Path $root 'assets\status.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Status do WhatsApp.lnk'

if (-not (Test-Path $vbs)) { throw "nao encontrei $vbs" }

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = "$env:WINDIR\System32\wscript.exe"
$s.Arguments = '"' + $vbs + '"'
$s.WorkingDirectory = $root
$s.Description = 'Painel de status: pareamento do WhatsApp, chaves de API e sessões do navegador'
if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
$s.Save()

if (Test-Path $lnk) {
    Write-Output "atalho criado: $lnk"
    $check = $ws.CreateShortcut($lnk)
    Write-Output ("target: " + $check.TargetPath + " " + $check.Arguments)
} else {
    throw 'falhou ao criar o atalho'
}
